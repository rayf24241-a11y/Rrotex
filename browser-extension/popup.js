const ROTEX = 'http://127.0.0.1:7878';
let token = '';
let messages = [];
let busy = false;

// ── UI refs ────────────────────────────────────────────────────────────────────
const connectScreen = document.getElementById('connectScreen');
const chatScreen    = document.getElementById('chatScreen');
const tokenInput    = document.getElementById('tokenInput');
const connectBtn    = document.getElementById('connectBtn');
const statusMsg     = document.getElementById('statusMsg');
const connDot       = document.getElementById('connDot');
const projectChip   = document.getElementById('projectChip');
const newChatBtn    = document.getElementById('newChatBtn');
const pageBanner    = document.getElementById('pageBanner');
const pageUrlEl     = document.getElementById('pageUrl');
const msgsEl        = document.getElementById('msgs');
const msgInput      = document.getElementById('msgInput');
const sendBtn       = document.getElementById('sendBtn');

// ── Markdown renderer ──────────────────────────────────────────────────────────
function renderMarkdown(raw) {
  let s = raw
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // fenced code blocks
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) =>
    `<pre><code>${code.trim()}</code></pre>`);
  // inline code
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // bold
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // newlines outside pre blocks — split by pre, apply <br> only to text parts
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/);
  return parts.map((p, i) => i % 2 === 0 ? p.replace(/\n/g, '<br>') : p).join('');
}

// ── Message rendering ──────────────────────────────────────────────────────────
function addMsg(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const isAI = role === 'ai';
  wrap.innerHTML = `
    <div class="msg-avatar ${isAI ? 'ai-av' : 'user-av'}">${isAI ? 'RX' : 'U'}</div>
    <div class="msg-bubble">${renderMarkdown(content)}</div>`;
  msgsEl.appendChild(wrap);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.id = 'rxTyping';
  el.innerHTML = `
    <div class="msg-avatar ai-av">RX</div>
    <div class="typing-bubble"><div class="tdot"></div><div class="tdot"></div><div class="tdot"></div></div>`;
  msgsEl.appendChild(el);
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function removeTyping() {
  document.getElementById('rxTyping')?.remove();
}

// ── Storage ────────────────────────────────────────────────────────────────────
function saveHistory() {
  if (token) chrome.storage.local.set({ [`h_${token}`]: messages.slice(-50) });
}

function loadHistory(t) {
  return new Promise(r => chrome.storage.local.get([`h_${t}`], res => r(res[`h_${t}`] || [])));
}

// ── Screen transitions ─────────────────────────────────────────────────────────
function showConnect() {
  connectScreen.style.display = 'flex';
  chatScreen.style.display    = 'none';
  connDot.className = 'conn-dot';
  projectChip.style.display = 'none';
  newChatBtn.style.display  = 'none';
}

async function showChat(project) {
  connectScreen.style.display = 'none';
  chatScreen.style.display    = 'flex';
  connDot.className = 'conn-dot on';
  if (project) {
    projectChip.textContent  = project;
    projectChip.style.display = '';
  }
  newChatBtn.style.display = '';

  // Page context banner
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('about:')) {
      pageUrlEl.textContent = tab.url;
      pageBanner.style.display = 'flex';
    }
  } catch {}

  // Load history
  messages = await loadHistory(token);
  msgsEl.innerHTML = '';
  if (messages.length === 0) {
    const greeting = `Hi! I'm your ${project || 'Supabase'} AI. Ask me about tables, RLS, Edge Functions, Auth, storage, realtime — anything Supabase.`;
    addMsg('ai', greeting);
    messages.push({ role: 'assistant', content: greeting });
    saveHistory();
  } else {
    for (const m of messages) addMsg(m.role === 'user' ? 'user' : 'ai', m.content);
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
  msgInput.focus();
}

// ── Connect ────────────────────────────────────────────────────────────────────
function setStatus(msg, cls) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (cls ? ' ' + cls : '');
}

async function connect(t) {
  t = (t || '').trim().toUpperCase();
  if (t.length < 4) { setStatus('Enter a valid token', 'err'); return; }
  token = t;
  connectBtn.disabled = true;
  setStatus('Connecting…', '');
  try {
    const res = await fetch(
      `${ROTEX}/ping?token=${encodeURIComponent(token)}&source=browser`,
      { signal: AbortSignal.timeout(4000) }
    );
    const data = res.ok ? await res.json() : null;
    if (data?.ok) {
      chrome.storage.local.set({ rotex_token: token });
      showChat(data.project);
      return;
    }
    token = '';
    setStatus('Wrong token — check ROTEX', 'err');
  } catch {
    token = '';
    setStatus('ROTEX not running — open the app first', 'err');
  } finally {
    connectBtn.disabled = false;
  }
}

connectBtn.addEventListener('click', () => connect(tokenInput.value));
tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') connect(tokenInput.value); });
tokenInput.addEventListener('input', () => { tokenInput.value = tokenInput.value.toUpperCase(); });

// ── New chat ───────────────────────────────────────────────────────────────────
newChatBtn.addEventListener('click', () => {
  messages = [];
  saveHistory();
  msgsEl.innerHTML = '';
  const greeting = `New chat started. What would you like help with?`;
  addMsg('ai', greeting);
  messages.push({ role: 'assistant', content: greeting });
  saveHistory();
  msgInput.focus();
});

// ── Send message ───────────────────────────────────────────────────────────────
async function send() {
  const text = msgInput.value.trim();
  if (!text || busy) return;

  // Inject page context into the first real user message
  let pageCtx = '';
  if (messages.length <= 1) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !tab.url.startsWith('chrome://')) {
        pageCtx = `[Viewing: ${tab.title || tab.url} — ${tab.url}]\n\n`;
      }
    } catch {}
  }

  const fullContent = pageCtx + text;
  msgInput.value = '';
  msgInput.style.height = 'auto';
  busy = true;
  sendBtn.disabled = true;

  addMsg('user', text);
  messages.push({ role: 'user', content: fullContent });
  showTyping();

  try {
    const res = await fetch(`${ROTEX}/chat?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        model: 'fast',
      }),
      signal: AbortSignal.timeout(30000),
    });

    removeTyping();

    let reply;
    if (res.ok) {
      const data = await res.json();
      reply = data.text || '(empty response)';
    } else {
      const err = await res.json().catch(() => ({}));
      reply = err.text || `Error ${res.status} — try again`;
    }

    addMsg('ai', reply);
    messages.push({ role: 'assistant', content: reply });
    saveHistory();
  } catch (err) {
    removeTyping();
    const msg = err.name === 'AbortError'
      ? 'Request timed out. Is ROTEX still open?'
      : 'Connection lost — is ROTEX still running?';
    addMsg('ai', msg);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    msgInput.focus();
  }
}

sendBtn.addEventListener('click', send);
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
msgInput.addEventListener('input', () => {
  msgInput.style.height = 'auto';
  msgInput.style.height = Math.min(msgInput.scrollHeight, 80) + 'px';
});

// ── Init ───────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['rotex_token'], res => {
  if (res.rotex_token) {
    token = res.rotex_token;
    tokenInput.value = token;
    connect(token);
  } else {
    showConnect();
  }
});
