require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

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

// Trust Railway's reverse proxy so rate-limit sees real client IPs
app.set('trust proxy', 1);

const server = http.createServer(app);

// Security headers via Helmet
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

// CORS — only allow the configured Railway origin
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// Body parser with size limit
app.use(express.json({ limit: '16kb' }));

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: RATE_WINDOW,
  max: RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, slow down.' },
});
app.use(globalLimiter);

// ─── Static Files (no auth needed — UI is public, auth happens at WS level) ─
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
  lastModified: true,
}));

// ─── Health Check ────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── API Auth Middleware ─────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.slice(7);
  if (!timingSafeCompare(token, UI_PASSWORD)) {
    return res.status(403).json({ error: 'Invalid token' });
  }
  next();
}

// Timing-safe string comparison to prevent timing attacks
function timingSafeCompare(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(Buffer.alloc(bufA.length), bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ─── API Endpoints (all require auth) ───────────────────────────────
app.get('/api/status', requireAuth, (_req, res) => {
  res.json({
    status: 'operational',
    agent: 'hermes',
    uptime: process.uptime(),
    connections: wss.clients.size,
  });
});

// Catch-all: serve index.html for SPA routing
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── WebSocket Server ───────────────────────────────────────────────
const wss = new WebSocket.Server({
  noServer: true,
  maxPayload: WS_MAX_PAYLOAD,
  perMessageDeflate: false,
});

// ─── WS Authentication ─────────────────────────────────────────────
// Instead of token-in-query (logged by proxies), we use a first-message handshake.
// Client must send { type: "auth", token: "..." } within 5 seconds of connection.
// If no valid auth message arrives, the socket is destroyed.
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws._authenticated = false;
    ws._authTimeout = setTimeout(() => {
      if (!ws._authenticated) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth timeout. Disconnecting.' }));
        ws.terminate();
      }
    }, 5000);

    wss.emit('connection', ws, request);
  });
});

// ─── Active Connection Tracking ──────────────────────────────────────
const activeConnections = new Map(); // ws -> { id, connectedAt }

// ─── WebSocket Connection Handler ───────────────────────────────────
wss.on('connection', (ws, request) => {
  const connectionId = crypto.randomUUID();
  const clientIp = request.headers['x-forwarded-for'] || request.socket.remoteAddress;

  console.log(`[WS] New connection ${connectionId} from ${clientIp}`);

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload.' }));
      return;
    }

    // ── Auth Handshake ──
    if (!ws._authenticated) {
      if (payload.type !== 'auth' || !payload.token) {
        ws.send(JSON.stringify({ type: 'error', message: 'Expected auth message first.' }));
        ws.terminate();
        return;
      }

      if (!timingSafeCompare(payload.token, UI_PASSWORD)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token. Disconnecting.' }));
        ws.terminate();
        return;
      }

      clearTimeout(ws._authTimeout);
      ws._authenticated = true;
      ws._connectionId = connectionId;
      ws._connectedAt = Date.now();
      activeConnections.set(ws, { id: connectionId, connectedAt: Date.now() });

      ws.send(JSON.stringify({
        type: 'auth_success',
        message: 'Authenticated. Hermes Agent ready.',
        connectionId,
      }));

      console.log(`[WS] Authenticated: ${connectionId}`);
      return;
    }

    // ── Authenticated Command Processing ──
    handleCommand(ws, payload, connectionId);
  });

  ws.on('close', () => {
    activeConnections.delete(ws);
    console.log(`[WS] Disconnected: ${connectionId}`);
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error on ${connectionId}:`, err.message);
    activeConnections.delete(ws);
  });

  ws.on('pong', () => { ws._isAlive = true; });
});

// ─── Heartbeat: Kill stale connections every 30s ────────────────────
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._isAlive === false) return ws.terminate();
    ws._isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

// ─── Command Handler ────────────────────────────────────────────────
function handleCommand(ws, payload, connectionId) {
  if (payload.type !== 'command' || typeof payload.data !== 'string') {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid command format. Expected { type: "command", data: "..." }' }));
    return;
  }

  const command = payload.data.trim();
  if (command.length === 0 || command.length > 10000) {
    ws.send(JSON.stringify({ type: 'error', message: 'Command must be 1-10000 characters.' }));
    return;
  }

  console.log(`[CMD] ${connectionId}: ${command}`);

  // ────────────────────────────────────────────────────────────────
  // HERMES INTEGRATION POINT
  // Replace the simulation below with actual Hermes agent execution.
  //
  // Example real integration:
  //   const result = await hermesAgent.execute(command, {
  //     onStatus: (msg)  => sendFrame(ws, 'status', { message: msg }),
  //     onCode:   (file, content) => sendFrame(ws, 'code', { filename: file, data: content }),
  //     onText:   (msg)  => sendFrame(ws, 'text', { message: msg }),
  //     onError:  (msg)  => sendFrame(ws, 'error', { message: msg }),
  //   });
  //
  // For now, we simulate a realistic streaming response.
  // ────────────────────────────────────────────────────────────────

  simulateAgentResponse(ws, command);
}

function sendFrame(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

// ─── Simulation (Replace with real Hermes integration) ──────────────
function simulateAgentResponse(ws, command) {
  const steps = [
    { delay: 300,   frame: { type: 'status', message: 'Analyzing instruction...' } },
    { delay: 800,   frame: { type: 'status', message: 'Cloning repository...' } },
    { delay: 1500,  frame: { type: 'status', message: 'Scanning codebase structure...' } },
    { delay: 2200,  frame: { type: 'status', message: 'Executing tool: file_edit' } },
    {
      delay: 3000,
      frame: {
        type: 'code',
        filename: 'src/components/Navbar.js',
        data: `import React from 'react';\n\nexport const Navbar = () => {\n  return (\n    <nav className="bg-zinc-900 text-white p-4 shadow-lg">\n      <div className="max-w-7xl mx-auto flex items-center justify-between">\n        <h1 className="text-xl font-bold tracking-tight">Hermes Project</h1>\n        <div className="flex gap-4 text-sm">\n          <a href="/dashboard" className="hover:text-amber-400 transition">Dashboard</a>\n          <a href="/settings" className="hover:text-amber-400 transition">Settings</a>\n        </div>\n      </div>\n    </nav>\n  );\n};`,
      },
    },
    { delay: 3800, frame: { type: 'status', message: 'Running tests...' } },
    { delay: 4500, frame: { type: 'status', message: 'Tests passed.' } },
    {
      delay: 5000,
      frame: {
        type: 'text',
        message: `Task complete. I created a responsive Navbar component at \`src/components/Navbar.js\` with:\n- Dark zinc background with shadow\n- Responsive flex layout\n- Navigation links with hover transitions\n\nAll tests passing. Ready for next instruction.`,
      },
    },
  ];

  steps.forEach(({ delay, frame }) => {
    setTimeout(() => sendFrame(ws, frame.type, frame), delay);
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Closing connections...`);
  clearInterval(heartbeatInterval);

  wss.clients.forEach((ws) => {
    ws.send(JSON.stringify({ type: 'status', message: 'Server shutting down.' }));
    ws.close(1001, 'Server shutting down');
  });

  wss.close(() => {
    server.close(() => {
      console.log('[SHUTDOWN] Clean exit.');
      process.exit(0);
    });
  });

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Hermes Web UI Gateway`);
  console.log(`   Port:      ${PORT}`);
  console.log(`   Origin:    ${ALLOWED_ORIGIN}`);
  console.log(`   Status:    http://localhost:${PORT}/health`);
  console.log(`   WebSocket: ws://localhost:${PORT}\n`);
});
