/* ═══════════════════════════════════════════════════════════════════════
   debug.js — In-app debug panel with console capture + copy-to-clipboard
   ═══════════════════════════════════════════════════════════════════════ */

const Debug = (() => {
  let _panel = null;
  let _logEntries = [];
  let _visible = false;
  let _pollTimer = null;
  const MAX_CLIENT_LOGS = 200;

  // ─── Console capture ──────────────────────────────────────────────
  const _origLog = console.log;
  const _origError = console.error;
  const _origWarn = console.warn;

  function _capture(level, args) {
    const msg = args.map(a => (typeof a === 'object') ? JSON.stringify(a, null, 2) : String(a)).join(' ');
    _logEntries.push({ t: Date.now(), level, msg, src: 'client' });
    if (_logEntries.length > MAX_CLIENT_LOGS) _logEntries.shift();
    if (_visible) _renderLogEntry(level, msg);
  }

  console.log = (...args) => { _origLog(...args); _capture('info', args); };
  console.error = (...args) => { _origError(...args); _capture('error', args); };
  console.warn = (...args) => { _origWarn(...args); _capture('warn', args); };

  window.onerror = (msg, src, line, col, err) => {
    _capture('error', [`[${src}:${line}:${col}] ${msg}`, err?.stack || '']);
  };
  window.onunhandledrejection = (e) => {
    _capture('error', [`Unhandled: ${e.reason?.message || e.reason}`]);
  };

  // ─── Panel creation ───────────────────────────────────────────────
  function _ensurePanel() {
    if (_panel) return;
    _panel = document.createElement('div');
    _panel.id = 'debug-panel';
    _panel.innerHTML = `
      <div class="debug-header">
        <span class="debug-title">Debug Console</span>
        <div class="debug-header-actions">
          <button class="debug-btn" id="debug-copy" title="Copy all logs">Copy</button>
          <button class="debug-btn" id="debug-clear" title="Clear logs">Clear</button>
          <button class="debug-btn" id="debug-diag" title="Show diagnostics">Diag</button>
          <button class="debug-btn debug-close" id="debug-close">✕</button>
        </div>
      </div>
      <div class="debug-filters">
        <button class="debug-filter active" data-level="all">All</button>
        <button class="debug-filter" data-level="error">Errors</button>
        <button class="debug-filter" data-level="warn">Warnings</button>
        <button class="debug-filter" data-level="info">Info</button>
      </div>
      <div class="debug-diag hidden" id="debug-diag-box"></div>
      <div class="debug-log" id="debug-log"></div>
    `;
    document.body.appendChild(_panel);

    document.getElementById('debug-close').onclick = toggle;
    document.getElementById('debug-clear').onclick = () => {
      _logEntries = [];
      document.getElementById('debug-log').innerHTML = '';
    };
    document.getElementById('debug-copy').onclick = _copyLogs;
    document.getElementById('debug-diag').onclick = _toggleDiag;

    _panel.querySelectorAll('.debug-filter').forEach(btn => {
      btn.onclick = () => {
        _panel.querySelectorAll('.debug-filter').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _filterLogs(btn.dataset.level);
      };
    });
  }

  // ─── Render existing logs into panel ──────────────────────────────
  function _renderAllLogs(filter) {
    const logEl = document.getElementById('debug-log');
    if (!logEl) return;
    logEl.innerHTML = '';
    _logEntries.forEach(e => {
      if (filter !== 'all' && e.level !== filter) return;
      _renderLogEntry(e.level, e.msg, e.src, e.t, logEl);
    });
  }

  function _renderLogEntry(level, msg, src, t, container) {
    const logEl = container || document.getElementById('debug-log');
    if (!logEl) return;
    const el = document.createElement('div');
    el.className = `debug-entry debug-${level}`;
    const time = new Date(t || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const srcTag = src ? `<span class="debug-src">[${src}]</span> ` : '';
    el.innerHTML = `<span class="debug-time">${time}</span> ${srcTag}${_escHtml(msg)}`;
    logEl.appendChild(el);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function _filterLogs(level) {
    _renderAllLogs(level);
  }

  // ─── Copy to clipboard ────────────────────────────────────────────
  function _copyLogs() {
    const lines = _logEntries.map(e => {
      const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `[${time}] [${e.level.toUpperCase()}] [${e.src || 'server'}] ${e.msg}`;
    });
    const diagBox = document.getElementById('debug-diag-box');
    const diagText = diagBox && !diagBox.classList.contains('hidden') ? '\n\n--- DIAGNOSTICS ---\n' + diagBox.textContent : '';
    const text = `=== Hermes Debug Log — ${new Date().toLocaleString()} ===\n` +
                 `Entries: ${lines.length}\n\n` +
                 lines.join('\n') + diagText;

    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('debug-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    }).catch(() => {
      // Fallback: textarea
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      const btn = document.getElementById('debug-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  }

  // ─── Diagnostics ──────────────────────────────────────────────────
  async function _toggleDiag() {
    const box = document.getElementById('debug-diag-box');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      box.textContent = 'Loading...';
      try {
        const cid = typeof WsClient !== 'undefined' ? WsClient.getConnectionId() : null;
        if (!cid) { box.textContent = 'No active connection'; return; }
        const res = await fetch(`/api/diag?cid=${cid}`);
        const data = await res.json();
        box.innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
      } catch (err) {
        box.textContent = `Error: ${err.message}`;
      }
    }
  }

  // ─── Fetch server logs ────────────────────────────────────────────
  let _lastServerLogTime = 0;
  async function _fetchServerLogs() {
    const cid = typeof WsClient !== 'undefined' ? WsClient.getConnectionId() : null;
    if (!cid) return;
    try {
      const res = await fetch(`/api/logs?cid=${cid}&since=${_lastServerLogTime}`);
      const data = await res.json();
      if (data.logs && data.logs.length) {
        data.logs.forEach(e => {
          _logEntries.push({ t: e.t, level: e.level, msg: e.msg, src: 'server' });
          if (_logEntries.length > MAX_CLIENT_LOGS) _logEntries.shift();
          if (_visible) _renderLogEntry(e.level, e.msg, 'server', e.t);
        });
        _lastServerLogTime = data.logs[data.logs.length - 1].t;
      }
    } catch {}
  }

  function _startServerPoll() {
    if (_pollTimer) return;
    _pollTimer = setInterval(_fetchServerLogs, 3000);
  }

  // ─── Toggle panel ─────────────────────────────────────────────────
  function toggle() {
    _ensurePanel();
    _visible = !_visible;
    _panel.classList.toggle('hidden', !_visible);
    if (_visible) {
      _renderAllLogs('all');
      _startServerPoll();
      _fetchServerLogs();
    }
  }

  function _escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Expose connection ID for diag endpoint
  function _getConnectionId() {
    return typeof WsClient !== 'undefined' ? WsClient._connectionId : null;
  }

  return { toggle };
})();


