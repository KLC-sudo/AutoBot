require('dotenv').config();
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { runAgent } = require('./agent');
const sessions = require('./sessions');

let _crashCount = 0;
process.on('unhandledRejection', (r) => { console.error('[FATAL] Rejection:', r); if (++_crashCount > 5) process.exit(1); });
process.on('uncaughtException', (e) => { console.error('[FATAL] Exception:', e.message, e.stack); if (++_crashCount > 5) process.exit(1); });

const PORT = process.env.PORT || 3000;
const UI_PASSWORD = process.env.WEB_UI_PASSWORD;

if (!UI_PASSWORD || UI_PASSWORD === 'change_this_immediately') {
  console.error('FATAL: WEB_UI_PASSWORD must be set.'); process.exit(1);
}
if (!process.env.OPENROUTER_API_KEY) console.warn('WARNING: OPENROUTER_API_KEY is not set.');

function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8'), bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) { crypto.timingSafeEqual(Buffer.alloc(bufA.length), bufA); return false; }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── Express ────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], fontSrc: ["'self'"],
      objectSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"],
    },
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use(cors({ origin: true, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-Connection-Id'] }));
app.use(express.json({ limit: '16kb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, lastModified: true }));
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Connection State ───────────────────────────────────────────────
const conns = new Map();
const LOG_BUFFER_SIZE = 200;
const logBuffer = [];
const startTime = Date.now();

function serverLog(level, msg) {
  const entry = { t: Date.now(), level, msg };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
}

function enqueue(connId, type, data) {
  const conn = conns.get(connId);
  if (conn) conn.queue.push({ type, ...data });
}

// ─── POST /api/auth — login, get connection ID ──────────────────────
app.post('/api/auth', async (req, res) => {
  const { token, sessionId } = req.body;
  if (!token || !timingSafeCompare(token, UI_PASSWORD)) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  const connId = crypto.randomUUID();
  const conn = { session: null, processing: false, queue: [], lastPoll: Date.now() };
  conns.set(connId, conn);

  let resumed = false;
  if (sessionId) {
    const loaded = await sessions.loadSession(sessionId).catch(() => null);
    if (loaded) { conn.session = loaded; resumed = true; }
  }
  if (!resumed) {
    const model = process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
    conn.session = sessions.createSession(null, model);
    await sessions.saveSession(conn.session);
  }

  // Queue initial data
  enqueue(connId, 'models', { models: Object.keys(sessions.MODEL_CONTEXT_LENGTHS) });
  enqueue(connId, 'session', sessions.getSessionStats(conn.session));
  enqueue(connId, 'auth_success', { message: 'Hermes Agent ready.', connectionId: connId });
  for (const msg of conn.session.messages) {
    if (msg.role === 'user') enqueue(connId, 'history', { role: 'user', content: msg.content });
    else if (msg.role === 'assistant' && msg.content) enqueue(connId, 'history', { role: 'assistant', content: msg.content });
  }

  console.log(`[AUTH] ${connId} ${resumed ? 'resumed' : 'new'}`);
  serverLog('info', `Auth: ${connId} ${resumed ? 'resumed session' : 'new session'}`);
  res.json({ connectionId: connId });
});

// ─── GET /api/poll — long-poll for messages ─────────────────────────
// Holds connection open for up to 30s, responds as soon as a message
// is available (or timeout). Standard HTTP — no proxy buffering issues.
app.get('/api/poll', (req, res) => {
  const connId = req.query.cid;
  if (!connId || !conns.has(connId)) return res.status(401).json({ error: 'No connection.' });

  const conn = conns.get(connId);
  conn.lastPoll = Date.now();

  if (conn.queue.length > 0) {
    const messages = conn.queue.splice(0);
    return res.json({ messages });
  }

  let sent = false;
  const timeout = setTimeout(() => {
    if (!sent) { sent = true; res.json({ messages: [] }); }
  }, 25000);

  const check = setInterval(() => {
    if (conn.queue.length > 0 && !sent) {
      sent = true;
      clearTimeout(timeout);
      clearInterval(check);
      const messages = conn.queue.splice(0);
      res.json({ messages });
    }
  }, 200);

  req.on('close', () => {
    clearTimeout(timeout);
    clearInterval(check);
  });
});

// ─── POST /api/send — send command/message to server ────────────────
app.post('/api/send', async (req, res) => {
  const connId = req.headers['x-connection-id'];
  if (!connId || !conns.has(connId)) return res.status(401).json({ error: 'No connection.' });

  const conn = conns.get(connId);
  const { type, ...payload } = req.body;

  if (conn.processing && type === 'command') {
    return res.status(429).json({ error: 'Agent is busy.' });
  }

  try {
    switch (type) {
      case 'command': {
        const command = (payload.data || '').trim();
        if (!command) { enqueue(connId, 'error', { message: 'Empty command.' }); return res.json({ ok: true }); }
        if (command.length > 10000) { enqueue(connId, 'error', { message: 'Command too long.' }); return res.json({ ok: true }); }

        conn.processing = true;
        res.json({ ok: true });
        const workdir = process.env.WORKDIR || path.join(__dirname, 'data', 'workspace');
        console.log(`[CMD] ${connId}: ${command}`);
        serverLog('info', `CMD: ${command.substring(0, 80)}`);

        runAgent(command, conn.session, {
          onStatus:      (msg)  => enqueue(connId, 'status', { message: msg }),
          onCode:        (f, c) => enqueue(connId, 'code', { filename: f, data: c }),
          onText:        (msg)  => enqueue(connId, 'text', { message: msg }),
          onError:       (msg)  => enqueue(connId, 'error', { message: msg }),
          onTokenUpdate: (d)    => enqueue(connId, 'tokens', d),
        }, workdir).then(async (result) => {
          if (result) {
            conn.session.messages.push(...result.messages);
            conn.session.tokenUsage.prompt += result.tokenUsage.prompt;
            conn.session.tokenUsage.completion += result.tokenUsage.completion;
            conn.session.tokenUsage.total += result.tokenUsage.total;
            await sessions.saveSession(conn.session);
            enqueue(connId, 'session', sessions.getSessionStats(conn.session));
          }
        }).catch(err => {
          enqueue(connId, 'error', { message: `Agent crashed: ${err.message}` });
          serverLog('error', `Agent crash: ${err.message}`);
        }).finally(() => { conn.processing = false; });
        return;
      }

      case 'session_list': {
        const list = await sessions.listSessions();
        enqueue(connId, 'session_list', { sessions: list });
        return res.json({ ok: true });
      }

      case 'session_create': {
        const model = payload.model || process.env.OPENROUTER_MODEL || 'openai/gpt-4o';
        conn.session = sessions.createSession(payload.name || null, model);
        await sessions.saveSession(conn.session);
        enqueue(connId, 'session', sessions.getSessionStats(conn.session));
        enqueue(connId, 'status', { message: `New session created (${model})` });
        return res.json({ ok: true });
      }

      case 'session_load': {
        if (!payload.id) return res.status(400).json({ error: 'Missing id.' });
        const loaded = await sessions.loadSession(payload.id);
        if (!loaded) return res.status(404).json({ error: 'Not found.' });
        conn.session = loaded;
        enqueue(connId, 'session', sessions.getSessionStats(conn.session));
        enqueue(connId, 'status', { message: `Loaded: ${loaded.name}` });
        for (const msg of loaded.messages) {
          if (msg.role === 'user') enqueue(connId, 'history', { role: 'user', content: msg.content });
          else if (msg.role === 'assistant' && msg.content) enqueue(connId, 'history', { role: 'assistant', content: msg.content });
        }
        return res.json({ ok: true });
      }

      case 'session_delete': {
        if (!payload.id) return res.status(400).json({ error: 'Missing id.' });
        await sessions.deleteSession(payload.id);
        enqueue(connId, 'status', { message: 'Session deleted.' });
        return res.json({ ok: true });
      }

      case 'session_rename': {
        if (!payload.id || !payload.name) return res.status(400).json({ error: 'Missing id or name.' });
        const s = await sessions.loadSession(payload.id);
        if (!s) return res.status(404).json({ error: 'Not found.' });
        s.name = payload.name;
        await sessions.saveSession(s);
        enqueue(connId, 'status', { message: `Renamed to "${payload.name}"` });
        return res.json({ ok: true });
      }

      case 'model_switch': {
        if (!payload.model) return res.status(400).json({ error: 'Missing model.' });
        conn.session.model = payload.model;
        await sessions.saveSession(conn.session);
        enqueue(connId, 'session', sessions.getSessionStats(conn.session));
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: `Unknown type: ${type}` });
    }
  } catch (err) {
    console.error(`[HTTP] Error:`, err.message);
    serverLog('error', `HTTP Error: ${err.message}`);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ─── Cleanup stale connections ───────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  conns.forEach((conn, id) => {
    if (now - conn.lastPoll > 120000) {
      conns.delete(id);
      serverLog('info', `Cleaned stale connection: ${id.substring(0, 8)}`);
    }
  });
}, 60000);

// ─── GET /api/logs — fetch buffered server logs ─────────────────────
app.get('/api/logs', (req, res) => {
  const connId = req.query.cid;
  if (!connId || !conns.has(connId)) return res.status(401).json({ error: 'No connection.' });
  const since = parseInt(req.query.since, 10) || 0;
  const entries = since ? logBuffer.filter(e => e.t > since) : logBuffer;
  res.json({ logs: entries });
});

// ─── GET /api/diag — server diagnostics ─────────────────────────────
app.get('/api/diag', (req, res) => {
  const connId = req.query.cid;
  if (!connId || !conns.has(connId)) return res.status(401).json({ error: 'No connection.' });
  const conn = conns.get(connId);
  const mem = process.memoryUsage();
  res.json({
    uptime: Math.round((Date.now() - startTime) / 1000),
    memoryMB: Math.round(mem.rss / 1048576),
    heapMB: Math.round(mem.heapUsed / 1048576),
    activeConnections: conns.size,
    queueDepth: conn.queue.length,
    processing: conn.processing,
    sessionId: conn.session?.id || null,
    sessionModel: conn.session?.model || null,
    messageCount: conn.session?.messages?.length || 0,
    tokenUsage: conn.session?.tokenUsage || { prompt: 0, completion: 0, total: 0 },
    logBufferSize: logBuffer.length,
  });
});

// ─── Railway API Proxy ──────────────────────────────────────────────
const RAILWAY_API = 'https://api.railway.app/graphql';
const RAILWAY_TOKEN = process.env.RAILWAY_API_TOKEN || process.env.RAILWAY_TOKEN;

async function railwayQuery(query, variables = {}) {
  if (!RAILWAY_TOKEN) throw new Error('RAILWAY_API_TOKEN not set');
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RAILWAY_TOKEN}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0]?.message || 'Railway API error');
  return json.data;
}

function requireRailway(req, res, next) {
  if (!RAILWAY_TOKEN) return res.status(503).json({ error: 'Neither RAILWAY_API_TOKEN nor RAILWAY_TOKEN is set.' });
  const connId = req.query.cid || req.headers['x-connection-id'];
  if (!connId || !conns.has(connId)) return res.status(401).json({ error: 'No connection.' });
  next();
}

// GET /api/railway/projects — list all projects
app.get('/api/railway/projects', requireRailway, async (req, res) => {
  try {
    const data = await railwayQuery(`{
      me { projects(first: 50, after: null) { edges { node { id name updatedAt } } } }
    }`);
    const projects = data.me.projects.edges.map(e => e.node);
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/railway/services?project=<id> — list services in a project
app.get('/api/railway/services', requireRailway, async (req, res) => {
  const projectId = req.query.project;
  if (!projectId) return res.status(400).json({ error: 'Missing project param.' });
  try {
    const data = await railwayQuery(`{
      project(id: "${projectId}") {
        services(first: 50) { edges { node { id name } } }
      }
    }`);
    const services = data.project.services.edges.map(e => e.node);
    res.json({ services });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/railway/logs?service=<id>&lines=200 — fetch logs for a service
app.get('/api/railway/logs', requireRailway, async (req, res) => {
  const serviceId = req.query.service;
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 1000);
  if (!serviceId) return res.status(400).json({ error: 'Missing service param.' });
  try {
    const data = await railwayQuery(`{
      logs(serviceId: "${serviceId}", limit: ${lines}) {
        elements { id timestamp text source }
      }
    }`);
    res.json({ logs: data.logs.elements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function shutdown(signal) {
  console.log(`\n[SHUTDOWN] ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

sessions.init().then(async () => {
  await sessions.cleanupEmptySessions();
  server.listen(PORT, () => {
    console.log(`\n🚀 Hermes Web UI Gateway`);
    console.log(`   Port:   ${PORT}`);
    console.log(`   Mode:   HTTP Long-Poll\n`);
    serverLog('info', `Server started on port ${PORT}`);
  });
});
