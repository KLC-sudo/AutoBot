/* ═══════════════════════════════════════════════════════════════════════
   ws-client.js — HTTP Long-Poll transport
   Client polls GET /api/poll, sends via POST /api/send
   ═══════════════════════════════════════════════════════════════════════ */

const WsClient = (() => {
  let _token = null;
  let _connectionId = null;
  let _intentionalClose = false;
  let _polling = false;
  let _pollAbort = null;

  const _handlers = {};

  function on(type, handler) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(handler);
  }

  function _emit(type, data) {
    (_handlers[type] || []).forEach(h => h(data));
  }

  function connect(token) {
    _token = token;
    _intentionalClose = false;
    _doConnect();
  }

  async function _doConnect() {
    if (_intentionalClose) return;
    updateConnectionStatus('connecting');

    try {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: _token, sessionId: Auth.getSessionId() }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Auth failed' }));
        showLoginError(err.error || 'Authentication failed');
        setLoginLoading(false);
        _intentionalClose = true;
        return;
      }

      const { connectionId } = await res.json();
      _connectionId = connectionId;
      console.log('[HTTP] Authenticated:', connectionId);
      updateConnectionStatus('online');
      _startPolling();
    } catch (err) {
      console.error('[HTTP] Auth error:', err);
      setTimeout(() => _doConnect(), 3000);
    }
  }

  function _startPolling() {
    if (_polling) return;
    _polling = true;
    _pollLoop();
  }

  async function _pollLoop() {
    while (_polling && !_intentionalClose && _connectionId) {
      try {
        const controller = new AbortController();
        _pollAbort = controller;

        const res = await fetch(`/api/poll?cid=${encodeURIComponent(_connectionId)}`, {
          signal: controller.signal,
        });

        _pollAbort = null;

        if (!res.ok) {
          console.log('[HTTP] Poll error:', res.status);
          _polling = false;
          _reconnect();
          return;
        }

        const { messages } = await res.json();
        for (const msg of messages) {
          _handlePacket(msg);
        }
      } catch (err) {
        _pollAbort = null;
        if (err.name === 'AbortError') continue;
        if (_intentionalClose) return;
        console.log('[HTTP] Poll failed:', err.message);
        _polling = false;
        _reconnect();
        return;
      }
    }
  }

  function _reconnect() {
    if (_intentionalClose) return;
    setTimeout(() => {
      _polling = false;
      _doConnect();
    }, 1000);
  }

  function _handlePacket(packet) {
    _emit(packet.type, packet);

    switch (packet.type) {
      case 'auth_success':
        console.log('[HTTP] Ready:', packet.connectionId);
        Auth.setToken(_token);
        setLoginLoading(false);
        updateConnectionStatus('online');
        showDashboard();
        Terminal.addSystem(packet.message);
        break;

      case 'error':
        if (!Auth.isAuthenticated()) {
          showLoginError(packet.message);
          setLoginLoading(false);
          _intentionalClose = true;
        } else {
          Terminal.addError(packet.message);
        }
        break;

      case 'status':
        Terminal.addStatus(packet.message);
        break;

      case 'text':
        Terminal.addAgent(packet.message);
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
    if (_pollAbort) _pollAbort.abort();
  }

  function isConnected() { return _polling && !!_connectionId; }

  return { connect, send, sendCommand, disconnect, isConnected, on };
})();
