/* ═══════════════════════════════════════════════════════════════════════
   app.js — Main application controller
   Session management, model switching, token tracking, command history.
   ═══════════════════════════════════════════════════════════════════════ */

/* ─── State ─────────────────────────────────────────────────────── */
let currentSessionId = null;
let availableModels = [];
let mobileCodePanelVisible = false;

/* ─── Mobile Viewport Fix ──────────────────────────────────────── */
// Android Go Edition (and older Android Chrome) doesn't support 100dvh.
// window.innerHeight gives the real viewport height excluding browser chrome.
function fixMobileViewport() {
  if (!('ontouchstart' in window) && window.innerWidth > 768) return;
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
  document.documentElement.style.setProperty('--app-height', `${window.innerHeight}px`);
}

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

    // On mobile, auto-show the code panel when new code arrives
    if (isMobile() && !mobileCodePanelVisible) {
      showMobileCodePanel();
    }
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

function showToast(message, type = '') {
  const existing = document.querySelector('.status-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = `status-toast ${type ? 'toast-' + type : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2200);
}

  return { showFile, showDiff };
})();

function switchCodeView(view) {
  document.querySelectorAll('.btn-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.getElementById('code-canvas').classList.toggle('hidden', view !== 'code');
  document.getElementById('diff-canvas').classList.toggle('hidden', view !== 'diff');
}

/* ─── Mobile Code Panel Toggle ──────────────────────────────────── */
function showMobileCodePanel() {
  if (!isMobile()) return;
  const panel = document.getElementById('panel-code');
  panel.classList.remove('mobile-hidden');
  mobileCodePanelVisible = true;
}

function hideMobileCodePanel() {
  if (!isMobile()) return;
  const panel = document.getElementById('panel-code');
  panel.classList.add('mobile-hidden');
  mobileCodePanelVisible = false;
}

function toggleMobileCodePanel() {
  if (mobileCodePanelVisible) {
    hideMobileCodePanel();
  } else {
    showMobileCodePanel();
  }
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

  sessions.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = `session-item${s.id === currentSessionId ? ' active' : ''}`;
    el.style.animationDelay = `${i * 30}ms`;

    const date = new Date(s.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const tokens = s.tokenUsage?.total ? `${s.tokenUsage.total.toLocaleString()} tok` : '0 tok';

    el.innerHTML = `
      <div class="session-item-actions">
        <button class="session-item-edit" data-id="${s.id}" title="Rename">✎</button>
        <button class="session-item-delete" data-id="${s.id}" title="Delete">×</button>
      </div>
      <div class="session-item-name">${_esc(s.name || 'Untitled')}</div>
      <div class="session-item-meta">
        <span>${s.model?.split('/').pop() || '?'}</span>
        <span>${tokens}</span>
        <span>${date}</span>
      </div>
    `;

    // Click to load session
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-item-edit') || e.target.closest('.session-item-delete')) return;
      WsClient.send('session_load', { id: s.id });
      currentSessionId = s.id;
      document.querySelectorAll('.session-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      if (isMobile()) setTimeout(() => closeSidebar(), 150);
    });

    // Edit button → rename
    el.querySelector('.session-item-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      startRename(el, s);
    });

    // Delete button
    el.querySelector('.session-item-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${s.name || 'Untitled'}"?`)) return;
      el.classList.add('session-item-deleting');
      el.addEventListener('animationend', () => {
        WsClient.send('session_delete', { id: s.id });
      }, { once: true });
    });

    list.appendChild(el);
  });
}

function startRename(el, s) {
  const nameEl = el.querySelector('.session-item-name');
  const currentName = s.name || '';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.className = 'session-rename-input';
  input.style.cssText = 'width:100%;background:var(--bg-input);border:1px solid var(--accent);color:var(--text-primary);padding:2px 4px;border-radius:3px;font-size:12px;font-family:var(--font-sans);outline:none;';
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let saved = false;
  const save = () => {
    if (saved) return;
    saved = true;
    const newName = input.value.trim() || currentName;
    if (newName !== currentName) {
      WsClient.send('session_rename', { id: s.id, name: newName });
      s.name = newName;
      el.classList.add('session-item-renaming');
      el.addEventListener('animationend', () => el.classList.remove('session-item-renaming'), { once: true });
    }
    const newNameEl = document.createElement('div');
    newNameEl.className = 'session-item-name';
    newNameEl.textContent = newName || 'Untitled';
    input.replaceWith(newNameEl);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') { saved = true; const n = document.createElement('div'); n.className = 'session-item-name'; n.textContent = currentName || 'Untitled'; input.replaceWith(n); }
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
  const prevSessionId = currentSessionId;
  currentSessionId = data.sessionId;

  // Persist session ID for resume after reconnect/restart
  Auth.setSessionId(data.sessionId);

  // Clear terminal when switching to a different session
  if (prevSessionId && prevSessionId !== data.sessionId) {
    Terminal.clear();
  }

  document.getElementById('session-title').textContent = data.name || data.model || 'Session';

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
  const hamburger = document.getElementById('show-sidebar-btn');
  sidebar.classList.remove('collapsed');
  backdrop.classList.add('visible');
  hamburger.style.display = 'none';
}

function closeSidebar() {
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const hamburger = document.getElementById('show-sidebar-btn');
  sidebar.classList.add('collapsed');
  backdrop.classList.remove('visible');
  hamburger.style.display = 'flex';
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
  // Fix mobile viewport height (critical for Android Go Edition)
  fixMobileViewport();
  window.addEventListener('resize', fixMobileViewport);
  window.addEventListener('orientationchange', () => {
    setTimeout(fixMobileViewport, 100);
  });

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
    const name = prompt('Session name (optional):') || undefined;
    WsClient.send('session_create', { model, name });
    if (isMobile()) closeSidebar();
  });

  // Mobile code panel toggle
  document.getElementById('mobile-code-toggle').addEventListener('click', toggleMobileCodePanel);
  document.getElementById('code-close-btn').addEventListener('click', hideMobileCodePanel);

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

  // Debug panel — click debug button or triple-tap status indicator
  document.getElementById('debug-btn').addEventListener('click', () => {
    if (typeof Debug !== 'undefined') Debug.toggle();
  });
  const statusDots = document.getElementById('conn-indicator');
  if (statusDots) {
    let _tapCount = 0;
    let _tapTimer = null;
    statusDots.addEventListener('click', () => {
      _tapCount++;
      clearTimeout(_tapTimer);
      _tapTimer = setTimeout(() => _tapCount = 0, 500);
      if (_tapCount >= 3) { _tapCount = 0; if (typeof Debug !== 'undefined') Debug.toggle(); }
    });
  }
  const sidebar = document.getElementById('sidebar');
  const hamburger = document.getElementById('show-sidebar-btn');
  if (isMobile()) {
    sidebar.classList.add('collapsed');
    hamburger.style.display = 'flex';
    // Hide code panel by default on mobile
    document.getElementById('panel-code').classList.add('mobile-hidden');
  } else {
    sidebar.classList.remove('collapsed');
    hamburger.style.display = 'none';
  }

  // Auto-reconnect
  const storedToken = Auth.getToken();
  if (storedToken) {
    setLoginLoading(true);
    WsClient.connect(storedToken);
  }
});