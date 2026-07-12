const $ = (id) => document.getElementById(id);

const els = {
  messages: $('messages'),
  form: $('chatForm'),
  input: $('chatInput'),
  send: $('sendBtn'),
  model: $('modelSelect'),
  bridgeCode: $('bridgeCode'),
  copyCode: $('copyCodeBtn'),
  refreshCode: $('refreshCodeBtn'),
  checkPlugin: $('checkPluginBtn'),
  pluginDot: $('pluginDot'),
  pluginStatus: $('pluginStatus'),
  bridgeHealth: $('bridgeHealth'),
  ctxPlugin: $('ctxPlugin'),
  ctxGame: $('ctxGame'),
  ctxScripts: $('ctxScripts'),
  ctxGui: $('ctxGui'),
  ctxActions: $('ctxActions'),
  ctxBridge: $('ctxBridge'),
  resultLog: $('resultLog'),
  runState: $('runState'),
  runDetail: $('runDetail'),
  runMini: $('runMini'),
  signIn: $('signInBtn'),
  signOut: $('signOutBtn'),
  avatar: $('profileAvatar'),
  accountName: $('accountName'),
  accountEmail: $('accountEmail'),
  accountPlanRow: $('accountPlanRow'),
  planBadge: $('planBadge'),
  getPro: $('getProBtn'),
  buyTokens: $('buyTokensBtn'),
  newChat: $('newChatBtn'),
  chatList: $('chatList'),
  connectStudio: $('connectStudioBtn'),
  connectStudioLabel: $('connectStudioLabel'),
  pluginModal: $('pluginModal'),
  pluginModalClose: $('pluginModalClose'),
  pluginModalCode: $('pluginModalCode'),
  pluginModalCopy: $('pluginModalCopy'),
  pluginModalCheck: $('pluginModalCheck'),
  pluginModalStatus: $('pluginModalStatus'),
  pluginModalStatusRow: $('pluginModalStatusRow'),
};

const VALID_ROOT = /^(ServerScriptService|ReplicatedStorage|StarterPlayer|StarterPlayerScripts|StarterCharacterScripts|StarterGui|Workspace|ServerStorage|StarterPack|Lighting|SoundService|Teams|Players|TextChatService|Chat)(\/|\\)/i;
const ACTION_TYPES = new Set(['delete_instance', 'set_property', 'select_instances', 'create_model', 'insert_toolbox_model', 'terrain_edit', 'lighting_set', 'create_ui_image', 'create_ui', 'undo', 'redo']);

const CHATS_KEY = 'rotex_web_chats'; // must precede the readChatStore() call below (TDZ)
// Must also precede the state block: state.bridgeCode calls
// getOrCreateBridgeCode() -> bridgeCodeExpired(), which reads this const (TDZ).
const BRIDGE_CODE_TTL_MS = 6 * 60 * 60 * 1000;
const _chatStore = readChatStore();
const state = {
  auth: null,
  provider: null,
  user: null,
  idToken: '',
  // Ask mode is gone — anyone whose saved preference was 'ask' lands on Agent.
  // Single mode now: Agent. (Supreme was replaced by the Low/Medium/Hard
  // effort picker -- depth is a per-message dial, not a separate mode.)
  mode: 'agent',
  bridgeCode: getOrCreateBridgeCode(),
  context: null,
  pluginConnected: false,
  lastResult: 0,
  busy: false,
  studioErrors: [],
  chats: _chatStore.chats,
  currentChatId: _chatStore.currentId,
  messages: ((_chatStore.chats.find((c) => c.id === _chatStore.currentId) || _chatStore.chats[0]).messages || []).slice(),
  pluginPromptOpen: false,
  lastBridgeMeta: null,
  bridgeInstances: new Set(),
};

// Bridge codes rotate: each code lives 6 hours (BRIDGE_CODE_TTL_MS, declared
// above the state block for TDZ), then a fresh one replaces it (or the user
// hits "Refresh code" for a new one on demand). The old code is deleted
// locally, so its pairing dies with it and the plugin must be given the new
// code.
function generateBridgeCode() {
  // 32-char unambiguous alphabet (no I/O/0/1). 6 chars = 32^6 ~= 1.07 billion
  // combinations, generated with a cryptographic RNG (not Math.random) so a
  // pairing code can't be predicted or feasibly enumerated. 32 divides 2^32
  // evenly, so `% 32` has no modulo bias.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const n = 6;
  let bytes;
  try {
    bytes = new Uint32Array(n);
    (self.crypto || window.crypto).getRandomValues(bytes);
  } catch { bytes = null; }
  let code = 'RX';
  for (let i = 0; i < n; i++) {
    const r = bytes ? bytes[i] : Math.floor(Math.random() * 0x100000000);
    code += chars[r % chars.length];
  }
  return code;
}

function storeBridgeCode(code) {
  try {
    localStorage.setItem('rotex_web_bridge_code', code);
    localStorage.setItem('rotex_web_bridge_code_ts', String(Date.now()));
  } catch {}
  return code;
}

function bridgeCodeExpired() {
  const ts = Number(localStorage.getItem('rotex_web_bridge_code_ts') || 0);
  return !ts || (Date.now() - ts) >= BRIDGE_CODE_TTL_MS;
}

function getOrCreateBridgeCode() {
  const existing = cleanCode(localStorage.getItem('rotex_web_bridge_code'));
  if (existing.length >= 4 && !bridgeCodeExpired()) return existing;
  return storeBridgeCode(generateBridgeCode()); // expired (or legacy/no timestamp) -> new code
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
}

// Delete the current code and switch to a brand-new one (manual "Refresh code"
// or the 6-hour auto-rotation). The old pairing dies immediately: the plugin
// keeps polling the dead code and gets nothing, so Studio shows disconnected
// until the user pastes the new code into the plugin.
function rotateBridgeCode() {
  const code = storeBridgeCode(generateBridgeCode());
  state.bridgeCode = code;
  state.pluginConnected = false;
  if (els.bridgeCode) els.bridgeCode.textContent = code;
  if (els.pluginModalCode) els.pluginModalCode.textContent = code;
  renderBridge({});
  return code;
}

// ── Multi-chat store ───────────────────────────────────────────────────────
// Each chat = { id, title, messages:[{role,content}], updatedAt }. Persisted
// as { currentId, chats:[...] } under CHATS_KEY. Legacy single-chat data
// (rotex_web_messages) is migrated in on first load. CHATS_KEY is declared
// above the state block so readChatStore() can use it without a TDZ error.

function newChatId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function chatTitleFrom(messages) {
  const firstUser = (messages || []).find((m) => m && m.role === 'user');
  const t = firstUser ? String(firstUser.content || '').replace(/\s+/g, ' ').trim() : '';
  return t ? t.slice(0, 42) : 'New chat';
}

function readChatStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHATS_KEY) || 'null');
    if (raw && Array.isArray(raw.chats) && raw.chats.length) {
      const chats = raw.chats
        .filter((c) => c && c.id)
        .map((c) => ({
          id: c.id,
          title: c.title || chatTitleFrom(c.messages),
          messages: Array.isArray(c.messages) ? c.messages.slice(-28) : [],
          updatedAt: Number(c.updatedAt) || 0,
        }));
      if (chats.length) {
        const currentId = chats.some((c) => c.id === raw.currentId) ? raw.currentId : chats[0].id;
        return { currentId, chats };
      }
    }
  } catch {}
  // First load (or corrupt store): migrate a legacy single chat if present.
  let legacy = [];
  try { legacy = JSON.parse(localStorage.getItem('rotex_web_messages') || '[]'); } catch {}
  legacy = Array.isArray(legacy) ? legacy.slice(-28) : [];
  const id = newChatId();
  return { currentId: id, chats: [{ id, title: chatTitleFrom(legacy), messages: legacy, updatedAt: Date.now() }] };
}

function currentChat() {
  return state.chats.find((c) => c.id === state.currentChatId) || state.chats[0] || null;
}

function persistChatStore() {
  const chats = state.chats
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, 40) // keep the 40 most recent chats
    .map((c) => ({ id: c.id, title: c.title, messages: (c.messages || []).slice(-28), updatedAt: c.updatedAt || 0 }));
  try { localStorage.setItem(CHATS_KEY, JSON.stringify({ currentId: state.currentChatId, chats })); } catch {}
}

// Called after every message change: fold the working messages back into the
// current chat, then persist + refresh the sidebar list.
function saveMessages() {
  const chat = currentChat();
  if (chat) {
    chat.messages = state.messages.slice(-28);
    chat.title = chatTitleFrom(chat.messages);
    chat.updatedAt = Date.now();
  }
  persistChatStore();
  renderChatList();
}

function newChat() {
  if (state.busy) return;
  const chat = { id: newChatId(), title: 'New chat', messages: [], updatedAt: Date.now() };
  state.chats.push(chat);
  state.currentChatId = chat.id;
  state.messages = [];
  state.pluginPromptOpen = false;
  persistChatStore();
  renderHistory();
  renderChatList();
  els.input && els.input.focus();
}

function switchChat(id) {
  if (id === state.currentChatId || state.busy) return;
  saveMessages(); // fold the working messages back before leaving
  const chat = state.chats.find((c) => c.id === id);
  if (!chat) return;
  state.currentChatId = id;
  state.messages = (chat.messages || []).slice();
  persistChatStore();
  renderHistory();
  renderChatList();
}

function deleteChat(id) {
  state.chats = state.chats.filter((c) => c.id !== id);
  if (state.currentChatId === id || !state.chats.length) {
    if (!state.chats.length) {
      state.chats.push({ id: newChatId(), title: 'New chat', messages: [], updatedAt: Date.now() });
    }
    const next = state.chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    state.currentChatId = next.id;
    state.messages = (next.messages || []).slice();
    renderHistory();
  }
  persistChatStore();
  renderChatList();
}

function renderChatList() {
  const el = els.chatList;
  if (!el) return;
  const chats = state.chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  el.innerHTML = '';
  for (const c of chats) {
    const item = document.createElement('div');
    item.className = 'chat-item' + (c.id === state.currentChatId ? ' active' : '');
    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'chat-item-label';
    label.textContent = c.title || 'New chat';
    label.title = c.title || 'New chat';
    label.addEventListener('click', () => switchChat(c.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-item-del';
    del.setAttribute('aria-label', 'Delete chat');
    del.textContent = '×';
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteChat(c.id); });
    item.append(label, del);
    el.appendChild(item);
  }
}

// ── Safe markdown rendering ────────────────────────────────────────────────
// AI replies contain markdown (**bold**, # headings, lists, `code`, ```blocks```).
// Rendered as PLAIN TEXT before, so users saw literal asterisks. This renders a
// safe subset to HTML. Every piece of model text is HTML-escaped FIRST, so raw
// HTML in a reply can never execute (important under the site CSP) -- only the
// known-safe tags this function inserts are ever produced.
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderMarkdown(text) {
  const blocks = [];
  const withPlaceholders = String(text || '').replace(/\r\n/g, '\n').replace(/```([^\n`]*)\n([\s\S]*?)```/g, (_, info, code) => {
    // A ```file:Service/Name.lua fence gets a filename header; a plain ```lang
    // fence just shows the code. Keeps Ask-mode "build" output clean.
    const infoStr = String(info || '').trim();
    const fileMatch = infoStr.match(/^file:\s*(.+)$/i);
    const label = fileMatch ? fileMatch[1].trim() : '';
    const header = label ? '<div class="code-file">' + escapeHtml(label) + '</div>' : '';
    blocks.push('<div class="code-wrap">' + header + '<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, '')) + '</code></pre></div>');
    return 'RX0B' + (blocks.length - 1) + 'RX0';
  });
  const lines = withPlaceholders.split('\n');
  let html = '';
  let list = null; // 'ul' | 'ol'
  const closeList = () => { if (list) { html += '</' + list + '>'; list = null; } };
  for (const line of lines) {
    const ph = line.match(/^RX0B(\d+)RX0$/);
    if (ph) { closeList(); html += blocks[Number(ph[1])]; continue; }
    if (!line.trim()) { closeList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); const lvl = Math.min(h[1].length + 2, 6); html += '<h' + lvl + '>' + renderInline(escapeHtml(h[2])) + '</h' + lvl + '>'; continue; }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ol) { if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; } html += '<li>' + renderInline(escapeHtml(ol[1])) + '</li>'; continue; }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) { if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; } html += '<li>' + renderInline(escapeHtml(ul[1])) + '</li>'; continue; }
    closeList();
    html += '<p>' + renderInline(escapeHtml(line)) + '</p>';
  }
  closeList();
  return html;
}

function addMessage(role, text, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extraClass}`.trim();
  if (role === 'user') div.textContent = text;      // user input stays literal
  else div.innerHTML = renderMarkdown(text);          // AI/status replies render markdown
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function fileNameFromPath(path) {
  let base = String(path || 'Script').split(/[\\/]/).pop() || 'Script';
  if (!/\.(lua|luau|txt|md|json)$/i.test(base)) base += '.lua';
  return base;
}

function downloadTextFile(name, content) {
  try {
    const blob = new Blob([String(content || '')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  } catch {}
}

// Adds a "Download" button to a message when the answer contains file blocks,
// so users can grab the scripts even outside Studio.
function addDownloadAction(bubble, files) {
  if (!bubble || !Array.isArray(files) || !files.length) return;
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn';
  btn.textContent = files.length === 1
    ? `⬇ Download ${fileNameFromPath(files[0].path)}`
    : `⬇ Download ${files.length} scripts`;
  btn.addEventListener('click', () => {
    files.forEach((f, i) => setTimeout(() => downloadTextFile(fileNameFromPath(f.path), f.content), i * 250));
  });
  actions.appendChild(btn);
  bubble.appendChild(actions);
}

function setRunState(label, detail = '', mini = '') {
  if (els.runState) els.runState.textContent = label;
  if (els.runDetail) els.runDetail.textContent = detail;
  if (els.runMini) els.runMini.textContent = mini;
}

function addEmptyWorkbench() {
  const shell = document.createElement('div');
  shell.className = 'forge-empty';
  if (!state.user) {
    // Signed-out: the login gate means chat won't send until you sign in, so
    // lead with that instead of build prompts that would just bounce.
    shell.innerHTML = `
      <div class="forge-badge">ROTEX · Roblox Dev Studio</div>
      <h1>Sign in to start building.</h1>
      <p>Log in to chat with ROTEX and get full, copy-paste-ready Roblox scripts, UI, and systems — right from your browser.</p>
      <button class="forge-signin" type="button" id="workbenchSignIn">Sign in to ROTEX</button>
    `;
    els.messages.appendChild(shell);
    shell.querySelector('#workbenchSignIn')?.addEventListener('click', () => signIn());
    return;
  }
  // Signed in: greet the user by name so the main screen clearly reflects
  // their logged-in state (never a "log in" prompt).
  const firstName = (state.user?.displayName || state.user?.email || '').trim().split(/[\s@]/)[0] || '';
  shell.innerHTML = `
    <div class="forge-badge">ROTEX · Roblox Dev Studio</div>
    <h1>${firstName ? `Welcome back, ${escapeHtml(firstName)}.` : 'What are we building?'}</h1>
    <p>${firstName ? 'What are we building today? ' : ''}ROTEX edits your game live through the Studio plugin. Crank the mode to Medium or Hard for bigger, more polished builds. Pick a starter or just type what you want.</p>
    <div class="forge-grid">
      <button class="forge-card" type="button" data-seed="Make a polished Roblox shop UI that appears in game, is mobile-safe, and has one LocalScript owner."><strong>UI Generator</strong><span>ScreenGui, buttons, mobile scale, visible layout, behavior owner.</span></button>
      <button class="forge-card" type="button" data-seed="Debug the latest broken feature. Search every likely owner script, fix the real cause, and remove duplicates."><strong>Bug Repair</strong><span>Find wrong paths, duplicate scripts, invisible GUI, nil errors, stale owners.</span></button>
      <button class="forge-card" type="button" data-seed="Build a Roblox map area using terrain, lighting, and Toolbox models only for static world props."><strong>Map Builder</strong><span>World props, terrain, lighting, placement, no Toolbox for scripts/UI.</span></button>
    </div>
  `;
  els.messages.appendChild(shell);
  shell.querySelectorAll('[data-seed]').forEach((button) => {
    button.addEventListener('click', () => {
      els.input.value = button.dataset.seed || '';
      autosizeInput();
      els.input.focus();
    });
  });
}

function pluginConnectText() {
  return [
    'Agent mode edits your real Roblox game, so it needs the ROTEX Studio plugin.',
    '',
    'Get the plugin (one-time):',
    '1. Install ROTEX from the Roblox Creator Store: https://create.roblox.com/store/asset/136503150523656/ROTEX',
    '2. In Roblox Studio, open the Plugins tab and click ROTEX to open its panel. Click Allow when Studio asks about HTTP.',
    '',
    'Connect it:',
    `3. Paste this bridge code into the ROTEX plugin:  ${state.bridgeCode}`,
    '4. Click Connect in the plugin, then press "Check Plugin" below.',
  ].join('\n');
}

// ── Connect-plugin modal ────────────────────────────────────────────────
// A centered popup that shows the bridge code + a Check Plugin button. Opens
// whenever a signed-in user tries to send without the Studio plugin connected,
// and auto-closes (resuming the queued message) the moment the plugin connects.
function openPluginModal(pendingText = '') {
  if (!els.pluginModal) return;
  state.pluginPromptOpen = true;
  state.pluginPending = pendingText || state.pluginPending || '';
  if (els.pluginModalCode) els.pluginModalCode.textContent = state.bridgeCode;
  setPluginModalStatus(state.pluginConnected);
  els.pluginModal.hidden = false;
}

function closePluginModal() {
  if (!els.pluginModal) return;
  els.pluginModal.hidden = true;
  state.pluginPromptOpen = false;
}

function setPluginModalStatus(connected) {
  if (!els.pluginModalStatusRow || !els.pluginModalStatus) return;
  els.pluginModalStatusRow.classList.toggle('ok', Boolean(connected));
  els.pluginModalStatus.textContent = connected ? 'Plugin connected!' : 'Waiting for the plugin…';
}

// Called by the poll loop when the plugin connects while the modal is open:
// close it and fire off whatever the user was trying to send.
function onPluginConnectedWhileWaiting() {
  if (!state.pluginPromptOpen) return;
  setPluginModalStatus(true);
  const pending = state.pluginPending || '';
  state.pluginPending = '';
  setTimeout(() => {
    closePluginModal();
    if (pending.trim()) sendMessage(pending, { skipUserRender: false, allowPluginPrompt: false });
  }, 550);
}

function renderHistory() {
  els.messages.innerHTML = '';
  if (!state.messages.length) {
    addEmptyWorkbench();
    return;
  }
  for (const m of state.messages) addMessage(m.role, m.content);
}

function pushHistory(role, content) {
  state.messages.push({ role, content: String(content || '') });
  // Trim silently -- this is an instant array slice. The old "Compacting
  // text..." status bubble was never removed by anything, so it sat in the
  // chat forever looking like a stuck operation.
  if (state.messages.length > 24) state.messages = state.messages.slice(-18);
  saveMessages();
}

function setMode() {
  state.mode = 'agent';
  els.input.placeholder = 'Tell ROTEX what to make, edit, debug, or remove...';
  setRunState(
    state.pluginConnected ? 'Ready' : 'Connect Studio',
    state.pluginConnected
      ? 'Agent will apply real changes through the plugin.'
      : 'Agent needs the Studio plugin before it can edit.',
    'Edit workflow',
  );
}

async function initAuth() {
  try {
    const res = await fetch('/api/firebase-config');
    const cfg = await res.json();
    if (!cfg.configured || !cfg.firebaseConfig) return;
    const [{ initializeApp }, authMod] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js'),
    ]);
    const app = initializeApp(cfg.firebaseConfig);
    state.auth = authMod.getAuth(app);
    state.provider = new authMod.GoogleAuthProvider();
    authMod.onAuthStateChanged(state.auth, async (user) => {
      state.user = user || null;
      state.idToken = user ? await user.getIdToken(true).catch(() => '') : '';
      renderAccount();
      // Login required: once Firebase confirms there's no signed-in user, send
      // them straight to the sign-in page (returning here afterward). Firebase
      // persists sessions, so a real signed-in user gets `user` here and is
      // never bounced. replace() keeps /app out of history (no back-button loop).
      if (!user) {
        window.location.replace('/login?return=' + encodeURIComponent('/app'));
      } else {
        // Signed in and staying: deliver (and clear) any homepage handoff prompt
        // that was preserved across the login redirect.
        consumeLandingPrompt();
        // Recognize Pro even on a fresh browser: mint/refresh the signed pass
        // from the Firebase identity so the badge + higher caps show without a
        // detour through /account. Fire-and-forget; the display re-renders when
        // it resolves.
        refreshProPass();
        // Pull the server-authoritative daily/monthly usage so the balance shown
        // is real (and reflects resets) instead of a stale per-browser counter.
        syncServerUsage();
      }
    });
  } catch (error) {
    console.warn('ROTEX auth init failed', error);
  }
}

function signIn() {
  // Full-page login (a whole dedicated page), then return to the app signed in.
  // Firebase persists the session across pages, so /app picks it up on return.
  window.location.href = '/login?return=' + encodeURIComponent('/app');
}

async function signOut() {
  if (!state.auth) return;
  const mod = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js');
  await mod.signOut(state.auth).catch(() => {});
  state.user = null;
  state.idToken = '';
  renderAccount();
}

function renderAccount() {
  const user = state.user;
  els.signIn.hidden = Boolean(user);
  els.signOut.hidden = !user;
  els.accountName.textContent = user?.displayName || (user ? 'Signed in' : 'Guest');
  els.accountEmail.textContent = user?.email || 'Sign in for Pro and cloud tokens';
  els.avatar.textContent = '?';
  els.avatar.innerHTML = '';
  if (user?.photoURL) {
    const img = document.createElement('img');
    img.src = user.photoURL;
    img.alt = user.displayName || user.email || 'Profile';
    els.avatar.appendChild(img);
  } else {
    els.avatar.textContent = (user?.displayName || user?.email || '?').trim().charAt(0).toUpperCase() || '?';
  }
  renderPlan();
  // Swap the empty state between signed-out (sign-in CTA) and signed-in (build
  // cards) the moment auth resolves -- only while no real conversation exists.
  if (!state.messages.length) renderHistory();
}

// Show the plan badge, TexToken balance, and the right upgrade CTA. Pro status
// is read from the locally cached signed pass (rotexTokens.isProUser), so it
// reflects a real purchase even before any server round-trip.
function renderPlan() {
  const row = els.accountPlanRow;
  if (!row) return;
  // Only surface plan/balance once signed in -- guests are redirected to /login
  // anyway, and an empty "Free" chip on the sign-in screen just adds noise.
  if (!state.user) { row.hidden = true; window.__rotexSignedIn = false; return; }
  row.hidden = false;
  // Signed-in: the balance display must wait for (and only ever trust) the
  // server sync -- see refreshBalanceDisplay in rotex-tokens.js.
  window.__rotexSignedIn = true;
  const isPro = Boolean(window.rotexTokens && window.rotexTokens.isProUser && window.rotexTokens.isProUser());
  if (els.planBadge) {
    els.planBadge.textContent = isPro ? 'Pro' : 'Free';
    els.planBadge.classList.toggle('pro', isPro);
  }
  // Free users get the "Get Pro" CTA; Pro users get a "Buy TexTokens" top-up link.
  if (els.getPro) els.getPro.hidden = isPro;
  if (els.buyTokens) els.buyTokens.hidden = !isPro;
  if (window.rotexTokens && window.rotexTokens.refreshBalanceDisplay) {
    window.rotexTokens.refreshBalanceDisplay();
  }
}

// Ask the server to reissue the Pro pass from the signed-in identity. For a
// one-time 30-day pass it hands the cached pass back unchanged; for a legacy
// subscription it re-signs against Stripe. Stores the fresh pass and re-renders
// the plan. Fail-open: a network hiccup just leaves the current display alone.
async function refreshProPass() {
  try {
    const res = await fetch('/api/refresh-pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proPass: localStorage.getItem('rotex_pro_pass') || '',
        authToken: state.idToken || '',
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.refreshed && data.proPass) {
      localStorage.setItem('rotex_pro_pass', data.proPass);
    } else if (data.cancelled) {
      localStorage.removeItem('rotex_pro_pass');
    }
  } catch (_) {
    // Offline or endpoint unavailable -- keep whatever pass is already cached.
  }
  renderPlan();
}

// Read the real server-side usage (day/month used) so the TexToken balance the
// user sees matches the server. The display shows a syncing placeholder until
// this lands (signed-in users NEVER see the drift-prone local estimate), so
// this must be relentless: retry on failure, refresh the token on an auth
// rejection, and keep trying until the first success.
async function syncServerUsage(attempt = 0) {
  if (!state.user || !state.idToken) return;
  try {
    // NOTE: must be /api/chat/billing-sync (the chat function handles it via
    // the /api/chat/:path* rewrite -- same as editor.html). The bare
    // /api/billing-sync has NO route and 404s: that single wrong URL kept the
    // web app's balance display permanently out of sync with the server.
    const res = await fetch('/api/chat/billing-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: state.user.uid,
        authToken: state.idToken,
        localBalance: (window.rotexTokens && window.rotexTokens.getPurchased) ? window.rotexTokens.getPurchased() : 0,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data || !data.ok) {
      // Stale token is the common failure -- refresh it before the retry.
      if (data && data.error === 'auth_expired' && state.user) {
        state.idToken = await state.user.getIdToken(true).catch(() => state.idToken || '');
      }
      throw new Error(data?.error || 'sync_failed');
    }
    window.__rotexServerUsage = data.usage || { dayUsed: 0, monthUsed: 0 };
    if (data.balance != null && window.rotexTokens && window.rotexTokens.savePurchased) {
      window.rotexTokens.savePurchased(data.balance);
    }
    if (window.rotexTokens && window.rotexTokens.refreshBalanceDisplay) {
      window.rotexTokens.refreshBalanceDisplay();
    }
  } catch (_) {
    // Keep the syncing placeholder honest: retry with backoff until the first
    // success (5s, 10s, 20s, then every 30s). The 60s interval in init() keeps
    // it fresh afterwards.
    if (!window.__rotexServerUsage) {
      const delay = Math.min(30000, 5000 * Math.pow(2, Math.min(attempt, 2)));
      setTimeout(() => syncServerUsage(attempt + 1), delay);
    }
  }
}

async function bridgePost(op, body = {}) {
  const res = await fetch('/api/plugin-bridge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, op, code: state.bridgeCode }),
  });
  return res.json().catch(() => ({ ok: false }));
}

async function bridgeGet(op, params = {}) {
  const qs = new URLSearchParams({ op, code: state.bridgeCode, ...params });
  const res = await fetch(`/api/plugin-bridge?${qs.toString()}`);
  return res.json().catch(() => ({ ok: false }));
}

async function pollBridge() {
  try {
    const hello = await bridgePost('web_hello');
    if (hello.ok) renderBridge(hello);
    const ctxRes = await bridgeGet('context');
    if (ctxRes.ok) {
      state.context = ctxRes.context || state.context;
      state.pluginConnected = Boolean(ctxRes.pluginConnected);
      renderBridge(ctxRes);
    }
    const results = await bridgeGet('results', { since: String(state.lastResult || 0) });
    if (results.ok) {
      state.pluginConnected = Boolean(results.pluginConnected);
      state.lastResult = results.last || state.lastResult;
      renderBridge(results);
      for (const result of results.results || []) renderStudioResult(result);
    }
  } catch {
    state.pluginConnected = false;
    renderBridge({});
  }
  // If the connect-plugin modal is waiting and Studio just connected, close it
  // and fire off the message the user was trying to send.
  if (state.pluginConnected && state.pluginPromptOpen) onPluginConnectedWhileWaiting();
  else if (state.pluginPromptOpen) setPluginModalStatus(false);
}

async function checkPluginAndResume(pendingText = '', button = null, bubble = null) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking...';
  }
  await pollBridge();
  if (state.pluginConnected) {
    if (bubble && bubble._textEl) bubble._textEl.innerHTML = renderMarkdown('Plugin connected. Sending your message now...');
    state.pluginPromptOpen = false;
    if (pendingText && pendingText.trim()) await sendMessage(pendingText, { skipUserRender: true, allowPluginPrompt: false });
    else addMessage('assistant', 'Plugin connected. You can talk to ROTEX now.', 'status');
  } else {
    if (bubble && bubble._textEl) bubble._textEl.innerHTML = renderMarkdown(pluginConnectText() + '\n\nStill not connected yet. Make sure the code matches and click Connect in the Studio plugin.');
    if (button) {
      button.disabled = false;
      button.textContent = 'Check Plugin';
    }
  }
}

function renderBridge(meta = {}) {
  if (meta.bridgeInstance) state.bridgeInstances.add(meta.bridgeInstance);
  if (Object.keys(meta).length) state.lastBridgeMeta = meta;
  els.bridgeCode.textContent = state.bridgeCode;
  const ctx = state.context || {};
  const connected = Boolean(meta.pluginConnected || state.pluginConnected);
  els.pluginDot.classList.toggle('ok', connected);
  els.pluginDot.classList.toggle('wait', !connected);
  els.pluginStatus.textContent = connected ? 'Studio plugin connected' : 'Waiting for Studio plugin';
  if (els.connectStudio) {
    els.connectStudio.classList.toggle('ok', connected);
    if (els.connectStudioLabel) els.connectStudioLabel.textContent = connected ? 'Studio Connected' : 'Connect Studio';
    els.connectStudio.title = connected ? 'Roblox Studio plugin is connected' : 'Connect the Roblox Studio plugin';
  }
  // Keep the modal's live status dot in sync while it's open.
  if (state.pluginPromptOpen) setPluginModalStatus(connected);
  if (els.bridgeHealth) els.bridgeHealth.textContent = connected ? 'Live' : meta.bridgeStorage === 'memory' ? 'Syncing' : 'Waiting';
  els.ctxPlugin.textContent = connected ? (meta.pluginVersion || ctx.pluginVersion || 'Connected') : 'Disconnected';
  els.ctxGame.textContent = meta.gameName || ctx.gameName || ctx.project || 'Unknown';
  els.ctxScripts.textContent = String(Array.isArray(ctx.scripts) ? ctx.scripts.length : 0);
  els.ctxGui.textContent = String(Array.isArray(ctx.gui) ? ctx.gui.length : 0);
  if (els.ctxActions) els.ctxActions.textContent = String(meta.pendingActions ?? meta.queued ?? 0);
  if (els.ctxBridge) {
    const storage = meta.bridgeStorage || 'memory';
    const nodes = state.bridgeInstances.size > 1 ? ` / ${state.bridgeInstances.size} nodes` : '';
    els.ctxBridge.textContent = `${storage}${nodes}`;
  }
  if (!state.busy) {
    setRunState(
      connected ? 'Ready' : 'Connect Studio',
      connected ? 'Studio context is live. ROTEX can edit your game now.' : 'Paste the bridge code into the plugin, then press Check Plugin.',
      `${meta.pendingActions ?? meta.queued ?? 0} edit(s) queued`,
    );
  }
}

function renderStudioResult(result) {
  const messages = Array.isArray(result.messages) ? result.messages : [result.message || result.text || 'Studio action finished'];
  const text = messages.filter(Boolean).join('\n');
  if (!text.trim()) return;
  const row = document.createElement('div');
  row.textContent = `${result.ok === false ? 'Problem' : 'Done'}: ${text}`;
  els.resultLog.prepend(row);
  while (els.resultLog.children.length > 20) els.resultLog.lastChild.remove();
  if (result.type === 'studio_error') {
    state.studioErrors.push({ t: Date.now(), type: 'Error', msg: text });
    state.studioErrors = state.studioErrors.slice(-12);
  }
}

function normalizeFilePath(raw) {
  let p = String(raw || '').trim().replace(/^['"`]+|['"`]+$/g, '');
  p = p.replace(/^game:GetService\(["']([^"']+)["']\)[./\\]?/i, '$1/');
  p = p.replace(/^game[./\\]/i, '');
  p = p.replace(/^workspace[./\\]/i, 'Workspace/');
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/');
  const extMatch = p.match(/(\.(?:client|server|module)?\.?lua)$/i);
  const ext = extMatch ? extMatch[1] : '';
  let base = ext ? p.slice(0, -ext.length) : p;
  if (!base.includes('/')) base = base.replace(/\./g, '/');
  p = (base + ext).replace(/\/+/g, '/');
  if (/^(StarterPlayerScripts|StarterCharacterScripts)\//i.test(p)) p = 'StarterPlayer/' + p;
  return p;
}

function looseJson(raw) {
  let s = String(raw || '').trim();
  try { return JSON.parse(s); } catch {}
  const start = s.search(/[\[{]/);
  if (start < 0) return null;
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  const end = s.lastIndexOf(close);
  if (end <= start) return null;
  s = s.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(s); } catch {}
  return null;
}

function extractStudioFiles(content) {
  const text = String(content || '').replace(/\r\n/g, '\n');
  const files = [];
  const fenceRe = /```\s*file:\s*([^\n`]+)\n([\s\S]*?)```|```\s*file:\s*([^\s`]+)\s+([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(text))) {
    const path = normalizeFilePath(match[1] || match[3] || '');
    const body = String(match[2] ?? match[4] ?? '').replace(/^\n+|\n+$/g, '');
    if (VALID_ROOT.test(path) && body) files.push({ path, content: body });
  }
  return files;
}

function extractStudioActions(content) {
  const actions = [];
  const text = String(content || '').replace(/\r\n/g, '\n');
  let match;
  const actionRe = /```\s*studio-action[^\n]*\n([\s\S]*?)```/g;
  while ((match = actionRe.exec(text))) {
    const parsed = looseJson(match[1]);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const action of list) {
      if (action && typeof action === 'object' && ACTION_TYPES.has(action.type)) actions.push(action);
    }
  }
  const modelRe = /```\s*roblox-model[^\n]*\n([\s\S]*?)```/g;
  while ((match = modelRe.exec(text))) {
    const parsed = looseJson(match[1]);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const model of list) {
      if (model && typeof model === 'object') actions.push({ type: 'create_model', ...model });
    }
  }
  const emptyFileRe = /```\s*file:\s*([^\n`]+)\n\s*```/g;
  while ((match = emptyFileRe.exec(text))) {
    const rawPath = String(match[1] || '').trim();
    if (rawPath && VALID_ROOT.test(normalizeFilePath(rawPath))) actions.push({ type: 'delete_instance', path: normalizeFilePath(rawPath) });
  }
  return actions;
}

function stripExecutableBlocks(content) {
  return String(content || '')
    .replace(/```\s*file:[^\n`]+\n[\s\S]*?```/gi, '')
    .replace(/```\s*studio-action[^\n]*\n[\s\S]*?```/gi, '')
    .replace(/```\s*roblox-model[^\n]*\n[\s\S]*?```/gi, '')
    .replace(/```\s*project-memory[^\n]*\n[\s\S]*?```/gi, '')
    .replace(/```[\s\S]*$/g, '')
    .trim();
}

function looksLikeSourceCode(content) {
  const text = String(content || '');
  if (/```(?:file:|lua|luau|studio-action|roblox-model)/i.test(text)) return true;
  return [
    /\blocal\s+\w+\s*=/,
    /\bInstance\.new\s*\(/,
    /\bgame:GetService\s*\(/,
    /\bfunction\s+\w*/,
    /\bend\b/,
    /\bUDim2\.new\s*\(/,
    /\bColor3\.fromRGB\s*\(/,
    /\bEnum\.[A-Za-z]+/,
  ].filter((re) => re.test(text)).length >= 2;
}

function visibleAssistantText(content, fallback = '') {
  const visible = stripExecutableBlocks(content).replace(/\n{3,}/g, '\n\n').trim();
  if (!visible || looksLikeSourceCode(visible)) return fallback;
  return visible;
}

function buildProjectContext() {
  const ctx = state.context || {};
  const scripts = Array.isArray(ctx.scripts) ? ctx.scripts : [];
  const gui = Array.isArray(ctx.gui) ? ctx.gui : [];
  const selected = Array.isArray(ctx.selected) ? ctx.selected : [];
  const caps = Array.isArray(ctx.capabilities) && ctx.capabilities.length
    ? ctx.capabilities.join(', ')
    : 'apply_files, create_model geometry, insert_toolbox_model (any model/prop/vehicle/weapon/character/furniture the user wants), terrain_edit, lighting_set, create_ui, create_ui_image, set_property, delete_instance, select_instances, undo/redo (real Ctrl+Z history)';
  let out = [
    'ROTEX UI MODE: AGENT.',
    `PLUGIN CAPABILITIES: ${caps}.`,
    'The web app hides executable file/studio-action/roblox-model blocks and queues them to the Roblox Studio plugin.',
    'Agent/Super Agent edit the actual Studio game through executable blocks. Never refuse, never just ask what they want, never tell them to switch modes -- make a smart assumption and build it.',
  ].join('\n');
  if (scripts.length) {
    out += `\n\nPROJECT SCRIPTS (live from Roblox Studio - ${scripts.length} scripts). Search these before editing:`;
    // Budget the scripts section: every char here is billed as model input on
    // EVERY message, so an uncapped dump (120 scripts x 12k chars ~= 1.4MB)
    // made single messages cost a fortune. ~45k chars (~11k tokens) keeps
    // plenty of context while keeping per-message cost sane. Per-script cap
    // 8k; stop adding whole scripts once the budget is spent (never truncate
    // the WORLD OBJECTS / SELECTION sections that follow -- deletes need them).
    let scriptChars = 0;
    for (const s of scripts.slice(0, 60)) {
      const src = String(s.source || '').slice(0, 8000);
      const path = normalizeFilePath(s.path || s.name || 'Script');
      const chunk = `\n\n--- ${path} [${s.class || 'Script'}] ---\n${src}`;
      if (scriptChars + chunk.length > 45000) { out += `\n\n(...more scripts omitted to keep context small - ask to focus on a specific script if needed)`; break; }
      scriptChars += chunk.length;
      out += chunk;
    }
  } else {
    out += '\n\nPROJECT SCRIPTS: none scanned yet. If this is an edit request and the plugin is disconnected, ask for connection instead of pretending.';
  }
  if (gui.length) {
    out += '\n\nPROJECT GUI INVENTORY (live from StarterGui - use this to fix invisible/duplicate UI):';
    for (const g of gui.slice(0, 100)) {
      const bits = [
        g.class || 'GuiObject',
        g.path || g.name || 'Unknown',
        g.enabled !== undefined ? `Enabled=${g.enabled}` : '',
        g.visible !== undefined ? `Visible=${g.visible}` : '',
        g.resetOnSpawn !== undefined ? `ResetOnSpawn=${g.resetOnSpawn}` : '',
        g.displayOrder !== undefined ? `DisplayOrder=${g.displayOrder}` : '',
        g.zIndex !== undefined ? `ZIndex=${g.zIndex}` : '',
        g.size ? `Size=${g.size}` : '',
        g.position ? `Position=${g.position}` : '',
        g.text ? `Text="${String(g.text).replace(/\s+/g, ' ').slice(0, 80)}"` : '',
      ].filter(Boolean);
      out += `\n- ${bits.join(' | ')}`;
    }
  }
  const instances = Array.isArray(ctx.instances) ? ctx.instances : [];
  if (instances.length) {
    out += `\n\nWORLD OBJECTS (live from Workspace/Storage - ${instances.length}). These Models/Folders/Parts can be deleted, edited, or selected by copying their EXACT path into a studio-action (delete_instance / set_property / select_instances):`;
    for (const o of instances.slice(0, 60)) {
      out += `\n- ${o.class || 'Instance'} | ${o.path || o.name || 'Unknown'}`;
    }
  }
  if (selected.length) out += `\n\nCURRENTLY SELECTED IN STUDIO: ${selected.map((x) => x.path || x.name).join(', ')}`;
  const recentErrors = state.studioErrors.filter((e) => Date.now() - e.t < 60000);
  if (recentErrors.length) {
    out += '\n\nRECENT STUDIO OUTPUT:\n' + recentErrors.map((e) => `[${e.type}] ${e.msg}`).join('\n');
  }
  return out;
}

function taskStatusFor(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(fix|debug|bug|broken|error|not working|still|doesn'?t work|didn'?t work)\b/.test(t)) return 'Debugging task...';
  if (/\b(done|finish|final|polish|cleanup|complete)\b/.test(t)) return 'Finishing task...';
  return 'Working on task...';
}

// ── Live streaming status ─────────────────────────────────────────────────
// While a build streams in, the bubble shows a light-gray line describing what
// the AI is doing right now (derived from the blocks it is writing), plus a ▾
// toggle (or the Down-Arrow key) that expands the full raw stream.
function initStreamBubble(bubble, initialLabel = 'Thinking...') {
  bubble.classList.add('streaming');
  bubble.innerHTML = '<div class="stream-status"><span class="stream-doing"></span><button type="button" class="stream-expand" title="Show everything it is writing (Down Arrow)">▾</button></div><pre class="stream-raw" hidden></pre>';
  bubble.querySelector('.stream-doing').textContent = initialLabel;
  bubble.querySelector('.stream-expand').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStreamRaw(bubble);
  });
}

function toggleStreamRaw(bubble) {
  const raw = bubble.querySelector('.stream-raw');
  const btn = bubble.querySelector('.stream-expand');
  if (!raw) return;
  raw.hidden = !raw.hidden;
  if (btn) btn.textContent = raw.hidden ? '▾' : '▴';
  if (!raw.hidden) raw.scrollTop = raw.scrollHeight;
}

// Mirrors the server's isRobloxMapBuildRequest trigger (api/chat.js) so the
// status line can honestly show the Toolbox search while it happens.
function looksLikeToolboxBuild(text) {
  const t = String(text || '').toLowerCase();
  const verb = /\b(make|create|build|add|generate|design|decorate|insert|place|put|spawn|fill|populate|import|bring in|drop in|get me|give me|need)\b/.test(t);
  const noun = /\b(map|maps|world|terrain|environment|level|lobby|arena|island|forest|city|town|village|dungeon|obby|building|buildings|house|houses|castle|cave|mountain|decor|decoration|scenery|prop|props|rock|rocks|tree|trees|plant|flower|model|models|asset|assets|furniture|chair|table|couch|sofa|bed|desk|door|window|fence|wall|car|cars|vehicle|vehicles|truck|boat|plane|helicopter|bike|tank|sword|swords|gun|guns|weapon|weapons|shield|armor|helmet|animal|animals|dog|cat|horse|dragon|monster|zombie|creature|statue|food|fruit|crate|barrel|box|chest|sign|light|lamp|lantern|torch|throne|gem|coin|key|potion|book|flag|tent|campfire)\b/.test(t);
  const pureLogic = /\b(script|localscript|modulescript|remoteevent|remotefunction|datastore|leaderstats|gamepass|developer product|shop ui|inventory ui|hud|menu ui|save system|currency system|admin panel|anticheat|dialogue system|quest system)\b/.test(t);
  return verb && noun && !pureLogic;
}

const STREAM_ACTION_LABELS = {
  delete_instance: 'Deleting old stuff...',
  set_property: 'Editing properties...',
  select_instances: 'Selecting objects...',
  create_model: 'Building 3D parts...',
  insert_toolbox_model: 'Inserting a model...',
  terrain_edit: 'Shaping terrain...',
  lighting_set: 'Adjusting lighting...',
  create_ui: 'Building the UI...',
  create_ui_image: 'Adding UI images...',
  undo: 'Undoing changes...',
  redo: 'Redoing changes...',
};

function describeStreamDoing(full) {
  const files = [...full.matchAll(/```\s*file:\s*([^\n`]+)/gi)];
  const actions = [...full.matchAll(/"type"\s*:\s*"(delete_instance|set_property|select_instances|create_model|insert_toolbox_model|terrain_edit|lighting_set|create_ui_image|create_ui|undo|redo)"/g)];
  const lastFile = files.length ? files[files.length - 1] : null;
  const lastAction = actions.length ? actions[actions.length - 1] : null;
  if (lastFile && (!lastAction || lastFile.index > lastAction.index)) {
    const name = String(lastFile[1]).trim().split(/[\\/]/).pop();
    return `Writing ${name}...`;
  }
  if (lastAction) return STREAM_ACTION_LABELS[lastAction[1]] || 'Applying Studio edits...';
  if (/```\s*roblox-model/i.test(full)) return 'Building 3D parts...';
  return full.trim() ? 'Planning...' : 'Thinking...';
}

function updateStreamBubble(bubble, full) {
  const hasExecutable = /```\s*(?:file:|studio-action|roblox-model)/i.test(full);
  if (!hasExecutable) {
    // Plain conversational reply: stream the markdown live like a normal
    // message -- no status scaffold needed.
    bubble.className = 'msg assistant';
    bubble.innerHTML = renderMarkdown(visibleAssistantText(full, 'Thinking...'));
    return;
  }
  // Build task: keep (or restore, if the reply started as plain text) the
  // status scaffold, update the doing-line, and mirror the raw stream.
  if (!bubble.querySelector('.stream-status')) initStreamBubble(bubble);
  bubble.className = 'msg assistant status streaming';
  bubble.querySelector('.stream-doing').textContent = describeStreamDoing(full);
  const raw = bubble.querySelector('.stream-raw');
  raw.textContent = full;
  if (!raw.hidden) raw.scrollTop = raw.scrollHeight;
}

async function queueExecutableBlocks(fullText, userText) {
  const files = extractStudioFiles(fullText);
  const actions = extractStudioActions(fullText);
  const actionId = `web-${Date.now().toString(36)}`;
  const queued = [];
  if (files.length) queued.push({ type: 'apply_files', id: actionId, files });
  for (const action of actions) queued.push({ ...action, id: action.id || actionId });
  if (!queued.length) return false;
  await bridgePost('queue', { actions: queued });
  renderStudioResult({
    ok: true,
    messages: [state.pluginConnected ? taskStatusFor(userText) : 'Queued Studio actions. Connect the plugin with the bridge code.'],
  });
  return true;
}

async function sendMessage(rawText, options = {}) {
  if (state.busy) return;
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
  if (!text.trim()) return;

  // Login required to chat -- guests can't send.
  if (!state.user) {
    if (!options.skipUserRender) addMessage('user', text);
    addMessage('assistant', 'Please log in to chat with ROTEX. Opening sign-in now...', 'status');
    els.input.value = '';
    autosizeInput();
    signIn();
    return;
  }

  // Every mode edits the game now, so the Studio plugin is always required.
  // Pop the connect-plugin modal instead of sending; it auto-resumes this
  // message once the plugin connects.
  if (!state.pluginConnected && options.allowPluginPrompt !== false) {
    if (!options.skipUserRender) addMessage('user', text);
    openPluginModal(text);
    els.input.value = '';
    autosizeInput();
    return;
  }

  state.busy = true;
  els.send.disabled = true;
  els.input.value = '';
  if (!options.skipUserRender) addMessage('user', text);
  pushHistory('user', text);
  setRunState(taskStatusFor(text), 'Planning, generating, and checking executable Studio edits.', 'Agent pass');
  // Live status bubble: a light-gray "what it's doing" line (no more static
  // "Working on task..."), with a ▾ toggle (or the Down-Arrow key) to watch
  // the full raw output stream in.
  const assistantBubble = addMessage('assistant', '', 'status');
  // If this request will trigger the server's Toolbox search, say so during
  // the pre-stream pause -- that IS what the server is doing right then.
  initStreamBubble(assistantBubble, looksLikeToolboxBuild(text)
    ? 'Searching the Roblox Toolbox for models...'
    : 'Thinking...');

  let full = '';
  let gotAny = false;
  try {
    // Greetings/small talk don't need (or want) the full game context and a
    // deep history -- every character of both is billed as model input, which
    // made "hi" cost real TexTokens. Mirror of the server classifier's
    // greeting regex: pure greetings only, so "hi can you build X" still gets
    // the full payload.
    // Also treat anything under 3 characters as small talk: a single stray
    // keypress ("H") once triggered a full rebuild of the user's stamina
    // system. Nothing that short can be a real build request.
    const isSmallTalk = text.trim().length <= 2
      || /^\s*(hi+|hello+|hey+|yo+|sup|wsg|wassup|what'?s ?up|bruh+|lol+|lmao+|xd|wow+|ok(ay)?|k|ty|thx|thanks?( you)?|good (morning|afternoon|evening)|are you (there|real|alive)|u there)[\s!.?~]*$/i.test(text);
    const history = state.messages.slice(isSmallTalk ? -4 : -18).map((m) => ({ role: m.role, content: m.content }));
    const modeForServer = 'editor';
    const authToken = state.user ? await state.user.getIdToken(true).catch(() => state.idToken || '') : '';
    if (authToken) state.idToken = authToken; // keep the cached token fresh for other calls
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authToken,
        model: els.model.value || 'google-flash',
        messages: history,
        projectMode: 'Roblox',
        projectContext: isSmallTalk
          ? 'ROTEX UI MODE: AGENT.\n(Small-talk message: full project context intentionally omitted. Reply conversationally; do not build.)'
          : buildProjectContext(),
        projectMemory: localStorage.getItem('rotex_project_memory') || '',
        projectSpec: localStorage.getItem('rotex_project_spec') || '',
        proPass: localStorage.getItem('rotex_pro_pass') || '',
        stream: true,
        mode: modeForServer,
        agent: true,
        superAgent: false,
        category: 'auto',
        // Effort mode: the picker (app.html) persists to this key; the server
        // is authoritative about what each level costs. Small talk is always
        // sent at low effort -- nobody should pay 2x for "hi" in Hard mode.
        effort: isSmallTalk ? 'low' : (['low', 'medium', 'high'].includes(localStorage.getItem('rotex_web_effort')) ? localStorage.getItem('rotex_web_effort') : 'low'),
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      const e = new Error(err.text || err.error || `Request failed (${res.status})`);
      e.code = err.error || '';
      throw e;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find((x) => x.startsWith('data:'));
        if (!line) continue;
        const payload = JSON.parse(line.slice(5).trim());
        // Living Project Spec rides on the one-time metadata event (which is
        // skipped just below), so persist it before the continue.
        if (typeof payload.spec === 'string' && payload.spec.trim()) {
          try { localStorage.setItem('rotex_project_spec', payload.spec.slice(0, 4000)); } catch {}
        }
        if (payload.ping || payload.model || payload.category) continue;
        if (payload.error) {
          const e = new Error(payload.text || payload.error);
          e.code = payload.error;
          throw e;
        }
        if (payload.d) {
          gotAny = true;
          full += payload.d;
          updateStreamBubble(assistantBubble, full);
          els.messages.scrollTop = els.messages.scrollHeight;
        }
        if (payload.usage?.textokens_charged && window.rotexTokens?.spend) {
          window.rotexTokens.spend(payload.usage.textokens_charged);
          // Pull the server's real usage right after a charge so the balance
          // shown tracks the server, not the local estimate.
          syncServerUsage();
        }
        if (payload.done) break;
      }
    }

    if (!gotAny && !full.trim()) throw new Error('The AI started but did not send a response fast enough. Try again, or switch models for this message.');
    const queued = await queueExecutableBlocks(full, text);
    // Terminal bubble text: never leave the in-progress status ("Working on
    // task...") as the FINAL message -- it reads as stuck. If the reply was all
    // executable blocks, say plainly that the edit went to Studio.
    const doneMsg = 'Sent to Roblox Studio — applying to your game now. Watch the Studio Results panel for confirmation.';
    const visible = visibleAssistantText(full, queued ? doneMsg : '');
    const shown = visible || (queued ? doneMsg : 'Done.');
    assistantBubble.className = `msg assistant ${queued ? 'status' : ''}`.trim();
    assistantBubble.innerHTML = renderMarkdown(shown);
    addDownloadAction(assistantBubble, extractStudioFiles(full));
    pushHistory('assistant', shown);
    setRunState(queued ? 'Queued edit' : 'Ready', queued ? 'Studio plugin is applying the generated change.' : 'Response complete.', queued ? 'Waiting for Studio result' : 'No action queued');
  } catch (error) {
    // A signed-in user should never be told to "log in": the server saying
    // login_required here means the Firebase ID token went stale mid-session
    // (they expire hourly). Force-refresh the token and retry once, silently.
    if (error.code === 'login_required' && state.user && !options.retriedAuth) {
      state.idToken = await state.user.getIdToken(true).catch(() => '');
      assistantBubble.remove();
      state.busy = false;
      els.send.disabled = false;
      return sendMessage(text, { ...options, skipUserRender: true, retriedAuth: true });
    }
    if (error.code === 'login_required' && state.user) {
      // Retry with a fresh token still rejected. Do NOT auto-redirect to the
      // login page -- Firebase still holds a session there, so it instantly
      // bounces back here and loops. A full sign-out is the only real reset.
      assistantBubble.className = 'msg assistant error';
      assistantBubble.textContent = 'Something is off with your session. Press "Out" (bottom-left) to sign out fully, then sign back in.';
      setRunState('Session issue', 'Sign out and back in to reset.', 'No action queued');
    } else {
      assistantBubble.className = 'msg assistant error';
      assistantBubble.textContent = error.message || 'No response.';
      setRunState('Needs retry', assistantBubble.textContent, 'No action queued');
    }
  } finally {
    state.busy = false;
    els.send.disabled = false;
    els.input.focus();
  }
}

function autosizeInput() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(150, Math.max(48, els.input.scrollHeight)) + 'px';
}

async function loadModels() {
  try {
    const res = await fetch('/api/models');
    const data = await res.json();
    if (!Array.isArray(data.models)) return;
    els.model.innerHTML = '';
    for (const model of data.models) {
      const opt = document.createElement('option');
      opt.value = model.id;
      opt.textContent = model.name;
      els.model.appendChild(opt);
    }
    els.model.value = localStorage.getItem('rotex_web_model') || 'google-flash';
  } catch {}
}

function initEvents() {
  document.querySelectorAll('[data-quick]').forEach((btn) => btn.addEventListener('click', () => {
    els.input.value = btn.dataset.quick || '';
    autosizeInput();
    els.input.focus();
  }));
  document.querySelectorAll('.nav-item[data-prompt]').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item === btn));
    els.input.value = btn.dataset.prompt || '';
    autosizeInput();
    els.input.focus();
  }));
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(els.input.value);
  });
  els.input.addEventListener('input', autosizeInput);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      els.form.requestSubmit();
    }
  });
  els.copyCode.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(state.bridgeCode).catch(() => {});
    els.copyCode.textContent = 'OK';
    setTimeout(() => { els.copyCode.textContent = '#'; }, 900);
  });
  if (els.refreshCode) {
    els.refreshCode.addEventListener('click', () => {
      rotateBridgeCode();
      els.refreshCode.textContent = '✓';
      setTimeout(() => { els.refreshCode.textContent = '⟳'; }, 900);
    });
  }
  // Down Arrow while a build is streaming: expand/collapse the live raw view.
  // Never hijacks the key while the user is writing in the input box.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown') return;
    const streaming = document.querySelector('.msg.streaming');
    if (!streaming) return;
    if (document.activeElement === els.input && els.input.value) return;
    e.preventDefault();
    toggleStreamRaw(streaming);
  });
  els.checkPlugin.addEventListener('click', async () => {
    els.checkPlugin.disabled = true;
    els.checkPlugin.textContent = 'Checking...';
    await checkPluginAndResume('', els.checkPlugin);
    els.checkPlugin.disabled = false;
    els.checkPlugin.textContent = 'Check Plugin';
  });

  // Permanent "Connect Studio" button in the top bar — opens the modal anytime.
  if (els.connectStudio) els.connectStudio.addEventListener('click', () => openPluginModal(''));

  // Connect-plugin modal controls
  if (els.pluginModalClose) els.pluginModalClose.addEventListener('click', closePluginModal);
  if (els.pluginModal) els.pluginModal.addEventListener('click', (e) => {
    if (e.target === els.pluginModal) closePluginModal();
  });
  if (els.pluginModalCopy) els.pluginModalCopy.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(state.bridgeCode).catch(() => {});
    els.pluginModalCopy.textContent = 'Copied';
    setTimeout(() => { els.pluginModalCopy.textContent = 'Copy'; }, 900);
  });
  if (els.pluginModalCheck) els.pluginModalCheck.addEventListener('click', async () => {
    const btn = els.pluginModalCheck;
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span><span>Checking…</span>';
    await pollBridge(); // its tail auto-resumes + closes the modal if connected
    if (!state.pluginConnected) {
      setPluginModalStatus(false);
      els.pluginModalStatus.textContent = 'Not connected yet — check the code, then click Connect in Studio.';
    }
    btn.disabled = false;
    btn.innerHTML = '<span>Check Plugin</span>';
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.pluginModal && !els.pluginModal.hidden) closePluginModal();
  });

  els.signIn.addEventListener('click', signIn);
  els.signOut.addEventListener('click', signOut);
  els.model.addEventListener('change', () => localStorage.setItem('rotex_web_model', els.model.value));
  els.newChat.addEventListener('click', newChat);
}

// Prompt handed off from the homepage hero ("type it on rrotex.com, land here
// ready to send"). Prefill only — never auto-send, since the user may still
// need to sign in and should see what they're about to spend a TexToken on.
function consumeLandingPrompt() {
  let prompt = '';
  try {
    const params = new URLSearchParams(window.location.search);
    const urlPrompt = String(params.get('prompt') || '').slice(0, 2000);
    if (urlPrompt) {
      // Stash in localStorage so the prompt survives the sign-in redirect
      // (URL params are dropped when we bounce a signed-out user to /login).
      localStorage.setItem('rotex_landing_prompt', urlPrompt);
      params.delete('prompt');
      const qs = params.toString();
      history.replaceState('', document.title, window.location.pathname + (qs ? `?${qs}` : ''));
    }
    prompt = String(localStorage.getItem('rotex_landing_prompt') || '').slice(0, 2000);
    // Only clear once a signed-in user is here to receive it — otherwise keep it
    // through the login round-trip and deliver it when they come back.
    if (prompt && state.user) localStorage.removeItem('rotex_landing_prompt');
  } catch {}
  if (!prompt || !els.input) return;
  if (!els.input.value) { // never clobber text the user has already typed
    els.input.value = prompt;
    els.input.focus();
    try { els.input.setSelectionRange(prompt.length, prompt.length); } catch {}
  }
}

async function init() {
  els.bridgeCode.textContent = state.bridgeCode;
  setMode(state.mode);
  renderHistory();
  renderChatList();
  renderAccount();
  initEvents();
  consumeLandingPrompt();
  await Promise.allSettled([initAuth(), loadModels()]);
  renderBridge({});
  pollBridge();
  setInterval(pollBridge, 2500);
  setInterval(() => window.rotexTokens?.refreshBalanceDisplay?.(), 10000);
  // Re-pull the server's usage every minute so the balance heals itself even
  // if a sign-in-time sync failed or the server reset usage since page load.
  setInterval(() => syncServerUsage(), 60000);
  // Rotate the bridge code when it passes its 6-hour lifetime, even for a tab
  // that has been sitting open the whole time.
  setInterval(() => { if (bridgeCodeExpired()) rotateBridgeCode(); }, 60000);
  // Firebase ID tokens expire after 1 hour; refresh the cached one every 20
  // minutes so a long-open tab never sends a stale token.
  setInterval(async () => {
    if (state.user) state.idToken = await state.user.getIdToken(true).catch(() => state.idToken || '');
  }, 20 * 60 * 1000);
}

init();
