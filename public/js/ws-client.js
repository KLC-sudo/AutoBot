/* ═══════════════════════════════════════════════════════════════════════
   ws-client.js — WebSocket client with auto-reconnect and auth handshake
   ═══════════════════════════════════════════════════════════════════════ */

const WsClient = (() => {
  let ws = null;
  let reconnectAttempts = 0;
  let reconnectTimer = null;
  let _token = null;
  let _intentionalClose = false;

  const MAX_RECONNECT_DELAY = 30000;
  const BASE_RECONNECT_DELAY = 1000;

  function connect(token) {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }

    _token = token;
    _intentionalClose = false;
    reconnectAttempts = 0;
    _doConnect();
  }

  function _doConnect() {
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
      _send({ type: 'auth', token: _token });
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
      console.log(`[WS] Closed: code=${event.code} reason=${event.reason}`);
      updateConnectionStatus('offline');

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

  function sendCommand(text) {
    _send({ type: 'command', data: text });
  }

  function disconnect() {
    _intentionalClose = true;
    clearTimeout(reconnectTimer);
    if (ws) ws.close(1000, 'User disconnected');
  }

  function _handlePacket(packet) {
    switch (packet.type) {
      case 'auth_success':
        console.log('[WS] Authenticated:', packet.connectionId);
        Auth.setToken(_token);
        updateConnectionStatus('online');
        showDashboard();
        Terminal.addSystem(packet.message);
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

      default:
        console.warn('[WS] Unknown packet type:', packet.type);
    }
  }

  function _scheduleReconnect() {
    reconnectAttempts++;
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

  return { connect, sendCommand, disconnect, isConnected };
})();
