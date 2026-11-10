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

  // File reveal + platform detection (added for the library Download button)
  showItemInFolder: (relativePath: string) => Promise<boolean>;
  platform: () => Promise<NodeJS.Platform>;

  // MCP server sidecar toggle (see desktop/main.js)
  getMcpEnabled: () => Promise<boolean>;
  setMcpEnabled: (on: boolean) => Promise<boolean>;

  // Self-update (see desktop/updater.js)
  updates?: {
    getState: () => Promise<DesktopUpdateStateShape>;
    check: () => Promise<DesktopUpdateStateShape>;
    skip: () => Promise<DesktopUpdateStateShape>;
    install: () => Promise<DesktopUpdateStateShape>;
    restart: () => Promise<boolean>;
    openNotes: () => Promise<void>;
    reveal: () => Promise<void>;
    onState: (callback: (state: DesktopUpdateStateShape) => void) => () => void;
  };
}

/** desktop/updater.js state, pushed over `update:state`. */
interface DesktopUpdateStateShape {
  current: string;
  build: string;
  enabled: boolean;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'staging' | 'ready' | 'manual' | 'error';
  latest: { version: string; released_at: string | null; notes_url: string | null; notes: string } | null;
  progress: { received: number; total: number } | null;
  error: string | null;
  manualPath: string | null;
  manualReason: string | null;
  checkedAt: number;
  skipped: string | null;
}

declare global {
  type DesktopUpdateState = DesktopUpdateStateShape;
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
