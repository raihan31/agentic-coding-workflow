const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Ensure standard developer CLI tools (git, node) are on PATH when launched as a GUI app on macOS
if (process.platform === 'darwin') {
  const extraPaths = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const currentPath = process.env.PATH || '';
  const toAdd = extraPaths.filter(p => !currentPath.includes(p) && fs.existsSync(p));
  if (toAdd.length > 0) {
    process.env.PATH = `${toAdd.join(':')}:${currentPath}`;
  }
}

let mainWindow = null;

function setupApplicationMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' },
          { type: 'separator' },
          { role: 'window' },
        ] : [
          { role: 'close' },
        ]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0d0d0d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Intercept window open calls to open external URLs in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:') || url.startsWith('vscode:') || url.startsWith('cursor:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Prevent drag-and-drop from navigating window to dropped files
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost') && !url.startsWith('data:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  const targetURL = isDev ? 'http://127.0.0.1:5173' : (process.env.AGENTIC_API_URL || 'http://127.0.0.1:8787');

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  function loadApp() {
    if (!mainWindow) return;
    mainWindow.loadURL(targetURL).catch((err) => {
      console.warn(`[Desktop] Cannot connect to ${targetURL} (${err.message}). Showing connection screen...`);
      const retryHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <title>Agent Orchestrator - Connecting</title>
          <style>
            body { background: #0d0d0d; color: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
            .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 32px 40px; max-width: 480px; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
            h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; color: #fff; }
            p { font-size: 14px; color: #a1a1aa; line-height: 1.5; margin: 0 0 20px; }
            code { background: #27272a; color: #38bdf8; padding: 3px 6px; border-radius: 4px; font-family: monospace; font-size: 13px; }
            .spinner { width: 32px; height: 32px; border: 3px solid #27272a; border-top-color: #38bdf8; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px; }
            @keyframes spin { to { transform: rotate(360deg); } }
            button { background: #2563eb; color: #fff; border: none; padding: 8px 18px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; transition: background 0.15s; }
            button:hover { background: #1d4ed8; }
          </style>
        </head>
        <body>
          <div class="card">
            <div class="spinner"></div>
            <h1>Connecting to Agent Orchestrator</h1>
            <p>Waiting for the backend server at <code>${targetURL}</code>...</p>
            <p style="font-size: 12px; color: #71717a;">Make sure the API server is running with:<br><code>npm run api</code></p>
            <button onclick="location.reload()">Retry Connection</button>
          </div>
          <script>
            setTimeout(() => { location.reload(); }, 2500);
          </script>
        </body>
        </html>
      `;
      mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(retryHtml)}`);
      setTimeout(() => {
        if (mainWindow) {
          mainWindow.loadURL(targetURL).catch(() => {});
        }
      }, 3000);
    });
  }

  loadApp();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// -------------------------------------------------------------
// Native IPC Handlers
// -------------------------------------------------------------

ipcMain.handle('desktop:select-directory', async (_event, defaultPath) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Git Repository',
    defaultPath: defaultPath || process.env.HOME,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('desktop:select-file', async (_event, filters) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Requirements Document',
    properties: ['openFile'],
    filters: filters || [
      { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'pdf', 'docx'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  const data = fs.readFileSync(filePath).toString('base64');
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    data,
  };
});

ipcMain.handle('desktop:is-git-repo', async (_event, dirPath) => {
  if (!dirPath) return false;
  try {
    return fs.existsSync(path.join(dirPath, '.git'));
  } catch {
    return false;
  }
});

ipcMain.handle('desktop:init-git-repo', async (_event, dirPath) => {
  if (!dirPath || !fs.existsSync(dirPath)) return { ok: false, error: 'Directory does not exist' };
  try {
    const { execSync } = require('child_process');
    execSync('git init -b main && git config user.name "Agentic Developer" && git config user.email "developer@agentic.local" && git commit --allow-empty -m "initial commit"', { cwd: dirPath, stdio: 'pipe' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'Failed to initialize git repository' };
  }
});

ipcMain.handle('desktop:open-in-editor', async (_event, { filePath, line = 1, editor = 'vscode' }) => {
  if (!filePath) return false;
  try {
    const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    if (editor === 'cursor') {
      await shell.openExternal(`cursor://file/${encodeURI(fullPath)}:${line}`);
    } else {
      await shell.openExternal(`vscode://file/${encodeURI(fullPath)}:${line}`);
    }
    return true;
  } catch (err) {
    console.error('Failed to open external editor:', err);
    return false;
  }
});

ipcMain.handle('desktop:open-path', async (_event, filePath) => {
  if (!filePath) return false;
  await shell.openPath(filePath);
  return true;
});

ipcMain.on('desktop:send-notification', (_event, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({
      title: title || 'Agentic Orchestrator',
      body: body || '',
      silent: false,
    }).show();
  }
});

// -------------------------------------------------------------
// App Lifecycle
// -------------------------------------------------------------

app.whenReady().then(() => {
  setupApplicationMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
