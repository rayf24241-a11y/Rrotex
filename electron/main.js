const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

let authServer = null;

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
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#05070b',
      symbolColor: '#a0aec1',
      height: 36,
    },
  });

  // Always start at login — login.html auto-redirects if already authenticated.
  mainWindow.loadFile(path.join(__dirname, '..', 'login.html'));

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Page navigation ──────────────────────────────────────────────────────────
const PAGE_FILES = {
  login: '../login.html',
  projects: '../projects.html',
  editor: '../editor.html',
};

ipcMain.handle('load-page', async (event, page) => {
  const file = PAGE_FILES[page];
  if (!file || !mainWindow) return;

  // Update titlebar overlay color per page
  const overlayColor = page === 'editor' ? '#1e1e1e' : '#05070b';
  mainWindow.setTitleBarOverlay({ color: overlayColor, symbolColor: '#a0aec1', height: 36 });

  await mainWindow.loadFile(path.join(__dirname, file));
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
