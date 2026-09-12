/* ═══════════════════════════════════════════════════════════════════════
   app.js — Main application controller
   Handles command dispatch, history, code viewer, and keyboard shortcuts.
   ═══════════════════════════════════════════════════════════════════════ */

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

  function up() {
    if (index > 0) index--;
    return history[index] || '';
  }

  function down() {
    if (index < history.length) index++;
    return history[index] || '';
  }

  function current() { return history[index] || ''; }
  function reset() { index = history.length; }

  return { push, up, down, current, reset };
})();

/* ─── Code Viewer ───────────────────────────────────────────────── */
const CodeViewer = (() => {
  let currentFile = null;
  let currentData = null;

  function showFile(filename, data) {
    currentFile = filename;
    currentData = data;

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
      const re = new RegExp(`\\b(${kw})\\b`, 'g');
      html = html.replace(re, '<span style="color:#ff7b72">$1</span>');
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
      const old = oldLines[i];
      const nw = newLines[i];

      if (old === undefined) {
        diffLines.push(`<span style="color:#22c55e">+ ${_esc(nw)}</span>`);
      } else if (nw === undefined) {
        diffLines.push(`<span style="color:#ef4444">- ${_esc(old)}</span>`);
      } else if (old !== nw) {
        diffLines.push(`<span style="color:#ef4444">- ${_esc(old)}</span>`);
        diffLines.push(`<span style="color:#22c55e">+ ${_esc(nw)}</span>`);
      } else {
        diffLines.push(`<span style="color:#52525b">  ${_esc(old)}</span>`);
      }
    }

    document.getElementById('diff-content').innerHTML = diffLines.join('\n');
    document.getElementById('code-filename').textContent = `Diff: ${filename}`;
  }

  function _esc(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function getFile() { return currentFile; }
  function getData() { return currentData; }

  return { showFile, showDiff, getFile, getData };
})();

function switchCodeView(view) {
  const codeCanvas = document.getElementById('code-canvas');
  const diffCanvas = document.getElementById('diff-canvas');
  const tabs = document.querySelectorAll('.btn-tab');

  tabs.forEach(t => t.classList.toggle('active', t.dataset.view === view));

  if (view === 'code') {
    codeCanvas.classList.remove('hidden');
    diffCanvas.classList.add('hidden');
  } else {
    codeCanvas.classList.add('hidden');
    diffCanvas.classList.remove('hidden');
  }
}

/* ─── Command Dispatch ──────────────────────────────────────────── */
function dispatchCommand(event) {
  event.preventDefault();

  const input = document.getElementById('cmd-input');
  const text = input.value.trim();

  if (!text) return false;
  if (!WsClient.isConnected()) {
    Terminal.addError('Not connected. Please re-authenticate.');
    return false;
  }

  CommandHistory.push(text);
  Terminal.addUser(text);
  WsClient.sendCommand(text);

  input.value = '';
  input.focus();
  return false;
}

/* ─── Keyboard Shortcuts ────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const input = document.getElementById('cmd-input');

  if (document.activeElement === input) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      input.value = CommandHistory.up();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      input.value = CommandHistory.down();
    } else if (e.key === 'Escape') {
      input.value = '';
      CommandHistory.reset();
    }
  }

  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearTerminal();
  }
});

/* ─── Event Listeners (CSP-safe: no inline handlers) ────────────── */
document.addEventListener('DOMContentLoaded', () => {

  // Login form submit
  document.getElementById('login-form').addEventListener('submit', handleLogin);

  // Command form submit
  document.getElementById('cmd-form').addEventListener('submit', dispatchCommand);

  // Clear terminal button
  document.getElementById('clear-btn').addEventListener('click', clearTerminal);

  // Code/Diff tab buttons
  document.querySelectorAll('.btn-tab').forEach(btn => {
    btn.addEventListener('click', () => switchCodeView(btn.dataset.view));
  });

  // Auto-reconnect with stored token
  const storedToken = Auth.getToken();
  if (storedToken) {
    setLoginLoading(true);
    WsClient.connect(storedToken);
  }
});
