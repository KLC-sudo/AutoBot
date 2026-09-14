/* ═══════════════════════════════════════════════════════════════════════
   ws-client.js — WebSocket client with auto-reconnect and auth handshake
   ═══════════════════════════════════════════════════════════════════════ */

const WsClient = (() => {
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let _token = null;
  let _intentionalClose = false;
  let _keepaliveInterval = null;
  let _connectedAt = 0;
  let _authedAt = 0;

  const MAX_RECONNECT_DELAY = 10000;
  const BASE_RECONNECT_DELAY = 1000;

  // Message handlers registry
  const _handlers = {};

  function on(type, handler) {
    if (!_handlers[type]) _handlers[type] = [];
    _handlers[type].push(handler);
  }

  function _emit(type, data) {
    (_handlers[type] || []).forEach(h => h(data));
  }

  function connect(token) {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }
    clearTimeout(reconnectTimer);
    clearInterval(_keepaliveInterval);

    _token = token;
    _intentionalClose = false;
    reconnectAttempts = 0;
    _doConnect();
  }

  function _doConnect() {
    if (ws) {
      try { ws.close(); } catch {}
      ws = null;
    }

    updateConnectionStatus('connecting');

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}`;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.error('[WS] Connection error:', err);
      _scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      _connectedAt = Date.now();
      console.log('[WS] Socket open, sending auth...');
      const authPayload = { type: 'auth', token: _token };
      const savedSessionId = Auth.getSessionId();
      if (savedSessionId) {
        authPayload.sessionId = savedSessionId;
      }
      _send(authPayload);
      _startKeepalive();
    };

    ws.onmessage = (event) => {
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch {
        return;
      }
      _handlePacket(packet);
    };

    ws.onclose = (event) => {
      const lifetime = _connectedAt ? ((Date.now() - _connectedAt) / 1000).toFixed(1) : '?';
      console.log(`[WS] Closed: code=${event.code} lifetime=${lifetime}s`);
      updateConnectionStatus('offline');
      _stopKeepalive();

      if (!_intentionalClose) {
        _emit('disconnected', { code: event.code });
        _scheduleReconnect();
      }
    };

    ws.onerror = () => {};
  }

  function _send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function send(type, data) {
    _send({ type, ...data });
  }

  function sendCommand(text) {
    _send({ type: 'command', data: text });
  }

  function disconnect() {
    _intentionalClose = true;
    clearTimeout(reconnectTimer);
    _stopKeepalive();
    if (ws) {
      try { ws.close(1000, 'User disconnected'); } catch {}
    }
  }

  function _startKeepalive() {
    _stopKeepalive();
    _keepaliveInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'ping' })); } catch {}
      }
    }, 15000);
  }

  function _stopKeepalive() {
    if (_keepaliveInterval) {
      clearInterval(_keepaliveInterval);
      _keepaliveInterval = null;
    }
  }

  function _handlePacket(packet) {
    _emit(packet.type, packet);

    switch (packet.type) {
      case 'auth_success':
        _authedAt = Date.now();
        console.log('[WS] Authenticated:', packet.connectionId);
        Auth.setToken(_token);
        setLoginLoading(false);
        updateConnectionStatus('online');
        showDashboard();
        Terminal.addSystem(packet.message);
        setTimeout(() => {
          _send({ type: 'session_list' });
        }, 100);
        break;

      case 'error':
        if (!Auth.isAuthenticated()) {
          showLoginError(packet.message);
          setLoginLoading(false);
          _intentionalClose = true;
          if (ws) ws.close();
        } else {
          Terminal.addError(packet.message);
        }
        break;

      case 'keepalive':
        // Server keepalive — just ignore, its purpose is to keep the proxy alive
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

      case 'pong':
        break;
    }
  }

  function _scheduleReconnect() {
    reconnectAttempts++;

    if (reconnectAttempts > 60) {
      console.error('[WS] Max reconnect attempts reached. Refreshing page...');
      location.reload();
      return;
    }

    // Reconnect fast — Railway kills connections every ~30s, this is expected
    const delay = Math.min(BASE_RECONNECT_DELAY, MAX_RECONNECT_DELAY);

    console.log(`[WS] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
    // No banner — reconnection is expected and seamless

    reconnectTimer = setTimeout(() => {
      _doConnect();
    }, delay);
  }

  function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  return { connect, send, sendCommand, disconnect, isConnected, on };
})();
