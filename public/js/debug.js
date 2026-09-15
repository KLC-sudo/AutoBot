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
          <select id="rw-env" class="railway-select" disabled><option value="">Select service first</option></select>
          <button class="debug-btn" id="rw-fetch">Logs</button>
          <button class="debug-btn" id="rw-check" title="Check token type">🔑</button>
          <select id="rw-lines" class="railway-select rw-lines">
            <option value="100">100</option>
            <option value="200" selected>200</option>
            <option value="500">500</option>
          </select>
        </div>
        <div class="railway-actions">
          <span class="railway-actions-label">Quick Actions:</span>
          <button class="debug-btn rw-action" id="rw-redeploy" title="Redeploy current service">🚀 Redeploy</button>
          <button class="debug-btn rw-action" id="rw-add-pg" title="Add PostgreSQL database">🐘 +Postgres</button>
          <button class="debug-btn rw-action" id="rw-add-redis" title="Add Redis">🔴 +Redis</button>
          <button class="debug-btn rw-action" id="rw-add-mysql" title="Add MySQL">🐬 +MySQL</button>
          <button class="debug-btn rw-action" id="rw-add-mongo" title="Add MongoDB">🍃 +Mongo</button>
          <button class="debug-btn rw-action" id="rw-add-volume" title="Add persistent volume">💾 +Volume</button>
          <button class="debug-btn rw-action" id="rw-view-vars" title="View environment variables">📋 Vars</button>
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
    document.getElementById('rw-project').onchange = () => { _loadServices(); _loadEnvironments(); };
    document.getElementById('rw-service').onchange = _loadEnvironments;
    document.getElementById('rw-fetch').onclick = _fetchRailwayLogs;
    document.getElementById('rw-check').onclick = _checkToken;
    document.getElementById('rw-redeploy').onclick = _redeployService;
    document.getElementById('rw-add-pg').onclick = () => _createDatabase('PostgreSQL', 'postgres');
    document.getElementById('rw-add-redis').onclick = () => _createDatabase('Redis', 'redis');
    document.getElementById('rw-add-mysql').onclick = () => _createDatabase('MySQL', 'mysql');
    document.getElementById('rw-add-mongo').onclick = () => _createDatabase('MongoDB', 'mongodb');
    document.getElementById('rw-add-volume').onclick = _addVolume;
    document.getElementById('rw-view-vars').onclick = _viewVariables;
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
    const status = document.getElementById('rw-status');
    try {
      const cid = WsClient.getConnectionId();
      if (!cid) { sel.innerHTML = '<option value="">No connection</option>'; return; }
      status.textContent = 'Loading projects...';
      const res = await fetch(`/api/railway/projects?cid=${cid}`);
      const data = await res.json();
      if (data.error) {
        sel.innerHTML = `<option value="">${data.error}</option>`;
        status.textContent = `Error: ${data.error}`;
        return;
      }
      if (!data.projects?.length) {
        sel.innerHTML = '<option value="">No projects found</option>';
        status.textContent = 'No projects returned. Check token type.';
        return;
      }
      sel.innerHTML = '<option value="">Select project...</option>';
      data.projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id; opt.textContent = p.name;
        sel.appendChild(opt);
      });
      status.textContent = `${data.projects.length} project(s) loaded`;
    } catch (err) {
      sel.innerHTML = `<option value="">Error: ${err.message}</option>`;
      status.textContent = `Error: ${err.message}`;
    }
  }

  async function _checkToken() {
    const status = document.getElementById('rw-status');
    status.textContent = 'Checking token...';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/token-info?cid=${cid}`);
      const data = await res.json();
      status.textContent = `Token type: ${data.type || 'unknown'}` +
        (data.user ? ` (${data.user.name || data.user.email})` : '') +
        (data.error ? ` — ${data.error}` : '');
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
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

  // ─── Load environments for selected project ────────────────────────
  async function _loadEnvironments() {
    const envSel = document.getElementById('rw-env');
    const projectId = document.getElementById('rw-project').value;
    if (!projectId) { envSel.disabled = true; envSel.innerHTML = '<option value="">Select project first</option>'; return; }
    envSel.disabled = true;
    envSel.innerHTML = '<option value="">Loading...</option>';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/environments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-Id': cid },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (data.error) { envSel.innerHTML = `<option value="">${data.error}</option>`; return; }
      envSel.innerHTML = '<option value="">Select environment...</option>';
      (data.environments || []).forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id; opt.textContent = e.name;
        envSel.appendChild(opt);
      });
      envSel.disabled = false;
    } catch (err) {
      envSel.innerHTML = `<option value="">Error: ${err.message}</option>`;
    }
  }

  // ─── Quick Actions ─────────────────────────────────────────────────
  async function _redeployService() {
    const serviceId = document.getElementById('rw-service').value;
    const envId = document.getElementById('rw-env').value;
    const statusEl = document.getElementById('rw-status');
    if (!serviceId || !envId) { statusEl.textContent = 'Select a service and environment first'; return; }
    statusEl.textContent = 'Redeploying...';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/redeploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-Id': cid },
        body: JSON.stringify({ serviceId, environmentId: envId }),
      });
      const data = await res.json();
      if (data.error) { statusEl.textContent = `Error: ${data.error}`; return; }
      statusEl.textContent = `Redeploy triggered (ID: ${data.deploymentId})`;
    } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
  }

  async function _createDatabase(name, type) {
    const projectId = document.getElementById('rw-project').value;
    const statusEl = document.getElementById('rw-status');
    if (!projectId) { statusEl.textContent = 'Select a project first'; return; }
    statusEl.textContent = `Creating ${name}...`;
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/service/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-Id': cid },
        body: JSON.stringify({ projectId, name, type }),
      });
      const data = await res.json();
      if (data.error) { statusEl.textContent = `Error: ${data.error}`; return; }
      statusEl.textContent = `Created ${name} (ID: ${data.id})`;
      _loadServices();
    } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
  }

  async function _addVolume() {
    const projectId = document.getElementById('rw-project').value;
    const serviceId = document.getElementById('rw-service').value;
    const statusEl = document.getElementById('rw-status');
    if (!projectId || !serviceId) { statusEl.textContent = 'Select a project and service first'; return; }
    const mountPath = prompt('Mount path (e.g., /data):', '/data');
    if (!mountPath) return;
    statusEl.textContent = 'Creating volume...';
    try {
      const cid = WsClient.getConnectionId();
      const res = await fetch(`/api/railway/volume/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Connection-Id': cid },
        body: JSON.stringify({ projectId, serviceId, mountPath }),
      });
      const data = await res.json();
      if (data.error) { statusEl.textContent = `Error: ${data.error}`; return; }
      statusEl.textContent = `Volume "${data.name}" created, mounted at ${mountPath}`;
    } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
  }

  async function _viewVariables() {
    const projectId = document.getElementById('rw-project').value;
    const envId = document.getElementById('rw-env').value;
    const serviceId = document.getElementById('rw-service').value;
    const logEl = document.getElementById('rw-log');
    const statusEl = document.getElementById('rw-status');
    if (!projectId || !envId) { statusEl.textContent = 'Select a project and environment first'; return; }
    statusEl.textContent = 'Loading variables...';
    logEl.innerHTML = '';
    try {
      const cid = WsClient.getConnectionId();
      let url = `/api/railway/vars?project=${projectId}&environment=${envId}`;
      if (serviceId) url += `&service=${serviceId}`;
      const res = await fetch(url, { headers: { 'X-Connection-Id': cid } });
      const data = await res.json();
      if (data.error) { statusEl.textContent = `Error: ${data.error}`; return; }
      const vars = data.variables || {};
      const keys = Object.keys(vars);
      if (!keys.length) { statusEl.textContent = 'No variables found'; return; }
      statusEl.textContent = `${keys.length} variable(s)`;
      keys.sort().forEach(key => {
        const val = vars[key];
        const display = val.length > 60 ? val.substring(0, 60) + '...' : val;
        const el = document.createElement('div');
        el.className = 'debug-entry debug-info';
        el.innerHTML = `<span style="color:var(--accent)">${_escHtml(key)}</span>=<span style="color:var(--text-muted)">${_escHtml(display)}</span>`;
        logEl.appendChild(el);
      });
    } catch (err) { statusEl.textContent = `Error: ${err.message}`; }
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
