const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

let authServer        = null;
let pluginServer      = null;
let pluginServerPort  = null;
let pluginToken       = null;
let rojoProcess       = null;
let aiContext         = null;
let currentProjectName = '';
let userAuthToken     = '';
let userProjectMode   = '';
const PLUGIN_PORTS    = [7878, 7879, 7880, 7881, 7882, 7883, 7884, 7885, 7886, 7887];

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'ROTEX',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#05070b',
      symbolColor: '#a0aec1',
      height: 36,
    },
  });

  // Always start at login — login.html auto-redirects if already authenticated.
  mainWindow.loadFile(appAssetPath('login.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Inject long-lived dev pro pass into localStorage on every page load.
  const DEV_PRO_PASS = 'eyJ1aWQiOiJkZXYtcmF5ZjI0MjQxIiwic3ViIjoiZGV2IiwicGxhbiI6InBybyIsImV4cCI6MjA5NzI3NzE1MTMzMH0.jXr6ra4H_g77_311en6AxnxMnYVmODPKzLae6odbi2Q';
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(
      `localStorage.setItem('rotex_pro_pass', ${JSON.stringify(DEV_PRO_PASS)})`
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
    // Add expiry: 1-hour window from now (website also sets exp param if available)
    if (!data.exp) data.exp = String(Date.now() + 60 * 60 * 1000);
    if (mainWindow) {
      mainWindow.webContents.send('auth-callback', data);
    }
  } catch {}
}

app.commandLine.appendSwitch('disable-cache');
app.whenReady().then(createWindow);

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

    // /ping — no auth needed for the check itself, but token must match
    if (url.pathname === '/ping' && req.method === 'GET') {
      if (reqToken === pluginToken) {
        res.end(JSON.stringify({ ok: true, project: currentProjectName }));
        const source = url.searchParams.get('source') || 'studio';
        if (mainWindow) {
          mainWindow.webContents.send(source === 'browser' ? 'browser-connected' : 'plugin-connected');
        }
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, error: 'bad token' }));
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

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      if (req.method === 'POST' && req.url === '/auth') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            if (mainWindow) {
              mainWindow.webContents.send('auth-callback', data);
              mainWindow.focus();
            }
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
