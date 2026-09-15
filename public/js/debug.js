/* ═══════════════════════════════════════════════════════════════════════
   debug.js — In-app debug panel: local logs + Railway logs + diagnostics
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
          <button class="debug-btn" id="debug-diag" title="Diagnostics">Diag</button>
          <button class="debug-btn debug-close" id="debug-close">✕</button>
        </div>
      </div>
      <div class="debug-tabs">
        <button class="debug-tab active" data-tab="local">Local Logs</button>
        <button class="debug-tab" data-tab="railway">Railway</button>
      </div>
      <div class="debug-tab-content" id="debug-tab-local">
        <div class="debug-filters">
          <button class="debug-filter active" data-level="all">All</button>
          <button class="debug-filter" data-level="error">Errors</button>
          <button class="debug-filter" data-level="warn">Warnings</button>
          <button class="debug-filter" data-level="info">Info</button>
        </div>
        <div class="debug-diag hidden" id="debug-diag-box"></div>
        <div class="debug-log" id="debug-log"></div>
      </div>
      <div class="debug-tab-content hidden" id="debug-tab-railway">
        <div class="railway-controls">
          <select id="rw-project" class="railway-select"><option value="">Loading projects...</option></select>
          <select id="rw-service" class="railway-select" disabled><option value="">Select project first</option></select>
          <button class="debug-btn" id="rw-fetch">Fetch Logs</button>
          <select id="rw-lines" class="railway-select rw-lines">
            <option value="100">100 lines</option>
            <option value="200" selected>200 lines</option>
            <option value="500">500 lines</option>
          </select>
        </div>
        <div class="railway-status" id="rw-status"></div>
        <div class="debug-log" id="rw-log"></div>
      </div>
    `;
    document.body.appendChild(_panel);

    // Tab switching
    _panel.querySelectorAll('.debug-tab').forEach(tab => {
      tab.onclick = () => {
        _panel.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        _panel.querySelector('.debug-tab-content:not(.hidden)')?.classList.add('hidden');
        document.getElementById(`debug-tab-${tab.dataset.tab}`).classList.remove('hidden');
      };
    });

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

    // Railway controls
    document.getElementById('rw-project').onchange = _loadServices;
    document.getElementById('rw-fetch').onclick = _fetchRailwayLogs;
    _loadProjects();
  }

  // ─── Local log rendering ──────────────────────────────────────────
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

  function _filterLogs(level) { _renderAllLogs(level); }

  // ─── Copy to clipboard ────────────────────────────────────────────
  function _copyLogs() {
    const lines = _logEntries.map(e => {
      const time = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return `[${time}] [${e.level.toUpperCase()}] [${e.src || 'server'}] ${e.msg}`;
    });

    // Also include Railway logs if visible
    const rwLogEl = document.getElementById('rw-log');
    let rwLines = [];
    if (rwLogEl && rwLogEl.children.length) {
      rwLines = ['\n--- RAILWAY LOGS ---', ...Array.from(rwLogEl.children).map(e => e.textContent)];
    }

    const diagBox = document.getElementById('debug-diag-box');
    const diagText = diagBox && !diagBox.classList.contains('hidden') ? '\n\n--- DIAGNOSTICS ---\n' + diagBox.textContent : '';

    const text = `=== Hermes Debug Log — ${new Date().toLocaleString()} ===\n` +
                 `Entries: ${lines.length}${rwLines.length ? ` + ${rwLines.length} Railway` : ''}\n\n` +
                 lines.join('\n') + rwLines.join('\n') + diagText;

    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('debug-copy');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    }).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      document.getElementById('debug-copy').textContent = 'Copied!';
      setTimeout(() => document.getElementById('debug-copy').textContent = 'Copy', 1500);
    });
  }

  // ─── Diagnostics ──────────────────────────────────────────────────
  async function _toggleDiag() {
    const box = document.getElementById('debug-diag-box');
    box.classList.toggle('hidden');
    if (!box.classList.contains('hidden')) {
      box.textContent = 'Loading...';
      try {
        const cid = WsClient.getConnectionId();
        if (!cid) { box.textContent = 'No active connection'; return; }
        const res = await fetch(`/api/diag?cid=${cid}`);
        const data = await res.json();
        box.innerHTML = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
      } catch (err) { box.textContent = `Error: ${err.message}`; }
    }
  }

  // ─── Fetch server logs ────────────────────────────────────────────
  let _lastServerLogTime = 0;
  async function _fetchServerLogs() {
    const cid = WsClient.getConnectionId();
    if (!cid) return;
    try {
      const res = await fetch(`/api/logs?cid=${cid}&since=${_lastServerLogTime}`);
      const data = await res.json();
      if (data.logs?.length) {
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
    _pollTimer = setInterval(_fetchServerLogs, 5000);
  }

  // ─── Railway API ──────────────────────────────────────────────────
  async function _loadProjects() {
    const sel = document.getElementById('rw-project');
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/projects?cid=${cid}`);
      const data = await res.json();
      if (data.error) { sel.innerHTML = `<option value="">${data.error}</option>`; return; }
      sel.innerHTML = '<option value="">Select project...</option>';
      data.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
    } catch (err) {
      sel.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
  }

  async function _loadServices() {
    const projectSel = document.getElementById('rw-project');
    const serviceSel = document.getElementById('rw-service');
    const projectId = projectSel.value;
    if (!projectId) { serviceSel.disabled = true; serviceSel.innerHTML = '<option value="">Select project first</option>'; return; }
    serviceSel.disabled = true;
    serviceSel.innerHTML = '<option value="">Loading...</option>';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/services?project=${projectId}&cid=${cid}`);
      const data = await res.json();
      if (data.error) { serviceSel.innerHTML = `<option value="">${data.error}</option>`; return; }
      serviceSel.innerHTML = '<option value="">Select service...</option>';
      data.services.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        serviceSel.appendChild(opt);
      });
      serviceSel.disabled = false;
    } catch (err) {
      serviceSel.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
  }

  async function _fetchRailwayLogs() {
    const serviceSel = document.getElementById('rw-service');
    const linesSel = document.getElementById('rw-lines');
    const statusEl = document.getElementById('rw-status');
    const logEl = document.getElementById('rw-log');
    const serviceId = serviceSel.value;
    if (!serviceId) { statusEl.textContent = 'Select a service first'; return; }

    statusEl.textContent = 'Fetching logs...';
    logEl.innerHTML = '';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/logs?service=${serviceId}&lines=${linesSel.value}&cid=${cid}`);
      const data = await res.json();
      if (data.error) { statusEl.textContent = `Error: ${data.error}`; return; }
      if (!data.logs?.length) { statusEl.textContent = 'No logs found'; return; }

      statusEl.textContent = `${data.logs.length} log entries`;
      data.logs.forEach(entry => {
        const el = document.createElement('div');
        el.className = `debug-entry debug-info`;
        const time = new Date(parseInt(entry.timestamp)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const source = entry.source === 'BUILD' ? '🔨' : entry.source === 'DEPLOY' ? '🚀' : '●';
        el.innerHTML = `<span class="debug-time">${time}</span> <span class="debug-src">${source}</span> ${_escHtml(entry.text)}`;
        logEl.appendChild(el);
      });
      logEl.scrollTop = logEl.scrollHeight;
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
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
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { toggle };
})();
