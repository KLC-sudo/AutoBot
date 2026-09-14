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

  const MAX_RECONNECT_DELAY = 30000;
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
    // Close any existing connection before creating a new one
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
    // Ensure old WS is cleaned up
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
        console.warn('[WS] Non-JSON message:', event.data);
        return;
      }

      _handlePacket(packet);
    };

    ws.onclose = (event) => {
      console.log(`[WS] Closed: code=${event.code}`);
      updateConnectionStatus('offline');
      _stopKeepalive();
      _emit('disconnected', { code: event.code });

      if (!_intentionalClose) {
        _scheduleReconnect();
      }
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
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

  // ─── Keepalive ping to prevent mobile browser idle kills ─────────
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
    // Emit to registered handlers
    _emit(packet.type, packet);

    // Built-in handling
    switch (packet.type) {
      case 'auth_success':
        console.log('[WS] Authenticated:', packet.connectionId);
        Auth.setToken(_token);
        updateConnectionStatus('online');
        showDashboard();
        // On reconnect (not first login), clear terminal so replay doesn't duplicate
        if (reconnectAttempts > 0) {
          Terminal.clear();
        }
        Terminal.addSystem(packet.message);
        // Request session list and models after auth (also on reconnect)
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
        // Server pong received, connection is alive
        break;
    }
  }

  function _scheduleReconnect() {
    reconnectAttempts++;
    // Cap reconnect attempts to avoid infinite loop
    if (reconnectAttempts > 20) {
      console.error('[WS] Max reconnect attempts reached. Refreshing page...');
      location.reload();
      return;
    }
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(1.5, reconnectAttempts - 1),
      MAX_RECONNECT_DELAY
    );

    console.log(`[WS] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
    showReconnectBanner(Math.round(delay / 1000));

    reconnectTimer = setTimeout(() => {
      hideReconnectBanner();
      _doConnect();
    }, delay);
  }

  function showReconnectBanner(seconds) {
    let banner = document.getElementById('reconnect-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'reconnect-banner';
      banner.className = 'reconnect-banner';
      document.body.appendChild(banner);
    }
    banner.textContent = `Connection lost. Reconnecting in ${seconds}s...`;
  }

  function hideReconnectBanner() {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.remove();
  }

  function isConnected() {
    return ws && ws.readyState === WebSocket.OPEN;
  }

  return { connect, send, sendCommand, disconnect, isConnected, on };
})();