/* ROTEX Editor - AI-Powered Code Editor */
(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────
  const state = {
    openFiles: new Map(), // path -> { content, model, language, modified }
    activeTab: 'welcome',
    directoryHandle: null,
    fileTree: [],
    aiMessages: [],
    aiModel: 'rod1',
    terminalHistory: [],
    sidePanel: 'explorer',
    bottomPanelOpen: false,
    aiPanelOpen: false,
  };

  // ─── AI Models ─────────────────────────────────────────────────────
  const MODELS = [
    { id: 'rod1', name: 'Rod _ 1', role: 'Everyday', desc: 'Quick answers, simple tasks' },
    { id: 'rod-thinking', name: 'Rod thinking', role: 'Hard tasks', desc: 'Careful reasoning, planning' },
    { id: 'rod-brain', name: 'Rod brain', role: 'Smart help', desc: 'Smarter decisions and details' },
    { id: 'tex0', name: 'Tex 0', role: 'Code', desc: 'Coding, debugging, implementation' },
    { id: 'tex15', name: 'Tex 1.5', role: 'Complex code', desc: 'Architecture, larger builds' },
    { id: 'tex25', name: 'Tex 2.5', role: 'Plus code', desc: 'Hardest coding (Plus only)' },
    { id: 'treesearch', name: 'Treesearch _ q', role: 'Research', desc: 'Research, comparisons' },
  ];

  // ─── Monaco Setup ──────────────────────────────────────────────────
  let monacoReady = false;
  const editorInstances = new Map();

  require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], function () {
    monaco.editor.defineTheme('rotex-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1e1e1e',
        'editor.foreground': '#cccccc',
        'editorLineNumber.foreground': '#5a5a5a',
        'editorCursor.foreground': '#aeafad',
        'editor.selectionBackground': '#264f78',
      },
    });
    monaco.editor.setTheme('rotex-dark');
    monacoReady = true;
  });

  // ─── Language Detection ────────────────────────────────────────────
  function detectLanguage(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const map = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
      json: 'json', xml: 'xml', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', sql: 'sql', sh: 'shell', bash: 'shell',
      c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin', dart: 'dart',
      toml: 'toml', ini: 'ini', dockerfile: 'dockerfile',
    };
    return map[ext] || 'plaintext';
  }

  // ─── DOM References ────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const editorApp = $('#editorApp');
  const activityBar = $('#activityBar');
  const sidePanel = $('#sidePanel');
  const spTitle = $('#spTitle');
  const spContent = $('#spContent');
  const fileTree = $('#fileTree');
  const tabBar = $('#tabBar');
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
  activityBar.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-panel]');
    if (!btn) return;

    const panel = btn.dataset.panel;

    if (panel === 'ai') {
      toggleAIPanel();
      return;
    }

    // Toggle side panel
    if (state.sidePanel === panel) {
      editorApp.classList.toggle('side-collapsed');
    } else {
      editorApp.classList.remove('side-collapsed');
      switchSidePanel(panel);
    }

    // Update active icon
    activityBar.querySelectorAll('.ab-icon[data-panel]').forEach((b) => {
      b.classList.toggle('active', b.dataset.panel === panel);
    });
  });

  function switchSidePanel(panel) {
    state.sidePanel = panel;
    const titles = { explorer: 'EXPLORER', search: 'SEARCH', git: 'SOURCE CONTROL' };
    spTitle.textContent = titles[panel] || panel.toUpperCase();
    spContent.querySelectorAll('.panel-view').forEach((v) => (v.hidden = true));
    const target = $(`#${panel}Panel`);
    if (target) target.hidden = false;
  }

  // ─── AI Panel ──────────────────────────────────────────────────────
  function toggleAIPanel() {
    state.aiPanelOpen = !state.aiPanelOpen;
    aiPanel.hidden = !state.aiPanelOpen;
    editorApp.classList.toggle('ai-open', state.aiPanelOpen);
  }

  $('#aiClosePanel').addEventListener('click', toggleAIPanel);
  $('#aiNewChat').addEventListener('click', () => {
    state.aiMessages = [];
    aiMessages.innerHTML = `<div class="ai-welcome-msg"><p><strong>ROTEX AI</strong></p><p>Ask me anything about your code.</p></div>`;
  });

  // AI Model selector
  function buildModelMenu() {
    aiModelMenu.innerHTML = MODELS.map((m) => `
      <button class="ai-model-option" data-model="${m.id}">
        <span class="model-name">${m.name}</span>
        <span class="model-desc">${m.role} - ${m.desc}</span>
      </button>
    `).join('');
  }
  buildModelMenu();

  aiModelButton.addEventListener('click', () => {
    aiModelMenu.hidden = !aiModelMenu.hidden;
  });
  aiModelMenu.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-model]');
    if (!opt) return;
    const model = MODELS.find((m) => m.id === opt.dataset.model);
    if (model) {
      state.aiModel = model.id;
      $('#aiSelectedModel').textContent = model.name;
      $('#aiSelectedRole').textContent = model.role;
    }
    aiModelMenu.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (!aiModelButton.contains(e.target) && !aiModelMenu.contains(e.target)) {
      aiModelMenu.hidden = true;
    }
  });

  // AI Chat submission
  aiComposer.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = aiInput.value.trim();
    if (!text) return;

    addAIMessage('user', text);
    aiInput.value = '';
    aiInput.style.height = 'auto';

    // Include current file context
    let context = '';
    if (state.activeTab && state.activeTab !== 'welcome') {
      const file = state.openFiles.get(state.activeTab);
      if (file) {
        context = `\n\n[Current file: ${state.activeTab}]\n\`\`\`${file.language}\n${file.content.substring(0, 3000)}\n\`\`\``;
      }
    }

    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: state.aiModel,
          messages: [
            { role: 'system', content: 'You are ROTEX, an AI coding assistant inside a code editor. Help the user with their code. Be concise and practical. When showing code, use markdown code blocks.' },
            ...state.aiMessages.slice(-10).map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: text + context },
          ],
          personality: 'coder',
        }),
      });

      if (!resp.ok) throw new Error('Chat request failed');
      const data = await resp.json();
      addAIMessage('assistant', data.reply || data.message || 'No response');
    } catch (err) {
      addAIMessage('assistant', 'Error connecting to AI. Make sure the API is configured.');
    }
  });

  function addAIMessage(role, content) {
    state.aiMessages.push({ role, content });
    const div = document.createElement('div');
    div.className = `ai-msg ai-msg-${role}`;
    div.innerHTML = formatAIContent(content);
    aiMessages.appendChild(div);
    aiMessages.scrollTop = aiMessages.scrollHeight;
  }

  function formatAIContent(text) {
    // Simple markdown code block rendering
    return text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<div class="ai-msg-code">${escapeHtml(code.trim())}</div>`;
    }).replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;">$1</code>')
      .replace(/\n/g, '<br>');
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Auto-resize AI input
  aiInput.addEventListener('input', () => {
    aiInput.style.height = 'auto';
    aiInput.style.height = Math.min(aiInput.scrollHeight, 120) + 'px';
  });

  // ─── File System (File System Access API) ──────────────────────────
  async function openFolder() {
    try {
      const handle = await window.showDirectoryPicker();
      state.directoryHandle = handle;
      await loadFileTree(handle);
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Failed to open folder:', err);
    }
  }

  async function loadFileTree(dirHandle, path = '') {
    const items = [];
    for await (const entry of dirHandle.values()) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;

      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        items.push({ name: entry.name, path: entryPath, kind: 'directory', handle: entry, children: [] });
      } else {
        items.push({ name: entry.name, path: entryPath, kind: 'file', handle: entry });
      }
    }

    items.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (!path) {
      state.fileTree = items;
      renderFileTree();
    }
    return items;
  }

  function renderFileTree() {
    if (state.fileTree.length === 0) {
      fileTree.innerHTML = `<div class="tree-empty"><p>No folder opened</p><button class="tree-open-btn" id="treeOpenBtn">Open Folder</button></div>`;
      $('#treeOpenBtn')?.addEventListener('click', openFolder);
      return;
    }

    fileTree.innerHTML = renderTreeItems(state.fileTree, 0);
    fileTree.querySelectorAll('.tree-item').forEach((item) => {
      item.addEventListener('click', handleTreeClick);
    });
  }

  function renderTreeItems(items, depth) {
    return items.map((item) => {
      const indent = depth * 12;
      const icon = item.kind === 'directory' ? '&#9654;' : '&#9679;';
      const html = `<div class="tree-item" data-path="${item.path}" data-kind="${item.kind}" style="padding-left:${8 + indent}px">
        <span class="tree-icon">${icon}</span>
        <span class="tree-label">${item.name}</span>
      </div>`;

      if (item.kind === 'directory') {
        return html + `<div class="tree-children" data-dir="${item.path}" hidden></div>`;
      }
      return html;
    }).join('');
  }

  async function handleTreeClick(e) {
    const item = e.currentTarget;
    const path = item.dataset.path;
    const kind = item.dataset.kind;

    if (kind === 'directory') {
      const children = item.nextElementSibling;
      if (children && children.classList.contains('tree-children')) {
        const isOpen = !children.hidden;
        children.hidden = isOpen;
        item.querySelector('.tree-icon').innerHTML = isOpen ? '&#9654;' : '&#9660;';

        if (!isOpen && children.innerHTML === '') {
          const entry = findEntry(state.fileTree, path);
          if (entry && entry.handle) {
            const items = await loadFileTree(entry.handle, path);
            entry.children = items;
            children.innerHTML = renderTreeItems(items, path.split('/').length);
            children.querySelectorAll('.tree-item').forEach((i) => {
              i.addEventListener('click', handleTreeClick);
            });
          }
        }
      }
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
    // Already open?
    if (state.openFiles.has(path)) {
      activateTab(path);
      return;
    }

    const entry = findEntry(state.fileTree, path);
    if (!entry || !entry.handle) return;

    try {
      const file = await entry.handle.getFile();
      const content = await file.text();
      const language = detectLanguage(entry.name);

      state.openFiles.set(path, { content, language, modified: false });
      createTab(path, entry.name);
      createEditorPane(path, content, language);
      activateTab(path);
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  }

  // ─── Tabs ──────────────────────────────────────────────────────────
  function createTab(path, name) {
    const tab = document.createElement('div');
    tab.className = 'tab';
    tab.dataset.tab = path;
    tab.innerHTML = `<span>${name}</span><button class="tab-close" data-tab="${path}">&times;</button>`;
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeTab(path);
      } else {
        activateTab(path);
      }
    });
    tabs.appendChild(tab);
  }

  function activateTab(path) {
    state.activeTab = path;

    // Update tab styles
    tabs.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === path);
    });

    // Update content
    editorContent.querySelectorAll('.editor-tab-content').forEach((c) => {
      c.classList.toggle('active', c.dataset.content === path);
    });

    // Update status bar
    const file = state.openFiles.get(path);
    if (file) {
      $('#sbLang').textContent = file.language;
    }

    // Update file tree highlight
    fileTree.querySelectorAll('.tree-item').forEach((i) => {
      i.classList.toggle('active', i.dataset.path === path);
    });
  }

  function closeTab(path) {
    const tab = tabs.querySelector(`[data-tab="${path}"]`);
    if (tab) tab.remove();

    const content = editorContent.querySelector(`[data-content="${path}"]`);
    if (content) content.remove();

    const editor = editorInstances.get(path);
    if (editor) { editor.dispose(); editorInstances.delete(path); }

    state.openFiles.delete(path);

    // Activate another tab
    const remaining = tabs.querySelectorAll('.tab');
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1].dataset.tab);
    }
  }

  function createEditorPane(path, content, language) {
    const div = document.createElement('div');
    div.className = 'editor-tab-content';
    div.dataset.content = path;

    const container = document.createElement('div');
    container.className = 'monaco-container';
    div.appendChild(container);
    editorContent.appendChild(div);

    // Wait for Monaco
    function initMonaco() {
      if (!monacoReady) { setTimeout(initMonaco, 100); return; }
      const editor = monaco.editor.create(container, {
        value: content,
        language: language,
        theme: 'rotex-dark',
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 14,
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        tabSize: 2,
        insertSpaces: true,
        folding: true,
        bracketPairColorization: { enabled: true },
      });

      editorInstances.set(path, editor);

      // Track changes
      editor.onDidChangeModelContent(() => {
        const file = state.openFiles.get(path);
        if (file) {
          file.content = editor.getValue();
          file.modified = true;
          const tab = tabs.querySelector(`[data-tab="${path}"] span`);
          if (tab && !tab.textContent.endsWith('*')) {
            tab.textContent += ' *';
          }
        }
      });

      // Update cursor position in status bar
      editor.onDidChangeCursorPosition((e) => {
        $('#sbPosition').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });
    }
    initMonaco();
  }

  // ─── Save Files ────────────────────────────────────────────────────
  async function saveCurrentFile() {
    const path = state.activeTab;
    if (!path || path === 'welcome') return;

    const file = state.openFiles.get(path);
    const entry = findEntry(state.fileTree, path);
    if (!file || !entry || !entry.handle) return;

    try {
      const writable = await entry.handle.createWritable();
      await writable.write(file.content);
      await writable.close();
      file.modified = false;

      const tab = tabs.querySelector(`[data-tab="${path}"] span`);
      if (tab) tab.textContent = tab.textContent.replace(' *', '');
    } catch (err) {
      console.error('Failed to save:', err);
    }
  }

  // ─── New File ──────────────────────────────────────────────────────
  async function createNewFile() {
    const name = prompt('File name:');
    if (!name) return;

    if (state.directoryHandle) {
      try {
        const handle = await state.directoryHandle.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        await writable.write('');
        await writable.close();
        await loadFileTree(state.directoryHandle);

        // Open the new file
        const language = detectLanguage(name);
        state.openFiles.set(name, { content: '', language, modified: false });
        createTab(name, name);
        createEditorPane(name, '', language);
        activateTab(name);
      } catch (err) {
        console.error('Failed to create file:', err);
      }
    } else {
      // No folder open, create virtual file
      const language = detectLanguage(name);
      state.openFiles.set(name, { content: '', language, modified: false });
      createTab(name, name);
      createEditorPane(name, '', language);
      activateTab(name);
    }
  }

  // ─── Terminal ──────────────────────────────────────────────────────
  function toggleTerminal() {
    state.bottomPanelOpen = !state.bottomPanelOpen;
    bottomPanel.hidden = !state.bottomPanelOpen;
  }

  $('#closeBottomPanel').addEventListener('click', () => {
    state.bottomPanelOpen = false;
    bottomPanel.hidden = true;
  });

  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = terminalInput.value.trim();
      if (!cmd) return;

      appendTerminal(`$ ${cmd}`);
      terminalInput.value = '';
      state.terminalHistory.push(cmd);

      // Simulate basic commands in browser
      if (cmd === 'clear') {
        terminalOutput.innerHTML = '';
      } else if (cmd === 'help') {
        appendTerminal('ROTEX Terminal (browser simulation)\nCommands: clear, help, echo, ls, pwd\nFor full terminal, use the desktop app.');
      } else if (cmd.startsWith('echo ')) {
        appendTerminal(cmd.slice(5));
      } else if (cmd === 'pwd') {
        appendTerminal(state.directoryHandle ? `/${state.directoryHandle.name}` : '/');
      } else if (cmd === 'ls') {
        if (state.fileTree.length) {
          appendTerminal(state.fileTree.map((f) => f.name).join('  '));
        } else {
          appendTerminal('(no folder open)');
        }
      } else {
        appendTerminal(`Command not available in browser. Use the ROTEX desktop app for full terminal access.`);
      }
    }
  });

  function appendTerminal(text) {
    terminalOutput.textContent += text + '\n';
    terminalOutput.scrollTop = terminalOutput.scrollHeight;
  }

  // ─── Button Wiring ─────────────────────────────────────────────────
  const openFolderBtns = ['#openFolderBtn', '#treeOpenBtn', '#welcomeOpenFolder'];
  openFolderBtns.forEach((sel) => {
    $(sel)?.addEventListener('click', openFolder);
  });

  const newFileBtns = ['#newFileBtn', '#welcomeNewFile'];
  newFileBtns.forEach((sel) => {
    $(sel)?.addEventListener('click', createNewFile);
  });

  $('#newTerminalBtn')?.addEventListener('click', () => {
    terminalOutput.innerHTML = '';
    appendTerminal('ROTEX Terminal\nType "help" for available commands.\n');
  });

  // ─── Keyboard Shortcuts ────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Ctrl+S - Save
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      saveCurrentFile();
    }
    // Ctrl+` - Toggle terminal
    if (e.ctrlKey && e.key === '`') {
      e.preventDefault();
      toggleTerminal();
    }
    // Ctrl+Shift+A - Toggle AI
    if (e.ctrlKey && e.shiftKey && e.key === 'A') {
      e.preventDefault();
      toggleAIPanel();
    }
    // Ctrl+P - Quick open (placeholder)
    if (e.ctrlKey && e.key === 'p' && !e.shiftKey) {
      e.preventDefault();
      // TODO: Command palette
    }
    // Ctrl+N - New file
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      createNewFile();
    }
  });

  // ─── Initialization ────────────────────────────────────────────────
  function init() {
    // Open AI panel by default for visibility
    // (users can close it)
    appendTerminal('ROTEX Terminal\nType "help" for available commands.\n');
  }

  init();
})();
