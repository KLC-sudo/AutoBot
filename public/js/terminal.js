/* ═══════════════════════════════════════════════════════════════════════
   terminal.js — Rolling terminal/chat log with XSS-safe rendering
   ═══════════════════════════════════════════════════════════════════════ */

const Terminal = (() => {
  const MAX_MESSAGES = 500;
  let messageCount = 0;

  function _getStream() {
    return document.getElementById('terminal-stream');
  }

  function _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function _renderMarkdown(text) {
    // Simple inline markdown: **bold**, *italic*, `code`, ```code blocks```
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

  function _append(html, className) {
    const stream = _getStream();
    const el = document.createElement('div');
    el.className = `msg ${className}`;
    el.innerHTML = html;
    stream.appendChild(el);

    messageCount++;
    _trimMessages();
    _scrollToBottom();
  }

  function _trimMessages() {
    const stream = _getStream();
    while (stream.children.length > MAX_MESSAGES) {
      stream.removeChild(stream.firstChild);
    }
  }

  function _scrollToBottom() {
    const stream = _getStream();
    requestAnimationFrame(() => {
      stream.scrollTop = stream.scrollHeight;
    });
  }

  function addStatus(message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _append(`<span class="text-muted">[${time}]</span> ${_escapeHtml(message)}`, 'msg-system');
  }

  function addAgent(message) {
    _append(`<span style="color:var(--accent);font-weight:600">Agent:</span> ${_renderMarkdown(message)}`, 'msg-agent');
  }

  function addUser(message) {
    _append(`<span style="color:var(--info);font-weight:600">You:</span> ${_escapeHtml(message)}`, 'msg-user');
  }

  function addError(message) {
    _append(`<span style="font-weight:600">Error:</span> ${_escapeHtml(message)}`, 'msg-error');
  }

  function addCodeUpdate(filename) {
    _append(`<span style="font-weight:600">File updated:</span> ${_escapeHtml(filename)}`, 'msg-code-update');
  }

  function addSystem(message) {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    _append(`<span class="text-muted">[${time}]</span> ${_escapeHtml(message)}`, 'msg-system');
  }

  function clear() {
    const stream = _getStream();
    stream.innerHTML = '';
    messageCount = 0;
  }

  return { addStatus, addAgent, addUser, addError, addCodeUpdate, addSystem, clear };
})();

/* ─── Clear Terminal ────────────────────────────────────────────── */
function clearTerminal() {
  Terminal.clear();
}
