/* ═══════════════════════════════════════════════════════════════════════
   sessions.js — Session persistence and management
   
   Stores conversation histories server-side so users can:
   - Resume sessions after disconnect
   - Switch between sessions
   - Export conversation logs
   ═══════════════════════════════════════════════════════════════════════ */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, 'data', 'sessions');
const ACTIVE_SESSION_FILE = path.join(SESSIONS_DIR, '.last_active.json');

// ─── Ensure sessions directory exists ─────────────────────────────
async function init() {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  // Ensure the active session tracker file exists
  try {
    await fsp.access(ACTIVE_SESSION_FILE);
  } catch {
    await fsp.writeFile(ACTIVE_SESSION_FILE, '{}', 'utf8');
  }
}

// ─── Track last active session ────────────────────────────────────
// Persists which session was last used so reconnections can resume.
async function setActiveSession(sessionId) {
  try {
    const data = { sessionId, updatedAt: Date.now() };
    await fsp.writeFile(ACTIVE_SESSION_FILE, JSON.stringify(data), 'utf8');
  } catch (err) {
    console.error('[Sessions] Failed to set active session:', err.message);
  }
}

async function getActiveSessionId() {
  try {
    const data = await fsp.readFile(ACTIVE_SESSION_FILE, 'utf8');
    const parsed = JSON.parse(data);
    return parsed.sessionId || null;
  } catch {
    return null;
  }
}

// ─── Get most recently updated session from disk ──────────────────
async function getMostRecentSession() {
  try {
    const files = await fsp.readdir(SESSIONS_DIR);
    let newest = null;
    let newestTime = 0;

    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      try {
        const data = await fsp.readFile(path.join(SESSIONS_DIR, file), 'utf8');
        const session = JSON.parse(data);
        if (session.updatedAt > newestTime) {
          newestTime = session.updatedAt;
          newest = session;
        }
      } catch { /* skip corrupted */ }
    }
    return newest;
  } catch {
    return null;
  }
}

// ─── Model context lengths (tokens) ──────────────────────────────
const MODEL_CONTEXT_LENGTHS = {
  'openai/gpt-4o': 128000,
  'openai/gpt-4o-mini': 128000,
  'openai/gpt-4-turbo': 128000,
  'openai/gpt-4': 8192,
  'openai/gpt-3.5-turbo': 16385,
  'anthropic/claude-3.5-sonnet': 200000,
  'anthropic/claude-3.5-haiku': 200000,
  'anthropic/claude-3-opus': 200000,
  'google/gemini-pro-1.5': 2000000,
  'google/gemini-pro': 32760,
  'meta-llama/llama-3-70b-instruct': 8192,
  'meta-llama/llama-3-8b-instruct': 8192,
  'mistralai/mixtral-8x7b-instruct': 32768,
  'deepseek/deepseek-chat': 65536,
  'deepseek/deepseek-r1': 65536,
  'xiaomi/mimo-v2.5': 1100000,
  'xiaomi/mimo-v2': 1100000,
  'MiMo-V2.5': 1100000,
  'Xiaomi V2.5': 1100000,
};

function getContextLength(model) {
  // Direct match
  if (MODEL_CONTEXT_LENGTHS[model]) return MODEL_CONTEXT_LENGTHS[model];
  // Case-insensitive partial match
  const lower = (model || '').toLowerCase();
  for (const [key, val] of Object.entries(MODEL_CONTEXT_LENGTHS)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) return val;
  }
  // Check for common patterns
  if (lower.includes('claude') && lower.includes('3')) return 200000;
  if (lower.includes('gemini') && lower.includes('1.5')) return 2000000;
  if (lower.includes('mimo')) return 1100000;
  return 128000; // safe default
}

// ─── Session structure ───────────────────────────────────────────
function createSession(name, model) {
  const id = crypto.randomUUID();
  const session = {
    id,
    name: name || `Session ${new Date().toLocaleString()}`,
    model: model || 'openai/gpt-4o',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    tokenUsage: {
      prompt: 0,
      completion: 0,
      total: 0,
    },
  };
  return session;
}

async function saveSession(session) {
  session.updatedAt = Date.now();
  const filePath = path.join(SESSIONS_DIR, `${session.id}.json`);
  await fsp.writeFile(filePath, JSON.stringify(session, null, 2), 'utf8');
  // Track this as the most recently active session
  await setActiveSession(session.id);
  return session;
}

async function loadSession(id) {
  const filePath = path.join(SESSIONS_DIR, `${id}.json`);
  try {
    const data = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function deleteSession(id) {
  const filePath = path.join(SESSIONS_DIR, `${id}.json`);
  try {
    await fsp.unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listSessions() {
  await init();
  const files = await fsp.readdir(SESSIONS_DIR);
  const sessions = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await fsp.readFile(path.join(SESSIONS_DIR, file), 'utf8');
      const session = JSON.parse(data);

      // Auto-delete empty sessions (0 messages, older than 5 minutes)
      if (session.messages.length === 0 && Date.now() - session.createdAt > 5 * 60 * 1000) {
        console.log(`[Sessions] Cleaning up empty session: ${session.id}`);
        await fsp.unlink(path.join(SESSIONS_DIR, file)).catch(() => {});
        continue;
      }

      sessions.push({
        id: session.id,
        name: session.name,
        model: session.model,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        tokenUsage: session.tokenUsage,
      });
    } catch { /* skip corrupted files */ }
  }

  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ─── Cleanup all empty sessions (called on startup) ────────────────
async function cleanupEmptySessions() {
  await init();
  const files = await fsp.readdir(SESSIONS_DIR);
  let cleaned = 0;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = await fsp.readFile(path.join(SESSIONS_DIR, file), 'utf8');
      const session = JSON.parse(data);
      if (session.messages.length === 0) {
        await fsp.unlink(path.join(SESSIONS_DIR, file)).catch(() => {});
        cleaned++;
      }
    } catch { /* skip corrupted */ }
  }

  if (cleaned > 0) {
    console.log(`[Sessions] Cleaned up ${cleaned} empty sessions`);
  }
  return cleaned;
}

// ─── Token estimation (rough: 1 token ≈ 4 chars) ────────────────
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function getSessionStats(session) {
  const contextLength = getContextLength(session.model);
  const messagesTokens = session.messages.reduce((sum, msg) => {
    return sum + estimateTokens(msg.content || '') + estimateTokens(msg.role);
  }, 0);

  return {
    sessionId: session.id,
    model: session.model,
    contextLength,
    messagesTokenEstimate: messagesTokens,
    totalTokensUsed: session.tokenUsage.total,
    promptTokens: session.tokenUsage.prompt,
    completionTokens: session.tokenUsage.completion,
    contextPercentUsed: Math.round((messagesTokens / contextLength) * 100),
    contextRemaining: contextLength - messagesTokens,
    messageCount: session.messages.length,
  };
}

module.exports = {
  init,
  createSession,
  saveSession,
  loadSession,
  deleteSession,
  listSessions,
  cleanupEmptySessions,
  getSessionStats,
  getContextLength,
  estimateTokens,
  setActiveSession,
  getActiveSessionId,
  getMostRecentSession,
  MODEL_CONTEXT_LENGTHS,
};
