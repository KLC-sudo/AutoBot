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

const SESSIONS_DIR = path.join(__dirname, 'sessions');

// ─── Ensure sessions directory exists ─────────────────────────────
async function init() {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
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
};

function getContextLength(model) {
  return MODEL_CONTEXT_LENGTHS[model] || 128000; // default fallback
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
  getSessionStats,
  getContextLength,
  estimateTokens,
  MODEL_CONTEXT_LENGTHS,
};
