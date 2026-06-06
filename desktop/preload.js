const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Request native open-file dialog
  showOpenDialog: () => ipcRenderer.invoke('show-open-dialog'),

  // Read a file from an absolute path → { name, size, lastModified, buffer }
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),

  // Listen for files opened via the native menu (Cmd+O) or drag-to-dock
  onOpenFiles: (callback) => {
    ipcRenderer.on('open-files', (_event, filePaths) => callback(filePaths));
  },

  // ── Library folder ──

  // Get the persisted library folder path (or null)
  getLibraryPath: () => ipcRenderer.invoke('get-library-path'),

  // Set the library folder path
  setLibraryPath: (folderPath) => ipcRenderer.invoke('set-library-path', folderPath),

  // Open a native folder picker and persist the selection → returns path or null
  selectLibraryFolder: () => ipcRenderer.invoke('select-library-folder'),

  // Scan the library folder → { files, tree, duration_ms } or { error }
  scanLibrary: () => ipcRenderer.invoke('scan-library'),

  // Read a file from the library by relative path → { name, size, lastModified, buffer }
  readLibraryFile: (relativePath) => ipcRenderer.invoke('read-library-file', relativePath),

  // Reveal a library file in the OS file browser (Finder / Explorer /
  // default file manager) with the file highlighted. relativePath is
  // relative to the persisted library folder.
  showItemInFolder: (relativePath) => ipcRenderer.invoke('show-item-in-folder', relativePath),

  // Return process.platform from the main process. Used by the renderer
  // to format platform-conditional labels like "Show in Finder" vs
  // "Show in Explorer".
  platform: () => ipcRenderer.invoke('platform'),
});
