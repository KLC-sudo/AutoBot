require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { runAgent } = require('./agent');
const sessions = require('./sessions');

// ─── Configuration ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const UI_PASSWORD = process.env.WEB_UI_PASSWORD;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000';
const RATE_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 100;
const WS_MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD, 10) || 1024 * 1024;

if (!UI_PASSWORD || UI_PASSWORD === 'change_this_immediately') {
  console.error('FATAL: WEB_UI_PASSWORD must be set to a strong value in environment.');
  process.exit(1);
}

// ─── Express App ─────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.use(express.json({ limit: '16kb' }));

const globalLimiter = rateLimit({
  windowMs: RATE_WINDOW,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use(globalLimiter);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, lastModified: true }));

// Force no-cache on HTML files (prevents stale mobile caches)
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  }
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── API Auth ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  if (!timingSafeCompare(authHeader.slice(7), UI_PASSWORD)) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(Buffer.alloc(bufA.length), bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

app.get('/api/status', requireAuth, (_req, res) => {
  res.json({ status: 'operational', agent: 'hermes', uptime: process.uptime(), connections: wss.clients.size });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket Server ───────────────────────────────────────────────
const wss = new WebSocket.Server({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._authenticated = false;
    ws._authTimeout = setTimeout(() => {
      if (!ws._authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth timeout.' }));
        ws.terminate();
      }
    }, 5000);
    wss.emit('connection', ws, request);
  });
});

// ─── Per-connection state ────────────────────────────────────────────
const connections = new Map(); // ws -> { id, session, processing }

function sendFrame(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// ─── Connection Handler ─────────────────────────────────────────────
wss.on('connection', (ws, request) => {
  const connectionId = crypto.randomUUID();
  console.log(`[WS] Connected: ${connectionId}`);

  connections.set(ws, { id: connectionId, session: null, processing: false });

  ws.on('message', async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return sendFrame(ws, 'error', { message: 'Invalid JSON.' });
    }

    const conn = connections.get(ws);
    if (!conn) return;

    // ── Auth Handshake ──
    if (!ws._authenticated) {
      if (payload.type !== 'auth' || !payload.token) {
        ws.send(JSON.stringify({ type: 'error', message: 'Expected auth.' }));
        return ws.terminate();
      }
      if (!timingSafeCompare(payload.token, UI_PASSWORD)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token.' }));
        return ws.terminate();
      }
      clearTimeout(ws._authTimeout);
      ws._authenticated = true;

      // Send available models list
      sendFrame(ws, 'models', { models: Object.keys(sessions.MODEL_CONTEXT_LENGTHS) });

      // ── Session Resume Logic ──
      // 1. Client may send a sessionId to resume
      // 2. Otherwise, try the last active session from disk
      // 3. Only create a new session if nothing can be resumed
      const requestedSessionId = payload.sessionId;
      let resumed = false;

      if (requestedSessionId) {
        const loaded = await sessions.loadSession(requestedSessionId);
        if (loaded) {
          conn.session = loaded;
          sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
          sendFrame(ws, 'auth_success', { message: 'Hermes Agent ready. Session resumed.', connectionId });
          // Replay conversation history to client
          for (const msg of loaded.messages) {
            if (msg.role === 'user') {
              sendFrame(ws, 'history', { role: 'user', content: msg.content });
            } else if (msg.role === 'assistant' && msg.content) {
              sendFrame(ws, 'history', { role: 'assistant', content: msg.content });
            }
          }
          resumed = true;
          console.log(`[WS] Authenticated: ${connectionId} — resumed session ${requestedSessionId}`);
        } else {
          console.log(`[WS] Requested session ${requestedSessionId} not found, trying last active...`);
        }
      }

      if (!resumed) {
        const lastActiveId = await sessions.getActiveSessionId();
        if (lastActiveId) {
          const loaded = await sessions.loadSession(lastActiveId);
          if (loaded) {
            conn.session = loaded;
            sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
            sendFrame(ws, 'auth_success', { message: 'Hermes Agent ready. Session restored.', connectionId });
            // Replay conversation history to client
            for (const msg of loaded.messages) {
              if (msg.role === 'user') {
                sendFrame(ws, 'history', { role: 'user', content: msg.content });
              } else if (msg.role === 'assistant' && msg.content) {
                sendFrame(ws, 'history', { role: 'assistant', content: msg.content });
              }
            }
            resumed = true;
            console.log(`[WS] Authenticated: ${connectionId} — restored last active session ${lastActiveId}`);
          }
        }
      }

      if (!resumed) {
        // Fall back to most recent session on disk, or create new
        const recent = await sessions.getMostRecentSession();
        if (recent) {
          conn.session = recent;
          await sessions.saveSession(recent); // touch updatedAt to mark active
          sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
          sendFrame(ws, 'auth_success', { message: 'Hermes Agent ready. Previous session restored.', connectionId });
          // Replay conversation history to client
          for (const msg of recent.messages) {
            if (msg.role === 'user') {
              sendFrame(ws, 'history', { role: 'user', content: msg.content });
            } else if (msg.role === 'assistant' && msg.content) {
              sendFrame(ws, 'history', { role: 'assistant', content: msg.content });
            }
          }
          resumed = true;
          console.log(`[WS] Authenticated: ${connectionId} — restored most recent session ${recent.id}`);
        }
      }

      if (!resumed) {
        const defaultModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
        conn.session = sessions.createSession(null, defaultModel);
        await sessions.saveSession(conn.session);
        sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
        sendFrame(ws, 'auth_success', { message: 'Hermes Agent ready.', connectionId });
        console.log(`[WS] Authenticated: ${connectionId} — new session`);
      }
      return;
    }

    // ── All other messages require auth ──
    if (conn.processing && payload.type === 'command') {
      return sendFrame(ws, 'error', { message: 'Agent is busy. Please wait.' });
    }

    switch (payload.type) {
      case 'command':
        await handleCommand(ws, conn, payload);
        break;

      case 'session_list':
        await handleSessionList(ws);
        break;

      case 'session_create':
        await handleSessionCreate(ws, conn, payload);
        break;

      case 'session_load':
        await handleSessionLoad(ws, conn, payload);
        break;

      case 'session_delete':
        await handleSessionDelete(ws, payload);
        break;

      case 'session_rename':
        await handleSessionRename(ws, payload);
        break;

      case 'model_switch':
        await handleModelSwitch(ws, conn, payload);
        break;

      default:
        sendFrame(ws, 'error', { message: `Unknown type: ${payload.type}` });
    }
  });

  ws.on('close', () => {
    const conn = connections.get(ws);
    console.log(`[WS] Disconnected: ${conn?.id}`);
    connections.delete(ws);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error:`, err.message);
    connections.delete(ws);
  });

  ws.on('pong', () => { ws._isAlive = true; });
});

// ─── Heartbeat ──────────────────────────────────────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._isAlive === false) return ws.terminate();
    ws._isAlive = false;
    ws.ping();
  });
}, 30000);
wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Command Handler ────────────────────────────────────────────────
async function handleCommand(ws, conn, payload) {
  const command = (payload.data || '').trim();
  if (!command) return sendFrame(ws, 'error', { message: 'Empty command.' });
  if (command.length > 10000) return sendFrame(ws, 'error', { message: 'Command too long (max 10000 chars).' });

  conn.processing = true;
  const workdir = process.env.WORKDIR || path.join(__dirname, 'data', 'workspace');

  console.log(`[CMD] ${conn.id}: ${command}`);

  try {
    const result = await runAgent(command, conn.session, {
      onStatus:      (msg)  => sendFrame(ws, 'status', { message: msg }),
      onCode:        (file, content) => sendFrame(ws, 'code', { filename: file, data: content }),
      onText:        (msg)  => sendFrame(ws, 'text', { message: msg }),
      onError:       (msg)  => sendFrame(ws, 'error', { message: msg }),
      onTokenUpdate: (data) => sendFrame(ws, 'tokens', data),
    }, workdir);

    if (result) {
      // Append new messages to session
      conn.session.messages.push(...result.messages);
      conn.session.tokenUsage.prompt += result.tokenUsage.prompt;
      conn.session.tokenUsage.completion += result.tokenUsage.completion;
      conn.session.tokenUsage.total += result.tokenUsage.total;
      await sessions.saveSession(conn.session);

      sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
    }
  } catch (err) {
    sendFrame(ws, 'error', { message: `Agent crashed: ${err.message}` });
  } finally {
    conn.processing = false;
  }
}

// ─── Session Handlers ───────────────────────────────────────────────
async function handleSessionList(ws) {
  const list = await sessions.listSessions();
  sendFrame(ws, 'session_list', { sessions: list });
}

async function handleSessionCreate(ws, conn, payload) {
  const model = payload.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
  const name = payload.name || null;
  conn.session = sessions.createSession(name, model);
  await sessions.saveSession(conn.session);
  sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
  sendFrame(ws, 'status', { message: `New session created (${model})` });
}

async function handleSessionLoad(ws, conn, payload) {
  if (!payload.id) return sendFrame(ws, 'error', { message: 'Missing session id.' });
  const loaded = await sessions.loadSession(payload.id);
  if (!loaded) return sendFrame(ws, 'error', { message: 'Session not found.' });
  conn.session = loaded;
  sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
  sendFrame(ws, 'status', { message: `Loaded: ${loaded.name}` });

  // Replay conversation history to client
  for (const msg of loaded.messages) {
    if (msg.role === 'user') {
      sendFrame(ws, 'history', { role: 'user', content: msg.content });
    } else if (msg.role === 'assistant' && msg.content) {
      sendFrame(ws, 'history', { role: 'assistant', content: msg.content });
    }
  }
}

async function handleSessionDelete(ws, payload) {
  if (!payload.id) return sendFrame(ws, 'error', { message: 'Missing session id.' });
  await sessions.deleteSession(payload.id);
  // If the deleted session was the active one, clear the tracker
  const activeId = await sessions.getActiveSessionId();
  if (activeId === payload.id) {
    await sessions.setActiveSession(null);
  }
  sendFrame(ws, 'status', { message: 'Session deleted.' });
}

async function handleSessionRename(ws, payload) {
  if (!payload.id) return sendFrame(ws, 'error', { message: 'Missing session id.' });
  if (!payload.name) return sendFrame(ws, 'error', { message: 'Missing new name.' });
  const session = await sessions.loadSession(payload.id);
  if (!session) return sendFrame(ws, 'error', { message: 'Session not found.' });
  session.name = payload.name;
  await sessions.saveSession(session);
  sendFrame(ws, 'status', { message: `Renamed to "${payload.name}"` });
  // Refresh session list
  const list = await sessions.listSessions();
  sendFrame(ws, 'session_list', { sessions: list });
}

async function handleModelSwitch(ws, conn, payload) {
  if (!payload.model) return sendFrame(ws, 'error', { message: 'Missing model name.' });
  const contextLen = sessions.getContextLength(payload.model);
  conn.session.model = payload.model;
  await sessions.saveSession(conn.session);
  sendFrame(ws, 'session', sessions.getSessionStats(conn.session));
  sendFrame(ws, 'status', { message: `Switched to ${payload.model} (${contextLen.toLocaleString()} token context)` });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal}`);
  clearInterval(heartbeatInterval);
  wss.clients.forEach((ws) => {
    ws.send(JSON.stringify({ type: 'status', message: 'Server shutting down.' }));
    ws.close(1001);
  });
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────
sessions.init().then(async () => {
  // Clean up empty sessions on startup
  await sessions.cleanupEmptySessions();

  server.listen(PORT, () => {
    console.log(`\n🚀 Hermes Web UI Gateway`);
    console.log(`   Port:      ${PORT}`);
    console.log(`   Origin:    ${ALLOWED_ORIGIN}`);
    console.log(`   Status:    http://localhost:${PORT}/health`);
    console.log(`   WebSocket: ws://localhost:${PORT}\n`);
  });
});
