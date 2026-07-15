const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  pickFreePort,
  isPortFree,
  resolveBoardDbPath,
  startBackend,
  waitForHealth,
  enableMcpConfig,
  stopBackend,
} = require('./backend-sidecar');

// The running backend sidecar, or null. { proc, port }.
let currentBackend = null;
// True while we deliberately kill the backend (user disabled MCP, or a
// crash-retry is about to replace it) so the 'exit' listener can tell an
// intentional stop from a crash. Reset at the top of startBackendAndLoad().
let stoppingDeliberately = false;
// Consecutive mid-session crash retries (see handleUnexpectedExit).
let crashRetries = 0;

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
      if (currentBackend) {
        mainWindow.loadURL(`http://127.0.0.1:${currentBackend.port}/`);
      } else {
        mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));
      }
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

  boot();

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

function loadStaticFile() {
  const indexPath = path.join(WEBAPP_DIR, 'index.html');
  log('INFO', `Loading: ${indexPath}`);
  return mainWindow.loadFile(indexPath).then(() => {
    log('INFO', 'index.html loaded successfully');
  }).catch((err) => {
    logFatal('Failed to load index.html', err);
  });
}

/** Resolve the loopback port for the sidecar. Prefer the persisted port so an
 *  external MCP client's saved connect URL survives restarts; fall back to a
 *  fresh free port (and persist it) if the preferred one is taken. */
async function resolvePort() {
  const settings = loadSettings();
  if (settings.mcpPort && await isPortFree(settings.mcpPort)) {
    return settings.mcpPort;
  }
  const port = await pickFreePort();
  const s = loadSettings();
  s.mcpPort = port;
  saveSettings(s);
  return port;
}

/** Spawn the backend, wait for health, seed mcp_enabled, then load the window
 *  from it. On startup failure: kill, revert mcpEnabled to false so the next
 *  launch doesn't retry a broken setup, and fall back to loadStaticFile().
 *  Returns true on success. A later unexpected exit (genuine crash) is handled
 *  by the 'exit' listener -> handleUnexpectedExit(), not this function. */
async function startBackendAndLoad() {
  stoppingDeliberately = false;
  const settings = loadSettings();
  const port = await resolvePort();
  log('INFO', `Starting backend sidecar on port ${port}...`);
  const proc = startBackend({
    dataDir: app.getPath('userData'),
    libraryDir: settings.libraryPath || '',
    staticDir: WEBAPP_DIR,
    boardDbPath: resolveBoardDbPath(),
    port,
  });
  proc.stdout.on('data', d => log('INFO', `[backend] ${d.toString().trim()}`));
  proc.stderr.on('data', d => log('ERROR', `[backend] ${d.toString().trim()}`));
  let exitedDuringStartup = false;
  proc.on('exit', (code, signal) => {
    log('ERROR', `Backend sidecar exited: code=${code} signal=${signal}`);
    const wasCurrent = currentBackend && currentBackend.proc === proc;
    if (wasCurrent) currentBackend = null;
    if (!wasCurrent) { exitedDuringStartup = true; return; } // handled below
    if (stoppingDeliberately) return; // user-initiated, not a crash
    void handleUnexpectedExit();
  });

  const healthy = await waitForHealth(port);
  if (!healthy || exitedDuringStartup) {
    log('ERROR', 'Backend sidecar failed to become healthy — disabling MCP');
    stopBackend(proc);
    const s = loadSettings();
    s.mcpEnabled = false;
    saveSettings(s);
    dialog.showErrorBox(
      'BoardRipper — MCP server failed to start',
      `The local server did not become healthy in time. MCP has been disabled.\n\nLog: ${LOG_FILE}`,
    );
    return false;
  }

  await enableMcpConfig(port);
  currentBackend = { proc, port };
  crashRetries = 0;
  log('INFO', `Backend sidecar healthy, loading http://127.0.0.1:${port}/`);
  // Tolerate a load failure (e.g. the backend died in the narrow window
  // between the health check and here) rather than letting the rejection
  // bubble to the fatal-error handler; the did-fail-load handler already
  // surfaces a dialog, and a crash 'exit' will drive handleUnexpectedExit.
  try {
    await mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  } catch (err) {
    log('ERROR', `loadURL failed: ${err?.message || err}`);
  }
  return true;
}

/** A previously-healthy backend died mid-session. Retry with backoff (1s, 3s,
 *  9s); if exhausted, disable MCP and fall back to the static file so the app
 *  stays usable. */
async function handleUnexpectedExit() {
  if (crashRetries >= 3) {
    logFatal('Backend sidecar crashed repeatedly', new Error('Exceeded restart retries'));
    const s = loadSettings();
    s.mcpEnabled = false;
    saveSettings(s);
    await loadStaticFile();
    return;
  }
  crashRetries += 1;
  const delayMs = 1000 * 3 ** (crashRetries - 1); // 1s, 3s, 9s
  log('INFO', `Backend sidecar crashed — retrying in ${delayMs}ms (attempt ${crashRetries}/3)`);
  await new Promise(r => setTimeout(r, delayMs));
  // The user may have disabled MCP during the backoff (the stale page still
  // shows the toggle); don't resurrect a backend they just turned off.
  if (!loadSettings().mcpEnabled) {
    log('INFO', 'MCP disabled during crash backoff — not restarting backend');
    return;
  }
  await startBackendAndLoad();
}

function stopCurrentBackend() {
  if (currentBackend) {
    stoppingDeliberately = true;
    stopBackend(currentBackend.proc);
    currentBackend = null;
  }
}

/** Startup entry point: honours the persisted mcpEnabled setting. */
async function boot() {
  const settings = loadSettings();
  if (settings.mcpEnabled) {
    const ok = await startBackendAndLoad();
    if (ok) return;
  }
  await loadStaticFile();
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

// Reveal a library file in the OS file browser. Path is interpreted
// relative to the persisted library folder. Guards: relative path must
// resolve inside libraryDir (no traversal); file must exist.
ipcMain.handle('show-item-in-folder', (_event, relativePath) => {
  if (typeof relativePath !== 'string' || !relativePath) return false;
  const libraryDir = loadSettings().libraryPath;
  if (!libraryDir) return false;
  const root = path.resolve(libraryDir);
  const abs = path.resolve(root, relativePath);
  // Containment check: abs must equal root or live under it (root + sep).
  if (abs !== root && !abs.startsWith(root + path.sep)) return false;
  if (!fs.existsSync(abs)) return false;
  shell.showItemInFolder(abs);
  return true;
});

// Return process.platform — used by the renderer for label formatting.
ipcMain.handle('platform', () => process.platform);

// MCP server sidecar toggle. Persisted in settings.json; gates whether the Go
// backend child process is spawned. Enabling spawns + health-checks + reloads
// the window from the backend origin; disabling kills it + reloads the static
// file. Returns whether MCP is enabled after the call (false if a requested
// enable failed to become healthy).
ipcMain.handle('get-mcp-enabled', () => !!loadSettings().mcpEnabled);

ipcMain.handle('set-mcp-enabled', async (_event, on) => {
  const settings = loadSettings();
  settings.mcpEnabled = !!on;
  saveSettings(settings);
  if (on) {
    return await startBackendAndLoad(); // true on success, false if unhealthy
  }
  stopCurrentBackend();
  await loadStaticFile();
  return false;
});

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

app.on('before-quit', () => {
  stopCurrentBackend();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
