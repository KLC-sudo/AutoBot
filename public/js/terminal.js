/* ═══════════════════════════════════════════════════════════════════════
   terminal.js — Rolling terminal/chat log with XSS-safe rendering
   Features: collapsible thinking steps, markdown rendering
   ═══════════════════════════════════════════════════════════════════════ */

const Terminal = (() => {
  const MAX_MESSAGES = 500;
  let _statusGroup = null;
  let _statusCount = 0;

  function _getStream() {
    return document.getElementById('terminal-stream');
  }

  function _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function _renderMarkdown(text) {
    let escaped = _escapeHtml(text);

    // Code blocks (triple backtick)
    escaped = escaped.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre style="background:var(--bg-input);padding:10px;border-radius:4px;overflow-x:auto;margin:6px 0;border:1px solid var(--border)"><code>${code.trim()}</code></pre>`;
    });

    // Inline code
    escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Line breaks
    escaped = escaped.replace(/\n/g, '<br>');

    return escaped;
  }

  function _scrollToBottom() {
    const stream = _getStream();
    requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
    });
  }

  function _trimMessages() {
    const stream = _getStream();
    while (stream.children.length > 500) {
      stream.removeChild(stream.firstChild);
    }
  }

  // Close any open status group
  function _closeStatusGroup() {
    _statusGroup = null;
    _statusCount = 0;
  }

  function addStatus(message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const stream = _getStream();

    // If no group yet, create a collapsible group
    if (!_statusGroup) {
      _statusGroup = document.createElement('details');
      _statusGroup.className = 'msg msg-status-group';
      _statusGroup.open = false; // Collapsed by default

      const summary = document.createElement('summary');
      summary.className = 'status-group-summary';
      summary.innerHTML = `<span class="text-muted">[${time}]</span> <span class="status-group-label">Thinking...</span>`;
      _statusGroup.appendChild(summary);

      const content = document.createElement('div');
      content.className = 'status-group-content';
      _statusGroup.appendChild(content);

      stream.appendChild(_statusGroup);
    }

    // Add status line to the group content
    const content = _statusGroup.querySelector('.status-group-content');
    const line = document.createElement('div');
    line.className = 'msg-system status-line';
    line.innerHTML = `<span class="text-muted">[${time}]</span> ${_escapeHtml(message)}`;
    content.appendChild(line);

    _statusCount++;

    // Update summary label
    const label = _statusGroup.querySelector('.status-group-label');
    if (message.includes('Tool:')) {
      const toolName = message.match(/Tool: (\w+)/)?.[1] || '...';
      label.textContent = `Running ${toolName} (${_statusCount} steps)`;
    } else if (message.includes('Thinking')) {
      label.textContent = `Thinking... (${_statusCount} steps)`;
    } else {
      label.textContent = message.substring(0, 50) + (_statusCount > 1 ? ` (${_statusCount} steps)` : '');
    }

    _trimMessages();
    _scrollToBottom();
  }

  function addAgent(message, isReplay) {
    _closeStatusGroup();
    const prefix = isReplay ? '<span style="color:var(--text-muted);font-weight:600">[history]</span> ' : '';
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = 'msg msg-agent';
    el.innerHTML = `${prefix}<span style="color:var(--accent);font-weight:600">Agent:</span> ${_renderMarkdown(message)}`;
    stream.appendChild(el);
    _trimMessages();
    _scrollToBottom();
  }

  function addUser(message, isReplay) {
    _closeStatusGroup();
    const prefix = isReplay ? '<span style="color:var(--text-muted);font-weight:600">[history]</span> ' : '';
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.innerHTML = `${prefix}<span style="color:var(--info);font-weight:600">You:</span> ${_escapeHtml(message)}`;
    stream.appendChild(el);
    _trimMessages();
    _scrollToBottom();
  }

  function addError(message) {
    _closeStatusGroup();
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = 'msg msg-error';
    el.innerHTML = `<span style="font-weight:600">Error:</span> ${_escapeHtml(message)}`;
    stream.appendChild(el);
    _trimMessages();
    _scrollToBottom();
  }

  function addCodeUpdate(filename) {
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = 'msg msg-code-update';
    el.innerHTML = `<span style="font-weight:600">File updated:</span> ${_escapeHtml(filename)}`;
    stream.appendChild(el);
    _trimMessages();
    _scrollToBottom();
  }

  function addSystem(message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = 'msg msg-system';
    el.innerHTML = `<span class="text-muted">[${time}]</span> ${_escapeHtml(message)}`;
    stream.appendChild(el);
    _trimMessages();
    _scrollToBottom();
  }

  function clear() {
    _getStream().innerHTML = '';
    _closeStatusGroup();
  }

  return { addStatus, addAgent, addUser, addError, addCodeUpdate, addSystem, clear };
})();

function clearTerminal() {
  Terminal.clear();
}
