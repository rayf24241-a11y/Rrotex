const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// ─── Auto-updater (electron-updater) ─────────────────────────────────────────
const logFile = require('path').join(require('os').homedir(), 'rotex-updater.log');
function ulog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  require('fs').appendFileSync(logFile, line);
}

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  ulog('electron-updater loaded. isPackaged=' + app.isPackaged);
} catch(e) {
  ulog('Failed to load electron-updater: ' + e.message);
  autoUpdater = null;
}

let authServer        = null;
let pluginServer      = null;
let pluginServerPort  = null;
let pluginToken       = null;
let aiContext         = null;
let currentProjectName = '';
let userAuthToken     = '';
let userProjectMode   = '';
let studioActionQueue = [];
let lastHeartbeat     = 0;
let heartbeatTimer    = null;
let pluginConnectedSent = false; // true once plugin-connected has been sent after latest server start/disconnect
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 2500;
const PLUGIN_PORTS    = [7878, 7874, 7871, 7870, 7861];

const ROTEX_ICON_PNG  = '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';
function makeRotexIcon() {
  try {
    const icoPath = path.join(__dirname, 'icon.ico');
    const img = nativeImage.createFromPath(icoPath);
    if (!img.isEmpty()) return img;
  } catch (_) {}
  return nativeImage.createFromBuffer(Buffer.from(ROTEX_ICON_PNG, 'base64'));
}


const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}

// Register custom protocol so the OS knows to open this app for rotex:// links.
// In dev mode (electron .), pass the script path so Windows routes the link back correctly.
if (process.defaultApp) {
  app.setAsDefaultProtocolClient('rotex', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('rotex');
}
app.setAppUserModelId('com.rrotex.editor');

// ─── macOS: deep-link arrives before window is ready ──────────────────────────
let pendingDeepLink = null;
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    handleDeepLink(url);
  } else {
    pendingDeepLink = url;
  }
});

let mainWindow;

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.setSkipTaskbar(false);
  mainWindow.moveTop();
  mainWindow.focus();
}

function appAssetPath(relativePath) {
  const packagedPath = path.join(process.resourcesPath || '', relativePath);
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  return path.join(__dirname, '..', relativePath);
}

function authBackupPath() {
  return path.join(app.getPath('userData'), 'rotex-auth.json');
}

function chatsBackupPath() {
  return path.join(app.getPath('userData'), 'rotex-chats.json');
}

async function readChatsBackup() {
  try {
    const raw = await fs.promises.readFile(chatsBackupPath(), 'utf8');
    const parsed = JSON.parse(raw);
    const chats = Array.isArray(parsed?.chats) ? parsed.chats.filter((c) => c && c.id) : [];
    return { chats, activeChat: parsed?.activeChat || null };
  } catch {
    return { chats: [], activeChat: null };
  }
}

async function writeChatsBackup(chats, activeChat) {
  const safe = Array.isArray(chats) ? chats.filter((c) => c && c.id) : [];
  const data = { chats: safe.slice(0, 50), activeChat: activeChat || null };
  await fs.promises.mkdir(path.dirname(chatsBackupPath()), { recursive: true });
  await fs.promises.writeFile(chatsBackupPath(), JSON.stringify(data), 'utf8');
  return data;
}

function tokensBackupPath() {
  return path.join(app.getPath('userData'), 'rotex-tokens.json');
}

async function readTokensBackup() {
  try {
    const raw = await fs.promises.readFile(tokensBackupPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return Math.max(0, Math.floor(Number(parsed?.balance) || 0));
  } catch {
    return 0;
  }
}

async function writeTokensBackup(balance) {
  const bal = Math.max(0, Math.floor(Number(balance) || 0));
  await fs.promises.mkdir(path.dirname(tokensBackupPath()), { recursive: true });
  await fs.promises.writeFile(tokensBackupPath(), JSON.stringify({ balance: bal }), 'utf8');
  return bal;
}

async function injectTokensIntoPage() {
  if (!mainWindow) return;
  const fileBal = await readTokensBackup();
  await mainWindow.webContents.executeJavaScript(
    `try {
      const cur = Math.max(0, Number(localStorage.getItem('rotex_textokens_balance') || 0));
      const best = Math.max(cur, ${fileBal});
      localStorage.setItem('rotex_textokens_balance', String(best));
    } catch {}`,
    true
  ).catch(() => {});
  const merged = await mainWindow.webContents.executeJavaScript(
    `Math.max(0, Number(localStorage.getItem('rotex_textokens_balance') || 0))`,
    true
  ).catch(() => fileBal);
  if (merged > fileBal) await writeTokensBackup(merged);
}

async function injectChatsIntoPage() {
  if (!mainWindow) return;
  const { chats, activeChat } = await readChatsBackup();
  if (!chats.length && !activeChat) return;
  const chatsJson = JSON.stringify(chats);
  const activeJson = JSON.stringify(activeChat || '');
  await mainWindow.webContents.executeJavaScript(
    `try {
      const chats = ${chatsJson};
      if (chats.length) localStorage.setItem('rotex_chats', JSON.stringify(chats));
      const active = ${activeJson};
      if (active) localStorage.setItem('rotex_active_chat', active);
    } catch {}`,
    true
  ).catch(() => {});
}

function normalizeDesktopAuth(data) {
  if (!data || !data.uid) return null;
  return {
    uid: String(data.uid || ''),
    email: String(data.email || ''),
    name: String(data.name || ''),
    exp: String(data.exp || Date.now() + 365 * 24 * 60 * 60 * 1000),
    token: String(data.token || ''),
    refreshToken: String(data.refreshToken || ''),
  };
}

function authTokenLooksExpired(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return true;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return Number(payload.exp || 0) * 1000 <= Date.now() + 60000;
  } catch {
    return true;
  }
}

async function writeAuthBackup(data) {
  const auth = normalizeDesktopAuth(data);
  if (!auth) return false;
  await fs.promises.mkdir(path.dirname(authBackupPath()), { recursive: true });
  await fs.promises.writeFile(authBackupPath(), JSON.stringify(auth, null, 2), 'utf8');
  return true;
}

function readAuthBackup() {
  try {
    const auth = JSON.parse(fs.readFileSync(authBackupPath(), 'utf8'));
    if (!auth?.uid) return null;
    if (!auth.refreshToken && authTokenLooksExpired(auth.token)) {
      return null;
    }
    return normalizeDesktopAuth(auth);
  } catch {
    return null;
  }
}

function ensurePluginTokenValue() {
  if (pluginToken && String(pluginToken).trim()) return String(pluginToken).trim();
  pluginToken = Math.random().toString(16).slice(2, 10).toUpperCase() + Math.random().toString(16).slice(2, 10).toUpperCase();
  return pluginToken;
}

async function clearAuthBackup() {
  try {
    await fs.promises.rm(authBackupPath(), { force: true });
    return true;
  } catch {
    return false;
  }
}

async function completeDesktopAuth(data) {
  const auth = normalizeDesktopAuth(data);
  if (!auth) return false;
  await writeAuthBackup(auth).catch(() => {});
  if (!mainWindow) return true;
  const proPass = String(data.proPass || '');
  const proPassLine = proPass ? `localStorage.setItem('rotex_pro_pass', ${JSON.stringify(proPass)});` : '';
  await mainWindow.webContents.executeJavaScript(
    `try {
      const auth = ${JSON.stringify(auth)};
      localStorage.setItem('rotex_desktop_auth', JSON.stringify(auth));
      localStorage.setItem('rotex_desktop_auth_mirror', JSON.stringify(auth));
      if (window.rotexDesktopAuth?.persist) window.rotexDesktopAuth.persist(auth);
      ${proPassLine}
    } catch {}`,
    true
  ).catch(() => {});
  await mainWindow.loadFile(appAssetPath('editor.html'));
  showMainWindow();
  return true;
}

function createWindow() {
  const appIcon = makeRotexIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ROTEX',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
    titleBarStyle: 'default',
  });

  mainWindow.setIcon(appIcon);
  mainWindow.webContents.once('did-finish-load', () => mainWindow && mainWindow.setIcon(appIcon));
  mainWindow.once('ready-to-show', showMainWindow);
  mainWindow.on('show', () => mainWindow && mainWindow.setSkipTaskbar(false));

  // Start directly in editor so the loading-screen gate (update + plugin check) shows immediately.
  const startupAuth = readAuthBackup();
  mainWindow.loadFile(appAssetPath(startupAuth?.uid ? 'editor.html' : 'login.html'));
  installStudioPluginFile().catch(() => {});
  startPluginServerInternal(ensurePluginTokenValue(), '', '', 'Roblox').catch(() => {});

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Block all devtools keyboard shortcuts
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const { control, meta, shift, key } = input;
    const mod = control || meta;
    if (
      key === 'F12' ||
      (mod && shift && ['I', 'J', 'C', 'i', 'j', 'c'].includes(key)) ||
      (mod && key === 'u') || (mod && key === 'U')
    ) {
      event.preventDefault();
    }
  });

  // Failsafe: immediately close devtools if somehow opened
  mainWindow.webContents.on('devtools-opened', () => {
    mainWindow.webContents.closeDevTools();
  });

  // Prevent navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    const auth = readAuthBackup();
    if (auth) {
      auth.exp = String(Date.now() + 365 * 24 * 60 * 60 * 1000);
      writeAuthBackup(auth).catch(() => {});
    }

    const authJson = auth ? JSON.stringify(auth) : '';
    const injectScript = auth
      ? `try {
          const auth = ${authJson};
          localStorage.setItem('rotex_desktop_auth', JSON.stringify(auth));
          localStorage.setItem('rotex_desktop_auth_mirror', JSON.stringify(auth));
          if (window.rotexDesktopAuth?.persist) window.rotexDesktopAuth.persist(auth);
          if (location.pathname.toLowerCase().endsWith('login.html') && window.rotexDesktop?.navigate) {
            window.rotexDesktop.navigate('editor');
          }
        } catch {}`
      : `try {
          localStorage.removeItem('rotex_desktop_auth');
          localStorage.removeItem('rotex_desktop_auth_mirror');
        } catch {}`;

    mainWindow.webContents.executeJavaScript(injectScript).catch(() => {});
    injectChatsIntoPage().catch(() => {});
    injectTokensIntoPage().catch(() => {});
    showMainWindow();
  });

  // Flush any deep link that arrived before the window was ready (macOS)
  if (pendingDeepLink) {
    mainWindow.webContents.once('did-finish-load', () => {
      handleDeepLink(pendingDeepLink);
      pendingDeepLink = null;
    });
  }
}

// ─── Windows/Linux: second instance carries the URL in argv ──────────────────
app.on('second-instance', (event, argv) => {
  const url = argv.find((arg) => arg.startsWith('rotex://'));
  if (url) handleDeepLink(url);
  showMainWindow();
});

function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'auth') return;
    const data = {};
    for (const [k, v] of parsed.searchParams.entries()) {
      data[k] = v;
    }
    if (!data.exp) data.exp = String(Date.now() + 365 * 24 * 60 * 60 * 1000);
    completeDesktopAuth(data);
  } catch {}
}

app.commandLine.appendSwitch('disable-cache');

// Remove the default menu bar (which exposes View → Toggle Developer Tools)
Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  createWindow();

  // Check for updates 8 seconds after launch so the window is settled.
  // autoDownload is true — download starts automatically in the background.
  // autoInstallOnAppQuit is true — installs silently when the user closes the app.
  if (autoUpdater) {
    ulog('Scheduling update check in 8s...');
    setTimeout(() => {
      ulog('Calling checkForUpdates()');
      autoUpdater.checkForUpdates().catch((e) => ulog('checkForUpdates error: ' + e.message));
    }, 8000);

    autoUpdater.on('update-available', (info) => {
      ulog('update-available: ' + JSON.stringify(info));
      if (mainWindow) mainWindow.webContents.send('rotex-update-available', info);
    });
    autoUpdater.on('update-not-available', (info) => {
      ulog('update-not-available: ' + JSON.stringify(info));
      if (mainWindow) mainWindow.webContents.send('rotex-update-not-available');
    });
    autoUpdater.on('error', (e) => {
      ulog('updater error: ' + e.message);
      if (mainWindow) mainWindow.webContents.send('rotex-update-error');
    });
    autoUpdater.on('download-progress', (progress) => {
      ulog('download-progress: ' + Math.round(progress.percent) + '%');
      if (mainWindow) mainWindow.webContents.send('rotex-update-progress', progress);
    });
    autoUpdater.on('update-downloaded', (info) => {
      ulog('update-downloaded! Installing in 5s...');
      if (mainWindow) mainWindow.webContents.send('rotex-update-ready', info);
      setTimeout(() => {
        ulog('Calling quitAndInstall()');
        autoUpdater.quitAndInstall(false, true);
      }, 5000);
    });
  } else {
    ulog('autoUpdater is null — skipping update check');
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Page navigation ──────────────────────────────────────────────────────────
const PAGE_FILES = {
  login: 'login.html',
  projects: 'projects.html',
  editor: 'editor.html',
  docs: 'docs.html',
};

ipcMain.handle('load-page', async (event, page) => {
  const file = PAGE_FILES[page];
  if (!file || !mainWindow) return;

  // Update titlebar overlay color per page
  const overlayColor = page === 'editor' ? '#1e1e1e' : '#05070b';
  mainWindow.setTitleBarOverlay({ color: overlayColor, symbolColor: '#a0aec1', height: 36 });

  await mainWindow.loadFile(appAssetPath(file));
});

// ─── IPC: File System ─────────────────────────────────────────────────────────

ipcMain.handle('open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle('read-directory', async (event, dirPath) => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.') || e.name === '.env.example')
      .filter((e) => e.name !== 'node_modules' && e.name !== '.git')
      .map((e) => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        kind: e.isDirectory() ? 'directory' : 'file',
      }))
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
});

ipcMain.handle('read-file', async (event, filePath) => {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
});

ipcMain.handle('write-file', async (event, filePath, content) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('create-file', async (event, filePath) => {
  try {
    await fs.promises.writeFile(filePath, '', 'utf8');
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('create-folder', async (event, dirPath) => {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
});

// ─── IPC: Terminal ────────────────────────────────────────────────────────────
ipcMain.handle('exec-command', async (event, command, cwd) => {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec(command, { cwd: cwd || process.cwd(), timeout: 30000, shell: true, env: { ...process.env } }, (error, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', exitCode: error ? (error.code || 1) : 0 });
    });
  });
});

ipcMain.handle('open-external', async (event, url) => {
  shell.openExternal(url);
});

// ─── IPC: in-app update controls ─────────────────────────────────────────────
ipcMain.handle('clear-desktop-auth', async () => {
  await clearAuthBackup();
  return { ok: true };
});

ipcMain.handle('persist-desktop-auth', async (_event, data) => {
  const ok = await writeAuthBackup(data);
  return { ok };
});

ipcMain.handle('get-auth-backup', () => readAuthBackup());

ipcMain.handle('get-chats-backup', () => readChatsBackup());
ipcMain.handle('save-chats-backup', async (_, chats, activeChat) => writeChatsBackup(chats, activeChat));
ipcMain.handle('get-tokens-backup', () => readTokensBackup());
ipcMain.handle('save-tokens-backup', async (_, balance) => writeTokensBackup(balance));

ipcMain.handle('update-download', () => {
  if (autoUpdater) autoUpdater.downloadUpdate().catch(() => {});
});
ipcMain.handle('update-install', () => {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true);
});
ipcMain.handle('check-for-updates', () => {
  if (autoUpdater) autoUpdater.checkForUpdates().catch(() => {
    if (mainWindow) mainWindow.webContents.send('rotex-update-error');
  });
});
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('capture-screen', async () => {
  try {
    const { desktopCapturer } = require('electron');
    // Prefer the Roblox Studio window so we capture the user's game, not ROTEX itself.
    const wins = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1080 } });
    const studio = wins.find((w) => /roblox studio/i.test(w.name))
      || wins.find((w) => /roblox/i.test(w.name) && !/rotex/i.test(w.name));
    if (studio && studio.thumbnail && !studio.thumbnail.isEmpty()) {
      return { ok: true, dataUrl: studio.thumbnail.toDataURL(), source: 'studio' };
    }
    // Fallback: full primary screen.
    const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (!screens.length) return { ok: false };
    return { ok: true, dataUrl: screens[0].thumbnail.toDataURL(), source: 'screen' };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('queue-studio-actions', async (event, actions) => {
  const safeActions = Array.isArray(actions) ? actions.slice(0, 10) : [];
  studioActionQueue.push(...safeActions);
  studioActionQueue = studioActionQueue.slice(-25);
  return { ok: true, queued: studioActionQueue.length };
});

// ─── IPC: Local auth callback server ─────────────────────────────────────────
// ─── IPC: Studio Plugin Server ───────────────────────────────────────────────
async function startPluginServerInternal(token, projectName, proPass, projectMode) {
  pluginToken = token || ensurePluginTokenValue();
  currentProjectName = projectName || '';
  userAuthToken = proPass || '';
  userProjectMode = projectMode || '';

  if (pluginServer) return pluginServerPort || 7878; // reuse existing server, just update token

  const pluginStatus = () => ({
    connected: Boolean(lastHeartbeat && Date.now() - lastHeartbeat < PLUGIN_HEARTBEAT_TIMEOUT_MS),
    port: pluginServerPort,
    token: pluginToken || '',
    project: currentProjectName || '',
    lastSeen: lastHeartbeat || 0,
  });

  const sendPluginStatus = () => {
    if (mainWindow) mainWindow.webContents.send('plugin-status', pluginStatus());
  };

  const markStudioConnected = (source = 'studio') => {
    lastHeartbeat = Date.now();
    if (mainWindow && !pluginConnectedSent) {
      mainWindow.webContents.send(source === 'browser' ? 'browser-connected' : 'plugin-connected');
      sendPluginStatus();
    }
    pluginConnectedSent = true;
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(() => {
        if (Date.now() - lastHeartbeat > PLUGIN_HEARTBEAT_TIMEOUT_MS) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          pluginConnectedSent = false;
          if (mainWindow) {
            mainWindow.webContents.send('plugin-disconnected');
            sendPluginStatus();
          }
        }
      }, 700);
    }
  };

  const sendJSON = (res, statusOrBody, maybeBody) => {
    const status = maybeBody !== undefined ? statusOrBody : 200;
    const body   = JSON.stringify(maybeBody !== undefined ? maybeBody : statusOrBody);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  };

  // Request handler (closure over pluginToken, markStudioConnected, etc.)
  const requestHandler = (req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end();
      return;
    }

    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${pluginServerPort || 7878}`); }
    catch { res.writeHead(400); res.end('bad request'); return; }
    const reqToken = url.searchParams.get('token') || '';

    if (url.pathname === '/ping' && req.method === 'GET') {
      sendJSON(res, { ok: true, project: currentProjectName, token: pluginToken });
      markStudioConnected(url.searchParams.get('source') || 'studio');
      return;
    }

    if (url.pathname === '/heartbeat' && req.method === 'POST') {
      markStudioConnected('studio');
      sendJSON(res, { ok: true, token: pluginToken });
      return;
    }

    if (reqToken !== pluginToken) {
      sendJSON(res, 401, { ok: false, error: 'bad token', token: pluginToken }); return;
    }

    if (url.pathname === '/disconnect' && req.method === 'POST') {
      lastHeartbeat = 0;
      pluginConnectedSent = false;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (mainWindow) {
        mainWindow.webContents.send('plugin-disconnected');
        sendPluginStatus();
      }
      sendJSON(res, { ok: true });
      return;
    }

    if (url.pathname === '/ai/start' && req.method === 'POST') {
      markStudioConnected('studio');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { aiContext = JSON.parse(body); } catch {}
        if (mainWindow) mainWindow.webContents.send('plugin-context', aiContext);
        sendJSON(res, { ok: true });
      });
      return;
    }

    if (url.pathname === '/studio/actions' && req.method === 'GET') {
      markStudioConnected('studio');
      const action = studioActionQueue.shift() || null;
      sendJSON(res, { ok: true, action });
      return;
    }

    if (url.pathname === '/studio/result' && req.method === 'POST') {
      markStudioConnected('studio');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const result = JSON.parse(body || '{}');
          if (mainWindow) mainWindow.webContents.send('plugin-context', { studioResult: result });
        } catch {}
        sendJSON(res, { ok: true });
      });
      return;
    }

    if (url.pathname === '/studio/error' && req.method === 'POST') {
      markStudioConnected('studio');
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const error = JSON.parse(body || '{}');
          if (mainWindow) mainWindow.webContents.send('plugin-context', { studioError: error });
        } catch {}
        sendJSON(res, { ok: true });
      });
      return;
    }

    if (url.pathname === '/chat' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const postData = JSON.stringify({
            messages: payload.messages || [],
            model: payload.model || 'fast',
            projectMode: userProjectMode || 'Supabase',
            projectName: currentProjectName || '',
            proPass: userAuthToken || '',
            stream: false,
          });
          const https = require('https');
          const options = {
            hostname: 'rrotex.com', port: 443, path: '/api/chat', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          };
          const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => { res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' }); res.end(data); });
          });
          apiReq.on('error', err => sendJSON(res, 500, { error: err.message }));
          apiReq.write(postData);
          apiReq.end();
        } catch (err) {
          sendJSON(res, 400, { error: err.message });
        }
      });
      return;
    }

    sendJSON(res, 404, { ok: false, error: 'not found' });
  };

  // Try each port with a FRESH server object per attempt.
  // Reusing the same server after EADDRINUSE leaves it in a broken state.
  return new Promise(resolve => {
    let index = 0;
    const tryNextPort = () => {
      const port = PLUGIN_PORTS[index++];
      if (port === undefined) { resolve(null); return; }

      const server = http.createServer(requestHandler);
      server.keepAliveTimeout = 2000;
      server.headersTimeout   = 8000;
      server.on('connection', socket => socket.setNoDelay(true));

      // Only handle bind-time errors here; after listen succeeds we swap
      // in a no-op handler so runtime errors never close the server.
      server.once('error', err => {
        server.close();
        if (err.code === 'EADDRINUSE') { tryNextPort(); }
        else { resolve(null); }
      });

      server.listen(port, '127.0.0.1', () => {
        // Remove the bind-time error handler and replace with a no-op.
        // Without this, any later socket-level error emitted on the server
        // triggers the handler above, calls server.close(), and kills it.
        server.removeAllListeners('error');
        server.on('error', () => {});
        pluginServer     = server;
        pluginServerPort = port;
        resolve(port);
      });
    };
    tryNextPort();
  });
}

ipcMain.handle('start-plugin-server', async (event, token, projectName, proPass, projectMode) => {
  return startPluginServerInternal(token, projectName, proPass, projectMode);
});

ipcMain.handle('get-plugin-status', () => ({
  connected: Boolean(lastHeartbeat && Date.now() - lastHeartbeat < PLUGIN_HEARTBEAT_TIMEOUT_MS),
  port: pluginServerPort,
  token: pluginToken || '',
  project: currentProjectName || '',
  lastSeen: lastHeartbeat || 0,
}));

ipcMain.handle('get-server-info', () => ({
  port: pluginServerPort,
  running: pluginServer !== null,
  token: pluginToken || '',
}));

// ─── IPC: TexBrain 0.5-β (proxied through ROTEX server to Railway Ollama) ─────
const TEXBRAIN_API_URL = process.env.TEXBRAIN_API_URL || 'https://www.rrotex.com/api/chat/texbrain';

function texbrainApiRequest(body) {
  return new Promise((resolve, reject) => {
    const url = new URL(TEXBRAIN_API_URL);
    const postData = JSON.stringify(body);
    const module = url.protocol === 'https:' ? https : http;
    const req = module.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { reject(new Error(`parse — HTTP ${res.statusCode} — raw: ${d.slice(0, 400)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(postData);
    req.end();
  });
}

ipcMain.handle('texbrain-call', async (event, messages, projectMode, mode = '', authToken = '') => {
  try {
    const res = await texbrainApiRequest({ authToken, messages, projectMode, mode });
    if (res.status >= 400) {
      return { error: res.body?.error || `TexBrain server error (${res.status})` };
    }
    return res.body;
  } catch (err) {
    return { error: `TexBrain error: ${err.message}` };
  }
});

function studioPluginPath() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
    'Roblox', 'Plugins', 'ROTEX.lua'
  );
}

async function findStudioPluginSource() {
  const candidates = [
    path.join(__dirname, '..', 'plugin', 'rotex-plugin.lua'),
    path.join(__dirname, 'plugin', 'rotex-plugin.lua'),
    path.join(process.resourcesPath || '', 'plugin', 'rotex-plugin.lua'),
  ];
  for (const candidate of candidates) {
    try {
      await fs.promises.access(candidate, fs.constants.R_OK);
      return candidate;
    } catch {}
  }
  return null;
}

async function installStudioPluginFile() {
  const dest = studioPluginPath();
  try {
    const src = await findStudioPluginSource();
    if (!src) throw new Error('ROTEX Roblox plugin source was not found in this app build.');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    const stat = await fs.promises.stat(dest);
    if (!stat.isFile()) throw new Error('Plugin copy finished, but the installed file was not found.');
    return { ok: true, installed: true, path: dest };
  } catch (err) {
    return { ok: false, installed: false, error: err.message, path: dest };
  }
}

ipcMain.handle('install-studio-plugin', async () => {
  return installStudioPluginFile();
});

ipcMain.handle('check-studio-plugin', async () => {
  const dest = studioPluginPath();
  try {
    const stat = await fs.promises.stat(dest);
    return { ok: true, installed: stat.isFile(), path: dest };
  } catch {
    return { ok: true, installed: false, path: dest };
  }
});

// ─── IPC: Purchase callback server ───────────────────────────────────────────
let purchaseServer = null;
ipcMain.handle('start-purchase-server', () => {
  return new Promise((resolve, reject) => {
    if (purchaseServer) { purchaseServer.close(); purchaseServer = null; }

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'POST' && req.url === '/purchase') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            server.close();
            purchaseServer = null;
            if (!mainWindow) return;
            const balance  = Number(data.balance  || 0);
            const proPass  = String(data.proPass  || '');
            const balanceLine = balance > 0 ? `if(window.rotexTokens) window.rotexTokens.savePurchased(${JSON.stringify(String(balance))}); else localStorage.setItem('rotex_textokens_balance', ${JSON.stringify(String(balance))});` : '';
            const proPassLine = proPass ? `localStorage.setItem('rotex_pro_pass', ${JSON.stringify(proPass)});` : '';
            mainWindow.webContents.executeJavaScript(
              `try { ${balanceLine} ${proPassLine} if(window.rotexTokens) window.rotexTokens.refreshBalanceDisplay(); if(window.updateSidebarPlan) window.updateSidebarPlan(); } catch {}`,
              true
            ).catch(() => {});
          } catch { res.writeHead(400); res.end('Bad request'); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      purchaseServer = server;
      resolve(port);
      setTimeout(() => { server.close(); purchaseServer = null; }, 10 * 60 * 1000);
    });

    server.on('error', reject);
  });
});

// ─── IPC: Local auth callback server ─────────────────────────────────────────
ipcMain.handle('start-auth-server', () => {
  return new Promise((resolve, reject) => {
    if (authServer) { authServer.close(); authServer = null; }

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'POST' && req.url === '/auth') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            completeDesktopAuth(data);
            server.close();
            authServer = null;
          } catch { res.writeHead(400); res.end('Bad request'); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      authServer = server;
      resolve(port);
      setTimeout(() => { server.close(); authServer = null; }, 5 * 60 * 1000);
    });

    server.on('error', reject);
  });
});
