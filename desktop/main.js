const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Serve the Vite build output from the bundled 'webapp' folder
const WEBAPP_DIR = path.join(__dirname, 'webapp');

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

const BOARD_EXTENSIONS = new Set(['.bvr', '.bv', '.brd', '.fz', '.cae', '.cad', '.pcb', '.xzz']);
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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'BoardRipper',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(WEBAPP_DIR, 'index.html'));

  // Build a minimal native menu (keeps Cmd+Q, Cmd+C/V, fullscreen, etc.)
  const template = [
    {
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
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Board…',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFileDialog(),
        },
        { type: 'separator' },
        { role: 'close' },
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
  if (!resolved.startsWith(path.resolve(libraryPath))) {
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
