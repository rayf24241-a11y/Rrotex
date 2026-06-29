const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

// ─── Auto-updater (electron-updater) ─────────────────────────────────────────
// Only active in packaged builds. In dev (electron .) it is silently skipped.
let autoUpdater = null;
if (app.isPackaged) {
  try {
    autoUpdater = require('electron-updater').autoUpdater;
    autoUpdater.autoDownload = false;        // never download without user action
    autoUpdater.autoInstallOnAppQuit = false; // never silently install on quit
    autoUpdater.logger = null;               // suppress console noise
  } catch {
    autoUpdater = null;
  }
}

let authServer        = null;
let pluginServer      = null;
let pluginServerPort  = null;
let pluginToken       = null;
let rojoProcess       = null;
let aiContext         = null;
let currentProjectName = '';
let userAuthToken     = '';
let userProjectMode   = '';
let studioActionQueue = [];
const PLUGIN_PORTS    = [7878, 7874, 7871, 7870, 7861, 7865, 7822, 7854, 7813, 7816, 7898, 7875];
const APP_ICON        = path.join(__dirname, process.platform === 'win32' ? 'icon.ico' : 'icon.png');

// ─── Single-instance lock (Windows/Linux deep-link) ──────────────────────────
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

function appAssetPath(relativePath) {
  const packagedPath = path.join(process.resourcesPath || '', relativePath);
  if (app.isPackaged && fs.existsSync(packagedPath)) return packagedPath;
  return path.join(__dirname, '..', relativePath);
}

function authBackupPath() {
  return path.join(app.getPath('userData'), 'rotex-auth.json');
}

function normalizeDesktopAuth(data) {
  if (!data || !data.uid) return null;
  return {
    uid: String(data.uid || ''),
    email: String(data.email || ''),
    name: String(data.name || ''),
    exp: String(data.exp || Date.now() + 365 * 24 * 60 * 60 * 1000),
    token: String(data.token || ''),
  };
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
    if (Number(auth.exp || 0) <= Date.now()) {
      auth.exp = String(Date.now() + 365 * 24 * 60 * 60 * 1000);
    }
    return normalizeDesktopAuth(auth);
  } catch {
    return null;
  }
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
  const authJson = JSON.stringify(auth);
  await mainWindow.webContents.executeJavaScript(
    `localStorage.setItem('rotex_desktop_auth', ${JSON.stringify(authJson)});`,
    true
  ).catch(() => {});
  await mainWindow.loadFile(appAssetPath('projects.html'));
  mainWindow.focus();
  return true;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ROTEX',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
    titleBarStyle: 'default',
  });

  // Always start at login — login.html auto-redirects if already authenticated.
  mainWindow.loadFile(appAssetPath('login.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Inject long-lived dev pro pass into localStorage on every page load.
  const DEV_PRO_PASS = 'eyJ1aWQiOiJkZXYtcmF5ZjI0MjQxIiwic3ViIjoiZGV2IiwicGxhbiI6InBybyIsImV4cCI6MjA5NzI3NzE1MTMzMH0.jXr6ra4H_g77_311en6AxnxMnYVmODPKzLae6odbi2Q';
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
            window.rotexDesktop.navigate('projects');
          }
        } catch {}`
      : `try {
          const raw = localStorage.getItem('rotex_desktop_auth') || localStorage.getItem('rotex_desktop_auth_mirror');
          if (raw && window.rotexDesktop?.persistDesktopAuth) {
            window.rotexDesktop.persistDesktopAuth(JSON.parse(raw));
          }
        } catch {}`;

    mainWindow.webContents.executeJavaScript(
      `${injectScript}
       localStorage.setItem('rotex_pro_pass', ${JSON.stringify(DEV_PRO_PASS)});`
    ).catch(() => {});
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
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
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
app.whenReady().then(() => {
  createWindow();

  // Check for updates 8 seconds after launch so the window is settled.
  // autoDownload is false, so nothing happens automatically — the renderer
  // decides what to do when it receives 'update-available'.
  if (autoUpdater) {
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 8000);

    autoUpdater.on('update-available', (info) => {
      if (mainWindow) mainWindow.webContents.send('rotex-update-available', info);
    });

    autoUpdater.on('download-progress', (progress) => {
      if (mainWindow) mainWindow.webContents.send('rotex-update-progress', progress);
    });

    autoUpdater.on('update-downloaded', () => {
      if (mainWindow) mainWindow.webContents.send('rotex-update-ready');
    });
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

ipcMain.handle('update-download', () => {
  if (autoUpdater) autoUpdater.downloadUpdate().catch(() => {});
});
ipcMain.handle('update-install', () => {
  if (autoUpdater) autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('queue-studio-actions', async (event, actions) => {
  const safeActions = Array.isArray(actions) ? actions.slice(0, 10) : [];
  studioActionQueue.push(...safeActions);
  studioActionQueue = studioActionQueue.slice(-25);
  return { ok: true, queued: studioActionQueue.length };
});

// ─── IPC: Local auth callback server ─────────────────────────────────────────
// ─── IPC: Studio Plugin Server ───────────────────────────────────────────────
ipcMain.handle('start-plugin-server', async (event, token, projectName, proPass, projectMode) => {
  pluginToken = token;
  currentProjectName = projectName || '';
  userAuthToken = proPass || '';
  userProjectMode = projectMode || '';

  if (pluginServer) return pluginServerPort || 7878; // reuse existing server, just update token

  pluginServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://127.0.0.1:${pluginServerPort || 7878}`);
    const reqToken = url.searchParams.get('token') || '';

    // /ping — always 200 so the plugin can distinguish "not running" from "wrong token"
    if (url.pathname === '/ping' && req.method === 'GET') {
      if (reqToken === pluginToken) {
        res.end(JSON.stringify({ ok: true, project: currentProjectName }));
        const source = url.searchParams.get('source') || 'studio';
        if (mainWindow) {
          mainWindow.webContents.send(source === 'browser' ? 'browser-connected' : 'plugin-connected');
        }
      } else {
        res.end(JSON.stringify({ ok: false, error: 'bad token', token: pluginToken }));
      }
      return;
    }

    if (reqToken !== pluginToken) {
      res.writeHead(401); res.end(JSON.stringify({ ok: false, error: 'bad token' })); return;
    }

    if (url.pathname === '/rojo/start' && req.method === 'POST') {
      if (!rojoProcess) {
        rojoProcess = spawn('rojo', ['serve'], { shell: true, stdio: 'ignore', detached: false });
        rojoProcess.on('close', () => {
          rojoProcess = null;
          if (mainWindow) mainWindow.webContents.send('rojo-status', 'stopped');
        });
        if (mainWindow) mainWindow.webContents.send('rojo-status', 'running');
      }
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/rojo/stop' && req.method === 'POST') {
      if (rojoProcess) { rojoProcess.kill(); rojoProcess = null; }
      if (mainWindow) mainWindow.webContents.send('rojo-status', 'stopped');
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === '/ai/start' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { aiContext = JSON.parse(body); } catch {}
        if (mainWindow) mainWindow.webContents.send('plugin-context', aiContext);
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    if (url.pathname === '/studio/actions' && req.method === 'GET') {
      const action = studioActionQueue.shift() || null;
      res.end(JSON.stringify({ ok: true, action }));
      return;
    }

    if (url.pathname === '/studio/result' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const result = JSON.parse(body || '{}');
          if (mainWindow) mainWindow.webContents.send('plugin-context', { studioResult: result });
        } catch {}
        res.end(JSON.stringify({ ok: true }));
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
            hostname: 'rrotex.com',
            port: 443,
            path: '/api/chat',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
          };
          const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => {
              res.writeHead(apiRes.statusCode, { 'Content-Type': 'application/json' });
              res.end(data);
            });
          });
          apiReq.on('error', err => {
            res.writeHead(500);
            res.end(JSON.stringify({ error: err.message }));
          });
          apiReq.write(postData);
          apiReq.end();
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  return new Promise(resolve => {
    let index = 0;
    const tryListen = () => {
      const port = PLUGIN_PORTS[index++];
      if (!port) {
        pluginServer = null;
        pluginServerPort = null;
        resolve(null);
        return;
      }
      pluginServer.once('error', err => {
        if (err.code === 'EADDRINUSE') {
          tryListen();
        } else {
          pluginServer = null;
          pluginServerPort = null;
          resolve(null);
        }
      });
      pluginServer.listen(port, '127.0.0.1', () => {
        pluginServerPort = port;
        resolve(port);
      });
    };
    tryListen();
  });
});

// ─── IPC: TexBrain 0.5-β (single Ollama call, engine-aware) ──────────────────
ipcMain.handle('texbrain-call', async (event, messages, projectMode, mode = '') => {
  const http = require('http');
  const OLLAMA_PORT = 11434;

  // Auto-detect best installed model
  let model = 'llama3.2';
  try {
    const tags = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${OLLAMA_PORT}/api/tags`, res => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } });
      }).on('error', reject);
    });
    const names = (tags.models || []).map(m => m.name);
    const preferred = [
      'qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'qwen2.5-coder',
      'deepseek-coder-v2:16b', 'deepseek-coder-v2',
      'codellama:70b', 'codellama:34b', 'codellama',
      'llama3.1:8b', 'llama3.1',
      'llama3.2:3b', 'llama3.2',
      'mistral:7b', 'mistral',
      'gemma2:9b', 'gemma2',
      'phi4',
    ];
    const found = preferred.find(p => names.some(n => n.startsWith(p)));
    if (found) model = found;
    else if (names.length > 0) model = names[0];
  } catch {
    return { error: 'Ollama is not running. Download it from ollama.ai, then run: ollama pull llama3.2' };
  }

  // Engine-specific focus
  const engineGuides = {
    Roblox:         'You only help with Roblox game development: Luau scripting, LocalScript/Script/ModuleScript, RemoteEvents, RemoteFunctions, Roblox services (Players, DataStoreService, TweenService, RunService, etc.), Roblox Studio, and the Roblox API. Do not help with anything outside Roblox.',
    Unity:          'You only help with Unity game development: C# scripting, MonoBehaviour lifecycle, Unity APIs, GameObjects, physics, animations, and the Unity Editor.',
    Blender:        'You only help with Blender 3D: Python/bpy scripting, modeling, geometry nodes, shaders (Cycles/EEVEE), rigging, animation, and rendering.',
    'Roblox+Blender': 'You only help with Roblox game development (Luau) and Blender 3D (bpy) for creating assets used in Roblox games.',
    'Unity+Blender':  'You only help with Unity (C#) and Blender 3D (bpy) for creating assets used in Unity projects.',
  };
  const engine = (projectMode || 'Roblox').trim();
  const engineFocus = engineGuides[engine] || engineGuides['Roblox'];

  const modeInstructions = {
    agent: 'AGENT MODE: you may edit the project. Output the smallest complete fix. Use existing scripts when possible; avoid duplicates. Wrap every script in ```file:ServiceName/path/ScriptName.lua blocks so ROTEX can apply it to Roblox Studio.',
    supreme: 'SUPER AGENT MODE: you may perform deeper multi-step edits. Inspect for conflicts, update or delete owning scripts, add missing server/client pieces, create RemoteEvents if needed, include cleanup, and verify the final behavior does not fight itself. Wrap every script in ```file:ServiceName/path/ScriptName.lua blocks.',
  };
  const modeInstruction = modeInstructions[mode] || '';

  const systemPrompt = [
    'You are TexBrain, the local ROTEX coding assistant running on-device via Ollama.',
    engineFocus,
    'You receive live ROTEX Studio context: script paths, source snippets, selected instances, experience name, and plugin status. Treat that context as your view of the project.',
    'Be concise and direct. Answer with working code using Markdown fenced code blocks. Do not go off-topic or hallucinate APIs that do not exist.',
    'When writing Roblox Lua scripts, wrap them in ```file:ServiceName/path/ScriptName.lua blocks so ROTEX can apply them directly to Roblox Studio.',
    modeInstruction,
  ].filter(Boolean).join('\n');

  try {
    // Limit history to last 6 messages to keep responses fast
    const history = messages.slice(-6);
    const res = await new Promise((resolve, reject) => {
      const postData = JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: systemPrompt }, ...history] });
      const req = http.request(
        { hostname: '127.0.0.1', port: OLLAMA_PORT, path: '/api/chat', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } },
        r => { let d = ''; r.on('data', c => { d += c; }); r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse')); } }); }
      );
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(postData);
      req.end();
    });
    return { text: res.message?.content || '(no response from local model)', model };
  } catch (err) {
    if (err.message.includes('ECONNREFUSED')) {
      return { error: 'Ollama is not running. Install from ollama.ai then run: ollama pull llama3.2' };
    }
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

ipcMain.handle('install-studio-plugin', async () => {
  const dest = studioPluginPath();
  try {
    const src = await findStudioPluginSource();
    if (!src) throw new Error('ROTEX Roblox plugin source was not found in this app build.');
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(src, dest);
    return { ok: true, installed: true, path: dest };
  } catch (err) {
    return { ok: false, installed: false, error: err.message, path: dest };
  }
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
