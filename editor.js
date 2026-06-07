/* ROTEX Editor - AI-Powered Code Editor */
(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────
  const state = {
    openFiles: new Map(),
    activeTab: 'welcome',
    directoryHandle: null,
    fileTree: [],
    aiMessages: [],
    aiModel: 'adapt',
    terminalHistory: [],
    terminalHistoryIdx: -1,
    sidePanel: 'explorer',
    bottomPanelOpen: false,
    aiPanelOpen: false,
    currentDirPath: '',
  };

  // ─── AI Models (IDs match /api/chat.js) ────────────────────────────
  const MODELS = [
    { id: 'adapt', name: 'Adapt', role: 'Auto', desc: 'Picks the best model(s) for your task', family: 'adapt', pro: false },
    { id: 'rod-1', name: 'Rod _ 1', role: 'Everyday', desc: 'Quick answers, simple tasks', family: 'rod', pro: false },
    { id: 'rod-thinking', name: 'Rod thinking', role: 'Hard tasks', desc: 'Careful reasoning, planning', family: 'rod', pro: false },
    { id: 'rod-brain', name: 'Rod brain', role: 'Smart help', desc: 'Smarter decisions, details', family: 'rod', pro: false },
    { id: 'tex-0', name: 'Tex 0', role: 'Code', desc: 'Coding, debugging, implementation', family: 'tex', pro: false },
    { id: 'tex-1-5', name: 'Tex 1.5', role: 'Complex code', desc: 'Architecture, larger builds', family: 'tex', pro: true },
    { id: 'tex-2-5', name: 'Tex 2.5', role: 'Plus code', desc: 'Hardest coding, deep debugging', family: 'tex', pro: true },
    { id: 'treesearch-q', name: 'Treesearch _ q', role: 'Research', desc: 'Research, comparisons', family: 'tree', pro: false },
  ];

  // User plan state (will be set from auth)
  let userIsPro = false;
  let freeMessagesUsed = parseInt(localStorage.getItem('rotex_free_msgs') || '0');
  const FREE_DAILY_LIMIT = 25;
  const FREE_DAILY_KEY = 'rotex_free_msgs_date';

  // Reset daily counter
  (function resetDailyCounter() {
    const today = new Date().toDateString();
    const savedDate = localStorage.getItem(FREE_DAILY_KEY);
    if (savedDate !== today) {
      freeMessagesUsed = 0;
      localStorage.setItem('rotex_free_msgs', '0');
      localStorage.setItem(FREE_DAILY_KEY, today);
    }
  })();

  // ─── Adapt logic: pick model based on message content ──────────────
  function adaptPickModel(text) {
    const lower = text.toLowerCase();
    const codeSignals = ['function', 'const ', 'let ', 'var ', 'import ', 'class ', 'def ', 'return', '```', 'error', 'bug', 'fix', 'refactor', 'build', 'compile', 'deploy', 'typescript', 'javascript', 'python', 'react', 'api', 'database', 'sql'];
    const hardCodeSignals = ['architecture', 'design pattern', 'optimize', 'performance', 'complex', 'entire', 'full app', 'rewrite', 'large', 'system'];
    const researchSignals = ['compare', 'difference between', 'explain', 'what is', 'how does', 'research', 'pros and cons', 'vs', 'versus'];
    const hardSignals = ['think through', 'step by step', 'plan', 'strategy', 'analyze', 'reason', 'why does'];

    const codeScore = codeSignals.filter(s => lower.includes(s)).length;
    const hardCodeScore = hardCodeSignals.filter(s => lower.includes(s)).length;
    const researchScore = researchSignals.filter(s => lower.includes(s)).length;
    const hardScore = hardSignals.filter(s => lower.includes(s)).length;

    if (hardCodeScore >= 2 || (codeScore >= 3 && lower.length > 200)) return 'tex-1-5';
    if (codeScore >= 2) return 'tex-0';
    if (researchScore >= 2) return 'treesearch-q';
    if (hardScore >= 2 || lower.length > 300) return 'rod-thinking';
    return 'rod-1';
  }

  // ─── Monaco Setup ──────────────────────────────────────────────────
  let monacoReady = false;
  const editorInstances = new Map();

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
  const aiComposer = $('#aiComposer');
  const aiInput = $('#aiInput');
  const terminalOutput = $('#terminalOutput');
  const terminalInput = $('#terminalInput');

  // ─── Activity Bar ──────────────────────────────────────────────────
  $('#activityBar').addEventListener('click', (e) => {
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
    const familyOrder = ['adapt', 'rod', 'tex', 'tree'];
    const familyLabels = { adapt: '', rod: 'ROD FAMILY', tex: 'TEX FAMILY', tree: 'RESEARCH' };
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
      const badge = m.id === 'adapt'
        ? '<span class="adapt-badge">AUTO</span>'
        : m.pro ? '<span class="pro-badge">PRO</span>' : '';

      html += `<button class="ai-model-option${activeClass}${lockedClass}" data-model="${m.id}" ${locked ? 'title="Upgrade to Plus to use this model"' : ''}>
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
        div.textContent = 'Upgrade to Plus to unlock this model';
        aiModelMenu.querySelector('.ai-model-scroll').appendChild(div);
        setTimeout(() => div.remove(), 2500);
      }
      return;
    }

    state.aiModel = model.id;
    $('#aiSelectedModel').textContent = model.name;
    $('#aiSelectedRole').textContent = model.role;
    aiModelMenu.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!aiModelButton.contains(e.target) && !aiModelMenu.contains(e.target)) {
      aiModelMenu.hidden = true;
    }
  });

  // ─── AI Chat ───────────────────────────────────────────────────────
  aiComposer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = aiInput.value.trim();
    if (!text) return;

    addAIMessage('user', text);
    aiInput.value = '';
    aiInput.style.height = 'auto';

    // Check free tier limit
    if (!userIsPro) {
      if (freeMessagesUsed >= FREE_DAILY_LIMIT) {
        addAIMessage('assistant', `You've used all ${FREE_DAILY_LIMIT} free messages today. Upgrade to Plus for more credits and access to Tex 1.5, Tex 2.5, and unlimited messages.`);
        return;
      }
      freeMessagesUsed++;
      localStorage.setItem('rotex_free_msgs', String(freeMessagesUsed));
    }

    // Show typing indicator
    const typing = document.createElement('div');
    typing.className = 'ai-msg ai-msg-typing';
    typing.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>';
    aiMessages.appendChild(typing);
    aiMessages.scrollTop = aiMessages.scrollHeight;

    // Determine which model to use
    let modelId = state.aiModel;
    let adaptNote = '';
    if (modelId === 'adapt') {
      modelId = adaptPickModel(text);
      const picked = MODELS.find(m => m.id === modelId);
      adaptNote = picked ? `Used ${picked.name}` : '';
    }

    // Build context from current file
    let fileContext = '';
    if (state.activeTab && state.activeTab !== 'welcome') {
      const file = state.openFiles.get(state.activeTab);
      if (file) {
        const content = file.content.substring(0, 4000);
        fileContext = `\n\n[Current file: ${state.activeTab} (${file.language})]\n\`\`\`${file.language}\n${content}\n\`\`\``;
      }
    }

    // Build messages for API
    const apiMessages = state.aiMessages.slice(-12).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      // Use absolute URL for Electron (no local server), relative for web
      const apiBase = window.rotexDesktop ? 'https://rrotex.com' : '';
      const resp = await fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          messages: [
            ...apiMessages,
            { role: 'user', content: text + fileContext },
          ],
          personality: 'coder',
        }),
      });

      typing.remove();

      if (!resp.ok) {
        const errData = await resp.json().catch(() => ({}));
        addAIMessage('assistant', errData.text || 'Something went wrong. Try again.');
        return;
      }

      const data = await resp.json();
      const reply = data.text || '';

      if (!reply) {
        addAIMessage('assistant', 'No response received. Check your API keys are set.');
        return;
      }

      addAIMessage('assistant', reply, adaptNote);
    } catch (err) {
      typing.remove();
      addAIMessage('assistant', 'Could not connect to the AI backend. Make sure the server is running.');
    }
  });

  function addAIMessage(role, content, note) {
    state.aiMessages.push({ role, content });
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;
    div.innerHTML = formatAIContent(content, role);
    if (note) {
      const badge = document.createElement('div');
      badge.className = 'ai-adapt-badge';
      badge.textContent = note;
      div.prepend(badge);
    }
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function formatAIContent(text, role) {
    if (role === 'user') return escapeHtml(text).replace(/\n/g, '<br>');

    // Parse code blocks and add "Apply to editor" buttons
    let html = text;

    // Handle file blocks: ```file:path
    html = html.replace(/```file:([^\n]+)\n([\s\S]*?)```/g, (_, filename, code) => {
      const escaped = escapeHtml(code.trim());
      return `<div class="ai-code-block">
        <div class="ai-code-header">
          <span>${escapeHtml(filename.trim())}</span>
          <button class="ai-code-apply" data-filename="${escapeHtml(filename.trim())}" data-code="${btoa(unescape(encodeURIComponent(code.trim())))}">Apply</button>
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

    return html;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Handle Apply/Copy clicks in AI messages
  aiMessages.addEventListener('click', (e) => {
    const applyBtn = e.target.closest('.ai-code-apply');
    const copyBtn = e.target.closest('.ai-code-copy');

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
      bar.innerHTML = '<span class="bc-active">Welcome</span>';
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
    if (e.ctrlKey && e.key === 'n') { e.preventDefault(); createNewFile(); }
    if (e.ctrlKey && e.key === 'b') { e.preventDefault(); editorApp.classList.toggle('side-collapsed'); }
  });

  // ─── Init ──────────────────────────────────────────────────────────
  appendTerminal('ROTEX Terminal — type "help" for commands', 'cmd');
})();
