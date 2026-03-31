/**
 * Guardrail Chat Widget v1.0
 * Drop-in AI chat with confidence scoring for any website.
 * 
 * Usage:
 *   <script 
 *     src="https://guardrail-mvp-production.up.railway.app/embed/widget.js"
 *     data-key="gr_live_xxx"
 *     data-context="general"
 *     data-title="AI Assistant"
 *     data-theme="dark"
 *   ></script>
 */
(function () {
  'use strict';

  var script  = document.currentScript || (function () {
    var scripts = document.querySelectorAll('script[data-key]');
    return scripts[scripts.length - 1];
  })();

  var API_KEY   = script.getAttribute('data-key')   || '';
  var CONTEXT   = script.getAttribute('data-context') || 'general';
  var TITLE     = script.getAttribute('data-title')  || 'AI Assistant';
  var THEME     = script.getAttribute('data-theme')  || 'dark';
  var SYS_PROMPT= script.getAttribute('data-system-prompt') || '';
  var WELCOME   = script.getAttribute('data-welcome') || 'Hi! I\'m your AI assistant. How can I help?';
  var PLACEHOLDER = script.getAttribute('data-placeholder') || 'Ask anything...';
  var ENDPOINT  = script.src.replace('/embed/widget.js', '');

  if (!API_KEY) {
    console.warn('[Guardrail Widget] data-key is required.');
    return;
  }

  var COLORS = {
    dark:  { bg: '#06111f', card: '#0d1e33', border: '#1e3050', text: '#e2edf8', muted: '#6b8aab', teal: '#1db99a', amber: '#f5a623', coral: '#ff5c5c' },
    light: { bg: '#f4f7fb', card: '#ffffff', border: '#dde3ed', text: '#1a2944', muted: '#7a8fa6', teal: '#0fa07f', amber: '#d48a1a', coral: '#e04040' },
  };
  var C = COLORS[THEME] || COLORS.dark;

  // ── Inject styles ──────────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = [
    '#gr-widget-btn{position:fixed;bottom:24px;right:24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:#1db99a;border:none;cursor:pointer;box-shadow:0 4px 20px rgba(29,185,154,.4);display:flex;align-items:center;justify-content:center;font-size:1.4rem;transition:transform .2s,box-shadow .2s}',
    '#gr-widget-btn:hover{transform:scale(1.1);box-shadow:0 6px 28px rgba(29,185,154,.55)}',
    '#gr-widget-panel{position:fixed;bottom:92px;right:24px;z-index:99998;width:360px;height:520px;background:' + C.bg + ';border:1px solid ' + C.border + ';border-radius:18px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font-family:Inter,system-ui,sans-serif}',
    '#gr-widget-panel.open{display:flex}',
    '#gr-panel-head{padding:16px 18px;border-bottom:1px solid ' + C.border + ';display:flex;align-items:center;justify-content:space-between;background:' + C.card + '}',
    '#gr-panel-head h3{color:' + C.text + ';font-size:.95rem;font-weight:700;margin:0}',
    '#gr-panel-close{background:none;border:none;color:' + C.muted + ';cursor:pointer;font-size:1.2rem;line-height:1;padding:2px 6px}',
    '#gr-panel-close:hover{color:' + C.text + '}',
    '#gr-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}',
    '.gr-msg{max-width:85%;border-radius:12px;padding:10px 14px;font-size:.875rem;line-height:1.55;word-break:break-word}',
    '.gr-msg.user{align-self:flex-end;background:#1db99a;color:#fff;border-bottom-right-radius:4px}',
    '.gr-msg.ai{align-self:flex-start;background:' + C.card + ';color:' + C.text + ';border:1px solid ' + C.border + ';border-bottom-left-radius:4px}',
    '.gr-badge{display:inline-flex;align-items:center;gap:4px;margin-top:6px;padding:2px 8px;border-radius:999px;font-size:.72rem;font-weight:600}',
    '.gr-badge.deliver{background:rgba(29,185,154,.15);color:#1db99a}',
    '.gr-badge.flag{background:rgba(245,166,35,.15);color:#f5a623}',
    '.gr-badge.escalate{background:rgba(255,92,92,.15);color:#ff5c5c}',
    '.gr-typing{align-self:flex-start;background:' + C.card + ';border:1px solid ' + C.border + ';border-radius:12px;border-bottom-left-radius:4px;padding:10px 16px;display:none}',
    '.gr-typing span{display:inline-block;width:6px;height:6px;background:' + C.muted + ';border-radius:50%;animation:gr-bounce .9s infinite}',
    '.gr-typing span:nth-child(2){animation-delay:.15s}.gr-typing span:nth-child(3){animation-delay:.3s}',
    '@keyframes gr-bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-6px)}}',
    '#gr-input-row{padding:12px;border-top:1px solid ' + C.border + ';display:flex;gap:8px}',
    '#gr-input{flex:1;padding:10px 14px;background:' + C.card + ';border:1px solid ' + C.border + ';border-radius:10px;color:' + C.text + ';font-size:.875rem;outline:none;font-family:inherit;resize:none;height:40px;transition:border-color .2s}',
    '#gr-input:focus{border-color:#1db99a}',
    '#gr-send{background:#1db99a;border:none;border-radius:10px;width:40px;height:40px;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.1rem;flex-shrink:0;transition:background .2s}',
    '#gr-send:hover{background:#15a085}',
    '#gr-powered{text-align:center;padding:6px;font-size:.7rem;color:' + C.muted + ';border-top:1px solid ' + C.border + '}',
    '#gr-powered a{color:#1db99a;text-decoration:none}',
  ].join('');
  document.head.appendChild(style);

  // ── Build DOM ──────────────────────────────────────────────────────────────
  var btn = document.createElement('button');
  btn.id = 'gr-widget-btn';
  btn.innerHTML = '🛡️';
  btn.title = 'Open ' + TITLE;

  var panel = document.createElement('div');
  panel.id = 'gr-widget-panel';
  panel.innerHTML = [
    '<div id="gr-panel-head">',
    '  <h3>🛡️ ' + TITLE + '</h3>',
    '  <button id="gr-panel-close" title="Close">✕</button>',
    '</div>',
    '<div id="gr-messages">',
    '  <div class="gr-msg ai">' + WELCOME + '</div>',
    '  <div class="gr-typing" id="gr-typing"><span></span><span></span><span></span></div>',
    '</div>',
    '<div id="gr-input-row">',
    '  <textarea id="gr-input" placeholder="' + PLACEHOLDER + '" rows="1"></textarea>',
    '  <button id="gr-send">➤</button>',
    '</div>',
    '<div id="gr-powered">Powered by <a href="' + ENDPOINT + '" target="_blank">Guardrail</a></div>',
  ].join('');

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  // ── Logic ──────────────────────────────────────────────────────────────────
  var messagesEl = document.getElementById('gr-messages');
  var typingEl   = document.getElementById('gr-typing');
  var inputEl    = document.getElementById('gr-input');

  btn.addEventListener('click', function () {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) inputEl.focus();
  });
  document.getElementById('gr-panel-close').addEventListener('click', function () {
    panel.classList.remove('open');
  });

  document.getElementById('gr-send').addEventListener('click', send);
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    addMsg(text, 'user');
    typingEl.style.display = 'flex';
    scrollBottom();

    // Try live chat first, fall back to demo-chat if no LLM key
    fetch(ENDPOINT + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Guardrail-Key': API_KEY },
      body: JSON.stringify({ message: text, context: CONTEXT, systemPrompt: SYS_PROMPT || undefined }),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error && data.error.indexOf('Anthropic') !== -1) {
        // No LLM key — fall back to demo-chat
        return fetch(ENDPOINT + '/api/demo-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, context: CONTEXT }),
        }).then(function(r) { return r.json(); })
        .then(function(demo) {
          typingEl.style.display = 'none';
          addMsg(demo.aiResponse || demo.text, 'ai', demo.decision, demo.confidence);
        });
      }
      typingEl.style.display = 'none';
      if (data.error) { addMsg('Error: ' + data.error, 'ai'); return; }
      addMsg(data.fullText || data.text, 'ai', data.decision, data.confidence);
    })
    .catch(function (err) {
      typingEl.style.display = 'none';
      addMsg('Connection error. Please try again.', 'ai');
    });
  }

  function addMsg(text, role, decision, confidence) {
    var div = document.createElement('div');
    div.className = 'gr-msg ' + role;
    div.textContent = text;
    if (decision) {
      var badge = document.createElement('div');
      var emoji = { deliver: '✅', flag: '⚠️', escalate: '🔴' }[decision] || '';
      badge.className = 'gr-badge ' + decision;
      badge.textContent = emoji + ' ' + decision + ' · ' + Math.round(confidence * 100) + '% confidence';
      div.appendChild(badge);
    }
    messagesEl.insertBefore(div, typingEl);
    scrollBottom();
  }

  function scrollBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Auto-load font if not present
  if (!document.querySelector('link[href*="Inter"]')) {
    var link = document.createElement('link');
    link.rel  = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap';
    document.head.appendChild(link);
  }
})();
