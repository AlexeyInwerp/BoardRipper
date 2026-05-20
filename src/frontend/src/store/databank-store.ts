import { lookupBoard } from './apple-boards';
import { log } from './log-store';
import { Emitter } from './emitter';
import { libraryCache } from './library-cache';
import { updateStore } from './update-store';
import { boardStore } from './board-store';
import { fetchWithCloudRetry, readCloudError, formatCloudErrorToast } from './fetch-with-cloud-retry';

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
  board_manufacturer: string;
  resolution_status: 'resolved' | 'pattern_matched' | 'unresolved' | '';
  board_uuid?: string;
  board_color?: string;
  board_color_hex?: string;
}

export interface DatabankBinding {
  id: number;
  board_file_id: number;
  pdf_file_id: number;
  auto_matched: boolean;
  /** Open vocabulary; v1 dropdown: 'schematic' | 'datasheet' | 'other'.
   *  Stored as plain text so future curated sources can introduce richer
   *  labels without a schema migration. */
  category: string;
  /** Filters the Auto-PDF flow: only bindings with auto_open=true open with
   *  the board. Independent of category so a user can pin a datasheet to
   *  auto-open or keep a schematic listed-only. */
  auto_open: boolean;
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
  /** Database mode (Go backend): IDs of files in this directory. The
   *  client resolves them via the store's id->file Map so the wire payload
   *  doesn't duplicate the file list (which already shipped via /files). */
  file_ids?: number[];
  /** Electron mode legacy shape — full FileRecord objects, embedded by
   *  desktop/main.js. Kept so the same FolderView component renders in
   *  both modes without an extra adapter. */
  files?: DatabankFile[];
}

export interface SearchResult {
  file_id: number;
  filename: string;
  path: string;
  page_num: number;
  snippet: string;
  /** True when the PDF file is in the donor pool (backend v2 field). */
  is_donor?: boolean;
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

export type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';
export type ViewMode = 'history' | 'metadata' | 'folders' | 'model' | 'search';

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

/** Entry returned by GET /api/databank/donors */
export interface DonorEntry {
  file_id: number;
  filename: string;
  path: string;
  added_at: string;
}

class DatabankStore extends Emitter {
  // ── Load lifecycle (added 2026-05-09) ───────────────────────────────
  /** Tracks the app-startup load orchestrated by ensureLoaded(). */
  private _loadStatus: LoadStatus = 'idle';
  /** When status === 'loading', the inflight promise so concurrent
   *  callers share work instead of re-firing the chain. */
  private _loadInflight: Promise<void> | null = null;
  /** Most recent error from a failed load attempt; cleared on next ensureLoaded(). */
  private _loadError: Error | null = null;

  private _files: DatabankFile[] = [];
  private _filesVersion = 0;
  /** True once the full file list has been fetched. False while we're showing
   *  a partial subset (e.g. only the files referenced by the History tab). */
  private _filesComplete = false;
  /** Inflight promise for the full file fetch — coalesces concurrent requests. */
  private _filesInflight: Promise<void> | null = null;
  /** Cache signature corresponding to the current `_files` payload. */
  private _filesSignature: string | null = null;
  /** O(1) lookup tables rebuilt whenever `_files` changes. Hot consumers
   *  (binding resolution, search-result expansion) used to do `files.find`
   *  per item — quadratic at 100k entries. */
  private _filesById = new Map<number, DatabankFile>();
  private _filesByPath = new Map<string, DatabankFile>();
  private _metadataCache: { version: number; tree: MetadataGroup[] } | null = null;
  private _modelCache: { version: number; tree: ModelGroup[] } | null = null;

  /** Single mutation point for `_files`. Bumps the version so memoized
   *  getters (metadataTree/modelTree) know to recompute. */
  private _setFiles(files: DatabankFile[], opts: { complete?: boolean; signature?: string | null } = {}) {
    this._files = files;
    this._filesVersion++;
    this._metadataCache = null;
    this._modelCache = null;
    // Build both lookup tables in a single pass — `new Map(files.map(...))`
    // allocates 2N intermediate tuple arrays per Map (4N total at 100k rows).
    const byId = new Map<number, DatabankFile>();
    const byPath = new Map<string, DatabankFile>();
    for (const f of files) {
      byId.set(f.id, f);
      byPath.set(f.path, f);
    }
    this._filesById = byId;
    this._filesByPath = byPath;
    if (opts.complete !== undefined) this._filesComplete = opts.complete;
    if (opts.signature !== undefined) this._filesSignature = opts.signature;
  }

  fileById(id: number): DatabankFile | undefined { return this._filesById.get(id); }
  fileByPath(path: string): DatabankFile | undefined { return this._filesByPath.get(path); }

  /** Linear-scan lookup by basename. Used by the renderer for per-board
   *  metadata-color resolution — called once per scene rebuild, so O(N) is fine. */
  fileByFilename(name: string): DatabankFile | undefined {
    if (!name) return undefined;
    for (const f of this._files) if (f.filename === name) return f;
    return undefined;
  }
  private _folderTree: FolderNode | null = null;
  private _scanStatus: ScanStatus | null = (() => {
    try {
      const stored = localStorage.getItem('boardripper-scan-status');
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  })();
  /** `_stats` doubles as the persistent header counter — restoring the last
   *  observed value from localStorage at construction lets the panel render
   *  "N boards, M PDFs" at t=0 instead of waiting for /api/databank/stats. */
  private _stats: DatabankStats | null = (() => {
    try {
      const raw = localStorage.getItem('boardripper-stats');
      return raw ? (JSON.parse(raw) as DatabankStats) : null;
    } catch { return null; }
  })();

  private _persistStats() {
    try {
      if (this._stats) {
        localStorage.setItem('boardripper-stats', JSON.stringify(this._stats));
      }
    } catch { /* ignore */ }
  }
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
      // Migration: the previous product default was 20. Bump legacy-default users
      // to the new default of 100, but leave any other stored value (including
      // values below 100 a user has explicitly chosen) untouched.
      if (v === '20') {
        localStorage.setItem('boardripper-history-depth', '100');
        return 100;
      }
      return v ? Math.min(100, Math.max(1, Number(v))) : 100;
    } catch { return 100; }
  })();
  private _selectedFileDetail: FileDetail | null = null;
  private _loading = false;
  private _backendAvailable = true; // assume yes until first failure
  private _libraryPath: string | null = null;
  private _electronMode = false;
  /** Set of file IDs currently in the pdf_donors list. Loaded at startup
   *  and refreshed after every add/remove. */
  private _donorIds = new Set<number>();
  /** Pending PDF search request set by ContextMenu "Search all donors" and
   *  consumed by LibraryPanel's search tab on mount. Cleared after pickup. */
  pendingPdfSearch: { query: string; scope: 'all' | 'donor' } | null = null;
  // Pinned-to-top entries in History. Keyed by `path` (matches RecentItem
  // identity) so a pin survives databank rescans that change file IDs.
  // Stored separately from history so `clearHistory` doesn't drop pins.
  private _favoritePaths: Set<string> = (() => {
    try {
      const raw = localStorage.getItem('boardripper-favorites');
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  })();

  get files() { return this._files; }
  get filesComplete() { return this._filesComplete; }
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
  get favoritePaths() { return this._favoritePaths; }
  get loadStatus(): LoadStatus { return this._loadStatus; }
  get loadError(): Error | null { return this._loadError; }
  get donorIds(): ReadonlySet<number> { return this._donorIds; }

  isFavorite(path: string): boolean {
    return this._favoritePaths.has(path);
  }

  toggleFavorite(path: string): void {
    const next = new Set(this._favoritePaths);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    this._favoritePaths = next;
    try { localStorage.setItem('boardripper-favorites', JSON.stringify([...next])); } catch { /* ignore */ }
    this.notify();
  }

  isDonor(fileId: number): boolean { return this._donorIds.has(fileId); }

  async addDonor(fileId: number): Promise<void> {
    await this.apiFetch(`/api/databank/donors/${fileId}`, { method: 'PUT' });
    await this.refreshDonors();
  }

  async removeDonor(fileId: number): Promise<void> {
    await this.apiFetch(`/api/databank/donors/${fileId}`, { method: 'DELETE' });
    await this.refreshDonors();
  }

  async refreshDonors(): Promise<void> {
    const list = await this.apiFetch<DonorEntry[]>('/api/databank/donors');
    this._donorIds = new Set((list ?? []).map(d => d.file_id));
    this.notify();
  }

  get metadataTree(): MetadataGroup[] {
    if (this._metadataCache && this._metadataCache.version === this._filesVersion) {
      return this._metadataCache.tree;
    }
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

    this._metadataCache = { version: this._filesVersion, tree: groups };
    return groups;
  }

  get modelTree(): ModelGroup[] {
    if (this._modelCache && this._modelCache.version === this._filesVersion) {
      return this._modelCache.tree;
    }
    // Group files by brand → model → board_number
    // Uses backend-enriched model/manufacturer fields (from Board DB resolution)
    // Falls back to client-side Apple lookup for files without backend resolution
    const lineMap = new Map<string, Map<string, { info: string; aNumber: string; boardNumber: string; files: DatabankFile[] }>>();
    const unresolved: DatabankFile[] = [];

    for (const f of this._files) {
      // Prefer backend-resolved model (works for all brands)
      if (f.resolution_status === 'resolved' && f.model && f.manufacturer) {
        const modelLine = `${f.manufacturer} — ${f.model}`;
        if (!lineMap.has(modelLine)) lineMap.set(modelLine, new Map());
        const variants = lineMap.get(modelLine)!;
        const key = f.board_number;
        if (!variants.has(key)) {
          const odm = f.board_manufacturer ? ` [${f.board_manufacturer}]` : '';
          variants.set(key, { info: `${f.model}${odm}`, aNumber: '', boardNumber: f.board_number, files: [] });
        }
        variants.get(key)!.files.push(f);
        continue;
      }

      // Fallback: client-side Apple lookup (for existing DBs not yet re-scanned)
      const entry = f.board_number ? lookupBoard(f.board_number) : undefined;
      if (entry) {
        if (!lineMap.has(entry.model)) lineMap.set(entry.model, new Map());
        const variants = lineMap.get(entry.model)!;
        const key = entry.board_number;
        if (!variants.has(key)) {
          variants.set(key, { info: entry.info, aNumber: entry.a_number, boardNumber: entry.board_number, files: [] });
        }
        variants.get(key)!.files.push(f);
        continue;
      }

      unresolved.push(f);
    }

    const groups: ModelGroup[] = [];

    for (const [modelLine, variants] of [...lineMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      groups.push({
        modelLine,
        variants: [...variants.values()].sort((a, b) => a.boardNumber.localeCompare(b.boardNumber)),
        unresolved: [],
      });
    }

    if (unresolved.length > 0) {
      groups.push({
        modelLine: 'Other',
        variants: [],
        unresolved,
      });
    }

    this._modelCache = { version: this._filesVersion, tree: groups };
    return groups;
  }

  // --- API calls ---

  private _backendWarned = false;

  /** Safely fetch JSON from the backend, returning null if unavailable. */
  private async apiFetch<T>(url: string, init?: RequestInit): Promise<T | null> {
    const method = init?.method ?? 'GET';
    // During the post-update settle window the proxy → new container handoff
    // routinely produces 502/503 for a few seconds; treat those as expected
    // and demote to a debug log so the user doesn't read them as a broken
    // update in the Debug panel.
    const settling = updateStore.isPostRestartSettling;
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        // Surface the status + URL on every failure so a stale backend
        // (e.g. missing the PATCH /api/databank/bindings/{id} route) shows
        // up in devtools instead of silently leaving the UI unchanged.
        if (settling) log.scan.log(`API ${method} ${url} → HTTP ${res.status} (post-restart settle)`);
        else log.scan.warn(`API ${method} ${url} → HTTP ${res.status}`);
        throw new Error(`HTTP ${res.status}`);
      }
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        log.scan.warn(`API ${method} ${url} → unexpected content-type: ${contentType}`);
        throw new Error('Expected JSON, got ' + contentType);
      }
      this._backendWarned = false;
      if (!this._backendAvailable) {
        this._backendAvailable = true;
        this.notify();
      }
      return await res.json();
    } catch {
      if (!this._backendWarned && !settling) {
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

  /** App-startup orchestrator. Idempotent: returns immediately if already
   *  loaded; returns the inflight promise if a previous call is in flight;
   *  otherwise runs the full load chain in the background and resolves when
   *  done. Must NOT be called from React component bodies — call it from
   *  App.tsx's mount effect (or any one-shot top-level lifecycle hook). */
  async ensureLoaded(): Promise<void> {
    if (this._loadStatus === 'loaded') return;
    if (this._loadInflight) return this._loadInflight;
    this._loadStatus = 'loading';
    this._loadError = null;
    this.notify();
    this._loadInflight = this._runStartupLoad();
    try {
      await this._loadInflight;
    } finally {
      this._loadInflight = null;
    }
  }

  /** Internal: actually walks the load chain. Wrapped in a try/catch so
   *  ensureLoaded can transition to 'error' on any thrown failure. */
  private async _runStartupLoad(): Promise<void> {
    try {
      // Electron branch: same as today's initElectron path.
      if (typeof window !== 'undefined' && window.electronAPI?.scanLibrary) {
        await this.initElectron();
        this._loadStatus = 'loaded';
        this.notify();
        return;
      }

      // Browser branch: matches the order in today's LibraryPanel useEffect
      // (which this method is replacing).
      await this.loadConfig();
      this.checkScanStatus();

      const recentIds = this._recentItems
        .map(r => r.fileId)
        .filter((v): v is number => typeof v === 'number');

      if (this._viewMode === 'history' && recentIds.length > 0) {
        // History tab is the default; first paint only needs the referenced
        // file rows. Stats run in parallel for the totals badge. Then the
        // full file list hydrates in the background.
        await Promise.all([
          this.fetchStats(),
          this.fetchFilesByIds(recentIds),
          this.refreshDonors(),
        ]);
        const hydrate = () => { void this.fetchFiles(); };
        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          (window as Window & { requestIdleCallback: (cb: () => void, opts?: { timeout: number }) => void })
            .requestIdleCallback(hydrate, { timeout: 5000 });
        } else {
          setTimeout(hydrate, 500);
        }
      } else {
        // Cold load: full list right away.
        await Promise.all([this.fetchStats(), this.fetchFiles(), this.refreshDonors()]);
      }

      this._loadStatus = 'loaded';
      this.notify();
    } catch (err) {
      this._loadStatus = 'error';
      this._loadError = err instanceof Error ? err : new Error(String(err));
      this.notify();
    }
  }

  async fetchFiles(): Promise<void> {
    if (this._filesInflight) {
      await this._filesInflight;
      return;
    }
    this._filesInflight = this._doFetchFiles().finally(() => {
      this._filesInflight = null;
    });
    await this._filesInflight;
  }

  private async _doFetchFiles(): Promise<void> {
    this._loading = true;
    this.notify();

    if (isElectron()) {
      await this._electronScan();
      this._loading = false;
      this.notify();
      return;
    }

    // Fire stats and IDB read in parallel — both add 50–300 ms each, and
    // the cached snapshot is independent of the stats response (we just
    // validate its signature after). On a warm load both finish in roughly
    // the time of the slower one instead of summing.
    const [stats, cachedSnapshot] = await Promise.all([
      this.apiFetch<DatabankStats>('/api/databank/stats'),
      libraryCache.getRaw(),
    ]);
    if (stats) {
      this._stats = stats;
      this._persistStats();
    }

    if (stats) {
      const signature = libraryCache.signatureFor(stats);
      // Already loaded the right signature in memory — nothing to do.
      if (this._filesComplete && this._filesSignature === signature) {
        this._loading = false;
        this.notify();
        return;
      }
      if (cachedSnapshot && cachedSnapshot.signature === signature) {
        log.scan.log(`Library cache hit (${cachedSnapshot.files.length} files, sig ${signature})`);
        this._setFiles(cachedSnapshot.files, { complete: true, signature });
        this._loading = false;
        this.notify();
        return;
      }
    }

    const data = await this.apiFetch<DatabankFile[]>('/api/databank/files');
    if (data) {
      const signature = stats ? libraryCache.signatureFor(stats) : null;
      this._setFiles(data, { complete: true, signature });
      if (signature) libraryCache.put(signature, data);
    }

    this._loading = false;
    this.notify();
  }

  private _filesByIdsInflight: Promise<void> | null = null;

  /** Fetch only the files referenced by the given IDs. Used for the History
   *  tab fast path so first paint doesn't block on the full 100k-row payload.
   *  Marks `_files` as partial — switching to a full-list view will trigger
   *  `fetchFiles()` to hydrate the remainder.
   *
   *  Coalesced: concurrent callers share the same inflight promise so a
   *  remount during initial load doesn't double-fetch. */
  async fetchFilesByIds(ids: number[]): Promise<void> {
    if (this._filesByIdsInflight) {
      await this._filesByIdsInflight;
      return;
    }
    this._filesByIdsInflight = this._doFetchFilesByIds(ids).finally(() => {
      this._filesByIdsInflight = null;
    });
    await this._filesByIdsInflight;
  }

  private async _doFetchFilesByIds(ids: number[]): Promise<void> {
    if (isElectron() || ids.length === 0) return;
    if (this._filesComplete) return; // already have everything
    const params = new URLSearchParams({ ids: ids.join(',') });
    const data = await this.apiFetch<DatabankFile[]>(`/api/databank/files?${params}`);
    if (!data || data.length === 0) return;
    // Only adopt this partial set if we still don't have the complete list.
    if (this._filesComplete) return;
    this._setFiles(data, { complete: false, signature: null });
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
    const out: DatabankFile[] = [];
    for (const b of detail.bindings) {
      const f = this._filesById.get(b.pdf_file_id);
      if (f) out.push(f);
    }
    return out;
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
      const existing = this._filesById.get(id);
      if (existing) {
        const idx = this._files.indexOf(existing);
        const next = [...this._files];
        next[idx] = { ...existing, ...update };
        // Local edits don't bump the backend's `last_file_scan_at`, so the
        // signature is preserved — patch the cached snapshot in place so
        // the next reload still hits the warm cache instead of paying a
        // full network refetch to recover one changed row.
        this._setFiles(next, { complete: this._filesComplete, signature: this._filesSignature });
        if (this._filesComplete) {
          libraryCache.patchFile(id, update);
        }
        this.notify();
      }
    }
  }

  async toggleDonor(id: number): Promise<void> {
    const file = this._filesById.get(id);
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

  /** Full-text PDF search with optional scope filter.
   *  Returns raw results — caller manages state. Does NOT mutate store
   *  `_searchResults` so the old pdfSearchMode flow is unaffected. */
  async searchPdfs(query: string, scope: 'all' | 'donor' = 'all'): Promise<SearchResult[]> {
    if (!query.trim()) return [];
    const params = new URLSearchParams({ q: query, scope });
    const data = await this.apiFetch<{ results: SearchResult[] }>(`/api/databank/search?${params}`);
    return data?.results ?? [];
  }

  async createBinding(
    boardFileId: number,
    pdfFileId: number,
    category?: string,
    autoOpen?: boolean,
  ): Promise<void> {
    const body: Record<string, unknown> = {
      board_file_id: boardFileId,
      pdf_file_id: pdfFileId,
    };
    if (category !== undefined) body.category = category;
    if (autoOpen !== undefined) body.auto_open = autoOpen;
    await this.apiFetch<{ id: number }>('/api/databank/bindings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async updateBinding(
    id: number,
    patch: { category?: string; auto_open?: boolean },
  ): Promise<void> {
    await this.apiFetch<{ status: string }>(`/api/databank/bindings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
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
      const existing = this._filesById.get(file.id);
      if (existing) {
        const idx = this._files.indexOf(existing);
        const next = [...this._files];
        next[idx] = { ...existing, has_preview: true };
        // Same flag-only update as updateFile — preserve the cache
        // signature and patch the cached snapshot in place so warm reloads
        // still skip the network round-trip.
        this._setFiles(next, { complete: this._filesComplete, signature: this._filesSignature });
        if (this._filesComplete) libraryCache.patchFile(file.id, { has_preview: true });
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
    if (data) { this._stats = data; this._persistStats(); this.notify(); }
  }

  async resetAll(): Promise<boolean> {
    const res = await this.apiFetch<{ status: string }>('/api/databank/reset', { method: 'POST' });
    if (res) {
      log.scan.log('Database reset complete');
      this._setFiles([], { complete: false, signature: null });
      this._folderTree = null; this._scanStatus = null; this._stats = null;
      libraryCache.clear();
      try {
        localStorage.removeItem('boardripper-scan-status');
        localStorage.removeItem('boardripper-stats');
      } catch { /* ignored */ }
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
    this._recentItems = this._trimHistoryRespectingFavorites(this._recentItems);
    try { localStorage.setItem('boardripper-history', JSON.stringify(this._recentItems)); } catch { /* ignore */ }
    this.notify();
  }

  /** The historyDepth cap applies only to non-favorite entries — pinned
   *  items are explicit user intent and shouldn't silently fall off. Returns
   *  a new array preserving original order, with non-favorites trimmed. */
  private _trimHistoryRespectingFavorites(items: RecentItem[]): RecentItem[] {
    let nonFavCount = 0;
    const out: RecentItem[] = [];
    for (const item of items) {
      if (this._favoritePaths.has(item.path)) {
        out.push(item);
        continue;
      }
      if (nonFavCount >= this._historyDepth) continue;
      out.push(item);
      nonFavCount++;
    }
    return out;
  }

  clearHistory() {
    this._recentItems = [];
    try { localStorage.removeItem('boardripper-history'); } catch { /* ignore */ }
    this.notify();
  }

  setHistoryDepth(n: number) {
    this._historyDepth = Math.min(100, Math.max(1, n));
    const trimmed = this._trimHistoryRespectingFavorites(this._recentItems);
    if (trimmed.length !== this._recentItems.length) {
      this._recentItems = trimmed;
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
    const res = await fetchWithCloudRetry(
      `/api/files/path/${encodeURIComponent(file.path)}`,
      undefined,
      {
        label: file.filename,
        onRetry: (attempt) => {
          // First retry only — subsequent waits are implied. The toast
          // self-dismisses after a few seconds so the user doesn't get
          // a stack of them on long retries.
          if (attempt === 2) {
            boardStore.addToast(`Downloading "${file.filename}" from cloud storage…`, 'info');
          }
        },
      },
    );
    if (!res.ok) {
      if (res.status === 503) {
        const { code, message } = await readCloudError(res);
        boardStore.addToast(formatCloudErrorToast(file.filename, code, message), 'error');
        throw new Error(`HTTP 503${code ? ` (${code})` : ''}`);
      }
      throw new Error(`HTTP ${res.status}`);
    }
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
    this._setFiles(result.files, { complete: true, signature: null });
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

// Expose for integration tests (Playwright) — DEV builds only, eliminated
// by Vite's tree-shaking in production.
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __databankStore?: typeof databankStore }).__databankStore = databankStore;
}
