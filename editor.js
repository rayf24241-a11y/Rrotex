/* ROTEX Desktop - AI agent for game dev */
(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────
  const state = {
    openFiles: new Map(),
    activeTab: 'welcome',
    directoryHandle: null,
    fileTree: [],
    aiMessages: [],
    aiModel: 'fast',
    terminalHistory: [],
    terminalHistoryIdx: -1,
    sidePanel: 'explorer',
    bottomPanelOpen: false,
    aiPanelOpen: false,
    currentDirPath: '',
    agentMode: false,
    superAgentMode: false,
    projectModes: readProjectModes(),
    projectName: localStorage.getItem('rotex_project_name') || '',
    projectMode: localStorage.getItem('rotex_project_mode') || readProjectModes().join(' + ') || 'Unity',
    studioScripts: [],
    studioSelected: [],
    studioErrors: [],
    lastAutoFixAt: 0,
  };

  // ─── AI Models (IDs match /api/chat.js) ────────────────────────────
  const MODELS = [
    { id: 'fast', name: 'Fast', role: '0.2x', desc: 'Groq Llama 3.1 8B Instant', family: 'cloud', logo: 'F', pro: false },
    { id: 'balanced', name: 'Balanced', role: '0.75x', desc: 'Groq Qwen3 32B - limited on Free', family: 'cloud', logo: 'B', pro: false },
    { id: 'smart', name: 'Smart', role: '1x', desc: 'Groq Llama 3.3 70B Versatile - small Free tests', family: 'cloud', logo: 'S', pro: false },
    { id: 'pro-smart', name: 'Pro Smart', role: '6x', desc: 'Claude Haiku 4.5 - Pro only', family: 'cloud', logo: 'H', pro: true, confirm: true },
  ];

  const API_BASE = window.rotexDesktop ? 'https://rrotex.com' : '';

  // Pro pass shared with rrotex.com chat via localStorage.
  const PRO_PASS_KEY = 'rotex_pro_pass';

  function getProPass() {
    try { return localStorage.getItem(PRO_PASS_KEY) || ''; } catch { return ''; }
  }

  function proPassPayload(pass) {
    try {
      const body = pass.split('.', 2)[0];
      return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
    } catch { return null; }
  }

  function computeIsPro() {
    const payload = proPassPayload(getProPass());
    return Boolean(payload && payload.plan === 'pro' && Number(payload.exp) > Date.now());
  }

  function getDesktopAuth() {
    const raw = localStorage.getItem('rotex_desktop_auth') || localStorage.getItem('rotex_desktop_auth_mirror');
    if (!raw) return { uid: '', email: '', token: '', refreshToken: '' };
    try {
      const auth = JSON.parse(raw);
      return {
        uid: String(auth.uid || ''),
        email: String(auth.email || ''),
        token: String(auth.token || ''),
        refreshToken: String(auth.refreshToken || ''),
      };
    } catch { return { uid: '', email: '', token: '', refreshToken: '' }; }
  }

  async function getFirebaseConfig() {
    try {
      const response = await fetch(`${API_BASE}/api/firebase-config`);
      const data = await response.json();
      return data.configured ? data.firebaseConfig : null;
    } catch { return null; }
  }

  async function refreshIdToken() {
    const auth = getDesktopAuth();
    if (!auth.refreshToken) return auth.token;
    const cfg = await getFirebaseConfig();
    if (!cfg?.apiKey) return auth.token;
    try {
      const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(cfg.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(auth.refreshToken)}`,
      });
      const data = await response.json();
      if (!response.ok || !data.id_token) return auth.token;
      const newToken = data.id_token;
      const newRefreshToken = data.refresh_token || auth.refreshToken;
      try {
        const raw = localStorage.getItem('rotex_desktop_auth') || localStorage.getItem('rotex_desktop_auth_mirror') || '{}';
        const parsed = JSON.parse(raw);
        parsed.token = newToken;
        parsed.refreshToken = newRefreshToken;
        parsed.exp = String(Date.now() + 365 * 24 * 60 * 60 * 1000);
        const serialized = JSON.stringify(parsed);
        localStorage.setItem('rotex_desktop_auth', serialized);
        localStorage.setItem('rotex_desktop_auth_mirror', serialized);
      } catch {}
      return newToken;
    } catch { return auth.token; }
  }

  async function getValidIdToken() {
    return await refreshIdToken();
  }

  async function refreshProPass() {
    const pass = getProPass();
    const auth = getDesktopAuth();
    const idToken = await getValidIdToken();
    if (!pass && !idToken) return { ok: false, message: 'No Pro pass or login session found.' };
    try {
      const response = await fetch(`${API_BASE}/api/refresh-pro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proPass: pass, authToken: idToken, uid: auth.uid, email: auth.email }),
      });
      const data = await response.json();
      if (data.refreshed && data.proPass) {
        localStorage.setItem(PRO_PASS_KEY, data.proPass);
        userIsPro = computeIsPro();
        buildModelMenu();
        if (window.rotexTokens) window.rotexTokens.refreshBalanceDisplay();
        return { ok: true };
      } else if (data.cancelled) {
        localStorage.removeItem(PRO_PASS_KEY);
        userIsPro = false;
        buildModelMenu();
        return { ok: false, message: 'Pro subscription is no longer active.' };
      }
      return { ok: false, message: data.message || 'Could not refresh Pro pass.' };
    } catch (err) {
      return { ok: false, message: err?.message || 'Network error while refreshing Pro pass.' };
    }
  }

  async function ensureFreshProPass() {
    const pass = getProPass();
    if (!pass) return;
    const payload = proPassPayload(pass);
    const exp = payload ? Number(payload.exp) : 0;
    if (exp - Date.now() > 7 * 24 * 60 * 60 * 1000) return;
    await refreshProPass();
  }

  // User plan state from the signed Pro pass.
  let userIsPro = computeIsPro();
  let freeMessagesUsed = parseInt(localStorage.getItem('rotex_free_msgs') || '0');
  const FREE_DAILY_LIMIT = 25;
  const FREE_DAILY_KEY = 'rotex_free_msgs_date';
  const TEX_SPENT_KEY = 'rotex_textokens_spent_today';
  const TEX_SPENT_DATE_KEY = 'rotex_textokens_spent_date';
  setTimeout(ensureFreshProPass, 1500);

  // Reset daily counter
  (function resetDailyCounter() {
    const today = new Date().toDateString();
    const savedDate = localStorage.getItem(FREE_DAILY_KEY);
    if (savedDate !== today) {
      freeMessagesUsed = 0;
      localStorage.setItem('rotex_free_msgs', '0');
      localStorage.setItem(FREE_DAILY_KEY, today);
      localStorage.setItem(TEX_SPENT_KEY, '0');
      localStorage.setItem(TEX_SPENT_DATE_KEY, today);
    }
  })();

  function dailyTexTokenLimit() {
    // Internal units: 8 TT / 1 TT per day (1 displayed TexToken = 30k units).
    return userIsPro ? 240000 : 30000;
  }

  function extraTexTokens() {
    return Math.max(0, Number(localStorage.getItem('rotex_textokens_balance') || 0));
  }

  function spentTexTokensToday() {
    const today = new Date().toDateString();
    if (localStorage.getItem(TEX_SPENT_DATE_KEY) !== today) {
      localStorage.setItem(TEX_SPENT_DATE_KEY, today);
      localStorage.setItem(TEX_SPENT_KEY, '0');
      return 0;
    }
    return Math.max(0, Number(localStorage.getItem(TEX_SPENT_KEY) || 0));
  }

  function texTokensLeft() {
    return Math.max(0, dailyTexTokenLimit() - spentTexTokensToday()) + extraTexTokens();
  }

  function spendTexTokens(amount) {
    const charge = Math.max(0, Math.ceil(Number(amount) || 0));
    if (!charge) {
      if (window.rotexTokens) window.rotexTokens.refreshBalanceDisplay();
      return;
    }
    // Use the shared wallet so Pro/free daily allowance and purchased balance stay in sync.
    if (window.rotexTokens) {
      window.rotexTokens.spend(charge);
    } else {
      const spent = spentTexTokensToday() + charge;
      localStorage.setItem(TEX_SPENT_DATE_KEY, new Date().toDateString());
      localStorage.setItem(TEX_SPENT_KEY, String(spent));
    }
    if (window.rotexTokens) window.rotexTokens.refreshBalanceDisplay();
  }

  // ─── Usage Tracking ─────────────────────────────────────────────────
  function getUsageData() {
    try {
      return JSON.parse(localStorage.getItem('rotex_usage') || '{}');
    } catch { return {}; }
  }

  function trackUsage(modelName) {
    const usage = getUsageData();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (!usage[today]) usage[today] = { total: 0, models: {} };
    usage[today].total++;
    usage[today].models[modelName] = (usage[today].models[modelName] || 0) + 1;
    localStorage.setItem('rotex_usage', JSON.stringify(usage));
  }

  function getUsageStats() {
    const usage = getUsageData();
    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);

    // Today's usage
    const todayData = usage[todayKey] || { total: 0, models: {} };

    // This week (last 7 days)
    let weekTotal = 0;
    const weekModels = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const day = usage[key];
      if (day) {
        weekTotal += day.total;
        for (const [m, count] of Object.entries(day.models)) {
          weekModels[m] = (weekModels[m] || 0) + count;
        }
      }
    }

    return { today: todayData, weekTotal, weekModels };
  }

  // ─── Monaco Setup (optional — chat page has no Monaco loader) ─────
  let monacoReady = false;
  const editorInstances = new Map();

  if (typeof require !== 'undefined') {
    require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
    require(['vs/editor/editor.main'], function () {
    monaco.editor.defineTheme('rotex-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a9955' },
        { token: 'keyword', foreground: '569cd6' },
        { token: 'string', foreground: 'ce9178' },
        { token: 'number', foreground: 'b5cea8' },
        { token: 'type', foreground: '4ec9b0' },
      ],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#d4d4d4',
        'editorLineNumber.foreground': '#858585',
        'editorLineNumber.activeForeground': '#c6c6c6',
        'editorCursor.foreground': '#aeafad',
        'editor.selectionBackground': '#264f78',
        'editor.lineHighlightBackground': '#2a2d2e',
        'editorIndentGuide.background': '#404040',
        'editorBracketMatch.background': '#0064001a',
        'editorBracketMatch.border': '#888888',
      },
    });
    monaco.editor.setTheme('rotex-dark');
    monacoReady = true;
  });
  }

  // ─── Language Detection ────────────────────────────────────────────
  function detectLanguage(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    const map = {
      js: 'javascript', mjs: 'javascript', cjs: 'javascript',
      jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', dart: 'dart',
      toml: 'toml', ini: 'ini', dockerfile: 'dockerfile',
      vue: 'html', svelte: 'html',
    };
    return map[ext] || 'plaintext';
  }

  function langDisplayName(lang) {
    const names = {
      javascript: 'JavaScript', typescript: 'TypeScript', python: 'Python',
      html: 'HTML', css: 'CSS', json: 'JSON', markdown: 'Markdown',
      plaintext: 'Plain Text', ruby: 'Ruby', rust: 'Rust', go: 'Go',
      java: 'Java', csharp: 'C#', cpp: 'C++', c: 'C', php: 'PHP',
      shell: 'Shell', sql: 'SQL', yaml: 'YAML', xml: 'XML',
    };
    return names[lang] || lang;
  }

  // ─── DOM ───────────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const editorApp = $('#editorApp');
  const sidePanel = $('#sidePanel');
  const spTitle = $('#spTitle');
  const fileTree = $('#fileTree');
  const tabs = $('#tabs');
  const editorContent = $('#editorContent');
  const bottomPanel = $('#bottomPanel');
  const aiPanel = $('#aiPanel');
  const aiMessages = $('#aiMessages');
  const aiModelMenu = $('#aiModelMenu');
  const aiModelButton = $('#aiModelButton');
  const projectModeSelect = $('#projectModeSelect');
  const projectSetupButton = $('#projectSetupButton');
  const projectSetupModal = $('#projectSetupModal');
  const projectSetupForm = $('#projectSetupForm');
  const projectSetupLater = $('#projectSetupLater');
  const projectNameInput = $('#projectNameInput');
  const projectSetupError = $('#projectSetupError');
  const superAgentToggle = $('#superAgentToggle');
  const stopAiButton = $('#stopAiButton');
  const aiCostPreview = $('#aiCostPreview');
  const aiComposer = $('#aiComposer');
  const aiInput = $('#aiInput');
  const terminalOutput = $('#terminalOutput');
  const terminalInput = $('#terminalInput');

  // ─── Activity Bar ──────────────────────────────────────────────────
  const activityBar = $('#activityBar');
  if (activityBar) activityBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-panel]');
    if (!btn) return;
    const panel = btn.dataset.panel;

    if (panel === 'ai') {
      toggleAIPanel();
      return;
    }

    if (state.sidePanel === panel && !editorApp.classList.contains('side-collapsed')) {
      editorApp.classList.add('side-collapsed');
    } else {
      editorApp.classList.remove('side-collapsed');
      switchSidePanel(panel);
    }

    $$('.ab-icon[data-panel]').forEach((b) => {
      b.classList.toggle('active', b.dataset.panel === panel && !editorApp.classList.contains('side-collapsed'));
    });
  });

  function switchSidePanel(panel) {
    state.sidePanel = panel;
    const titles = { explorer: 'EXPLORER', search: 'SEARCH', git: 'SOURCE CONTROL' };
    spTitle.textContent = titles[panel] || panel.toUpperCase();
    $$('#spContent .panel-view').forEach((v) => (v.hidden = true));
    const target = $(`#${panel}Panel`);
    if (target) target.hidden = false;
  }

  // ─── AI Panel ──────────────────────────────────────────────────────
  function toggleAIPanel() {
    state.aiPanelOpen = !state.aiPanelOpen;
    aiPanel.hidden = !state.aiPanelOpen;
    editorApp.classList.toggle('ai-open', state.aiPanelOpen);
    const btn = $('.ab-icon[data-panel="ai"]');
    if (btn) btn.classList.toggle('active', state.aiPanelOpen);
  }

  $('#aiClosePanel').addEventListener('click', toggleAIPanel);
  $('#aiNewChat').addEventListener('click', () => {
    state.aiMessages = [];
    aiMessages.innerHTML = `<div class="ai-welcome-msg"><p><strong>ROTEX AI</strong></p><p>Ask me anything about your code. I can write, edit, debug, refactor, and explain.</p></div>`;
  });

  // ─── AI Model Selector (scrollable, at bottom) ─────────────────────
  function buildModelMenu() {
    const familyLabels = { cloud: 'ROTEX CLOUD' };
    let html = '<div class="ai-model-scroll">';
    let lastFamily = '';

    for (const m of MODELS) {
      if (m.family !== lastFamily && familyLabels[m.family]) {
        html += `<div class="ai-model-divider">${familyLabels[m.family]}</div>`;
        lastFamily = m.family;
      } else if (m.family !== lastFamily) {
        lastFamily = m.family;
      }

      const locked = m.pro && !userIsPro;
      const activeClass = m.id === state.aiModel ? ' active' : '';
      const lockedClass = locked ? ' locked' : '';
      const badge = m.pro ? '<span class="pro-badge">PRO</span>' : '';

      html += `<button class="ai-model-option${activeClass}${lockedClass}" data-model="${m.id}" ${locked ? 'title="Go Pro to use this model"' : ''}>
        <span class="ai-model-logo ai-model-logo-${m.id}" aria-hidden="true">${m.logo || m.name[0]}</span>
        <div class="model-option-left">
          <span class="model-name">${m.name}</span>
          <span class="model-desc">${m.desc}</span>
        </div>
        <div class="model-option-right">
          ${badge}
          <span class="model-role-tag">${m.role}</span>
        </div>
      </button>`;
    }
    html += '</div>';
    aiModelMenu.innerHTML = html;
  }
  buildModelMenu();

  aiModelButton.addEventListener('click', () => {
    aiModelMenu.hidden = !aiModelMenu.hidden;
    if (!aiModelMenu.hidden) buildModelMenu(); // refresh active state
  });
  aiModelMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-model]');
    if (!opt) return;
    const model = MODELS.find((m) => m.id === opt.dataset.model);
    if (!model) return;

    // Block locked models
    if (model.pro && !userIsPro) {
      // Show upgrade hint
      const hint = aiModelMenu.querySelector('.ai-model-upgrade-hint');
      if (!hint) {
        const div = document.createElement('div');
        div.className = 'ai-model-upgrade-hint';
        div.textContent = 'Go Pro to unlock this model';
        aiModelMenu.querySelector('.ai-model-scroll').appendChild(div);
        setTimeout(() => div.remove(), 2500);
      }
      return;
    }

    state.aiModel = model.id;
    $('#aiSelectedModel').textContent = model.name;
    $('#aiSelectedRole').textContent = model.role;
    aiModelMenu.hidden = true;
    updateCostPreview();
  });
  document.addEventListener('click', (e) => {
    if (!aiModelButton.contains(e.target) && !aiModelMenu.contains(e.target)) {
      aiModelMenu.hidden = true;
    }
  });

  function modelTexTokenMultiplier(modelId) {
    if (modelId === 'fast') return 0.2;
    if (modelId === 'balanced') return 0.75;
    if (modelId === 'smart') return 1;
    if (modelId === 'pro-smart') return 6;
    return 1;
  }

  function estimateTaskCost() {
    const base = state.superAgentMode ? 500000 : state.agentMode ? 250000 : 75000;
    let multiplier = modelTexTokenMultiplier(state.aiModel);
    if (state.agentMode) multiplier *= 2;
    if (state.superAgentMode) multiplier *= 4;
    return Math.round(base * multiplier);
  }

  // Display conversion: 1 shown TexToken = 30k internal units (TT_UNIT in api/chat.js).
  function fmtTexTokens(internal) {
    if (window.rotexTokens?.formatTT) return window.rotexTokens.formatTT(internal);
    const tt = Math.max(0, Number(internal) || 0) / 30000;
    return tt >= 100 ? String(Math.round(tt)) : Math.max(tt, tt > 0 ? 0.1 : 0).toFixed(1).replace(/\.0$/, '');
  }

  function updateCostPreview() {
    if (!aiCostPreview) return;
    const estimate = estimateTaskCost();
    const mode = state.superAgentMode ? 'Super Agent' : state.agentMode ? 'Agent' : 'Chat';
    aiCostPreview.textContent = `${state.projectMode} · ${mode} · est. ${fmtTexTokens(estimate)} TexTokens`;
  }

  function confirmLargeTaskIfNeeded() {
    const estimate = estimateTaskCost();
    if (texTokensLeft() <= 0 || estimate > texTokensLeft()) {
      alert('You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.');
      return false;
    }
    if (state.aiModel === 'pro-smart' && !confirm('Claude Haiku costs more TexTokens. Continue?')) return false;
    if (estimate <= 250000) return true;
    return confirm(`This task is estimated to cost ${fmtTexTokens(estimate)} TexTokens. Big tasks (over ${fmtTexTokens(250000)}) need confirmation. Run it?`);
  }

  // Agent mode toggle: Pro multi-file edits in one reply.
  const agentToggle = $('#agentToggle');
  if (agentToggle) {
    agentToggle.addEventListener('click', () => {
      if (!userIsPro) {
        showToast('Agent mode is a Pro feature - upgrade at rrotex.com/#pricing');
        return;
      }
      state.agentMode = !state.agentMode;
      agentToggle.classList.toggle('on', state.agentMode);
      agentToggle.title = state.agentMode
        ? 'Agent mode on: the AI can change multiple files in one reply'
        : 'Agent mode off';
      updateCostPreview();
    });
  }

  if (projectModeSelect) {
    renderProjectModeSelect();
    projectModeSelect.addEventListener('change', () => {
      state.projectMode = projectModeSelect.value;
      localStorage.setItem('rotex_project_mode', state.projectMode);
      updateCostPreview();
    });
  }

  projectSetupButton?.addEventListener('click', () => openProjectSetup(false));
  projectSetupLater?.addEventListener('click', () => closeProjectSetup());
  projectSetupForm?.addEventListener('change', enforceProjectToolLimit);
  projectSetupForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const modes = [...projectSetupForm.querySelectorAll('input[name="projectTool"]:checked')].map((input) => input.value);
    const name = projectNameInput.value.trim();
    if (!modes.length) {
      projectSetupError.textContent = 'Pick at least one tool.';
      return;
    }
    if (modes.length > 2) {
      projectSetupError.textContent = 'Pick up to two tools.';
      return;
    }
    if (!name) {
      projectSetupError.textContent = 'Name your project.';
      return;
    }
    saveProjectSetup(name, modes);
    closeProjectSetup();
    showToast(`Project saved: ${name}`);
  });

  if (!localStorage.getItem('rotex_project_setup_done')) {
    setTimeout(() => openProjectSetup(true), 350);
  }

  if (superAgentToggle) {
    superAgentToggle.addEventListener('click', () => {
      if (!userIsPro) {
        showToast('Super Agent mode is a Pro feature — upgrade at rrotex.com/#pricing');
        return;
      }
      state.superAgentMode = !state.superAgentMode;
      if (state.superAgentMode) state.agentMode = true;
      superAgentToggle.classList.toggle('on', state.superAgentMode);
      agentToggle?.classList.toggle('on', state.agentMode);
      updateCostPreview();
    });
  }


  function showToast(text) {
    document.querySelector('.rotex-toast')?.remove();
    const toast = document.createElement('div');
    toast.className = 'rotex-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3200);
  }

  function readProjectModes() {
    try {
      const parsed = JSON.parse(localStorage.getItem('rotex_project_modes') || '[]');
      const modes = parsed.filter((item) => ['Roblox', 'Blender', 'Unity'].includes(item));
      return modes.slice(0, 2);
    } catch {
      return [];
    }
  }

  function openProjectSetup(required) {
    if (!projectSetupModal || !projectSetupForm) return;
    projectSetupModal.hidden = false;
    projectSetupLater.hidden = Boolean(required);
    projectSetupError.textContent = '';
    projectNameInput.value = state.projectName || '';
    const hasSavedSetup = localStorage.getItem('rotex_project_setup_done') === '1';
    projectSetupForm.querySelectorAll('input[name="projectTool"]').forEach((input) => {
      input.checked = hasSavedSetup && state.projectModes.includes(input.value);
    });
    enforceProjectToolLimit();
    setTimeout(() => projectNameInput.focus(), 20);
  }

  function closeProjectSetup() {
    if (projectSetupModal) projectSetupModal.hidden = true;
    localStorage.setItem('rotex_project_setup_done', '1');
  }

  function enforceProjectToolLimit() {
    if (!projectSetupForm) return;
    const checked = [...projectSetupForm.querySelectorAll('input[name="projectTool"]:checked')];
    const atLimit = checked.length >= 2;
    projectSetupForm.querySelectorAll('input[name="projectTool"]').forEach((input) => {
      input.disabled = atLimit && !input.checked;
    });
    if (projectSetupError && checked.length <= 2) projectSetupError.textContent = '';
  }

  function saveProjectSetup(name, modes) {
    state.projectName = name;
    state.projectModes = modes.slice(0, 2);
    state.projectMode = state.projectModes.join(' + ');
    localStorage.setItem('rotex_project_name', state.projectName);
    localStorage.setItem('rotex_project_modes', JSON.stringify(state.projectModes));
    localStorage.setItem('rotex_project_mode', state.projectMode);
    localStorage.setItem('rotex_project_setup_done', '1');
    renderProjectModeSelect();
    updateCostPreview();
    updateBreadcrumb(state.activeTab);
  }

  function renderProjectModeSelect() {
    if (!projectModeSelect) return;
    const modes = state.projectModes?.length ? state.projectModes : [state.projectMode || 'Unity'];
    const options = modes.length > 1 ? [modes.join(' + '), ...modes] : modes;
    projectModeSelect.innerHTML = options.map((mode) => `<option value="${escapeHtml(mode)}">${escapeHtml(mode)} mode</option>`).join('');
    if (!options.includes(state.projectMode)) state.projectMode = options[0];
    projectModeSelect.value = state.projectMode;
  }

  // ─── Project Context (what the AI can "see") ───────────────────────
  function collectTreePaths(items, out, depth) {
    for (const item of items || []) {
      if (out.length >= 200) return;
      out.push(`${'  '.repeat(depth)}${item.path}${item.kind === 'directory' ? '/' : ''}`);
      if (item.children) collectTreePaths(item.children, out, depth + 1);
    }
  }

  function buildProjectContext() {
    const parts = [];
    if (state.projectName) parts.push(`Project name: ${state.projectName}`);
    if (state.projectModes?.length) parts.push(`Project tools: ${state.projectModes.join(', ')}`);
    if (state.currentDirPath) parts.push(`Project root: ${state.currentDirPath}`);

    const treePaths = [];
    collectTreePaths(state.fileTree, treePaths, 0);
    if (treePaths.length) parts.push(`File tree:\n${treePaths.join('\n')}`);

    const openPaths = [...state.openFiles.keys()];
    if (openPaths.length) parts.push(`Open tabs: ${openPaths.join(', ')}`);

    const activeCap = userIsPro ? 24000 : 6000;
    if (state.activeTab && state.activeTab !== 'welcome') {
      const file = state.openFiles.get(state.activeTab);
      if (file) {
        parts.push(`Active file: ${state.activeTab} (${file.language})\n\`\`\`${file.language}\n${file.content.slice(0, activeCap)}\n\`\`\``);
      }
    }

    // Pro: include other open files so the AI sees cross-file connections.
    if (userIsPro) {
      let extras = 0;
      for (const [path, file] of state.openFiles) {
        if (path === state.activeTab || extras >= 3) continue;
        parts.push(`Open file: ${path} (${file.language})\n\`\`\`${file.language}\n${file.content.slice(0, 4000)}\n\`\`\``);
        extras++;
      }
    }

    // Roblox Studio scanned scripts and selection (auto-synced by plugin every 10s).
    if (state.studioScripts?.length) {
      const maxScripts = userIsPro ? 120 : 40;
      const scriptCap = userIsPro ? 3000 : 1500;
      const scriptLines = [];
      for (let i = 0; i < Math.min(state.studioScripts.length, maxScripts); i++) {
        const s = state.studioScripts[i];
        scriptLines.push(`SCRIPT: ${s.path} (${s.class})\n\`\`\`lua\n${(s.source || '').slice(0, scriptCap)}\n\`\`\``);
      }
      parts.push(`STUDIO SCRIPTS (${state.studioScripts.length} total):\n${scriptLines.join('\n')}`);
    }
    if (state.studioSelected?.length) {
      parts.push(`STUDIO SELECTED:\n${state.studioSelected.map((s) => `- ${s.path} (${s.class})`).join('\n')}`);
    }
    if (state.studioErrors?.length) {
      const recent = state.studioErrors.slice(-5);
      parts.push(`RECENT STUDIO ERRORS / WARNINGS:\n${recent.map((e) => `- [${e.type}] ${e.message}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  // ─── Ollama (local models on the user's PC) ────────────────────────
  // ─── AI Chat (streaming) ───────────────────────────────────────────
  let aiBusy = false;
  let aiAbortController = null;
  let studioConnectWarningAt = 0;

  async function isStudioConnected() {
    if (window.__rotexStudioConnected) return true;
    if (!window.rotexDesktop?.getPluginStatus) return false;
    try {
      const status = await window.rotexDesktop.getPluginStatus();
      window.__rotexStudioConnected = Boolean(status?.connected);
      return window.__rotexStudioConnected;
    } catch {
      return false;
    }
  }

  stopAiButton?.addEventListener('click', () => {
    if (aiAbortController) aiAbortController.abort();
    aiBusy = false;
    showToast('Stopped current ROTEX task.');
  });

  async function sendChatRequest(text, options = {}) {
    if (aiBusy || !text) return;
    if (options.requireConfirm && !confirmLargeTaskIfNeeded()) return;

    const isAutoFix = options.autoFix || false;
    addAIMessage('user', text);
    if (!isAutoFix) {
      aiInput.value = '';
      aiInput.style.height = 'auto';
    }

    const studioConnected = await isStudioConnected();
    if (!studioConnected && !isAutoFix && Date.now() - studioConnectWarningAt > 30000) {
      studioConnectWarningAt = Date.now();
      addAIMessage('assistant', 'Studio is not connected yet. You can keep chatting, but I cannot apply scripts or read your Roblox place until you open the ROTEX AI plugin in Roblox Studio and click Connect to ROTEX.');
    }

    // Determine which model to use
    let modelId = state.aiModel;
    const picked = MODELS.find((m) => m.id === modelId);
    let usedModelName = picked ? picked.name : modelId;
    if (!userIsPro) {
      if (freeMessagesUsed >= FREE_DAILY_LIMIT) {
        addAIMessage('assistant', 'You are out of TexTokens. Upgrade to Pro or add more TexTokens to continue.');
        return;
      }
      freeMessagesUsed++;
      localStorage.setItem('rotex_free_msgs', String(freeMessagesUsed));
    }

    const apiMessages = state.aiMessages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    const projectContext = [
      state.projectName ? `Project name: ${state.projectName}` : '',
      `Project mode: ${state.projectMode}`,
      state.projectModes?.length ? `Selected tools: ${state.projectModes.join(', ')}` : '',
      studioConnected
        ? 'Roblox Studio plugin: CONNECTED. Studio actions can be queued and applied.'
        : 'Roblox Studio plugin: NOT CONNECTED. Tell the user to open the ROTEX AI plugin in Roblox Studio and click Connect to ROTEX before applying scripts or reading Studio context.',
      buildProjectContext(),
    ].filter(Boolean).join('\n');

    // Streaming message bubble
    const bubble = document.createElement('div');
    bubble.className = 'ai-msg ai-msg-assistant ai-msg-streaming';
    const streamBody = document.createElement('div');
    streamBody.className = 'ai-msg-stream';
    bubble.appendChild(streamBody);
    aiMessages.appendChild(bubble);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    let fullText = '';
    const onDelta = (chunk) => {
      fullText += chunk;
      streamBody.textContent = fullText;
      const nearBottom = aiMessages.scrollHeight - aiMessages.scrollTop - aiMessages.clientHeight < 80;
      if (nearBottom) aiMessages.scrollTop = aiMessages.scrollHeight;
    };

    aiBusy = true;
    aiAbortController = new AbortController();
    const desktopAuth = getDesktopAuth();
    const idToken = await getValidIdToken();
    try {
      const resp = await fetch(`${API_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: aiAbortController.signal,
          body: JSON.stringify({
            model: modelId,
            messages: apiMessages,
            mode: 'editor',
            agent: Boolean(state.agentMode),
            superAgent: Boolean(state.superAgentMode),
            projectMode: state.projectMode,
            projectContext,
            proPass: getProPass(),
            authToken: idToken,
            uid: desktopAuth.uid,
            email: desktopAuth.email,
            texTokensLeft: texTokensLeft(),
            stream: true,
          }),
      });

      const contentType = resp.headers.get('content-type') || '';
      if (!resp.ok || !contentType.includes('text/event-stream')) {
        const errData = await resp.json().catch(() => ({}));
        // If the user is Pro but the server rejected the pass, try refreshing once.
        if ((errData.error === 'pro_required' || errData.error === 'no_textokens') && userIsPro && !options.retryedProRefresh) {
          const refresh = await refreshProPass();
          if (refresh.ok) {
            bubble.remove();
            aiBusy = false;
            aiAbortController = null;
            return sendChatRequest(text, { ...options, retryedProRefresh: true });
          }
        }
        bubble.remove();
        addAIMessage('assistant', errData.text || 'servers are down');
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamError = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const events = buf.split('\n\n');
        buf = events.pop() || '';
        for (const event of events) {
          const line = event.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (payload.model) usedModelName = payload.model;
          if (payload.d) onDelta(payload.d);
          if (payload.error) streamError = payload.text || 'servers are down';
        }
      }
      if (streamError && !fullText) {
        bubble.remove();
        addAIMessage('assistant', streamError);
        return;
      }

      bubble.remove();
      if (!fullText) {
        addAIMessage('assistant', 'servers are down');
        return;
      }
      spendTexTokens(estimateTaskCost());
      addAIMessage('assistant', fullText, usedModelName);
    } catch (err) {
      bubble.remove();
      if (err?.name === 'AbortError') {
        addAIMessage('assistant', 'Stopped.');
        return;
      }
      addAIMessage('assistant', 'servers are down');
    } finally {
      aiBusy = false;
      aiAbortController = null;
    }
  }

  aiComposer.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendChatRequest(aiInput.value.trim(), { requireConfirm: true });
  });

  // ─── Studio Plugin Context (scripts, selection, errors) ───────────
  function handlePluginContext(ctx) {
    if (!ctx) return;

    if (ctx.scripts && Array.isArray(ctx.scripts)) {
      state.studioScripts = ctx.scripts;
    }
    if (ctx.selected && Array.isArray(ctx.selected)) {
      state.studioSelected = ctx.selected;
    }
    if (ctx.aiContext) {
      if (ctx.aiContext.scripts && Array.isArray(ctx.aiContext.scripts)) {
        state.studioScripts = ctx.aiContext.scripts;
      }
      if (ctx.aiContext.selected && Array.isArray(ctx.aiContext.selected)) {
        state.studioSelected = ctx.aiContext.selected;
      }
    }

    if (ctx.studioError && ctx.studioError.message) {
      state.studioErrors.push({
        message: ctx.studioError.message,
        type: ctx.studioError.type || 'Error',
        time: ctx.studioError.time || Date.now(),
      });
      // Keep only the most recent 20 errors.
      if (state.studioErrors.length > 20) state.studioErrors = state.studioErrors.slice(-20);
      // Only auto-fix real errors; warnings are just context.
      if (ctx.studioError.type !== 'MessageWarning') {
        triggerAutoFix(ctx.studioError);
      }
    }

    if (ctx.studioResult) {
      // Action results can also contain failures that look like errors.
      const result = ctx.studioResult;
      if (result.ok === false && result.messages && result.messages.length) {
        const msg = result.messages.join('\n');
        state.studioErrors.push({ message: msg, type: 'ActionFailed', time: Date.now() });
        if (state.studioErrors.length > 20) state.studioErrors = state.studioErrors.slice(-20);
        triggerAutoFix({ message: msg, type: 'ActionFailed' });
      }
    }
  }

  async function triggerAutoFix(error) {
    if (!error || !error.message) return;
    if (aiBusy) return;
    if (Date.now() - state.lastAutoFixAt < 8000) return;
    const studioConnected = await isStudioConnected();
    if (!studioConnected) return;

    // Only auto-fix real errors, not warnings about missing instances from removal actions.
    const msg = String(error.message).toLowerCase();
    if (msg.includes('not found') && msg.includes('delete')) return;
    if (msg.includes('not found') && msg.includes('remove')) return;

    state.lastAutoFixAt = Date.now();
    const prompt = `[AUTO-FIX] Roblox Studio reported an error. Please investigate the PROJECT CONTEXT and fix it.\n\nError: ${error.message}\n\nType: ${error.type || 'Error'}`;
    sendChatRequest(prompt, { autoFix: true });
  }

  function addAIMessage(role, content, modelName) {
    state.aiMessages.push({ role, content });
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;
    div.innerHTML = formatAIContent(content, role);
    if (modelName && role === 'assistant') {
      const meta = document.createElement('div');
      meta.className = 'ai-msg-model';
      meta.textContent = modelName;
      div.appendChild(meta);
    }
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    // Track usage
    if (role === 'assistant' && modelName) {
      trackUsage(modelName);
    }
  }

  function formatAIContent(text, role) {
    if (role === 'user') return escapeHtml(text).replace(/\n/g, '<br>');

    // Parse code blocks and add "Apply to editor" buttons
    let html = text;
    let fileBlockCount = 0;

    // Handle file blocks: ```file:path
    html = html.replace(/```file:([^\n]+)\n([\s\S]*?)```/g, (_, filename, code) => {
      fileBlockCount++;
      const cleanName = escapeHtml(filename.trim());
      const encoded = btoa(unescape(encodeURIComponent(code.trim())));
      const escaped = escapeHtml(code.trim());
      return `<div class="ai-code-block">
        <div class="ai-code-header">
          <span>${cleanName}</span>
          <button class="ai-code-diff" data-filename="${cleanName}" data-code="${encoded}">Diff</button>
          <button class="ai-code-apply" data-filename="${cleanName}" data-code="${encoded}">Apply</button>
        </div>
        <pre><code>${escaped}</code></pre>
      </div>`;
    });

    // Handle regular code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = escapeHtml(code.trim());
      const applyBtn = state.activeTab && state.activeTab !== 'welcome'
        ? `<button class="ai-code-apply" data-action="replace" data-code="${btoa(unescape(encodeURIComponent(code.trim())))}">Apply to File</button>`
        : '';
      return `<div class="ai-code-block">
        <div class="ai-code-header">
          <span>${lang || 'code'}</span>
          <button class="ai-code-copy" data-code="${btoa(unescape(encodeURIComponent(code.trim())))}">Copy</button>
          ${applyBtn}
        </div>
        <pre><code>${escaped}</code></pre>
      </div>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Newlines
    html = html.replace(/\n/g, '<br>');

    // Multiple file blocks (agent mode) → one-click Apply All
    if (fileBlockCount > 1) {
      html += `<div class="ai-apply-all"><button class="ai-apply-all-btn">Apply All (${fileBlockCount} files)</button></div>`;
    }

    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Handle Apply/Copy/Diff clicks in AI messages
  aiMessages.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('.ai-code-apply');
    const copyBtn = e.target.closest('.ai-code-copy');
    const diffBtn = e.target.closest('.ai-code-diff');
    const applyAllBtn = e.target.closest('.ai-apply-all-btn');

    if (applyAllBtn) {
      const msg = applyAllBtn.closest('.ai-msg');
      const buttons = msg ? [...msg.querySelectorAll('.ai-code-apply[data-filename]')] : [];
      (async () => {
        for (const btn of buttons) {
          const code = decodeURIComponent(escape(atob(btn.dataset.code)));
          await applyCodeToFile(btn.dataset.filename, code);
          btn.textContent = 'Applied!';
          btn.classList.add('applied');
        }
        applyAllBtn.textContent = `Applied ${buttons.length} files`;
        applyAllBtn.disabled = true;
      })();
      return;
    }

    if (diffBtn) {
      const code = decodeURIComponent(escape(atob(diffBtn.dataset.code)));
      showDiffModal(diffBtn.dataset.filename, code);
      return;
    }

    if (copyBtn) {
      const code = decodeURIComponent(escape(atob(copyBtn.dataset.code)));
      navigator.clipboard.writeText(code);
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      return;
    }

    if (applyBtn) {
      const code = decodeURIComponent(escape(atob(applyBtn.dataset.code)));
      const filename = applyBtn.dataset.filename;

      if (filename) {
        // Create or open file with this content
        applyCodeToFile(filename, code);
      } else if (state.activeTab && state.activeTab !== 'welcome') {
        // Replace current file content
        applyCodeToCurrentFile(code);
      }

      applyBtn.textContent = 'Applied!';
      applyBtn.classList.add('applied');
      setTimeout(() => { applyBtn.textContent = filename ? 'Apply' : 'Apply to File'; applyBtn.classList.remove('applied'); }, 2000);
    }
  });

  async function applyCodeToFile(filename, code) {
    const language = detectLanguage(filename);
    if (state.openFiles.has(filename)) {
      const file = state.openFiles.get(filename);
      file.content = code;
      file.modified = false; // We're saving immediately
      const editor = editorInstances.get(filename);
      if (editor) editor.setValue(code);
      activateTab(filename);
    } else {
      state.openFiles.set(filename, { content: code, language, modified: false });
      createTab(filename, filename.split('/').pop());
      createEditorPane(filename, code, language);
      activateTab(filename);
    }

    // Write to disk
    await writeFileToDisk(filename, code);
  }

  async function applyCodeToCurrentFile(code) {
    const path = state.activeTab;
    const file = state.openFiles.get(path);
    if (!file) return;
    file.content = code;
    file.modified = false; // Saving immediately
    const editor = editorInstances.get(path);
    if (editor) editor.setValue(code);

    // Write to disk
    await writeFileToDisk(path, code);

    // Update tab (remove modified indicator)
    const tabEl = tabs.querySelector(`[data-tab="${path}"] .tab-name`);
    if (tabEl) tabEl.textContent = tabEl.textContent.replace(' *', '');
  }

  // ─── Diff Preview ──────────────────────────────────────────────────
  async function getKnownFileContent(path) {
    const open = state.openFiles.get(path);
    if (open) return open.content;
    const entry = findEntry(state.fileTree, path);
    if (!entry) return null;
    try {
      if (window.rotexDesktop) {
        return await window.rotexDesktop.readFile(entry.path);
      }
      if (entry.handle) {
        const file = await entry.handle.getFile();
        return await file.text();
      }
    } catch { /* unreadable — treat as new file */ }
    return null;
  }

  // Common prefix/suffix line diff — fast and good enough for previews.
  function computeLineDiff(oldText, newText) {
    const a = String(oldText).split('\n');
    const b = String(newText).split('\n');
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

    const rows = [];
    for (let i = Math.max(0, start - 3); i < start; i++) rows.push({ type: 'ctx', text: a[i], num: i + 1 });
    for (let i = start; i < endA; i++) rows.push({ type: 'del', text: a[i], num: i + 1 });
    for (let i = start; i < endB; i++) rows.push({ type: 'add', text: b[i], num: i + 1 });
    for (let i = endA; i < Math.min(a.length, endA + 3); i++) rows.push({ type: 'ctx', text: a[i], num: i + 1 });
    return { rows, removed: endA - start, added: endB - start };
  }

  async function showDiffModal(filename, newCode) {
    document.querySelector('.diff-modal-overlay')?.remove();

    const oldContent = await getKnownFileContent(filename);
    const overlay = document.createElement('div');
    overlay.className = 'diff-modal-overlay';

    let bodyHtml;
    let summary;
    if (oldContent === null) {
      summary = 'New file';
      bodyHtml = newCode.split('\n').slice(0, 400)
        .map((line, i) => `<div class="diff-line diff-add"><span class="diff-num">${i + 1}</span>${escapeHtml(line) || '&nbsp;'}</div>`)
        .join('');
    } else {
      const diff = computeLineDiff(oldContent, newCode);
      summary = `−${diff.removed} +${diff.added} lines`;
      bodyHtml = diff.rows.slice(0, 600).map((row) => {
        const cls = row.type === 'add' ? 'diff-add' : row.type === 'del' ? 'diff-del' : 'diff-ctx';
        return `<div class="diff-line ${cls}"><span class="diff-num">${row.num}</span>${escapeHtml(row.text) || '&nbsp;'}</div>`;
      }).join('');
      if (!diff.rows.length) bodyHtml = '<div class="diff-line diff-ctx">No changes — file already matches.</div>';
    }

    overlay.innerHTML = `
      <div class="diff-modal">
        <div class="diff-modal-header">
          <span class="diff-modal-title">${escapeHtml(filename)}</span>
          <span class="diff-modal-summary">${summary}</span>
          <button class="diff-modal-apply">Apply</button>
          <button class="diff-modal-close">&times;</button>
        </div>
        <div class="diff-modal-body">${bodyHtml}</div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('.diff-modal-close')) overlay.remove();
    });
    overlay.querySelector('.diff-modal-apply').addEventListener('click', async () => {
      await applyCodeToFile(filename, newCode);
      overlay.remove();
    });
  }

  // ─── Write File to Disk ────────────────────────────────────────────
  async function writeFileToDisk(filePath, content) {
    // Desktop (Electron) - use IPC to write directly
    if (window.rotexDesktop) {
      const fullPath = state.currentDirPath
        ? `${state.currentDirPath}/${filePath}`
        : filePath;
      const success = await window.rotexDesktop.writeFile(fullPath, content);
      if (!success) console.error('Failed to write file:', fullPath);
      return success;
    }

    // Browser - use File System Access API if we have a directory handle
    if (state.directoryHandle) {
      try {
        // Handle nested paths (e.g. "src/app.js")
        const parts = filePath.split('/');
        let dirHandle = state.directoryHandle;

        // Navigate/create subdirectories
        for (let i = 0; i < parts.length - 1; i++) {
          dirHandle = await dirHandle.getDirectoryHandle(parts[i], { create: true });
        }

        // Create/overwrite the file
        const fileHandle = await dirHandle.getFileHandle(parts[parts.length - 1], { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        return true;
      } catch (err) {
        console.error('Browser file write failed:', err);
        return false;
      }
    }

    // No filesystem access — file only exists in memory
    return false;
  }

  function markTabModified(path) {
    const tabEl = tabs.querySelector(`[data-tab="${path}"] .tab-name`);
    if (tabEl && !tabEl.textContent.endsWith(' *')) {
      tabEl.textContent += ' *';
    }
  }

  // Auto-resize AI input
  aiInput.addEventListener('input', () => {
    aiInput.style.height = 'auto';
    aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
  });
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      aiComposer.dispatchEvent(new Event('submit'));
    }
  });

  // ─── File System ───────────────────────────────────────────────────
  async function openFolder() {
    // Desktop (Electron) - use native dialog via IPC
    if (window.rotexDesktop) {
      const folderPath = await window.rotexDesktop.openFolder();
      if (!folderPath) return;
      state.currentDirPath = folderPath;
      state.directoryHandle = null;
      await buildTreeDesktop(folderPath, '');
      return;
    }

    // Browser - use File System Access API
    try {
      const handle = await window.showDirectoryPicker();
      state.directoryHandle = handle;
      state.currentDirPath = handle.name;
      await buildTree(handle, '');
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Open folder error:', err);
    }
  }

  // Desktop file tree (uses Electron IPC)
  async function buildTreeDesktop(dirPath, basePath) {
    const entries = await window.rotexDesktop.readDirectory(dirPath);
    const items = entries
      .filter(e => !e.name.startsWith('.') || e.name === '.env.example')
      .filter(e => e.name !== 'node_modules' && e.name !== '__pycache__' && e.name !== '.git')
      .map(e => ({
        name: e.name,
        path: e.path,
        kind: e.kind,
        children: null,
        open: false,
      }));

    if (!basePath) {
      state.fileTree = items;
      renderFileTree();
    }
    return items;
  }

  // Browser file tree (uses File System Access API handles)
  async function buildTree(dirHandle, basePath) {
    const items = [];
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') continue;

      const entryPath = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        items.push({ name: entry.name, path: entryPath, kind: 'directory', handle: entry, children: null, open: false });
      } else {
        items.push({ name: entry.name, path: entryPath, kind: 'file', handle: entry });
      }
    }
    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (!basePath) {
      state.fileTree = items;
      renderFileTree();
    }
    return items;
  }

  function renderFileTree() {
    if (!state.fileTree.length) {
      fileTree.innerHTML = `<div class="tree-empty"><p>No folder opened</p><button class="tree-open-btn" id="treeOpenBtn">Open Folder</button></div>`;
      $('#treeOpenBtn')?.addEventListener('click', openFolder);
      return;
    }

    fileTree.innerHTML = `<div class="tree-root-label">${escapeHtml(state.currentDirPath)}</div>` + buildTreeHTML(state.fileTree, 0);
    attachTreeListeners();
  }

  function buildTreeHTML(items, depth) {
    return items.map((item) => {
      const pad = 16 + depth * 16;
      if (item.kind === 'directory') {
        const arrow = item.open ? '&#9662;' : '&#9656;';
        const childrenHTML = item.open && item.children ? buildTreeHTML(item.children, depth + 1) : '';
        return `<div class="tree-item tree-folder${item.open ? ' open' : ''}" data-path="${item.path}" style="padding-left:${pad}px">
          <span class="tree-arrow">${arrow}</span>
          <span class="tree-icon tree-icon-folder"></span>
          <span class="tree-label">${item.name}</span>
        </div>${item.open ? `<div class="tree-children">${childrenHTML}</div>` : ''}`;
      }
      return `<div class="tree-item tree-file" data-path="${item.path}" style="padding-left:${pad}px">
        <span class="tree-icon tree-icon-file"></span>
        <span class="tree-label">${item.name}</span>
      </div>`;
    }).join('');
  }

  function attachTreeListeners() {
    fileTree.querySelectorAll('.tree-item').forEach((el) => {
      el.addEventListener('click', handleTreeClick);
    });
  }

  async function handleTreeClick(e) {
    const item = e.currentTarget;
    const path = item.dataset.path;

    if (item.classList.contains('tree-folder')) {
      const entry = findEntry(state.fileTree, path);
      if (!entry) return;
      entry.open = !entry.open;
      if (entry.open && !entry.children) {
        // Desktop vs browser
        if (window.rotexDesktop) {
          entry.children = await buildTreeDesktop(path, path);
        } else if (entry.handle) {
          entry.children = await buildTree(entry.handle, path);
        }
      }
      renderFileTree();
    } else {
      await openFile(path);
    }
  }

  function findEntry(items, path) {
    for (const item of items) {
      if (item.path === path) return item;
      if (item.children) {
        const found = findEntry(item.children, path);
        if (found) return found;
      }
    }
    return null;
  }

  async function openFile(path) {
    if (state.openFiles.has(path)) {
      activateTab(path);
      return;
    }

    const entry = findEntry(state.fileTree, path);
    if (!entry) return;

    try {
      let content = '';
      const name = entry.name || path.split('/').pop() || path.split('\\').pop();

      if (window.rotexDesktop) {
        // Desktop: read via IPC
        content = await window.rotexDesktop.readFile(path);
        if (content === null) {
          console.error('Could not read file:', path);
          return;
        }
      } else if (entry.handle) {
        // Browser: use File System Access API
        const file = await entry.handle.getFile();
        content = await file.text();
      } else {
        return;
      }

      const language = detectLanguage(name);
      state.openFiles.set(path, { content, language, modified: false, handle: entry.handle || null });
      createTab(path, name);
      createEditorPane(path, content, language);
      activateTab(path);
    } catch (err) {
      console.error('Open file failed:', err);
    }
  }

  // ─── Tabs ──────────────────────────────────────────────────────────
  function createTab(path, name) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.tab = path;
    tab.innerHTML = `<span class="tab-name">${escapeHtml(name)}</span><button class="tab-close">&times;</button>`;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) closeTab(path);
      else activateTab(path);
    });
    tabs.appendChild(tab);
  }

  function activateTab(path) {
    state.activeTab = path;
    tabs.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === path));
    editorContent.querySelectorAll('.editor-tab-content').forEach((c) => c.classList.toggle('active', c.dataset.content === path));

    const file = state.openFiles.get(path);
    if (file) {
      $('#sbLang').textContent = langDisplayName(file.language);
    }

    // Update breadcrumb
    updateBreadcrumb(path);

    // Highlight in tree
    fileTree.querySelectorAll('.tree-item').forEach((i) => i.classList.toggle('active', i.dataset.path === path));

    // Resize monaco
    const editor = editorInstances.get(path);
    if (editor) setTimeout(() => editor.layout(), 10);
  }

  function updateBreadcrumb(path) {
    const bar = $('#breadcrumbBar');
    if (!bar) return;
    if (path === 'welcome') {
      const label = state.projectName ? `${escapeHtml(state.projectName)} / Welcome` : 'Welcome';
      bar.innerHTML = `<span class="bc-active">${label}</span>`;
      return;
    }
    const parts = path.split('/');
    bar.innerHTML = parts.map((p, i) => {
      const isLast = i === parts.length - 1;
      const sep = i < parts.length - 1 ? '<span class="bc-sep">›</span>' : '';
      return `<span class="${isLast ? 'bc-active' : ''}">${p}</span>${sep}`;
    }).join('');
  }

  function closeTab(path) {
    const tab = tabs.querySelector(`[data-tab="${path}"]`);
    if (tab) tab.remove();
    const content = editorContent.querySelector(`[data-content="${path}"]`);
    if (content) content.remove();
    const editor = editorInstances.get(path);
    if (editor) { editor.dispose(); editorInstances.delete(path); }
    state.openFiles.delete(path);

    const remaining = tabs.querySelectorAll('.tab');
    if (remaining.length) activateTab(remaining[remaining.length - 1].dataset.tab);
    else { state.activeTab = 'welcome'; activateTab('welcome'); }
  }

  function createEditorPane(path, content, language) {
    const div = document.createElement('div');
    div.className = 'editor-tab-content';
    div.dataset.content = path;
    const container = document.createElement('div');
    container.className = 'monaco-container';
    div.appendChild(container);
    editorContent.appendChild(div);

    function init() {
      if (!monacoReady) { setTimeout(init, 50); return; }
      const editor = monaco.editor.create(container, {
        value: content,
        language,
        theme: 'rotex-dark',
        automaticLayout: true,
        minimap: { enabled: true, scale: 1 },
        fontSize: 14,
        fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
        fontLigatures: true,
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: true,
        wordWrap: 'off',
        tabSize: 2,
        insertSpaces: true,
        folding: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true, indentation: true },
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        padding: { top: 8 },
        suggest: { showWords: true },
        quickSuggestions: true,
      });

      editorInstances.set(path, editor);

      // Ctrl+K inside Monaco (Monaco swallows the document-level shortcut)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => openInlineEdit());

      editor.onDidChangeModelContent(() => {
        const file = state.openFiles.get(path);
        if (file) {
          file.content = editor.getValue();
          if (!file.modified) {
            file.modified = true;
            markTabModified(path);
          }
        }
      });

      editor.onDidChangeCursorPosition((e) => {
        if (state.activeTab === path) {
          $('#sbPosition').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        }
      });
    }
    init();
  }

  // ─── Save ──────────────────────────────────────────────────────────
  async function saveCurrentFile() {
    const path = state.activeTab;
    if (!path || path === 'welcome') return;
    const file = state.openFiles.get(path);
    if (!file || !file.modified) return;

    try {
      const success = await writeFileToDisk(path, file.content);
      if (success || !window.rotexDesktop) {
        // Browser fallback: try File System Access API handles
        if (!window.rotexDesktop) {
          if (file.handle) {
            const writable = await file.handle.createWritable();
            await writable.write(file.content);
            await writable.close();
          } else {
            const entry = findEntry(state.fileTree, path);
            if (entry && entry.handle) {
              const writable = await entry.handle.createWritable();
              await writable.write(file.content);
              await writable.close();
            }
          }
        }
      }
      file.modified = false;
      const tabEl = tabs.querySelector(`[data-tab="${path}"] .tab-name`);
      if (tabEl) tabEl.textContent = tabEl.textContent.replace(' *', '');
    } catch (err) {
      console.error('Save failed:', err);
    }
  }

  // ─── New File ──────────────────────────────────────────────────────
  async function createNewFile() {
    const name = prompt('File name:');
    if (!name) return;

    const language = detectLanguage(name);
    state.openFiles.set(name, { content: '', language, modified: true });
    createTab(name, name);
    createEditorPane(name, '', language);
    activateTab(name);
  }

  // ─── Terminal ──────────────────────────────────────────────────────
  function toggleTerminal() {
    state.bottomPanelOpen = !state.bottomPanelOpen;
    bottomPanel.hidden = !state.bottomPanelOpen;
    if (state.bottomPanelOpen) terminalInput.focus();
  }

  $('#closeBottomPanel').addEventListener('click', () => {
    state.bottomPanelOpen = false;
    bottomPanel.hidden = true;
  });

  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = terminalInput.value;
      if (!cmd.trim()) return;
      state.terminalHistory.push(cmd);
      state.terminalHistoryIdx = state.terminalHistory.length;
      appendTerminal(`$ ${cmd}`, 'cmd');
      terminalInput.value = '';
      runTerminalCommand(cmd.trim());
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (state.terminalHistoryIdx > 0) {
        state.terminalHistoryIdx--;
        terminalInput.value = state.terminalHistory[state.terminalHistoryIdx] || '';
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (state.terminalHistoryIdx < state.terminalHistory.length - 1) {
        state.terminalHistoryIdx++;
        terminalInput.value = state.terminalHistory[state.terminalHistoryIdx] || '';
      } else {
        state.terminalHistoryIdx = state.terminalHistory.length;
        terminalInput.value = '';
      }
    }
  });

  function runTerminalCommand(cmd) {
    // Desktop app has real terminal via IPC
    if (window.rotexDesktop) {
      const approved = confirm(`ROTEX wants to run this command in your project:\n\n${cmd}\n\nApprove command?`);
      if (!approved) {
        appendTerminal('Command cancelled by user.', 'error');
        return;
      }
      window.rotexDesktop.execCommand(cmd, state.currentDirPath).then((result) => {
        if (result.stdout) appendTerminal(result.stdout);
        if (result.stderr) appendTerminal(result.stderr, 'error');
      });
      return;
    }

    // Browser simulation
    if (cmd === 'clear') { terminalOutput.innerHTML = ''; return; }
    if (cmd === 'help') { appendTerminal('ROTEX Terminal (browser mode)\nAvailable: clear, help, echo, ls, pwd, cat <file>\nFor full terminal access, use the ROTEX desktop app.'); return; }
    if (cmd.startsWith('echo ')) { appendTerminal(cmd.slice(5)); return; }
    if (cmd === 'pwd') { appendTerminal(`/${state.currentDirPath || 'home'}`); return; }
    if (cmd === 'ls') {
      if (state.fileTree.length) appendTerminal(state.fileTree.map(f => f.kind === 'directory' ? f.name + '/' : f.name).join('  '));
      else appendTerminal('(no folder open — use Open Folder first)');
      return;
    }
    if (cmd.startsWith('cat ')) {
      const filename = cmd.slice(4).trim();
      const file = state.openFiles.get(filename);
      if (file) appendTerminal(file.content);
      else appendTerminal(`cat: ${filename}: No such file (only open files available in browser mode)`);
      return;
    }
    appendTerminal(`'${cmd}' is not available in browser terminal.\nUse the ROTEX desktop app for full shell access.`);
  }

  function appendTerminal(text, type) {
    const line = document.createElement('div');
    line.className = 'term-line' + (type === 'error' ? ' term-error' : type === 'cmd' ? ' term-cmd' : '');
    line.textContent = text;
    terminalOutput.appendChild(line);
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  // ─── Ctrl+K Inline Edit ────────────────────────────────────────────
  let ctrlkOpen = false;

  function openInlineEdit() {
    if (ctrlkOpen) return;
    const path = state.activeTab;
    if (!path || path === 'welcome') {
      showToast('Open a file first, then press Ctrl+K to edit with AI');
      return;
    }
    const editor = editorInstances.get(path);
    if (!editor) return;
    ctrlkOpen = true;

    const widget = document.createElement('div');
    widget.className = 'ctrlk-widget';
    widget.innerHTML = `
      <input type="text" class="ctrlk-input" placeholder="Edit with AI — describe the change (Enter to run, Esc to cancel)" />
      <span class="ctrlk-status"></span>`;
    const host = editorContent.querySelector(`[data-content="${CSS.escape(path)}"]`) || editorContent;
    host.appendChild(widget);
    const input = widget.querySelector('.ctrlk-input');
    const status = widget.querySelector('.ctrlk-status');
    input.focus();

    const close = () => { widget.remove(); ctrlkOpen = false; editor.focus(); };

    input.addEventListener('keydown', async (ev) => {
      if (ev.key === 'Escape') { close(); return; }
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const instruction = input.value.trim();
      if (!instruction || input.disabled) return;

      const selection = editor.getSelection();
      const model = editor.getModel();
      const hasSelection = selection && !selection.isEmpty();
      const selectedText = hasSelection ? model.getValueInRange(selection) : '';
      const file = state.openFiles.get(path);

      if (!userIsPro) {
        if (freeMessagesUsed >= FREE_DAILY_LIMIT) {
          status.textContent = 'Daily limit reached - Go Pro';
          return;
        }
        freeMessagesUsed++;
        localStorage.setItem('rotex_free_msgs', String(freeMessagesUsed));
      }

      input.disabled = true;
      status.textContent = 'Thinking...';

      const prompt = [
        `INLINE EDIT in file ${path} (${file ? file.language : 'text'}).`,
        hasSelection
          ? `Selected code:\n\`\`\`\n${selectedText.slice(0, 12000)}\n\`\`\``
          : `Cursor is at line ${selection.startLineNumber}. Full file for context:\n\`\`\`\n${file ? file.content.slice(0, 12000) : ''}\n\`\`\``,
        `Instruction: ${instruction}`,
        hasSelection
          ? 'Reply with ONLY the replacement for the selected code. No markdown fences, no explanation, no file blocks.'
          : 'Reply with ONLY the code to insert at the cursor. No markdown fences, no explanation, no file blocks.',
      ].join('\n\n');

      try {
        const ctrlkAuth = getDesktopAuth();
        const ctrlkToken = await getValidIdToken();
        const resp = await fetch(`${API_BASE}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: userIsPro ? 'pro-smart' : 'fast',
            messages: [{ role: 'user', content: prompt }],
            mode: 'editor',
            proPass: getProPass(),
            authToken: ctrlkToken,
            uid: ctrlkAuth.uid,
            email: ctrlkAuth.email,
            texTokensLeft: texTokensLeft(),
          }),
        });
        const data = await resp.json();
        let code = String(data.text || '').trim();
        code = code.replace(/^```[a-zA-Z]*\r?\n?/, '').replace(/\r?\n?```\s*$/, '');
        if (!code) {
          status.textContent = data.error ? (data.text || 'No edit returned') : 'No edit returned';
          input.disabled = false;
          return;
        }
        const range = hasSelection
          ? selection
          : new monaco.Range(selection.startLineNumber, selection.startColumn, selection.startLineNumber, selection.startColumn);
        editor.pushUndoStop();
        editor.executeEdits('rotex-ai', [{ range, text: code }]);
        editor.pushUndoStop();
        spendTexTokens(userIsPro ? 75000 : 25000);
        showToast('AI edit applied — Ctrl+Z to undo');
        close();
      } catch {
        status.textContent = 'Could not reach the AI backend';
        input.disabled = false;
      }
    });
  }

  // ─── Auto-open project selected from projects screen ──────────────
  if (window.rotexDesktop) {
    const pending = localStorage.getItem('rotex_pending_project');
    if (pending) {
      localStorage.removeItem('rotex_pending_project');
      state.currentDirPath = pending;
      buildTreeDesktop(pending, '');
    }
  }

  // ─── Button Wiring ─────────────────────────────────────────────────
  ['#openFolderBtn', '#treeOpenBtn', '#welcomeOpenFolder'].forEach((sel) => {
    $(sel)?.addEventListener('click', openFolder);
  });
  ['#newFileBtn', '#welcomeNewFile'].forEach((sel) => {
    $(sel)?.addEventListener('click', createNewFile);
  });
  $('#newTerminalBtn')?.addEventListener('click', () => {
    terminalOutput.innerHTML = '';
    appendTerminal('ROTEX Terminal — type "help" for commands', 'cmd');
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
    if (e.ctrlKey && e.key === '`') { e.preventDefault(); toggleTerminal(); }
    if (e.ctrlKey && e.shiftKey && (e.key === 'A' || e.key === 'a')) { e.preventDefault(); toggleAIPanel(); }
    if (e.ctrlKey && !e.shiftKey && e.key === 'k') { e.preventDefault(); openInlineEdit(); }
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); createNewFile(); }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); editorApp.classList.toggle('side-collapsed'); }
  });

  // ─── Profile / Usage Popup ──────────────────────────────────────────
  const profileBtn = $('#sbProfile');
  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      showUsagePopup();
    });
  }

  function showUsagePopup() {
    // Remove existing popup
    const existing = document.querySelector('.usage-popup');
    if (existing) { existing.remove(); return; }

    const stats = getUsageStats();
    const remaining = userIsPro ? 'Unlimited' : `${Math.max(0, FREE_DAILY_LIMIT - freeMessagesUsed)} / ${FREE_DAILY_LIMIT}`;
    const planLabel = userIsPro ? 'Pro' : 'Free';

    // Build model breakdown
    let todayModels = '';
    for (const [model, count] of Object.entries(stats.today.models || {})) {
      todayModels += `<div class="usage-model-row"><span>${model}</span><span>${count}</span></div>`;
    }
    if (!todayModels) todayModels = '<div class="usage-model-row muted">No messages yet today</div>';

    let weekModels = '';
    for (const [model, count] of Object.entries(stats.weekModels || {})) {
      weekModels += `<div class="usage-model-row"><span>${model}</span><span>${count}</span></div>`;
    }
    if (!weekModels) weekModels = '<div class="usage-model-row muted">No messages this week</div>';

    const popup = document.createElement('div');
    popup.className = 'usage-popup';
    popup.innerHTML = `
      <div class="usage-popup-header">
        <span class="usage-plan-badge ${userIsPro ? 'pro' : 'free'}">${planLabel}</span>
        <span class="usage-title">Usage</span>
        <button class="usage-close">&times;</button>
      </div>
      <div class="usage-section">
        <div class="usage-section-title">Today</div>
        <div class="usage-stat-row">
          <span>Messages</span>
          <span class="usage-stat-value">${stats.today.total}</span>
        </div>
        <div class="usage-stat-row">
          <span>Remaining</span>
          <span class="usage-stat-value">${remaining}</span>
        </div>
        <div class="usage-models-title">Models used</div>
        ${todayModels}
      </div>
      <div class="usage-section">
        <div class="usage-section-title">This Week (7 days)</div>
        <div class="usage-stat-row">
          <span>Total messages</span>
          <span class="usage-stat-value">${stats.weekTotal}</span>
        </div>
        <div class="usage-models-title">Models used</div>
        ${weekModels}
      </div>
      ${!userIsPro ? '<div class="usage-upgrade"><button class="usage-upgrade-btn">Go Pro</button></div>' : ''}
    `;

    document.body.appendChild(popup);

    popup.querySelector('.usage-close').addEventListener('click', () => popup.remove());
    const upgradeBtn = popup.querySelector('.usage-upgrade-btn');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        window.open('https://rrotex.com/#pricing', '_blank');
        popup.remove();
      });
    }

    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', function closePopup(e) {
        if (!popup.contains(e.target) && e.target !== profileBtn) {
          popup.remove();
          document.removeEventListener('click', closePopup);
        }
      });
    }, 10);
  }

  // ─── Init ──────────────────────────────────────────────────────────
  appendTerminal('ROTEX Terminal — type "help" for commands', 'cmd');
  updateCostPreview();

  // Listen for Studio plugin context (scripts, selection, runtime errors).
  if (window.rotexDesktop?.onPluginContext) {
    window.rotexDesktop.onPluginContext(handlePluginContext);
  }
  // Also expose the handler so editor.html can register it if needed.
  window.__rotexHandlePluginContext = handlePluginContext;
})();

