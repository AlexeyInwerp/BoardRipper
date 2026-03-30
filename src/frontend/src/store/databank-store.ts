import { lookupBoard } from './apple-boards';
import { log } from './log-store';
import { Emitter } from './emitter';

/** Are we running inside Electron with library APIs available? */
export function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.scanLibrary;
}


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
  phase?: string;
  last_file?: string;
  completed_at?: number;
  pdf_completed_at?: number;
  // Phase 2: PDF text extraction
  pdf_running?: boolean;
  pdf_extracted?: number;
  pdf_total?: number;
  pdf_errors?: number;
  pdf_current?: string;
}

export interface DatabankStats {
  boards: number;
  pdfs: number;
  bindings: number;
  pdf_pages: number;
  pdf_errors: number;
  db_size_bytes: number;
  last_file_scan_at: number;
  last_pdf_scan_at: number;
}

export interface BrowseEntry {
  name: string;
  is_dir: boolean;
  size?: number;
  mod_time?: number;
  file_type?: string;
}

export interface BrowseResult {
  path: string;
  entries: BrowseEntry[];
}

export type ViewMode = 'history' | 'metadata' | 'folders' | 'model';

/** Entry in the recently-opened history */
export interface RecentItem {
  fileName: string;
  fileType: 'board' | 'pdf';
  path: string;
  openedAt: number;
  /** Databank file ID (if available) */
  fileId?: number;
}

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

class DatabankStore extends Emitter {
  private _files: DatabankFile[] = [];
  private _folderTree: FolderNode | null = null;
  private _scanStatus: ScanStatus | null = (() => {
    try {
      const stored = localStorage.getItem('boardripper-scan-status');
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  })();
  private _stats: DatabankStats | null = null;
  private _browseMode: 'database' | 'live' = (() => {
    try { return (localStorage.getItem('boardripper-library-browse-mode') as 'database' | 'live') || 'database'; }
    catch { return 'database' as const; }
  })();
  private _browseResult: BrowseResult | null = null;
  private _browsing = false;
  private _searchResults: SearchResult[] = [];
  private _searchQuery = '';
  private _autoPdf = (() => { try { return localStorage.getItem('boardripper-library-autopdf') !== '0'; } catch { return true; } })();
  private _verboseScan = (() => { try { return localStorage.getItem('boardripper-library-verbose') === '1'; } catch { return false; } })();
  private _showPreviews = (() => { try { return localStorage.getItem('boardripper-library-previews') === '1'; } catch { return false; } })();
  private _viewMode: ViewMode = 'history';
  private _selectedFileId: number | null = null;
  private _recentItems: RecentItem[] = (() => {
    try {
      const raw = localStorage.getItem('boardripper-history');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  })();
  private _historyDepth: number = (() => {
    try {
      const v = localStorage.getItem('boardripper-history-depth');
      return v ? Math.min(100, Math.max(1, Number(v))) : 20;
    } catch { return 20; }
  })();
  private _selectedFileDetail: FileDetail | null = null;
  private _loading = false;
  private _backendAvailable = true; // assume yes until first failure
  private _libraryPath: string | null = null;
  private _electronMode = false;

  get files() { return this._files; }
  get folderTree() { return this._folderTree; }
  get scanStatus() { return this._scanStatus; }
  get stats() { return this._stats; }
  get browseMode() { return this._browseMode; }
  get browseResult() { return this._browseResult; }
  get browsing() { return this._browsing; }
  get searchResults() { return this._searchResults; }
  get searchQuery() { return this._searchQuery; }
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
  get recentItems() { return this._recentItems; }
  get historyDepth() { return this._historyDepth; }

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
        log.scan.warn('Backend unavailable — run the Docker container or backend on :8080');
        this._backendWarned = true;
      }
      if (this._backendAvailable) {
        this._backendAvailable = false;
        this.notify();
      }
      return null;
    }
  }

  private _persistScanStatus() {
    try {
      if (this._scanStatus) {
        localStorage.setItem('boardripper-scan-status', JSON.stringify(this._scanStatus));
      }
    } catch { /* ignore */ }
  }

  /** Check if a scan or PDF extraction is already in progress and start polling if so. */
  async checkScanStatus(): Promise<void> {
    if (isElectron()) return;
    const status = await this.apiFetch<ScanStatus>('/api/databank/scan/status');
    if (status) {
      this._scanStatus = status;
      this._persistScanStatus();
      this.notify();
      if (status.running || status.pdf_running) {
        log.scan.log('Resuming scan polling — scan still in progress');
        this._startScanPolling();
      }
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

  private _scanPollTimer: ReturnType<typeof setInterval> | null = null;

  async triggerFileScan(): Promise<void> {
    log.scan.log('File scan: starting...');
    this._scanStatus = { running: true, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };
    this._persistScanStatus();
    this.notify();

    if (isElectron()) {
      await this._electronScan();
      this._scanStatus = {
        running: false, scanned: this._files.length, total: this._files.length,
        added: this._files.length, updated: 0, deleted: 0, errors: 0,
        duration_ms: 0,
      };
      this._persistScanStatus();
      this.notify();
    } else {
      // Fire-and-forget: backend runs scan in background
      await this.apiFetch<ScanStatus>('/api/databank/scan', { method: 'POST' });
      this._startScanPolling();
    }
  }

  async triggerPdfScan(): Promise<void> {
    log.scan.log('PDF extraction: starting...');
    await this.apiFetch<ScanStatus>('/api/databank/scan/pdf', { method: 'POST' });
    this._startScanPolling();
  }

  async stopScan(): Promise<void> {
    if (isElectron()) return;
    await this.apiFetch<ScanStatus>('/api/databank/scan/stop', { method: 'POST' });
    this._stopScanPolling();
    // Fetch final status
    const status = await this.apiFetch<ScanStatus>('/api/databank/scan/status');
    if (status) {
      this._scanStatus = status;
      this._persistScanStatus();
      if (!status.running) {
        await this.fetchFiles();
        await this.fetchTree();
      }
    }
    this.notify();
  }

  private _filesFetchedAfterScan = false;

  private _startScanPolling() {
    this._stopScanPolling();
    this._filesFetchedAfterScan = false;
    this._scanPollTimer = setInterval(async () => {
      const status = await this.apiFetch<ScanStatus>('/api/databank/scan/status');
      if (status) {
        const prev = this._scanStatus;
        const changed = !prev
          || prev.scanned !== status.scanned || prev.running !== status.running
          || prev.pdf_running !== status.pdf_running || prev.pdf_extracted !== status.pdf_extracted
          || prev.phase !== status.phase;
        this._scanStatus = status;
        this._persistScanStatus();
        if (changed) this.notify();

        // File scan done — fetch files once (even if PDF extraction still running)
        if (!status.running && !this._filesFetchedAfterScan) {
          this._filesFetchedAfterScan = true;
          await this.fetchFiles();
          await this.fetchTree();
          this.notify();
        }

        // Stop polling only when both file scan and PDF extraction are done
        if (!status.running && !status.pdf_running) {
          this._stopScanPolling();
          // Final refresh in case PDF extraction changed something
          if (this._filesFetchedAfterScan) {
            this.notify();
          }
        }
      }
    }, 500);
  }

  private _stopScanPolling() {
    if (this._scanPollTimer) {
      clearInterval(this._scanPollTimer);
      this._scanPollTimer = null;
    }
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

  async search(query: string): Promise<void> {
    this._searchQuery = query;
    this.notify();

    if (!query.trim()) {
      this._searchResults = [];
      this.notify();
      return;
    }

    const params = new URLSearchParams({ q: query });
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
    if (file.file_type !== 'pdf' || file.has_preview || isElectron()) return false;
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
      log.scan.warn('Preview generation failed for', file.filename, err);
      return false;
    }
  }

  /** Get the preview URL for a file (or null if no preview) */
  previewUrl(file: DatabankFile): string | null {
    if (!file.has_preview) return null;
    return `/api/databank/preview/${file.id}`;
  }

  // --- Stats, reset, browse ---

  async fetchStats(): Promise<void> {
    const data = await this.apiFetch<DatabankStats>('/api/databank/stats');
    if (data) { this._stats = data; this.notify(); }
  }

  async resetAll(): Promise<boolean> {
    const res = await this.apiFetch<{ status: string }>('/api/databank/reset', { method: 'POST' });
    if (res) {
      log.scan.log('Database reset complete');
      this._files = []; this._folderTree = null; this._scanStatus = null; this._stats = null;
      try { localStorage.removeItem('boardripper-scan-status'); } catch { /* ignored */ }
      await this.fetchStats();
      this.notify();
      return true;
    }
    return false;
  }

  async resetPdf(): Promise<boolean> {
    const res = await this.apiFetch<{ status: string }>('/api/databank/reset-pdf', { method: 'POST' });
    if (res) {
      log.scan.log('PDF text reset complete');
      await this.fetchStats();
      this.notify();
      return true;
    }
    return false;
  }

  async browse(path: string): Promise<void> {
    this._browsing = true;
    this.notify();
    const data = await this.apiFetch<BrowseResult>(`/api/databank/browse?path=${encodeURIComponent(path)}`);
    if (data) this._browseResult = data;
    this._browsing = false;
    this.notify();
  }

  setBrowseMode(mode: 'database' | 'live') {
    this._browseMode = mode;
    try { localStorage.setItem('boardripper-library-browse-mode', mode); } catch { /* ignored */ }
    if (mode === 'live') this.browse('');
    this.notify();
  }

  // --- Local state ---

  setViewMode(mode: ViewMode) {
    this._viewMode = mode;
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

  // --- History ---

  addToHistory(file: DatabankFile) {
    // Remove any existing entry for the same path (move to top)
    this._recentItems = this._recentItems.filter(r => r.path !== file.path);
    this._recentItems.unshift({
      fileName: file.filename,
      fileType: file.file_type,
      path: file.path,
      openedAt: Date.now(),
      fileId: file.id,
    });
    // Trim to depth limit
    if (this._recentItems.length > this._historyDepth) {
      this._recentItems = this._recentItems.slice(0, this._historyDepth);
    }
    try { localStorage.setItem('boardripper-history', JSON.stringify(this._recentItems)); } catch { /* ignore */ }
    this.notify();
  }

  clearHistory() {
    this._recentItems = [];
    try { localStorage.removeItem('boardripper-history'); } catch { /* ignore */ }
    this.notify();
  }

  setHistoryDepth(n: number) {
    this._historyDepth = Math.min(100, Math.max(1, n));
    // Trim if needed
    if (this._recentItems.length > this._historyDepth) {
      this._recentItems = this._recentItems.slice(0, this._historyDepth);
      try { localStorage.setItem('boardripper-history', JSON.stringify(this._recentItems)); } catch { /* ignore */ }
    }
    try { localStorage.setItem('boardripper-history-depth', String(this._historyDepth)); } catch { /* ignore */ }
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
      log.scan.warn('Electron scan error:', result.error);
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
