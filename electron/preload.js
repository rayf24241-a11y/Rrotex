const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rotexDesktop', {
  isDesktop: true,

  // ─── Navigation ───────────────────────────────────────────────────────
  navigate: (page) => ipcRenderer.invoke('load-page', page),

  // ─── Auth deep-link callback ──────────────────────────────────────────
  onAuthCallback: (fn) => {
    ipcRenderer.on('auth-callback', (_, data) => fn(data));
  },

  // ─── File system ──────────────────────────────────────────────────────
  openFolder: () => ipcRenderer.invoke('open-folder'),
  readDirectory: (dirPath) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),
  createFile: (filePath) => ipcRenderer.invoke('create-file', filePath),
  createFolder: (dirPath) => ipcRenderer.invoke('create-folder', dirPath),

  // ─── Terminal ─────────────────────────────────────────────────────────
  execCommand: (command, cwd) => ipcRenderer.invoke('exec-command', command, cwd),

  // ─── Utils ────────────────────────────────────────────────────────────
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  startAuthServer: () => ipcRenderer.invoke('start-auth-server'),

  // ─── Studio plugin ────────────────────────────────────────────────────────
  installStudioPlugin: () => ipcRenderer.invoke('install-studio-plugin'),
  checkStudioPlugin: () => ipcRenderer.invoke('check-studio-plugin'),
  startPluginServer: (token, projectName, proPass, projectMode) => ipcRenderer.invoke('start-plugin-server', token, projectName, proPass, projectMode),
  queueStudioActions: (actions) => ipcRenderer.invoke('queue-studio-actions', actions),
  callTexBrain: (messages, projectMode) => ipcRenderer.invoke('texbrain-call', messages, projectMode),
  onPluginConnected: (fn) => ipcRenderer.on('plugin-connected', fn),
  onBrowserConnected: (fn) => ipcRenderer.on('browser-connected', fn),
  onPluginContext: (fn) => ipcRenderer.on('plugin-context', (_, ctx) => fn(ctx)),
  onRojoStatus: (fn) => ipcRenderer.on('rojo-status', (_, status) => fn(status)),

  // ─── In-app updater ───────────────────────────────────────────────────────
  onUpdateAvailable:  (fn) => ipcRenderer.on('rotex-update-available', (_, info) => fn(info)),
  onUpdateProgress:   (fn) => ipcRenderer.on('rotex-update-progress',  (_, p)    => fn(p)),
  onUpdateReady:      (fn) => ipcRenderer.on('rotex-update-ready',     ()        => fn()),
  downloadUpdate: () => ipcRenderer.invoke('update-download'),
  installUpdate:  () => ipcRenderer.invoke('update-install'),
});
