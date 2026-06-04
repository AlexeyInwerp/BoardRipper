const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ── GPU/sandbox workarounds for Windows ──
// exitCode 18 = renderer launch-failed, typically GPU process or sandbox issues
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}
// Fallback to software rendering if GPU is unavailable
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
app.disableHardwareAcceleration && void 0; // keep HW accel on, but add ANGLE fallback
app.commandLine.appendSwitch('use-angle', 'default');

// ── Crash logging ──
const LOG_DIR = path.join(app.getPath('userData'), 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
const LOG_FILE = path.join(LOG_DIR, 'boardripper.log');

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
  if (level === 'ERROR') console.error(line.trim());
  else console.log(line.trim());
}

function logFatal(context, err) {
  const msg = `${context}: ${err?.stack || err?.message || err}`;
  log('FATAL', msg);
  try {
    dialog.showErrorBox(
      `BoardRipper — Fatal Error`,
      `${context}\n\n${err?.stack || err?.message || String(err)}\n\nLog file: ${LOG_FILE}`,
    );
  } catch {}
}

process.on('uncaughtException', (err) => {
  logFatal('Uncaught exception in main process', err);
});

process.on('unhandledRejection', (reason) => {
  logFatal('Unhandled rejection in main process', reason);
});

log('INFO', '═══ BoardRipper starting ═══');
log('INFO', `Electron ${process.versions.electron}, Chrome ${process.versions.chrome}, Node ${process.versions.node}`);
log('INFO', `Platform: ${process.platform} ${process.arch}`);
log('INFO', `App path: ${app.getAppPath()}`);
log('INFO', `User data: ${app.getPath('userData')}`);
log('INFO', `__dirname: ${__dirname}`);

// Serve the Vite build output from the bundled 'webapp' folder
const WEBAPP_DIR = path.join(__dirname, 'webapp');
log('INFO', `WEBAPP_DIR: ${WEBAPP_DIR}`);
log('INFO', `WEBAPP_DIR exists: ${fs.existsSync(WEBAPP_DIR)}`);
if (fs.existsSync(WEBAPP_DIR)) {
  try {
    const files = fs.readdirSync(WEBAPP_DIR);
    log('INFO', `WEBAPP_DIR contents: ${files.join(', ')}`);
    log('INFO', `index.html exists: ${files.includes('index.html')}`);
  } catch (e) {
    log('ERROR', `Failed to read WEBAPP_DIR: ${e.message}`);
  }
}

// ── Library folder persistence ──
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const BOARD_EXTENSIONS = new Set(['.bvr', '.bv', '.brd', '.bdv', '.fz', '.cae', '.cad', '.pcb', '.xzz', '.tvw']);
const PDF_EXTENSIONS = new Set(['.pdf']);

function scanDirectory(dirPath) {
  const results = [];
  let nextId = 1;

  function walk(dir, relPath) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const rel = relPath ? relPath + '/' + entry.name : entry.name;

      if (entry.isDirectory()) {
        walk(fullPath, rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        let fileType = null;
        if (BOARD_EXTENSIONS.has(ext)) fileType = 'board';
        else if (PDF_EXTENSIONS.has(ext)) fileType = 'pdf';

        if (fileType) {
          let stats;
          try { stats = fs.statSync(fullPath); } catch { continue; }
          results.push({
            id: nextId++,
            path: rel,
            fullPath,
            filename: entry.name,
            extension: ext,
            file_type: fileType,
            size: stats.size,
            mod_time: Math.floor(stats.mtimeMs / 1000),
            scan_time: Math.floor(Date.now() / 1000),
            board_number: extractBoardNumber(entry.name),
            manufacturer: '',
            model: '',
            format_id: '',
            part_count: null,
            net_count: null,
            donor_pool: false,
            has_preview: false,
          });
        }
      }
    }
  }

  walk(dirPath, '');
  return results;
}

function extractBoardNumber(filename) {
  const m = filename.match(/(\d{3}-\d{5})/);
  return m ? m[1] : '';
}

function buildFolderTree(files, rootName) {
  const root = { name: rootName, path: '', children: [], files: [] };
  const dirs = new Map();
  dirs.set('', root);

  function ensureDir(dirPath) {
    if (dirs.has(dirPath)) return dirs.get(dirPath);
    const parent = path.dirname(dirPath);
    const parentNode = parent === '.' ? root : ensureDir(parent);
    const node = { name: path.basename(dirPath), path: dirPath, children: [], files: [] };
    parentNode.children.push(node);
    dirs.set(dirPath, node);
    return node;
  }

  for (const file of files) {
    const dir = path.dirname(file.path);
    const node = dir === '.' ? root : ensureDir(dir);
    node.files.push(file);
  }

  return root;
}

let mainWindow;

function createWindow() {
  log('INFO', 'Creating BrowserWindow...');
  const preloadPath = path.join(__dirname, 'preload.js');
  log('INFO', `Preload path: ${preloadPath}`);
  log('INFO', `Preload exists: ${fs.existsSync(preloadPath)}`);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'BoardRipper',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 2-Window Mode: Dockview pops out the PDF group via window.open(). Override
  // child BrowserWindow options so the detached window has a sensible title,
  // no menu bar, the BoardRipper icon, and the same preload as the main window.
  // Without this handler, Electron's default child window has the application
  // menu and a "BoardRipper" title (inherited from the loaded page title).
  const childIconPath = path.join(__dirname, 'webapp', 'logo.svg');
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    log('INFO', `Popout requested: ${url}`);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 900,
        height: 1200,
        minWidth: 400,
        minHeight: 400,
        title: 'BoardRipper PDF',
        autoHideMenuBar: true,
        icon: fs.existsSync(childIconPath) ? childIconPath : undefined,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
        },
      },
    };
  });

  // Log renderer crashes — retry once with GPU disabled on launch failure
  let retried = false;
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`);
    if (details.reason === 'launch-failed' && !retried) {
      retried = true;
      log('INFO', 'Retrying with GPU disabled...');
      app.commandLine.appendSwitch('disable-gpu');
      mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
    } else {
      logFatal('Renderer process gone', new Error(`reason: ${details.reason}, exitCode: ${details.exitCode}`));
    }
  });

  mainWindow.webContents.on('crashed', (_event, killed) => {
    logFatal('Renderer crashed', new Error(`killed: ${killed}`));
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log('ERROR', `Failed to load: ${errorDescription} (code ${errorCode}) URL: ${validatedURL}`);
    dialog.showErrorBox(
      'BoardRipper — Load Failed',
      `Failed to load the app.\n\n${errorDescription} (code ${errorCode})\nURL: ${validatedURL}\n\nLog: ${LOG_FILE}`,
    );
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
    log(levels[level] || 'INFO', `[renderer] ${message} (${sourceId}:${line})`);
  });

  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  log('INFO', `Loading: ${indexPath}`);
  log('INFO', `index.html exists: ${fs.existsSync(indexPath)}`);
  mainWindow.loadFile(indexPath).then(() => {
    log('INFO', 'index.html loaded successfully');
  }).catch((err) => {
    logFatal('Failed to load index.html', err);
  });

  // Build a platform-aware native menu
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Board…',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFileDialog(),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
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
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function openFileDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Board File',
    filters: [
      {
        name: 'Board Files',
        extensions: ['bvr', 'bv', 'brd', 'fz', 'cae', 'cad', 'pcb', 'xzz'],
      },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || filePaths.length === 0) return;
  mainWindow.webContents.send('open-files', filePaths);
}

// IPC: renderer can also request the open dialog
ipcMain.handle('show-open-dialog', () => openFileDialog());

// IPC: read a file from disk and return its ArrayBuffer + metadata
ipcMain.handle('read-file', async (_event, filePath) => {
  const stats = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  return {
    name: path.basename(filePath),
    size: stats.size,
    lastModified: stats.mtimeMs,
    buffer: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  };
});

// ── Library folder IPC ──

ipcMain.handle('get-library-path', () => {
  const settings = loadSettings();
  return settings.libraryPath || null;
});

ipcMain.handle('set-library-path', async (_event, folderPath) => {
  const settings = loadSettings();
  settings.libraryPath = folderPath;
  saveSettings(settings);
  return true;
});

ipcMain.handle('select-library-folder', async () => {
  const settings = loadSettings();
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Library Folder',
    defaultPath: settings.libraryPath || undefined,
    properties: ['openDirectory'],
  });
  if (canceled || filePaths.length === 0) return null;
  const folderPath = filePaths[0];
  settings.libraryPath = folderPath;
  saveSettings(settings);
  return folderPath;
});

ipcMain.handle('scan-library', async () => {
  const settings = loadSettings();
  const libraryPath = settings.libraryPath;
  if (!libraryPath || !fs.existsSync(libraryPath)) {
    return { files: [], tree: null, error: 'No library folder configured' };
  }
  const t0 = Date.now();
  const files = scanDirectory(libraryPath);
  const tree = buildFolderTree(files, path.basename(libraryPath));
  return {
    files,
    tree,
    duration_ms: Date.now() - t0,
  };
});

ipcMain.handle('read-library-file', async (_event, relativePath) => {
  const settings = loadSettings();
  const libraryPath = settings.libraryPath;
  if (!libraryPath) throw new Error('No library folder configured');
  const fullPath = path.join(libraryPath, relativePath);
  // Security: ensure the resolved path is within the library folder
  const resolved = path.resolve(fullPath);
  const resolvedLib = path.resolve(libraryPath);
  // Case-insensitive comparison on Windows
  const a = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const b = process.platform === 'win32' ? resolvedLib.toLowerCase() : resolvedLib;
  if (!a.startsWith(b)) {
    throw new Error('Path traversal detected');
  }
  const stats = fs.statSync(resolved);
  const buffer = fs.readFileSync(resolved);
  return {
    name: path.basename(resolved),
    size: stats.size,
    lastModified: stats.mtimeMs,
    buffer: buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ),
  };
});

app.whenReady().then(() => {
  log('INFO', 'App ready');
  try {
    createWindow();
  } catch (err) {
    logFatal('Failed to create window', err);
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
