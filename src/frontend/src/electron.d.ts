/** Type declarations for the Electron preload bridge (window.electronAPI) */

interface ElectronFileResult {
  name: string;
  size: number;
  lastModified: number;
  buffer: ArrayBuffer;
}

interface ElectronScanResult {
  files: import('./store/databank-store').DatabankFile[];
  tree: import('./store/databank-store').FolderNode | null;
  duration_ms: number;
  error?: string;
}

interface ElectronAPI {
  showOpenDialog: () => Promise<void>;
  readFile: (filePath: string) => Promise<ElectronFileResult>;
  onOpenFiles: (callback: (filePaths: string[]) => void) => void;

  // Library folder
  getLibraryPath: () => Promise<string | null>;
  setLibraryPath: (folderPath: string) => Promise<boolean>;
  selectLibraryFolder: () => Promise<string | null>;
  scanLibrary: () => Promise<ElectronScanResult>;
  readLibraryFile: (relativePath: string) => Promise<ElectronFileResult>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
