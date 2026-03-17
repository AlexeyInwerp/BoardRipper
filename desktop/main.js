const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');

// Serve the Vite build output from the bundled 'webapp' folder
const WEBAPP_DIR = path.join(__dirname, 'webapp');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Boardviewer',
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
  const fs = require('fs');
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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
