/* ═══════════════════════════════════════════════════════════════════════
   ws-client.js — HTTP Long-Poll transport
   ═══════════════════════════════════════════════════════════════════════ */

const WsClient = (() => {
  let _token = null;
  let _connectionId = null;
  let _intentionalClose = false;
  let _polling = false;
  let _pollTimer = null;

  const _handlers = {};

  function on(type, handler) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(handler);
  }

  function _emit(type, data) {
    (_handlers[type] || []).forEach(h => h(data));
  }

  function connect(token) {
    console.log('[HTTP] connect() called');
    if (_polling || _connectionId) {
      console.log('[HTTP] Already connected, ignoring');
      return;
    }
    _token = token;
    _intentionalClose = false;
    _doAuth();
  }

  async function _doAuth() {
    if (_intentionalClose) return;
    updateConnectionStatus('connecting');

    try {
      console.log('[HTTP] POST /api/auth ...');
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: _token, sessionId: Auth.getSessionId() }),
      });

      console.log('[HTTP] Auth response:', res.status);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Auth failed' }));
        console.log('[HTTP] Auth failed:', err.error);
        showLoginError(err.error || 'Authentication failed');
        setLoginLoading(false);
        _intentionalClose = true;
        return;
      }

      const data = await res.json();
      _connectionId = data.connectionId;
      console.log('[HTTP] Authenticated:', _connectionId);
      updateConnectionStatus('online');
      _startPoll();
    } catch (err) {
      console.error('[HTTP] Auth error:', err);
      _scheduleRetry(3000);
    }
  }

  function _startPoll() {
    if (_polling) return;
    _polling = true;
    console.log('[HTTP] Starting poll loop');
    _pollOnce();
  }

  async function _pollOnce() {
    while (_polling && !_intentionalClose && _connectionId) {
      try {
        const url = `/api/poll?cid=${encodeURIComponent(_connectionId)}`;
        const res = await fetch(url);

        if (!res.ok) {
          console.log('[HTTP] Poll error:', res.status);
          _polling = false;
          _connectionId = null;
          _scheduleRetry(2000);
          return;
        }

        const data = await res.json();
        if (data.messages && data.messages.length > 0) {
          console.log(`[HTTP] Received ${data.messages.length} messages`);
          for (const msg of data.messages) {
            _handlePacket(msg);
          }
        }
      } catch (err) {
        console.error('[HTTP] Poll failed:', err.message);
        _polling = false;
        _connectionId = null;
        _scheduleRetry(2000);
        return;
      }
    }
  }

  function _scheduleRetry(ms) {
    clearTimeout(_pollTimer);
    _pollTimer = setTimeout(() => {
      if (!_intentionalClose) _doAuth();
    }, ms);
  }

  function _handlePacket(packet) {
    _emit(packet.type, packet);

    switch (packet.type) {
      case 'auth_success':
        console.log('[HTTP] Ready:', packet.connectionId);
        try {
          Auth.setToken(_token);
          setLoginLoading(false);
          updateConnectionStatus('online');
          showDashboard();
          Terminal.addSystem(packet.message);
        } catch (err) {
          console.error('[HTTP] auth_success handler error:', err);
        }
        break;

      case 'error':
        if (!Auth.isAuthenticated()) {
          showLoginError(packet.message);
          setLoginLoading(false);
          _intentionalClose = true;
        } else {
          Terminal.addError(packet.message);
          _emit('agentDone', packet);
        }
        break;

      case 'status':
        Terminal.addStatus(packet.message);
        if (typeof showToast === 'function') {
          const msg = packet.message || '';
          if (msg.includes('created')) showToast(msg, 'create');
          else if (msg.includes('deleted')) showToast(msg, 'delete');
          else if (msg.includes('Renamed') || msg.includes('Loaded')) showToast(msg, 'rename');
        }
        break;

      case 'text':
        Terminal.addAgent(packet.message);
        break;

      case 'agent_done':
        _emit('agentDone', packet);
        break;

      case 'code':
        Terminal.addCodeUpdate(packet.filename);
        CodeViewer.showFile(packet.filename, packet.data);
        break;

      case 'tokens':
        _emit('tokenUpdate', packet);
        break;

      case 'session':
        _emit('sessionUpdate', packet);
        break;

      case 'session_list':
        _emit('sessionList', packet);
        break;

      case 'models':
        _emit('modelsList', packet);
        break;

      case 'history':
        if (packet.role === 'user') Terminal.addUser(packet.content, true);
        else if (packet.role === 'assistant') Terminal.addAgent(packet.content, true);
        break;
    }
  }

  function send(type, data) {
    if (!_connectionId) return;
    fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Connection-Id': _connectionId },
      body: JSON.stringify({ type, ...data }),
    }).catch(err => console.error('[HTTP] Send error:', err));
  }

  function sendCommand(text) { send('command', { data: text }); }

  function disconnect() {
    _intentionalClose = true;
    _polling = false;
    clearTimeout(_pollTimer);
    _connectionId = null;
  }

  function isConnected() { return _polling && !!_connectionId; }

  return { connect, send, sendCommand, disconnect, isConnected, on, getConnectionId: () => _connectionId };
})();
