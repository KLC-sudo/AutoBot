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

let _crashCount = 0;
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection:', reason);
  _crashCount++;
  if (_crashCount > 5) process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message, err.stack);
  _crashCount++;
  if (_crashCount > 5) process.exit(1);
});

const PORT = process.env.PORT || 3000;
const UI_PASSWORD = process.env.WEB_UI_PASSWORD;
const RATE_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const RATE_MAX = parseInt(process.env.RATE_LIMIT_MAX, 10) || 200;

if (!UI_PASSWORD || UI_PASSWORD === 'change_this_immediately') {
  console.error('FATAL: WEB_UI_PASSWORD must be set.');
  process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) {
  console.warn('WARNING: OPENROUTER_API_KEY is not set.');
}

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(Buffer.alloc(bufA.length), bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return false;
  return timingSafeCompare(auth.slice(7), UI_PASSWORD);
}

// ─── Express App ────────────────────────────────────────────────────
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
      connectSrc: ["'self'"],
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

app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '16kb' }));

const globalLimiter = rateLimit({ windowMs: RATE_WINDOW, max: RATE_MAX, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, lastModified: true }));
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── SSE Connections ────────────────────────────────────────────────
// Each SSE connection gets an id, a message queue, and a session.
const sseConnections = new Map(); // id -> { res, session, processing, queue }

function sendSSE(connId, type, data) {
  const conn = sseConnections.get(connId);
  if (!conn) return;
  const frame = `data: ${JSON.stringify({ type, ...data })}\n\n`;
  conn.res.write(frame);
}

// ─── Auth endpoint (POST /api/auth) ─────────────────────────────────
app.post('/api/auth', async (req, res) => {
  const { token, sessionId } = req.body;
  if (!token || !timingSafeCompare(token, UI_PASSWORD)) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  const connId = crypto.randomUUID();
  const conn = { res: null, session: null, processing: false, queue: [] };
  sseConnections.set(connId, conn);

  // Session resume/create
  let resumed = false;
  if (sessionId) {
    const loaded = await sessions.loadSession(sessionId).catch(() => null);
    if (loaded) {
      conn.session = loaded;
      resumed = true;
      console.log(`[HTTP] Auth: ${connId} — resumed session ${sessionId}`);
    }
  }
  if (!resumed) {
    const defaultModel = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
    conn.session = sessions.createSession(null, defaultModel);
    await sessions.saveSession(conn.session);
    console.log(`[HTTP] Auth: ${connId} — new session`);
  }

  res.json({ connectionId: connId });
});

// ─── SSE Stream endpoint (GET /api/stream) ──────────────────────────
app.get('/api/stream', (req, res) => {
  const connId = req.query.cid || req.headers['x-connection-id'];
  if (!connId || !sseConnections.has(connId)) {
    return res.status(401).json({ error: 'Invalid connection. Re-authenticate.' });
  }

  const conn = sseConnections.get(connId);
  conn.res = res;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('\n');

  // Send initial data
  sendSSE(connId, 'models', { models: Object.keys(sessions.MODEL_CONTEXT_LENGTHS) });
  sendSSE(connId, 'session', sessions.getSessionStats(conn.session));
  sendSSE(connId, 'auth_success', { message: 'Hermes Agent ready.', connectionId: connId });
  for (const msg of conn.session.messages) {
    if (msg.role === 'user') sendSSE(connId, 'history', { role: 'user', content: msg.content });
    else if (msg.role === 'assistant' && msg.content) sendSSE(connId, 'history', { role: 'assistant', content: msg.content });
  }

  // Keepalive comment every 15s to keep the connection alive through proxies
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepalive);
    conn.res = null;
    console.log(`[SSE] Stream closed: ${connId}`);
  });

  console.log(`[SSE] Stream opened: ${connId}`);
});

// ─── Send endpoint (POST /api/send) — client sends commands ─────────
app.post('/api/send', async (req, res) => {
  const connId = req.headers['x-connection-id'];
  if (!connId || !sseConnections.has(connId)) {
    return res.status(401).json({ error: 'Invalid connection.' });
  }

  const conn = sseConnections.get(connId);
  const { type, ...payload } = req.body;

  if (conn.processing && type === 'command') {
    return res.status(429).json({ error: 'Agent is busy. Please wait.' });
  }

  try {
    switch (type) {
      case 'command':
        conn.processing = true;
        res.json({ ok: true });
        handleCommandSSE(connId, conn, payload).catch(err => {
          console.error(`[CMD] Error:`, err.message);
          sendSSE(connId, 'error', { message: 'Command failed.' });
        }).finally(() => { conn.processing = false; });
        return;

      case 'session_list': {
        const list = await sessions.listSessions();
        sendSSE(connId, 'session_list', { sessions: list });
        res.json({ ok: true });
        return;
      }

      case 'session_create': {
        const model = payload.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
        conn.session = sessions.createSession(payload.name || null, model);
        await sessions.saveSession(conn.session);
        sendSSE(connId, 'session', sessions.getSessionStats(conn.session));
        sendSSE(connId, 'status', { message: `New session created (${model})` });
        res.json({ ok: true });
        return;
      }

      case 'session_load': {
        if (!payload.id) return res.status(400).json({ error: 'Missing session id.' });
        const loaded = await sessions.loadSession(payload.id);
        if (!loaded) return res.status(404).json({ error: 'Session not found.' });
        conn.session = loaded;
        sendSSE(connId, 'session', sessions.getSessionStats(conn.session));
        sendSSE(connId, 'status', { message: `Loaded: ${loaded.name}` });
        for (const msg of loaded.messages) {
          if (msg.role === 'user') sendSSE(connId, 'history', { role: 'user', content: msg.content });
          else if (msg.role === 'assistant' && msg.content) sendSSE(connId, 'history', { role: 'assistant', content: msg.content });
        }
        res.json({ ok: true });
        return;
      }

      case 'session_delete': {
        if (!payload.id) return res.status(400).json({ error: 'Missing session id.' });
        await sessions.deleteSession(payload.id);
        sendSSE(connId, 'status', { message: 'Session deleted.' });
        res.json({ ok: true });
        return;
      }

      case 'session_rename': {
        if (!payload.id) return res.status(400).json({ error: 'Missing session id.' });
        if (!payload.name) return res.status(400).json({ error: 'Missing new name.' });
        const s = await sessions.loadSession(payload.id);
        if (!s) return res.status(404).json({ error: 'Session not found.' });
        s.name = payload.name;
        await sessions.saveSession(s);
        sendSSE(connId, 'status', { message: `Renamed to "${payload.name}"` });
        res.json({ ok: true });
        return;
      }

      case 'model_switch': {
        if (!payload.model) return res.status(400).json({ error: 'Missing model name.' });
        conn.session.model = payload.model;
        await sessions.saveSession(conn.session);
        const ctx = sessions.getContextLength(payload.model);
        sendSSE(connId, 'session', sessions.getSessionStats(conn.session));
        sendSSE(connId, 'status', { message: `Switched to ${payload.model} (${ctx.toLocaleString()} tokens)` });
        res.json({ ok: true });
        return;
      }

      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(`[HTTP] Send error:`, err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── Command Handler (SSE version) ──────────────────────────────────
async function handleCommandSSE(connId, conn, payload) {
  const command = (payload.data || '').trim();
  if (!command) return sendSSE(connId, 'error', { message: 'Empty command.' });
  if (command.length > 10000) return sendSSE(connId, 'error', { message: 'Command too long.' });

  const workdir = process.env.WORKDIR || path.join(__dirname, 'data', 'workspace');
  console.log(`[CMD] ${connId}: ${command}`);

  const result = await runAgent(command, conn.session, {
    onStatus:      (msg)  => sendSSE(connId, 'status', { message: msg }),
    onCode:        (file, content) => sendSSE(connId, 'code', { filename: file, data: content }),
    onText:        (msg)  => sendSSE(connId, 'text', { message: msg }),
    onError:       (msg)  => sendSSE(connId, 'error', { message: msg }),
    onTokenUpdate: (data) => sendSSE(connId, 'tokens', data),
  }, workdir);

  if (result) {
    conn.session.messages.push(...result.messages);
    conn.session.tokenUsage.prompt += result.tokenUsage.prompt;
    conn.session.tokenUsage.completion += result.tokenUsage.completion;
    conn.session.tokenUsage.total += result.tokenUsage.total;
    await sessions.saveSession(conn.session);
    sendSSE(connId, 'session', sessions.getSessionStats(conn.session));
  }
}

// ─── Status API ─────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  if (!verifyToken(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ status: 'operational', uptime: process.uptime(), connections: sseConnections.size });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Graceful Shutdown ──────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal}`);
  sseConnections.forEach((conn, id) => {
    sendSSE(id, 'status', { message: 'Server shutting down.' });
    try { conn.res.end(); } catch {}
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────
sessions.init().then(async () => {
  await sessions.cleanupEmptySessions();
  server.listen(PORT, () => {
    console.log(`\n🚀 Hermes Web UI Gateway`);
    console.log(`   Port:   ${PORT}`);
    console.log(`   Status: http://localhost:${PORT}/health`);
    console.log(`   Mode:   HTTP/SSE\n`);
  });
});
