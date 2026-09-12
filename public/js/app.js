/* ═══════════════════════════════════════════════════════════════════════
   app.js — Main application controller
   Session management, model switching, token tracking, command history.
   ═══════════════════════════════════════════════════════════════════════ */

/* ─── State ─────────────────────────────────────────────────────── */
let currentSessionId = null;
let availableModels = [];

/* ─── Command History ───────────────────────────────────────────── */
const CommandHistory = (() => {
  const MAX_HISTORY = 100;
  let history = [];
  let index = -1;

  function push(cmd) {
    if (cmd === history[history.length - 1]) return;
    history.push(cmd);
    if (history.length > MAX_HISTORY) history.shift();
    index = history.length;
  }
  function up() { if (index > 0) index--; return history[index] || ''; }
  function down() { if (index < history.length) index++; return history[index] || ''; }
  function reset() { index = history.length; }
  return { push, up, down, reset };
})();

/* ─── Code Viewer ───────────────────────────────────────────────── */
const CodeViewer = (() => {
  let currentFile = null;

  function showFile(filename, data) {
    currentFile = filename;
    document.getElementById('code-filename').textContent = filename;
    const codeEl = document.getElementById('code-content');
    codeEl.textContent = data;
    _highlight(codeEl);
    switchCodeView('code');
  }

  function _highlight(codeEl) {
    let html = codeEl.textContent;
    const div = document.createElement('div');
    div.textContent = html;
    html = div.innerHTML;

    const keywords = ['import', 'export', 'from', 'const', 'let', 'var', 'function',
      'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this',
      'default', 'async', 'await', 'try', 'catch', 'throw', 'switch', 'case',
      'break', 'continue', 'typeof', 'instanceof', 'in', 'of', 'yield'];

    html = html.replace(/(&#39;[^&#]*?&#39;|&quot;[^&]*?&quot;|`[^`]*?`)/g,
      '<span style="color:#a5d6ff">$1</span>');
    html = html.replace(/(\/\/.*$)/gm, '<span style="color:#52525b;font-style:italic">$1</span>');
    html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:#52525b;font-style:italic">$1</span>');

    keywords.forEach(kw => {
      html = html.replace(new RegExp(`\\b(${kw})\\b`, 'g'), '<span style="color:#ff7b72">$1</span>');
    });
    html = html.replace(/(&lt;\/?)([\w.]+)/g, '$1<span style="color:#7ee787">$2</span>');

    codeEl.innerHTML = html;
  }

  function showDiff(filename, oldCode, newCode) {
    const oldLines = (oldCode || '').split('\n');
    const newLines = (newCode || '').split('\n');
    const diffLines = [];
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      const old = oldLines[i], nw = newLines[i];
      if (old === undefined) diffLines.push(`<span style="color:#22c55e">+ ${_esc(nw)}</span>`);
      else if (nw === undefined) diffLines.push(`<span style="color:#ef4444">- ${_esc(old)}</span>`);
      else if (old !== nw) {
        diffLines.push(`<span style="color:#ef4444">- ${_esc(old)}</span>`);
        diffLines.push(`<span style="color:#22c55e">+ ${_esc(nw)}</span>`);
      } else diffLines.push(`<span style="color:#52525b">  ${_esc(old)}</span>`);
    }
    document.getElementById('diff-content').innerHTML = diffLines.join('\n');
    document.getElementById('code-filename').textContent = `Diff: ${filename}`;
  }

  function _esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

  return { showFile, showDiff };
})();

function switchCodeView(view) {
  document.querySelectorAll('.btn-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('code-canvas').classList.toggle('hidden', view !== 'code');
  document.getElementById('diff-canvas').classList.toggle('hidden', view !== 'diff');
}

/* ─── Command Dispatch ──────────────────────────────────────────── */
function dispatchCommand(event) {
  event.preventDefault();
  const input = document.getElementById('cmd-input');
  const text = input.value.trim();
  if (!text) return false;
  if (!WsClient.isConnected()) {
    Terminal.addError('Not connected.');
    return false;
  }
  CommandHistory.push(text);
  Terminal.addUser(text);
  WsClient.sendCommand(text);
  input.value = '';
  input.focus();
  return false;
}

/* ─── Session Management ────────────────────────────────────────── */
function renderSessionList(sessions) {
  const list = document.getElementById('session-list');
  list.innerHTML = '';

  if (!sessions.length) {
    list.innerHTML = '<div class="text-muted text-xs" style="padding:12px;text-align:center">No sessions yet</div>';
    return;
  }

  sessions.forEach(s => {
    const el = document.createElement('div');
    el.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;

    const date = new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tokens = s.tokenUsage?.total ? `${s.tokenUsage.total.toLocaleString()} tok` : '0 tok';

    el.innerHTML = `
      <button class="session-item-delete" data-id="${s.id}" title="Delete">×</button>
      <div class="session-item-name">${_esc(s.name || 'Untitled')}</div>
      <div class="session-item-meta">
        <span>${s.model?.split('/').pop() || '?'}</span>
        <span>${tokens}</span>
        <span>${date}</span>
      </div>
    `;

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('session-item-delete')) return;
      WsClient.send('session_load', { id: s.id });
      if (isMobile()) closeSidebar();
    });

    el.querySelector('.session-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Delete this session?')) {
        WsClient.send('session_delete', { id: s.id });
      }
    });

    list.appendChild(el);
  });
}

function _esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

/* ─── Token Usage Display ───────────────────────────────────────── */
function updateTokenDisplay(data) {
  const fill = document.getElementById('token-fill');
  const label = document.getElementById('token-label');

  const percent = data.contextPercent || 0;
  fill.style.width = `${Math.min(percent, 100)}%`;

  fill.className = 'token-fill';
  if (percent > 80) fill.classList.add('danger');
  else if (percent > 50) fill.classList.add('warning');

  const used = (data.contextUsed || 0).toLocaleString();
  const total = (data.contextLength || 0).toLocaleString();
  label.textContent = `${used}/${total} tok`;
  label.title = `Prompt: ${data.prompt?.toLocaleString() || 0} · Completion: ${data.completion?.toLocaleString() || 0} · Total: ${data.total?.toLocaleString() || 0}`;
}

function updateSessionDisplay(data) {
  currentSessionId = data.sessionId;
  document.getElementById('session-title').textContent = data.model || 'Session';

  // Update token display from session stats
  if (data.contextLength) {
    const fill = document.getElementById('token-fill');
    const label = document.getElementById('token-label');
    const percent = data.contextPercentUsed || 0;
    fill.style.width = `${Math.min(percent, 100)}%`;
    fill.className = 'token-fill';
    if (percent > 80) fill.classList.add('danger');
    else if (percent > 50) fill.classList.add('warning');
    label.textContent = `${data.totalTokensUsed?.toLocaleString() || 0} total`;
  }

  // Update model selector
  const sel = document.getElementById('model-select');
  if (data.model) sel.value = data.model;

  // Refresh session list
  WsClient.send('session_list', {});
}

/* ─── Model Selector ────────────────────────────────────────────── */
function populateModels(models) {
  availableModels = models;
  const sel = document.getElementById('model-select');
  sel.innerHTML = '';
  models.forEach(m => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m;
    sel.appendChild(opt);
  });
}

/* ─── Sidebar Toggle ────────────────────────────────────────────── */
function openSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.remove('collapsed');
  backdrop.classList.add('visible');
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar.classList.add('collapsed');
  backdrop.classList.remove('visible');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar.classList.contains('collapsed')) {
    openSidebar();
  } else {
    closeSidebar();
  }
}

function isMobile() {
  return window.innerWidth <= 768;
}

/* ─── Keyboard Shortcuts ────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const input = document.getElementById('cmd-input');
  if (document.activeElement === input) {
    if (e.key === 'ArrowUp') { e.preventDefault(); input.value = CommandHistory.up(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); input.value = CommandHistory.down(); }
    else if (e.key === 'Escape') { input.value = ''; CommandHistory.reset(); }
  }
  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); clearTerminal(); }
});

/* ─── Init ──────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Wire up UI elements
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('cmd-form').addEventListener('submit', dispatchCommand);
  document.getElementById('clear-btn').addEventListener('click', clearTerminal);
  document.querySelectorAll('.btn-tab').forEach(btn => {
    btn.addEventListener('click', () => switchCodeView(btn.dataset.view));
  });

  // Sidebar
  document.getElementById('show-sidebar-btn').addEventListener('click', openSidebar);
  document.getElementById('sidebar-close-btn').addEventListener('click', closeSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);
  document.getElementById('new-session-btn').addEventListener('click', () => {
    const model = document.getElementById('model-select').value || 'openai/gpt-4o';
    WsClient.send('session_create', { model });
    if (isMobile()) closeSidebar();
  });
  document.getElementById('new-session-btn-footer').addEventListener('click', () => {
    const model = document.getElementById('model-select').value || 'openai/gpt-4o';
    WsClient.send('session_create', { model });
    if (isMobile()) closeSidebar();
  });

  // Model selector
  document.getElementById('model-select').addEventListener('change', (e) => {
    if (e.target.value) {
      WsClient.send('model_switch', { model: e.target.value });
    }
  });

  // WebSocket event handlers
  WsClient.on('tokenUpdate', updateTokenDisplay);
  WsClient.on('sessionUpdate', updateSessionDisplay);
  WsClient.on('sessionList', (pkt) => renderSessionList(pkt.sessions || []));
  WsClient.on('modelsList', (pkt) => populateModels(pkt.models || []));
  WsClient.on('disconnected', () => { currentSessionId = null; });

  // Set initial sidebar state
  if (isMobile()) {
    document.getElementById('sidebar').classList.add('collapsed');
  }

  // Handle resize: close sidebar if switching to mobile
  window.addEventListener('resize', () => {
    if (isMobile()) {
      document.getElementById('sidebar').classList.add('collapsed');
      document.getElementById('sidebar-backdrop').classList.remove('visible');
    }
  });

  // Auto-reconnect
  const storedToken = Auth.getToken();
  if (storedToken) {
    setLoginLoading(true);
    WsClient.connect(storedToken);
  }
});
