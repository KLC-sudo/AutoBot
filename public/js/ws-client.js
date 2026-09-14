/* ═══════════════════════════════════════════════════════════════════════
   ws-client.js — HTTP/SSE transport (replaces WebSocket for Railway compat)
   Server→Client: EventSource (SSE)
   Client→Server: fetch POST
   ═══════════════════════════════════════════════════════════════════════ */

const WsClient = (() => {
  let _token = null;
  let _connectionId = null;
  let _intentionalClose = false;
  let _eventSource = null;
  let _reconnectTimer = null;
  let _reconnectAttempts = 0;

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
    _reconnectAttempts = 0;
    _doConnect();
  }

  async function _doConnect() {
    if (_intentionalClose) return;
    updateConnectionStatus('connecting');

    try {
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: _token, sessionId: Auth.getSessionId() }),
      });

      if (!authRes.ok) {
        const err = await authRes.json().catch(() => ({ error: 'Auth failed' }));
        showLoginError(err.error || 'Authentication failed');
        setLoginLoading(false);
        _intentionalClose = true;
        return;
      }

      const { connectionId } = await authRes.json();
      _connectionId = connectionId;
      console.log('[SSE] Authenticated:', connectionId);
      _openSSE();
    } catch (err) {
      console.error('[SSE] Connection error:', err);
      _scheduleReconnect();
    }
  }

  function _openSSE() {
    if (_eventSource) { _eventSource.close(); _eventSource = null; }

    const url = `/api/stream?cid=${encodeURIComponent(_connectionId)}`;
    _eventSource = new EventSource(url);

    _eventSource.onopen = () => {
      console.log('[SSE] Stream open');
      updateConnectionStatus('online');
      _reconnectAttempts = 0;
    };

    _eventSource.onmessage = (event) => {
      try { _handlePacket(JSON.parse(event.data)); } catch {}
    };

    _eventSource.onerror = () => {
      console.log('[SSE] Stream closed');
      updateConnectionStatus('offline');
      _eventSource.close();
      _eventSource = null;
      if (!_intentionalClose) _scheduleReconnect();
    };
  }

  function _handlePacket(packet) {
    _emit(packet.type, packet);

    switch (packet.type) {
      case 'auth_success':
        console.log('[SSE] Ready:', packet.connectionId);
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

  async function _post(type, payload) {
    try {
      const res = await fetch('/api/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Connection-Id': _connectionId,
        },
        body: JSON.stringify({ type, ...payload }),
      });
      return await res.json();
    } catch (err) {
      console.error('[HTTP] Send error:', err);
      return { error: err.message };
    }
  }

  function send(type, data) { _post(type, data); }

  function sendCommand(text) { _post('command', { data: text }); }

  function disconnect() {
    _intentionalClose = true;
    clearTimeout(_reconnectTimer);
    if (_eventSource) { _eventSource.close(); _eventSource = null; }
  }

  function _scheduleReconnect() {
    _reconnectAttempts++;
    if (_reconnectAttempts > 60) { location.reload(); return; }
    const delay = Math.min(1000 * Math.pow(1.5, _reconnectAttempts - 1), 10000);
    console.log(`[SSE] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${_reconnectAttempts})`);
    _reconnectTimer = setTimeout(() => _doConnect(), delay);
  }

  function isConnected() {
    return _eventSource && _eventSource.readyState === EventSource.OPEN;
  }

  return { connect, send, sendCommand, disconnect, isConnected, on };
})();
