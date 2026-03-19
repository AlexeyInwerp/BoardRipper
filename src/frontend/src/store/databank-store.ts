import { lookupBoard } from './apple-boards';

/** Are we running inside Electron with library APIs available? */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.scanLibrary;
}

export type DatabankListener = () => void;

export interface DatabankFile {
  id: number;
  path: string;
  filename: string;
  extension: string;
  file_type: 'board' | 'pdf';
  size: number;
  mod_time: number;
  scan_time: number;
  board_number: string;
  manufacturer: string;
  model: string;
  format_id: string;
  part_count: number | null;
  net_count: number | null;
  donor_pool: boolean;
  has_preview: boolean;
}

export interface DatabankBinding {
  id: number;
  board_file_id: number;
  pdf_file_id: number;
  auto_matched: boolean;
  board_filename: string;
  board_path: string;
  pdf_filename: string;
  pdf_path: string;
}

export interface FileDetail extends DatabankFile {
  bindings: DatabankBinding[];
}

export interface FolderNode {
  name: string;
  path: string;
  children?: FolderNode[];
  files?: DatabankFile[];
}

export interface SearchResult {
  file_id: number;
  filename: string;
  path: string;
  page_num: number;
  snippet: string;
  board_bindings: {
    board_file_id: number;
    board_filename: string;
    donor_pool: boolean;
  }[];
}

export interface ScanStatus {
  running: boolean;
  scanned: number;
  total: number;
  added: number;
  updated: number;
  deleted: number;
  errors: number;
  duration_ms: number;
}

export type ViewMode = 'metadata' | 'folders' | 'model';

/** Metadata tree node for foobar2000-style grouping */
export interface MetadataGroup {
  manufacturer: string;
  boardNumbers: {
    boardNumber: string;
    files: DatabankFile[];
  }[];
  ungrouped: DatabankFile[]; // files without board_number
}

/** Model tree node — groups by resolved Apple model name */
export interface ModelGroup {
  /** Display model line, e.g. "MacBook Pro 16\"" */
  modelLine: string;
  variants: {
    /** e.g. "MacBook Pro 16\" M3 Pro/Max 2023, EMC 8408" */
    info: string;
    aNumber: string;
    boardNumber: string;
    files: DatabankFile[];
  }[];
  /** Files whose board_number didn't resolve to a known model */
  unresolved: DatabankFile[];
}

class DatabankStore {
  private _files: DatabankFile[] = [];
  private _folderTree: FolderNode | null = null;
  private _scanStatus: ScanStatus | null = null;
  private _searchResults: SearchResult[] = [];
  private _searchQuery = '';
  private _donorOnlyFilter = false;
  private _autoPdf = (() => { try { return localStorage.getItem('boardripper-library-autopdf') !== '0'; } catch { return true; } })();
  private _verboseScan = (() => { try { return localStorage.getItem('boardripper-library-verbose') === '1'; } catch { return false; } })();
  private _showPreviews = (() => { try { return localStorage.getItem('boardripper-library-previews') === '1'; } catch { return false; } })();
  private _viewMode: ViewMode = 'model';
  private _selectedFileId: number | null = null;
  private _selectedFileDetail: FileDetail | null = null;
  private _loading = false;
  private _backendAvailable = true; // assume yes until first failure
  private _listeners = new Set<DatabankListener>();
  private _libraryPath: string | null = null;
  private _electronMode = false;

  get files() { return this._files; }
  get folderTree() { return this._folderTree; }
  get scanStatus() { return this._scanStatus; }
  get searchResults() { return this._searchResults; }
  get searchQuery() { return this._searchQuery; }
  get donorOnlyFilter() { return this._donorOnlyFilter; }
  get autoPdf() { return this._autoPdf; }
  get verboseScan() { return this._verboseScan; }
  get showPreviews() { return this._showPreviews; }
  get viewMode() { return this._viewMode; }
  get selectedFileId() { return this._selectedFileId; }
  get selectedFileDetail() { return this._selectedFileDetail; }
  get loading() { return this._loading; }
  get backendAvailable() { return this._backendAvailable; }
  get libraryPath() { return this._libraryPath; }
  get electronMode() { return this._electronMode; }

  get metadataTree(): MetadataGroup[] {
    const mfrMap = new Map<string, Map<string, DatabankFile[]>>();
    const ungroupedMap = new Map<string, DatabankFile[]>();

    for (const f of this._files) {
      const mfr = f.manufacturer || 'Unknown';

      if (f.board_number) {
        if (!mfrMap.has(mfr)) mfrMap.set(mfr, new Map());
        const boardMap = mfrMap.get(mfr)!;
        if (!boardMap.has(f.board_number)) boardMap.set(f.board_number, []);
        boardMap.get(f.board_number)!.push(f);
      } else {
        if (!ungroupedMap.has(mfr)) ungroupedMap.set(mfr, []);
        ungroupedMap.get(mfr)!.push(f);
      }
    }

    const groups: MetadataGroup[] = [];
    const allMfrs = new Set([...mfrMap.keys(), ...ungroupedMap.keys()]);

    for (const mfr of [...allMfrs].sort()) {
      const boardMap = mfrMap.get(mfr);
      const boardNumbers: MetadataGroup['boardNumbers'] = [];

      if (boardMap) {
        for (const [bn, files] of [...boardMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          boardNumbers.push({ boardNumber: bn, files });
        }
      }

      groups.push({
        manufacturer: mfr,
        boardNumbers,
        ungrouped: ungroupedMap.get(mfr) || [],
      });
    }

    return groups;
  }

  get modelTree(): ModelGroup[] {
    // Group files by resolved model line (e.g. "MacBook Pro 16\"")
    const lineMap = new Map<string, Map<string, { info: string; aNumber: string; boardNumber: string; files: DatabankFile[] }>>();
    const unresolved: DatabankFile[] = [];

    for (const f of this._files) {
      const entry = f.board_number ? lookupBoard(f.board_number) : undefined;
      if (!entry) {
        unresolved.push(f);
        continue;
      }

      if (!lineMap.has(entry.model)) lineMap.set(entry.model, new Map());
      const variants = lineMap.get(entry.model)!;
      const key = entry.board_number; // group by exact board entry
      if (!variants.has(key)) {
        variants.set(key, { info: entry.info, aNumber: entry.a_number, boardNumber: entry.board_number, files: [] });
      }
      variants.get(key)!.files.push(f);
    }

    const groups: ModelGroup[] = [];

    for (const [modelLine, variants] of [...lineMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      groups.push({
        modelLine,
        variants: [...variants.values()].sort((a, b) => a.boardNumber.localeCompare(b.boardNumber)),
        unresolved: [],
      });
    }

    // Add unresolved files as a separate group at the end
    if (unresolved.length > 0) {
      groups.push({
        modelLine: 'Other',
        variants: [],
        unresolved,
      });
    }

    return groups;
  }

  subscribe(listener: DatabankListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    this._listeners.forEach(l => l());
  }

  // --- API calls ---

  private _backendWarned = false;

  /** Safely fetch JSON from the backend, returning null if unavailable. */
  private async apiFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await fetch(url, init);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        throw new Error('Expected JSON, got ' + contentType);
      }
      this._backendWarned = false;
      if (!this._backendAvailable) {
        this._backendAvailable = true;
        this.notify();
      }
      return await res.json();
    } catch (err) {
      if (!this._backendWarned) {
        console.warn('[Databank] Backend unavailable — run the Docker container or backend on :8080');
        this._backendWarned = true;
      }
      if (this._backendAvailable) {
        this._backendAvailable = false;
        this.notify();
      }
      return null;
    }
  }

  async fetchFiles(): Promise<void> {
    this._loading = true;
    this.notify();

    if (isElectron()) {
      await this._electronScan();
    } else {
      const data = await this.apiFetch<DatabankFile[]>('/api/databank/files');
      if (data) this._files = data;
    }

    this._loading = false;
    this.notify();
  }

  async fetchTree(): Promise<void> {
    if (isElectron()) {
      // Tree is built during _electronScan
      return;
    }
    const data = await this.apiFetch<FolderNode>('/api/databank/tree');
    if (data) {
      this._folderTree = data;
      this.notify();
    }
  }

  /** Fetch a single file's detail including its bindings */
  async fetchFileDetail(id: number): Promise<FileDetail | null> {
    const data = await this.apiFetch<FileDetail>(`/api/databank/files/${id}`);
    if (data) {
      this._selectedFileDetail = data;
      this.notify();
    }
    return data;
  }

  /** Get bound PDF files for a board file by its ID */
  async getBoundPdfs(boardFileId: number): Promise<DatabankFile[]> {
    const detail = await this.apiFetch<FileDetail>(`/api/databank/files/${boardFileId}`);
    if (!detail?.bindings) return [];
    // Return the PDF file records for each binding
    const pdfIds = detail.bindings.map(b => b.pdf_file_id);
    return this._files.filter(f => pdfIds.includes(f.id));
  }

  async triggerScan(): Promise<void> {
    this._scanStatus = { running: true, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };
    this.notify();

    if (isElectron()) {
      await this._electronScan();
      this._scanStatus = {
        running: false, scanned: this._files.length, total: this._files.length,
        added: this._files.length, updated: 0, deleted: 0, errors: 0,
        duration_ms: 0,
      };
    } else {
      const data = await this.apiFetch<ScanStatus>('/api/databank/scan', { method: 'POST' });
      if (data) {
        this._scanStatus = data;
        await this.fetchFiles();
        await this.fetchTree();
      } else {
        this._scanStatus = null;
      }
    }
    this.notify();
  }

  async updateFile(id: number, update: Partial<Pick<DatabankFile, 'board_number' | 'manufacturer' | 'model' | 'donor_pool'>>): Promise<void> {
    const data = await this.apiFetch<{ status: string }>(`/api/databank/files/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
    });
    if (data) {
      const idx = this._files.findIndex(f => f.id === id);
      if (idx >= 0) {
        this._files[idx] = { ...this._files[idx], ...update };
        this._files = [...this._files];
        this.notify();
      }
    }
  }

  async toggleDonor(id: number): Promise<void> {
    const file = this._files.find(f => f.id === id);
    if (!file) return;
    await this.updateFile(id, { donor_pool: !file.donor_pool });
  }

  async search(query: string, donorOnly?: boolean): Promise<void> {
    this._searchQuery = query;
    if (donorOnly !== undefined) this._donorOnlyFilter = donorOnly;
    this.notify();

    if (!query.trim()) {
      this._searchResults = [];
      this.notify();
      return;
    }

    const params = new URLSearchParams({ q: query });
    if (this._donorOnlyFilter) params.set('donor', '1');
    const data = await this.apiFetch<{ results: SearchResult[] }>(`/api/databank/search?${params}`);
    this._searchResults = data?.results || [];
    this.notify();
  }

  async createBinding(boardFileId: number, pdfFileId: number): Promise<void> {
    await this.apiFetch<{ id: number }>('/api/databank/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_file_id: boardFileId, pdf_file_id: pdfFileId }),
    });
  }

  async deleteBinding(id: number): Promise<void> {
    await this.apiFetch<{ status: string }>(`/api/databank/bindings/${id}`, { method: 'DELETE' });
  }

  // --- Previews ---

  /** Generate and upload a PDF preview thumbnail for a file */
  async generatePdfPreview(file: DatabankFile): Promise<boolean> {
    if (file.file_type !== 'pdf' || file.has_preview) return false;
    try {
      const pdfjsLib = await import('pdfjs-dist');
      const fileObj = await this.fetchFileBuffer(file);
      const buffer = await fileObj.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
      const page = await doc.getPage(1);

      const THUMB_WIDTH = 200;
      const viewport = page.getViewport({ scale: 1 });
      const scale = THUMB_WIDTH / viewport.width;
      const scaledViewport = page.getViewport({ scale });

      const canvas = new OffscreenCanvas(
        Math.floor(scaledViewport.width),
        Math.floor(scaledViewport.height),
      );
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvas: canvas as unknown as HTMLCanvasElement, canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: scaledViewport }).promise;

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      doc.destroy();

      // Upload to backend
      const res = await fetch(`/api/databank/preview/${file.id}`, {
        method: 'PUT',
        body: blob,
      });
      if (!res.ok) return false;

      // Update local state
      const idx = this._files.findIndex(f => f.id === file.id);
      if (idx >= 0) {
        this._files[idx] = { ...this._files[idx], has_preview: true };
        this._files = [...this._files];
        this.notify();
      }
      return true;
    } catch (err) {
      console.warn('[Databank] Preview generation failed for', file.filename, err);
      return false;
    }
  }

  /** Get the preview URL for a file (or null if no preview) */
  previewUrl(file: DatabankFile): string | null {
    if (!file.has_preview) return null;
    return `/api/databank/preview/${file.id}`;
  }

  // --- Local state ---

  setViewMode(mode: ViewMode) {
    this._viewMode = mode;
    this.notify();
  }

  setDonorOnlyFilter(v: boolean) {
    this._donorOnlyFilter = v;
    this.notify();
  }

  setAutoPdf(v: boolean) {
    this._autoPdf = v;
    try { localStorage.setItem('boardripper-library-autopdf', v ? '1' : '0'); } catch { /* ignore */ }
    this.notify();
  }

  setVerboseScan(v: boolean) {
    this._verboseScan = v;
    try { localStorage.setItem('boardripper-library-verbose', v ? '1' : '0'); } catch { /* ignore */ }
    this.notify();
  }

  setShowPreviews(v: boolean) {
    this._showPreviews = v;
    try { localStorage.setItem('boardripper-library-previews', v ? '1' : '0'); } catch { /* ignore */ }
    this.notify();
  }

  selectFile(id: number | null) {
    this._selectedFileId = id;
    if (id === null) this._selectedFileDetail = null;
    this.notify();
  }

  /** Fetch a file's ArrayBuffer from the backend for opening in the viewer */
  async fetchFileBuffer(file: DatabankFile): Promise<File> {
    if (isElectron()) {
      const result = await window.electronAPI!.readLibraryFile(file.path);
      return new File([result.buffer], result.name, { lastModified: result.lastModified });
    }
    const res = await fetch(`/api/files/path/${encodeURIComponent(file.path)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = await res.arrayBuffer();
    return new File([buffer], file.filename, { lastModified: file.mod_time * 1000 });
  }

  // ── Electron-mode methods ──

  /** Initialize Electron mode: load persisted library path */
  async initElectron(): Promise<void> {
    if (!isElectron()) return;
    this._electronMode = true;
    this._libraryPath = await window.electronAPI!.getLibraryPath();
    this.notify();
    if (this._libraryPath) {
      await this._electronScan();
    }
  }

  /** Open native folder picker and set the library folder */
  async selectLibraryFolder(): Promise<string | null> {
    if (!isElectron()) return null;
    const folderPath = await window.electronAPI!.selectLibraryFolder();
    if (folderPath) {
      this._libraryPath = folderPath;
      this.notify();
      await this._electronScan();
    }
    return folderPath;
  }

  // ── Docker/web config methods ──

  /** Load config from backend — picks up library_dir and effective scan root */
  async loadConfig(): Promise<void> {
    if (isElectron()) return;
    const cfg = await this.apiFetch<Record<string, string>>('/api/config');
    if (cfg) {
      // Use explicit library_dir config, or the effective _scan_root from env/fallback
      this._libraryPath = cfg.library_dir || cfg._scan_root || null;
      this.notify();
    }
  }

  /** Set the library folder path on the backend (Docker mode) */
  async setLibraryDir(dir: string): Promise<boolean> {
    if (isElectron()) return false;
    const res = await this.apiFetch<{ status: string }>('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'library_dir', value: dir }),
    });
    if (res) {
      this._libraryPath = dir || null;
      this.notify();
      return true;
    }
    return false;
  }

  /** Scan the library folder via Electron IPC */
  private async _electronScan(): Promise<void> {
    if (!isElectron()) return;
    const result = await window.electronAPI!.scanLibrary();
    if (result.error) {
      console.warn('[Databank] Electron scan error:', result.error);
      return;
    }
    this._files = result.files;
    this._folderTree = result.tree;
    this._scanStatus = {
      running: false, scanned: result.files.length, total: result.files.length,
      added: result.files.length, updated: 0, deleted: 0, errors: 0,
      duration_ms: result.duration_ms,
    };
    this.notify();
  }
}

export const databankStore = new DatabankStore();
