const $ = (id) => document.getElementById(id);

const els = {
  messages: $('messages'),
  form: $('chatForm'),
  input: $('chatInput'),
  send: $('sendBtn'),
  model: $('modelSelect'),
  bridgeCode: $('bridgeCode'),
  copyCode: $('copyCodeBtn'),
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
  newChat: $('newChatBtn'),
};

const VALID_ROOT = /^(ServerScriptService|ReplicatedStorage|StarterPlayer|StarterPlayerScripts|StarterCharacterScripts|StarterGui|Workspace|ServerStorage|StarterPack|Lighting|SoundService|Teams|Players|TextChatService|Chat)(\/|\\)/i;
const ACTION_TYPES = new Set(['delete_instance', 'set_property', 'select_instances', 'create_model', 'insert_toolbox_model', 'terrain_edit', 'lighting_set', 'create_ui_image', 'create_ui']);

const state = {
  auth: null,
  provider: null,
  user: null,
  idToken: '',
  mode: localStorage.getItem('rotex_web_mode') || 'ask',
  bridgeCode: getOrCreateBridgeCode(),
  context: null,
  pluginConnected: false,
  lastResult: 0,
  busy: false,
  studioErrors: [],
  messages: readMessages(),
  pluginPromptOpen: false,
  lastBridgeMeta: null,
  bridgeInstances: new Set(),
};

function getOrCreateBridgeCode() {
  const existing = cleanCode(localStorage.getItem('rotex_web_bridge_code'));
  if (existing.length >= 4) return existing;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'RX';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  localStorage.setItem('rotex_web_bridge_code', code);
  return code;
}

function cleanCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 18);
}

function readMessages() {
  try {
    const parsed = JSON.parse(localStorage.getItem('rotex_web_messages') || '[]');
    return Array.isArray(parsed) ? parsed.slice(-28) : [];
  } catch {
    return [];
  }
}

function saveMessages() {
  localStorage.setItem('rotex_web_messages', JSON.stringify(state.messages.slice(-28)));
}

function addMessage(role, text, extraClass = '') {
  const div = document.createElement('div');
  div.className = `msg ${role} ${extraClass}`.trim();
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
  return div;
}

function setRunState(label, detail = '', mini = '') {
  if (els.runState) els.runState.textContent = label;
  if (els.runDetail) els.runDetail.textContent = detail;
  if (els.runMini) els.runMini.textContent = mini;
}

function addEmptyWorkbench() {
  const shell = document.createElement('div');
  shell.className = 'forge-empty';
  shell.innerHTML = `
    <h1>Build Roblox Studio features from the website.</h1>
    <p>Ask mode can answer right away. Agent and Supreme connect to the plugin so ROTEX can edit scripts, create visible UI, delete stale duplicates, adjust terrain/lighting, and use Toolbox only for static map assets.</p>
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
    'Connect the Roblox Studio plugin to let Agent edit the game.',
    '',
    `1. Copy this bridge code: ${state.bridgeCode}`,
    '2. Open the ROTEX plugin in Roblox Studio.',
    '3. Paste the code, click Connect, then press Check Plugin here.',
  ].join('\n');
}

function addPluginConnectPrompt(pendingText = '') {
  state.pluginPromptOpen = true;
  const div = addMessage('assistant', pluginConnectText(), 'status');
  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn';
  copyBtn.type = 'button';
  copyBtn.textContent = 'Copy Code';
  copyBtn.addEventListener('click', async () => {
    await navigator.clipboard?.writeText(state.bridgeCode).catch(() => {});
    copyBtn.textContent = 'Copied';
    setTimeout(() => { copyBtn.textContent = 'Copy Code'; }, 900);
  });

  const checkBtn = document.createElement('button');
  checkBtn.className = 'btn primary';
  checkBtn.type = 'button';
  checkBtn.textContent = 'Check Plugin';
  checkBtn.addEventListener('click', async () => {
    await checkPluginAndResume(pendingText, checkBtn, div);
  });

  actions.append(copyBtn, checkBtn);
  div.appendChild(actions);
  return div;
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
  if (state.messages.length > 24) {
    state.messages = state.messages.slice(-18);
    addMessage('assistant', 'Compacting text...', 'status');
  }
  saveMessages();
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('rotex_web_mode', mode);
  document.querySelectorAll('.tab').forEach((btn) => btn.classList.toggle('active', btn.dataset.mode === mode));
  els.input.placeholder = mode === 'ask' ? 'Ask ROTEX...' : 'Tell ROTEX what to make, edit, debug, or remove...';
  setRunState(
    mode === 'ask' ? 'Ready' : state.pluginConnected ? 'Ready' : 'Connect Studio',
    mode === 'ask'
      ? 'Ask mode can talk without Studio. Switch to Agent or Supreme for edits.'
      : state.pluginConnected
        ? 'Agent will apply real changes through the plugin.'
        : 'Agent needs the Studio plugin before it can edit.',
    mode === 'supreme' ? 'Deep workflow' : mode === 'agent' ? 'Edit workflow' : 'Chat workflow',
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
    });
  } catch (error) {
    console.warn('ROTEX auth init failed', error);
  }
}

async function signIn() {
  if (!state.auth || !state.provider) {
    location.href = '/login';
    return;
  }
  const { signInWithPopup } = await import('https://www.gstatic.com/firebasejs/10.12.4/firebase-auth.js');
  await signInWithPopup(state.auth, state.provider).catch(() => {});
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
}

async function checkPluginAndResume(pendingText = '', button = null, bubble = null) {
  if (button) {
    button.disabled = true;
    button.textContent = 'Checking...';
  }
  await pollBridge();
  if (state.pluginConnected) {
    if (bubble) bubble.firstChild.textContent = 'Plugin connected. Sending your message now...';
    state.pluginPromptOpen = false;
    if (pendingText && pendingText.trim()) await sendMessage(pendingText, { skipUserRender: true, allowPluginPrompt: false });
    else addMessage('assistant', 'Plugin connected. You can talk to ROTEX now.', 'status');
  } else {
    if (bubble) bubble.firstChild.textContent = pluginConnectText() + '\n\nStill not connected yet. Make sure the code matches and click Connect in the Studio plugin.';
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
      connected ? 'Ready' : state.mode === 'ask' ? 'Ready' : 'Connect Studio',
      connected ? 'Studio context is live. Agent and Supreme can edit now.' : state.mode === 'ask' ? 'Ask mode can talk while Studio is disconnected.' : 'Paste the bridge code into the plugin, then press Check Plugin.',
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
    : 'apply_files, create_model geometry, insert_toolbox_model for map/world assets only, terrain_edit, lighting_set, create_ui, create_ui_image, set_property, delete_instance, select_instances';
  let out = [
    `ROTEX UI MODE: ${state.mode === 'supreme' ? 'SUPER AGENT' : state.mode === 'agent' ? 'AGENT' : 'ASK'}.`,
    `PLUGIN CAPABILITIES: ${caps}.`,
    'The web app hides executable file/studio-action/roblox-model blocks and queues them to the Roblox Studio plugin.',
    'Agent/Super Agent must edit the actual Studio game through executable blocks. Ask mode must not output code.',
  ].join('\n');
  if (scripts.length) {
    out += `\n\nPROJECT SCRIPTS (live from Roblox Studio - ${scripts.length} scripts). Search these before editing:`;
    for (const s of scripts.slice(0, 120)) {
      const src = String(s.source || '').slice(0, 12000);
      const path = normalizeFilePath(s.path || s.name || 'Script');
      out += `\n\n--- ${path} [${s.class || 'Script'}] ---\n${src}`;
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

  const requiresPlugin = state.mode !== 'ask';
  if (requiresPlugin && !state.pluginConnected && options.allowPluginPrompt !== false) {
    if (!options.skipUserRender) addMessage('user', text);
    if (!state.pluginPromptOpen) addPluginConnectPrompt(text);
    else addMessage('assistant', 'Plugin still needs to connect first. Paste the bridge code into Studio, click Connect, then press Check Plugin.', 'status');
    els.input.value = '';
    autosizeInput();
    return;
  }

  state.busy = true;
  els.send.disabled = true;
  els.input.value = '';
  if (!options.skipUserRender) addMessage('user', text);
  pushHistory('user', text);
  setRunState(state.mode === 'ask' ? 'Thinking' : taskStatusFor(text), state.mode === 'ask' ? 'Reading the request.' : 'Planning, generating, and checking executable Studio edits.', state.mode === 'supreme' ? 'Supreme pass' : state.mode === 'agent' ? 'Agent pass' : 'Ask pass');
  const assistantBubble = addMessage('assistant', state.mode === 'ask' ? 'Thinking...' : taskStatusFor(text), state.mode === 'ask' ? '' : 'status');

  let full = '';
  let gotAny = false;
  try {
    const history = state.messages.slice(-18).map((m) => ({ role: m.role, content: m.content }));
    const modeForServer = state.mode === 'supreme' ? 'editor' : state.mode === 'agent' ? 'editor' : 'editor';
    const authToken = state.user ? await state.user.getIdToken(true).catch(() => state.idToken || '') : '';
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authToken,
        model: els.model.value || 'google-flash',
        messages: history,
        projectMode: 'Roblox',
        projectContext: buildProjectContext(),
        projectMemory: localStorage.getItem('rotex_project_memory') || '',
        projectSpec: localStorage.getItem('rotex_project_spec') || '',
        proPass: localStorage.getItem('rotex_pro_pass') || '',
        stream: true,
        mode: modeForServer,
        agent: state.mode === 'agent' || state.mode === 'supreme',
        superAgent: state.mode === 'supreme',
        category: 'auto',
      }),
    });

    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.text || err.error || `Request failed (${res.status})`);
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
        if (payload.error) throw new Error(payload.text || payload.error);
        if (payload.d) {
          gotAny = true;
          full += payload.d;
          const hasExecutable = /```\s*(?:file:|studio-action|roblox-model)/i.test(full);
          const visible = visibleAssistantText(full, hasExecutable ? taskStatusFor(text) : 'Thinking...');
          assistantBubble.className = `msg assistant ${hasExecutable && state.mode !== 'ask' ? 'status' : ''}`.trim();
          assistantBubble.textContent = visible;
          els.messages.scrollTop = els.messages.scrollHeight;
        }
        if (payload.usage?.textokens_charged && window.rotexTokens?.spend) {
          window.rotexTokens.spend(payload.usage.textokens_charged);
        }
        if (payload.done) break;
      }
    }

    if (!gotAny && !full.trim()) throw new Error('The AI started but did not send a response fast enough. Try again, or switch models for this message.');
    const queued = await queueExecutableBlocks(full, text);
    const visible = visibleAssistantText(full, queued && state.mode !== 'ask' ? taskStatusFor(text) : '');
    assistantBubble.className = `msg assistant ${queued && state.mode !== 'ask' ? 'status' : ''}`.trim();
    assistantBubble.textContent = visible || (queued ? taskStatusFor(text) : 'Done.');
    pushHistory('assistant', assistantBubble.textContent);
    setRunState(queued ? 'Queued edit' : 'Ready', queued ? 'Studio plugin is applying the generated change.' : 'Response complete.', queued ? 'Waiting for Studio result' : 'No action queued');
  } catch (error) {
    assistantBubble.className = 'msg assistant error';
    assistantBubble.textContent = error.message || 'No response.';
    setRunState('Needs retry', assistantBubble.textContent, 'No action queued');
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
  document.querySelectorAll('.tab').forEach((btn) => btn.addEventListener('click', () => setMode(btn.dataset.mode)));
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
  els.checkPlugin.addEventListener('click', async () => {
    els.checkPlugin.disabled = true;
    els.checkPlugin.textContent = 'Checking...';
    await checkPluginAndResume('', els.checkPlugin);
    els.checkPlugin.disabled = false;
    els.checkPlugin.textContent = 'Check Plugin';
  });
  els.signIn.addEventListener('click', signIn);
  els.signOut.addEventListener('click', signOut);
  els.model.addEventListener('change', () => localStorage.setItem('rotex_web_model', els.model.value));
  els.newChat.addEventListener('click', () => {
    state.messages = [];
    saveMessages();
    renderHistory();
  });
}

async function init() {
  els.bridgeCode.textContent = state.bridgeCode;
  setMode(state.mode);
  renderHistory();
  renderAccount();
  initEvents();
  await Promise.allSettled([initAuth(), loadModels()]);
  renderBridge({});
  pollBridge();
  setInterval(pollBridge, 2500);
  setInterval(() => window.rotexTokens?.refreshBalanceDisplay?.(), 10000);
}

init();
