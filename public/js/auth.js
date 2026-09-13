/* ═══════════════════════════════════════════════════════════════════════
   auth.js — Token management and login flow
   ═══════════════════════════════════════════════════════════════════════ */

const Auth = (() => {
  const STORAGE_KEY = 'hermes_session_token';
  const SESSION_KEY = 'hermes_session_id';
  let _token = null;

  function getToken() {
    if (_token) return _token;
    try {
      _token = sessionStorage.getItem(STORAGE_KEY);
    } catch { /* private browsing */ }
    return _token;
  }

  function setToken(token) {
    _token = token;
    try {
      sessionStorage.setItem(STORAGE_KEY, token);
    } catch { /* quota exceeded */ }
  }

  function clearToken() {
    _token = null;
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }

  function isAuthenticated() {
    return !!getToken();
  }

  // ── Session ID persistence (survives server restarts) ──
  function getSessionId() {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch { return null; }
  }

  function setSessionId(sessionId) {
    try {
      if (sessionId) localStorage.setItem(SESSION_KEY, sessionId);
      else localStorage.removeItem(SESSION_KEY);
    } catch { /* ignore */ }
  }

  function clearSessionId() {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  return { getToken, setToken, clearToken, isAuthenticated, getSessionId, setSessionId, clearSessionId };
})();

/* ─── Login Handler ─────────────────────────────────────────────── */
function handleLogin(event) {
  event.preventDefault();
  const tokenInput = document.getElementById('auth-token');
  const token = tokenInput.value.trim();

  if (!token) {
    showLoginError('Please enter your access token.');
    return false;
  }

  setLoginLoading(true);
  hideLoginError();

  // Attempt WebSocket connection with token
  WsClient.connect(token);

  return false;
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLoginError() {
  document.getElementById('login-error').classList.add('hidden');
}

function setLoginLoading(loading) {
  const btn = document.getElementById('login-btn');
  const text = document.getElementById('login-btn-text');
  const spinner = document.getElementById('login-btn-spinner');

  btn.disabled = loading;
  text.textContent = loading ? 'Connecting...' : 'Authenticate';
  spinner.classList.toggle('hidden', !loading);
}

/* ─── Dashboard Transitions ─────────────────────────────────────── */
function showDashboard() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  document.getElementById('cmd-input').disabled = false;
  document.getElementById('send-btn').disabled = false;
  document.getElementById('cmd-input').focus();
}

function showLogin() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('cmd-input').disabled = true;
  document.getElementById('send-btn').disabled = true;
  setLoginLoading(false);
}

/* ─── Connection Status Indicator ───────────────────────────────── */
function updateConnectionStatus(state) {
  const dots = document.querySelectorAll('.status-dot');
  const label = document.getElementById('conn-label');
  const loginStatus = document.getElementById('login-status-text');

  dots.forEach(dot => {
    dot.className = 'status-dot ' + state;
  });

  const labels = {
    offline: 'Disconnected',
    connecting: 'Connecting...',
    online: 'Connected',
  };

  if (label) label.textContent = labels[state] || state;
  if (loginStatus) loginStatus.textContent = labels[state] || state;
}
