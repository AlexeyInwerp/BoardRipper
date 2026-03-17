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
});
