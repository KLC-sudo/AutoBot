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
    if (cmd === history[history.length - 1]) return; // skip duplicate
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

    // Syntax highlighting (basic)
    _highlight(codeEl);

    // Switch to code view
    switchCodeView('code');
  }

  function _highlight(codeEl) {
    // Basic keyword highlighting for JS/JSX/TS/TSX
    let html = codeEl.textContent;

    // Escape first
    const div = document.createElement('div');
    div.textContent = html;
    html = div.innerHTML;

    // Keywords
    const keywords = ['import', 'export', 'from', 'const', 'let', 'var', 'function',
      'return', 'if', 'else', 'for', 'while', 'class', 'extends', 'new', 'this',
      'default', 'async', 'await', 'try', 'catch', 'throw', 'switch', 'case',
      'break', 'continue', 'typeof', 'instanceof', 'in', 'of', 'yield'];

    // Strings
    html = html.replace(/(&#39;[^&#]*?&#39;|&quot;[^&]*?&quot;|`[^`]*?`)/g,
      '<span style="color:#a5d6ff">$1</span>');

    // Comments
    html = html.replace(/(\/\/.*$)/gm, '<span style="color:#52525b;font-style:italic">$1</span>');
    html = html.replace(/(\/\*[\s\S]*?\*\/)/g, '<span style="color:#52525b;font-style:italic">$1</span>');

    // Keywords
    keywords.forEach(kw => {
      const re = new RegExp(`\\b(${kw})\\b`, 'g');
      html = html.replace(re, '<span style="color:#ff7b72">$1</span>');
    });

    // JSX tags
    html = html.replace(/(&lt;\/?)([\w.]+)/g, '$1<span style="color:#7ee787">$2</span>');

    codeEl.innerHTML = html;
  }

  function showDiff(filename, oldCode, newCode) {
    // Simple line-by-line diff
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

  // Add to history
  CommandHistory.push(text);

  // Render in terminal
  Terminal.addUser(text);

  // Send to agent
  WsClient.sendCommand(text);

  input.value = '';
  input.focus();
  return false;
}

/* ─── Keyboard Shortcuts ────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  const input = document.getElementById('cmd-input');

  // Only handle history keys when input is focused
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

  // Ctrl+L to clear terminal
  if (e.key === 'l' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearTerminal();
  }
});

/* ─── Init: Check for stored session ────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const storedToken = Auth.getToken();
  if (storedToken) {
    // Auto-reconnect with stored token
    setLoginLoading(true);
    WsClient.connect(storedToken);
  }
});
