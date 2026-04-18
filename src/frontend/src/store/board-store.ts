import type { BoardData, BoardRevision, Part, Pin } from '../parsers';
import { Emitter } from './emitter';
import { boardCache } from './board-cache';
import { parseBoardFile, getFormat } from '../parsers';
import { computeBBox, generateSyntheticOutline, detectGhostComponents } from '../parsers/types';
import { log } from './log-store';
import { createLayerStates } from './layer-store';
import type { LayerState } from './layer-store';
import { deriveBoardView } from './derive-board-view';


export interface SelectionState {
  partIndex: number | null;
  pinIndex: number | null;
  highlightedNet: string | null;
}

export interface BoardTab {
  id: number;
  fileName: string;
  board: BoardData | null;
  /** Cache key used to load this board (empty string if loaded fresh from file) */
  cacheKey: string;
  selection: SelectionState;
  showTop: boolean;
  showBottom: boolean;
  butterfly: boolean;
  searchQuery: string;
  rotation: number;
  mirrorX: boolean;
  mirrorY: boolean;
  flipAxis: 'x' | 'y';
  showNetLines: boolean;
  showNetDim: boolean;
  showHoverInfo: boolean;
  followPdf: boolean;
  showTraces: boolean;
  showComponents: boolean;
  showVias: boolean;
  showPins: boolean;
  showOutlines: boolean;
  showLabels: boolean;
  /** Show ghost outlines of hidden-side components when a net is selected */
  showGhosts: boolean;
  /** Per-layer visibility and color state (multi-layer boards only) */
  layerStates: LayerState[];
  pdfFileNames: string[];  // references into pdfFiles registry (1:N)
  /** When true, parts flagged in board.ghosts are filtered from the rendered
   *  parts list. Set via toggleHideGhosts(). Persists across revision switches
   *  on the same tab. */
  hideGhosts: boolean;
  /** XZZ fold resolution. 'suggested' uses the parser's auto-fold output;
   *  'all-sides' renders the raw pre-fold layout (both halves side-by-side). */
  foldMode: 'suggested' | 'all-sides';
  /** XZZ multi-board selection. null = show all boards. An index selects the
   *  group at that position in `board.boardGroups`. */
  selectedBoardIndex: number | null;
  /** Cached presented view of `board` — computed from (board, foldMode,
   *  selectedBoardIndex) via `deriveBoardView`. Invalidated whenever any of
   *  those inputs change. Consumers should read `boardStore.board` (which
   *  returns this) rather than `tab.board` directly. */
  _derivedBoard?: BoardData;
  _derivedBoardKey?: string;
}

export interface PdfEntry {
  file: File;
  /** Board tab IDs this PDF is bound to (empty = unbound) */
  boundTabIds: Set<number>;
}

export interface FocusRequest {
  partIndex: number | null;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const emptySelection: SelectionState = { partIndex: null, pinIndex: null, highlightedNet: null };

/** Compute (or return the cached) derived BoardData for a tab. Re-derives
 *  only when the inputs change so `useSyncExternalStore` gets a stable
 *  reference on unchanged state. */
function ensureDerivedBoard(tab: BoardTab): BoardData | null {
  if (!tab.board) return null;
  const key = `${tab.foldMode}|${tab.selectedBoardIndex ?? 'all'}`;
  if (tab._derivedBoard && tab._derivedBoardKey === key) return tab._derivedBoard;
  tab._derivedBoard = deriveBoardView(tab.board, tab.foldMode, tab.selectedBoardIndex);
  tab._derivedBoardKey = key;
  return tab._derivedBoard;
}
/** Force re-derivation on next read (used after tab.board itself changes). */
function invalidateDerivedBoard(tab: BoardTab): void {
  tab._derivedBoard = undefined;
  tab._derivedBoardKey = undefined;
}

/** Re-calibrate view orientation for the currently-derived board.
 *
 *  When a multi-board selection or fold mode changes, the derived BoardData
 *  can have a very different aspect ratio and fold axis than the raw file.
 *  Re-run the same heuristics `loadFile` uses on first open:
 *
 *  - `rotation` — auto-rotate tall boards so they display wide on screen
 *    (matches `autoRotation` logic on raw-board load).
 *  - `flipAxis` — pick based on the *screen* aspect (after rotation), so
 *    pressing "flip" mirrors along the board's visibly-longest side
 *    regardless of how the file stored the board.
 *  - `mirrorY` / `mirrorX` — match the X-fold → mirrorY=true convention
 *    used for natively-butterfly files.
 */
function syncMirrorsToDerivedFold(tab: BoardTab): void {
  const derived = ensureDerivedBoard(tab);
  if (!derived) return;

  // Auto-rotation matches the loadFile heuristic (inlined to avoid plumbing
  // an instance method through module-level code).
  const w = derived.bounds.maxX - derived.bounds.minX;
  const h = derived.bounds.maxY - derived.bounds.minY;
  let rotation = 0;
  if (h > w) {
    const flipY = derived.flipY ?? getFormat(derived.format)?.flipY ?? false;
    rotation = flipY ? 270 : 90;
  }
  tab.rotation = rotation;

  // Pick flipAxis based on the post-rotation SCREEN aspect:
  //   screen tall  (long side vertical)    → 'x' (hinge is horizontal axis)
  //   screen wide  (long side horizontal)  → 'y' (hinge is vertical axis)
  // The button naming is confusing — 'x' flips scale.y under the hood, which
  // combined with the renderer's axesSwapped logic produces the visible flip
  // along the screen's long side. This matches how natively-butterfly tall
  // files appear on first load (default flipAxis='x' is correct for them
  // because their post-rotation aspect is wide, and the 'x' setting plus
  // 270° rotation yields the expected left-right flip on screen).
  const rot90 = Math.round(rotation / 90) % 4;
  const axesSwapped = rot90 === 1 || rot90 === 3;
  const screenW = axesSwapped ? h : w;
  const screenH = axesSwapped ? w : h;
  tab.flipAxis = screenH > screenW ? 'x' : 'y';

  const axis = derived.butterflyFoldAxis ?? null;
  tab.mirrorY = axis === 'x';
  tab.mirrorX = axis === 'y';
}

/** Extract a "820-XXXXX" board code (5 digits) from a file name, or null if absent. */
function extract820Code(fileName: string): string | null {
  const m = fileName.match(/820-(\d{5})/i);
  return m ? m[1] : null;
}

function findBestNameMatch(source: string, candidates: string[]): string | null {
  const srcCode = extract820Code(source);
  if (srcCode !== null) {
    // Strict mode: only bind when the 820-XXXXX code matches exactly.
    return candidates.find(c => extract820Code(c) === srcCode) ?? null;
  }
  // No 820-XXXXX pattern — do not auto-bind.
  return null;
}

let nextTabId = 1;

/* ── Persistent view preferences ── */
const VIEW_PREFS_KEY = 'boardripper-view-prefs';

interface ViewPrefs {
  showNetLines: boolean;
  showNetDim: boolean;
  showHoverInfo: boolean;
  followPdf: boolean;
}

const DEFAULT_VIEW_PREFS: ViewPrefs = { showNetLines: false, showNetDim: true, showHoverInfo: true, followPdf: false };

/**
 * Build a renderable BoardData from a base board + a chosen revision +
 * the current "hide ghosts" state. When hideGhosts is on, ghost-flagged
 * parts are filtered out and bounds/outline are recomputed from the
 * remaining geometry. When off, the revision's full part list is used.
 * Returns a NEW object reference so the renderer's identity check fires.
 */
function buildRenderedBoard(
  base: BoardData,
  rev: BoardRevision,
  hideGhosts: boolean,
): BoardData {
  // Per-revision traces/vias/layerNames override global ones when present
  const traceOverrides: Partial<BoardData> = {};
  if (rev.traces)     traceOverrides.traces = rev.traces;
  if (rev.vias)       traceOverrides.vias = rev.vias;
  if (rev.layerNames) traceOverrides.layerNames = rev.layerNames;

  if (!hideGhosts || rev.ghosts.length === 0) {
    return {
      ...base,
      ...traceOverrides,
      parts: rev.parts,
      bounds: rev.bounds,
      outline: rev.outline,
      nets: rev.nets,
      ghosts: rev.ghosts.length > 0 ? rev.ghosts : undefined,
      activeRevision: rev.index,
    };
  }
  const drop = new Set<number>(rev.ghosts.map(g => g.partIndex));
  const filteredParts: Part[] = [];
  for (let i = 0; i < rev.parts.length; i++) {
    if (!drop.has(i)) filteredParts.push(rev.parts[i]);
  }
  const allPoints = filteredParts.flatMap(p => p.pins.map(pin => pin.position));
  const outline = generateSyntheticOutline(allPoints);
  const bounds = computeBBox([...outline, ...allPoints]);
  return {
    ...base,
    ...traceOverrides,
    parts: filteredParts,
    bounds,
    outline,
    nets: rev.nets,
    ghosts: rev.ghosts,
    activeRevision: rev.index,
  };
}

/** Synthesize a BoardRevision from a single-revision board so that
 *  buildRenderedBoard can run uniformly for files without revisions[]. */
function syntheticRevisionFromBoard(b: BoardData): BoardRevision {
  return {
    index: 1,
    label: 'rev 1',
    componentCount: b.parts.length,
    parts: b.parts,
    bounds: b.bounds,
    outline: b.outline,
    nets: b.nets,
    ghosts: b.ghosts ?? detectGhostComponents(b.parts),
  };
}

function loadViewPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) return { ...DEFAULT_VIEW_PREFS, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...DEFAULT_VIEW_PREFS };
}

function saveViewPrefs(p: ViewPrefs) {
  try { localStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export interface Toast {
  id: number;
  message: string;
  type: 'error' | 'info';
  timestamp: number;
}

class BoardStore extends Emitter {
  private _tabs: BoardTab[] = [];
  private _activeTabId: number | null = null;
  private _focusRequest: FocusRequest | null = null;
  private _pdfFiles: Map<string, PdfEntry> = new Map();
  private _toasts: Toast[] = [];
  private _nextToastId = 1;
  /** Guard against concurrent loadFile calls for the same file */
  private _loading = new Set<string>();
  /** Original File objects for currently-open board tabs, keyed by fileName.
   *  Kept so "reparse current board" can re-read the raw bytes without
   *  re-prompting the user. Cleared when a tab closes. File references are
   *  cheap Blob handles — memory cost is negligible. */
  private _openFiles: Map<string, File> = new Map();
  /** Callback fired when a new board tab is created (tabId, fileName) */
  onTabCreated: ((tabId: number, fileName: string) => void) | null = null;
  /** Callback fired when a board tab is closed (tabId) */
  onTabClosed: ((tabId: number) => void) | null = null;

  get tabs(): BoardTab[] { return this._tabs; }
  get activeTabId(): number | null { return this._activeTabId; }
  get pdfFiles(): Map<string, PdfEntry> { return this._pdfFiles; }
  get toasts(): Toast[] { return this._toasts; }

  addToast(message: string, type: 'error' | 'info' = 'error') {
    const toast: Toast = { id: this._nextToastId++, message, type, timestamp: Date.now() };
    this._toasts = [...this._toasts, toast];
    this.notify();
    setTimeout(() => this.dismissToast(toast.id), 6000);
  }

  dismissToast(id: number) {
    const next = this._toasts.filter(t => t.id !== id);
    if (next.length !== this._toasts.length) {
      this._toasts = next;
      this.notify();
    }
  }

  /** Look up a specific tab by id (for per-panel sidebar use). */
  getTab(tabId: number): BoardTab | null {
    return this._tabs.find(t => t.id === tabId) ?? null;
  }

  get activeTab(): BoardTab | null {
    return this._tabs.find(t => t.id === this._activeTabId) ?? null;
  }

  get board(): BoardData | null {
    const tab = this.activeTab;
    if (!tab?.board) return null;
    return ensureDerivedBoard(tab);
  }
  /** Untransformed board as emitted by the parser. Most code should use
   *  `board` (the derived view) instead — this exists only for places that
   *  genuinely need the full parts array (e.g. serialising the cache). */
  get rawBoard(): BoardData | null { return this.activeTab?.board ?? null; }
  get fileName(): string { return this.activeTab?.fileName ?? ''; }
  get selection(): SelectionState { return this.activeTab?.selection ?? emptySelection; }
  get showTop(): boolean { return this.activeTab?.showTop ?? true; }
  get showBottom(): boolean { return this.activeTab?.showBottom ?? true; }
  get butterfly(): boolean { return this.activeTab?.butterfly ?? false; }
  get searchQuery(): string { return this.activeTab?.searchQuery ?? ''; }
  get rotation(): number { return this.activeTab?.rotation ?? 0; }
  get mirrorX(): boolean { return this.activeTab?.mirrorX ?? false; }
  get mirrorY(): boolean { return this.activeTab?.mirrorY ?? false; }
  get flipAxis(): 'x' | 'y' { return this.activeTab?.flipAxis ?? 'x'; }
  get showNetLines(): boolean { return this.activeTab?.showNetLines ?? false; }
  get showTraces(): boolean { return this.activeTab?.showTraces ?? true; }
  get showComponents(): boolean { return this.activeTab?.showComponents ?? true; }
  get showVias(): boolean { return this.activeTab?.showVias ?? false; }
  get showPins(): boolean { return this.activeTab?.showPins ?? true; }
  get showOutlines(): boolean { return this.activeTab?.showOutlines ?? true; }
  get showLabels(): boolean { return this.activeTab?.showLabels ?? true; }
  get showGhosts(): boolean { return this.activeTab?.showGhosts ?? true; }
  get hideGhosts(): boolean { return this.activeTab?.hideGhosts ?? false; }
  get foldMode(): 'suggested' | 'all-sides' { return this.activeTab?.foldMode ?? 'suggested'; }
  get selectedBoardIndex(): number | null { return this.activeTab?.selectedBoardIndex ?? null; }
  get layerStates(): LayerState[] { return this.activeTab?.layerStates ?? []; }
  get showNetDim(): boolean { return this.activeTab?.showNetDim ?? true; }
  get showHoverInfo(): boolean { return this.activeTab?.showHoverInfo ?? true; }
  get followPdf(): boolean { return this.activeTab?.followPdf ?? false; }

  /** All PDF Files bound to the active board tab */
  get boundPdfFiles(): File[] {
    const names = this.activeTab?.pdfFileNames ?? [];
    return names
      .map(n => this._pdfFiles.get(n)?.file)
      .filter((f): f is File => f != null);
  }

  /** All PDF filenames currently loaded */
  get pdfFileNames(): string[] {
    return [...this._pdfFiles.keys()];
  }

  /** Add a PDF to the registry. Does NOT bind it to any tab. */
  addPdf(file: File) {
    if (!this._pdfFiles.has(file.name)) {
      this._pdfFiles.set(file.name, { file, boundTabIds: new Set() });
    }
  }

  /** Add a PDF binding to the active board tab (appends, doesn't replace) */
  bindPdf(pdfFileName: string) {
    const tab = this.activeTab;
    if (!tab) return;
    this.addPdfBinding(tab.id, pdfFileName);
  }

  /** Add a PDF binding to a specific board tab (appends if not already bound) */
  addPdfBinding(tabId: number, pdfFileName: string) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.pdfFileNames.includes(pdfFileName)) return; // already bound

    tab.pdfFileNames.push(pdfFileName);
    const entry = this._pdfFiles.get(pdfFileName);
    if (entry) entry.boundTabIds.add(tab.id);
    this.notify();
  }

  /** Remove a specific PDF binding from a board tab */
  removePdfBinding(tabId: number, pdfFileName: string) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    const idx = tab.pdfFileNames.indexOf(pdfFileName);
    if (idx === -1) return;

    tab.pdfFileNames.splice(idx, 1);
    const entry = this._pdfFiles.get(pdfFileName);
    if (entry) entry.boundTabIds.delete(tab.id);
    this.notify();
  }

  /** Clear all PDF bindings from a board tab */
  clearPdfBindings(tabId: number) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    for (const name of tab.pdfFileNames) {
      const entry = this._pdfFiles.get(name);
      if (entry) entry.boundTabIds.delete(tab.id);
    }
    tab.pdfFileNames = [];
    this.notify();
  }

  /** Toggle a PDF binding on a board tab (add if missing, remove if present) */
  togglePdfBinding(tabId: number, pdfFileName: string) {
    const tab = this._tabs.find(t => t.id === tabId);
    if (!tab) return;
    if (tab.pdfFileNames.includes(pdfFileName)) {
      this.removePdfBinding(tabId, pdfFileName);
    } else {
      this.addPdfBinding(tabId, pdfFileName);
    }
  }

  /** Remove a PDF from the registry and unbind from all tabs */
  removePdf(pdfFileName: string) {
    const entry = this._pdfFiles.get(pdfFileName);
    if (!entry) return;
    for (const tab of this._tabs) {
      const idx = tab.pdfFileNames.indexOf(pdfFileName);
      if (idx !== -1) tab.pdfFileNames.splice(idx, 1);
    }
    this._pdfFiles.delete(pdfFileName);
    this.notify();
  }

  /** Bind a newly-opened PDF: name-match first, fall back to the active tab */
  autoBindPdf(pdfFileName: string) {
    const matchName = findBestNameMatch(pdfFileName, this._tabs.map(t => t.fileName));
    const tab = (matchName && this._tabs.find(t => t.fileName === matchName)) ?? this.activeTab;
    if (tab && !tab.pdfFileNames.includes(pdfFileName)) {
      tab.pdfFileNames.push(pdfFileName);
      const entry = this._pdfFiles.get(pdfFileName);
      if (entry) entry.boundTabIds.add(tab.id);
      this.notify();
    }
  }

  /** Try to auto-bind a board tab to an existing PDF by partial filename match */
  autoBindBoard(boardFileName: string) {
    const tab = this._tabs.find(t => t.fileName === boardFileName);
    if (!tab) return;
    const pdfNames = [...this._pdfFiles.keys()];
    const match = findBestNameMatch(boardFileName, pdfNames);
    if (match && !tab.pdfFileNames.includes(match)) {
      tab.pdfFileNames.push(match);
      const entry = this._pdfFiles.get(match);
      if (entry) entry.boundTabIds.add(tab.id);
      this.notify();
    }
  }

  get selectedPart(): Part | null {
    const tab = this.activeTab;
    if (tab && tab.board && tab.selection.partIndex !== null) {
      return tab.board.parts[tab.selection.partIndex] ?? null;
    }
    return null;
  }

  get selectedPin(): Pin | null {
    const part = this.selectedPart;
    const tab = this.activeTab;
    if (part && tab && tab.selection.pinIndex !== null) {
      return part.pins[tab.selection.pinIndex] ?? null;
    }
    return null;
  }

  private updateActiveTab(patch: Partial<BoardTab>) {
    const tab = this.activeTab;
    if (!tab) return;
    Object.assign(tab, patch);
  }

  async loadFile(file: File) {
    const existing = this._tabs.find(t => t.fileName === file.name);
    if (existing) {
      this._activeTabId = existing.id;
      this.notify();
      return;
    }

    // Guard against concurrent loads of the same file
    if (this._loading.has(file.name)) return;
    this._loading.add(file.name);

    try {
      const id = nextTabId++;
      const vp = loadViewPrefs();
      const tab: BoardTab = {
        id,
        fileName: file.name,
        board: null,
        selection: { ...emptySelection },
        showTop: true,
        showBottom: false,
        butterfly: false,
        searchQuery: '',
        rotation: 0,
        mirrorX: false,
        mirrorY: false,
        flipAxis: 'x',
        showNetLines: vp.showNetLines,
        showNetDim: vp.showNetDim,
        showHoverInfo: vp.showHoverInfo,
        followPdf: vp.followPdf,
        showTraces: true,
        showComponents: true,
        showVias: false,
        showPins: true,
        showOutlines: true,
        showLabels: true,
        showGhosts: true,
        layerStates: [],
        pdfFileNames: [],
        cacheKey: '',
        hideGhosts: false,
        foldMode: 'suggested',
        selectedBoardIndex: null,
      };

      this._tabs.push(tab);
      this._activeTabId = id;
      this.notify(); // notify immediately so existing renderers know the active tab changed

      try {
        this._openFiles.set(file.name, file);
        const cached = await boardCache.get(file.name, file.size, file.lastModified);
        if (cached) {
          log.cache.log(`Loaded from cache: ${file.name} (${cached.parts.length} parts, ${cached.nets.size} nets)`);
          tab.board = cached;
          invalidateDerivedBoard(tab);
          tab.cacheKey = boardCache.makeCacheKey(file.name, file.size, file.lastModified);
          tab.rotation = this.autoRotation(cached);
          if (cached.butterflyFoldAxis === 'x') tab.mirrorY = true;
          const cachedFmt = getFormat(cached.format);
          // Initial side = user's perception of "top". For inverted files
          // (primarySide='bottom'), the user's "Top" button is mapped to the
          // file's side='bottom' in selectTop, so set showBottom=true on open.
          const wantsBottomOnOpen = cachedFmt?.swapSides || cached.primarySide === 'bottom';
          if (wantsBottomOnOpen) {
            tab.showTop = false;
            tab.showBottom = true;
          }
          if (cached.layerNames) tab.layerStates = createLayerStates(cached.layerNames, wantsBottomOnOpen ? 'bottom' : 'top');
          this.autoBindBoard(file.name);
          // Create panel AFTER board + rotation are ready so the renderer sees correct state
          this.onTabCreated?.(id, file.name);
          this.notify();
          return;
        }

        log.parser.log(`Parsing: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
        this._openFiles.set(file.name, file);
        const t0 = performance.now();
        const buffer = await file.arrayBuffer();
        const board = await parseBoardFile(buffer, file.name);
        const elapsed = (performance.now() - t0).toFixed(0);
        log.parser.log(`Parsed OK in ${elapsed}ms: format=${board.format}, parts=${board.parts.length}, nets=${board.nets.size}, outline=${board.outline.length} pts`);

        // Log side detection summary
        const fmt = getFormat(board.format);
        const topParts = board.parts.filter(p => p.side === 'top').length;
        const botParts = board.parts.filter(p => p.side === 'bottom').length;
        const topNails = board.nails.filter(n => n.side === 'top').length;
        const botNails = board.nails.filter(n => n.side === 'bottom').length;
        const topTP = board.parts.filter(p => p.side === 'top' && p.pins.length === 1).length;
        const botTP = board.parts.filter(p => p.side === 'bottom' && p.pins.length === 1).length;
        log.parser.log(
          `Side detection: top=${topParts} parts/${topNails} nails, bottom=${botParts} parts/${botNails} nails` +
          (topTP + botTP > 0 ? `, testpoints=${topTP}T/${botTP}B` : '') +
          (fmt?.flipY ? ', flipY=ON' : '') +
          (fmt?.swapSides ? ', swapSides=ON' : ''),
        );

        tab.board = board;
        invalidateDerivedBoard(tab);
        tab.rotation = this.autoRotation(board);
        if (board.butterflyFoldAxis === 'x') tab.mirrorY = true;
        const wantsBottomOnOpen = fmt?.swapSides || board.primarySide === 'bottom';
        if (wantsBottomOnOpen) {
          tab.showTop = false;
          tab.showBottom = true;
        }
        if (board.layerNames) tab.layerStates = createLayerStates(board.layerNames, wantsBottomOnOpen ? 'bottom' : 'top');

        await boardCache.put(file.name, file.size, file.lastModified, board);

        this.autoBindBoard(file.name);
      } catch (err) {
        log.parser.error(`Failed to load ${file.name}:`, err);
        const errMsg = err instanceof Error ? err.message : String(err);
        this.addToast(`Failed to load ${file.name}: ${errMsg}`, 'error');
        const idx = this._tabs.indexOf(tab);
        if (idx !== -1) this._tabs.splice(idx, 1);
        if (this._activeTabId === tab.id) {
          this._activeTabId = this._tabs.length > 0 ? this._tabs[this._tabs.length - 1].id : null;
        }
        this.notify();
        return;
      }

      // Create panel AFTER board + rotation are ready so the renderer sees correct state
      this.onTabCreated?.(id, file.name);
      this.notify();
    } finally {
      this._loading.delete(file.name);
    }
  }

  private autoRotation(board: BoardData): number {
    const w = board.bounds.maxX - board.bounds.minX;
    const h = board.bounds.maxY - board.bounds.minY;
    if (h <= w) return 0;
    // 90° + flipY creates a horizontal mirror on tall boards.
    // 270° avoids this for all flipY formats.
    const fmt = getFormat(board.format);
    const flipY = board.flipY ?? fmt?.flipY ?? false;
    return flipY ? 270 : 90;
  }

  async loadFiles(files: FileList | File[]) {
    for (const file of files) {
      await this.loadFile(file);
    }
  }

  /** Evict the cache entry for the given board data (call after a scene build failure). */
  evictCacheForBoard(board: BoardData): void {
    const tab = this._tabs.find(t => t.board === board);
    if (tab?.cacheKey) {
      boardCache.deleteEntry(tab.cacheKey);
      tab.cacheKey = '';
    }
  }

  switchTab(tabId: number) {
    if (this._tabs.some(t => t.id === tabId) && this._activeTabId !== tabId) {
      this._activeTabId = tabId;
      this.notify();
    }
  }

  closeTab(tabId: number) {
    const idx = this._tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    // Unbind all PDFs
    const tab = this._tabs[idx];
    for (const name of tab.pdfFileNames) {
      const entry = this._pdfFiles.get(name);
      if (entry) entry.boundTabIds.delete(tab.id);
    }

    // Clear search cache if it referenced the closed tab's board
    if (this._cachedSearchBoard && tab.board === this._cachedSearchBoard) {
      this._cachedSearchBoard = null;
    }

    // Drop the File reference if no other tab holds it (file names are unique
    // per tab today, but keep the guard in case that changes).
    if (!this._tabs.some(t => t.id !== tabId && t.fileName === tab.fileName)) {
      this._openFiles.delete(tab.fileName);
    }

    this._tabs.splice(idx, 1);
    this.onTabClosed?.(tabId);

    if (this._activeTabId === tabId) {
      if (this._tabs.length > 0) {
        const newIdx = Math.min(idx, this._tabs.length - 1);
        this._activeTabId = this._tabs[newIdx].id;
      } else {
        this._activeTabId = null;
      }
    }
    this.notify();
  }

  selectPart(partIndex: number | null) {
    this.updateActiveTab({
      selection: { partIndex, pinIndex: null, highlightedNet: null },
    });
    this.notify();
  }

  selectPin(partIndex: number, pinIndex: number) {
    const tab = this.activeTab;
    const part = tab?.board?.parts[partIndex];
    const pin = part?.pins[pinIndex];
    this.updateActiveTab({
      selection: { partIndex, pinIndex, highlightedNet: pin?.net || null },
    });
    this.notify();
  }

  highlightNet(netName: string | null) {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({
      selection: { ...tab.selection, highlightedNet: netName },
    });
    this.notify();
  }

  selectTop(both = false) {
    const tab = this.activeTab;
    if (!tab) return;
    if (both) {
      this.updateActiveTab({ showTop: true, showBottom: true, butterfly: false });
    } else {
      // When the board's primarySide is 'bottom', the file labels sides inverted
      // relative to the user's expectation. The user pressing "Top" wants to see
      // the physical CPU side, which lives under side='bottom' in the file — so
      // we trigger the bottom-view rendering (scene.root is auto-mirrored there,
      // which correctly un-mirrors the bottom-frame coordinates into physical view).
      const swap = tab.board?.primarySide === 'bottom';
      this.updateActiveTab({
        showTop: swap ? false : true,
        showBottom: swap ? true : false,
        butterfly: false,
      });
    }
    this.notify();
  }

  selectBottom(both = false) {
    const tab = this.activeTab;
    if (!tab) return;
    if (both) {
      this.updateActiveTab({ showTop: true, showBottom: true, butterfly: false });
    } else {
      const swap = tab.board?.primarySide === 'bottom';
      this.updateActiveTab({
        showTop: swap ? true : false,
        showBottom: swap ? false : true,
        butterfly: false,
      });
    }
    this.notify();
  }

  toggleButterfly() {
    const tab = this.activeTab;
    if (!tab) return;
    // Butterfly mode is not supported for multi-layer boards (stacked layers)
    if (tab.board?.layerNames && tab.board.layerNames.length > 0) return;
    const newButterfly = !tab.butterfly;
    if (newButterfly) {
      this.updateActiveTab({ butterfly: true, showTop: true, showBottom: true });
    } else {
      this.updateActiveTab({ butterfly: false, showTop: true, showBottom: false });
    }
    this.notify();
  }

  rotateCW() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: (tab.rotation + 90) % 360 });
    this.notify();
  }

  rotateCCW() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: (tab.rotation + 270) % 360 });
    this.notify();
  }

  /** Set arbitrary rotation in degrees (from trackpad gesture or other free input). */
  /**
   * Switch the active board to a different revision (multi-revision .cad
   * files only). Builds a new BoardData object reference so that the
   * renderer's reference-equality check fires and a fresh scene is built.
   * Selection is reset because part/pin indices change between revisions.
   */
  setActiveRevision(index: number) {
    const tab = this.activeTab;
    if (!tab || !tab.board || !tab.board.revisions) return;
    const target = tab.board.revisions.find(r => r.index === index);
    if (!target) return;
    if (tab.board.activeRevision === index && !tab.hideGhosts) return;
    tab.board = buildRenderedBoard(tab.board, target, tab.hideGhosts);
    invalidateDerivedBoard(tab);
    tab.selection = emptySelection;
    tab.searchQuery = '';
    this.notify();
  }

  /**
   * Toggle whether parts flagged as suspicious overlaps (board.ghosts) are
   * hidden from the rendered parts list. Rebuilds the BoardData reference
   * so the renderer picks up the change. Selection resets to avoid dangling
   * indices into the filtered array.
   */
  toggleHideGhosts() {
    const tab = this.activeTab;
    if (!tab || !tab.board) return;
    const next = !tab.hideGhosts;
    tab.hideGhosts = next;
    // Find the current revision (or build from the existing top-level fields
    // for single-revision .cad files where revisions is unset).
    const rev = tab.board.revisions?.find(r => r.index === tab.board?.activeRevision)
      ?? syntheticRevisionFromBoard(tab.board);
    tab.board = buildRenderedBoard(tab.board, rev, next);
    invalidateDerivedBoard(tab);
    tab.selection = emptySelection;
    this.notify();
  }

  setFoldMode(mode: 'suggested' | 'all-sides'): void {
    const tab = this.activeTab;
    if (!tab || tab.foldMode === mode) return;
    this.updateActiveTab({ foldMode: mode });
    invalidateDerivedBoard(tab);
    // Clear any stale selection so it doesn't point at a now-hidden part.
    tab.selection = { ...emptySelection };
    // NOTE: we deliberately do NOT call `syncMirrorsToDerivedFold` here.
    // For butterfly files (1 detected board) toggling fold mode flips
    // between the parser's pre-folded view and the raw side-by-side view,
    // but the user's preferred screen orientation (rotation/mirrorY/flipAxis)
    // shouldn't change with that toggle — the load-time defaults remain
    // correct. Only selection changes warrant a full orientation re-sync.
    this.requestFitDerivedBoard(tab);
    this.notify();
  }

  setSelectedBoardIndex(idx: number | null): void {
    const tab = this.activeTab;
    if (!tab || tab.selectedBoardIndex === idx) return;
    this.updateActiveTab({ selectedBoardIndex: idx });
    invalidateDerivedBoard(tab);
    tab.selection = { ...emptySelection };
    syncMirrorsToDerivedFold(tab);
    this.requestFitDerivedBoard(tab);
    this.notify();
  }

  /** Ask the renderer (on its next onBoardUpdate) to fit the derived board
   *  into view. Uses the existing focus-request plumbing: the renderer picks
   *  it up and calls zoomToBounds which fits and centers. Prevents the
   *  post-selection viewport from ending up stranded where the previous
   *  all-boards view used to show a different board — and also gives the
   *  flip-preservation math a sane starting point (centered inside the
   *  new derived bounds). */
  private requestFitDerivedBoard(tab: BoardTab): void {
    const derived = ensureDerivedBoard(tab);
    if (!derived) return;
    this._focusRequest = { partIndex: null, bounds: { ...derived.bounds } };
  }

  // ── Cache control actions ────────────────────────────────────────────
  //
  // Scoped reset operations exposed to the UI. Each one targets a specific
  // cache layer so the user can pick the minimum they need rather than
  // wiping the whole database.

  /** Re-parse the active tab's board from its original File bytes. Deletes
   *  its IDB cache entry first, then runs parseBoardFile and swaps the new
   *  BoardData into tab.board (new reference → renderer auto-rebuilds).
   *  Selection/search reset. Most common reset: "I just updated the parser,
   *  show me the effect on this board." Returns false if no active tab or
   *  the original File reference was lost (e.g. after a full page reload). */
  async reparseActiveBoard(): Promise<boolean> {
    const tab = this.activeTab;
    if (!tab) return false;
    const file = this._openFiles.get(tab.fileName);
    if (!file) {
      log.cache.error(`reparse: no File reference for ${tab.fileName}`);
      this.addToast(`Cannot re-parse ${tab.fileName} — original file not in memory. Drag-and-drop it again.`, 'error');
      return false;
    }
    try {
      await boardCache.deleteEntry(boardCache.makeCacheKey(file.name, file.size, file.lastModified));
      log.parser.log(`Re-parsing ${file.name}…`);
      const t0 = performance.now();
      const buffer = await file.arrayBuffer();
      const board = await parseBoardFile(buffer, file.name);
      log.parser.log(`Re-parsed in ${(performance.now() - t0).toFixed(0)}ms`);
      tab.board = board;
      invalidateDerivedBoard(tab);
      tab.selection = emptySelection;
      tab.searchQuery = '';
      await boardCache.put(file.name, file.size, file.lastModified, board);
      this.notify();
      return true;
    } catch (err) {
      log.parser.error(`Re-parse failed for ${tab.fileName}:`, err);
      this.addToast(`Re-parse failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return false;
    }
  }

  /** Clear ALL cached parsed boards (IDB boards store) and re-parse every
   *  currently-open tab from its original File. Useful after a parser fix
   *  that affects multiple formats. PDF caches are left alone. */
  async resetBoardCaches(): Promise<void> {
    await boardCache.clear();
    log.cache.log('Board cache cleared');
    let reparsed = 0;
    let skipped = 0;
    for (const tab of this._tabs) {
      const file = this._openFiles.get(tab.fileName);
      if (!file) { skipped++; continue; }
      try {
        const buffer = await file.arrayBuffer();
        const board = await parseBoardFile(buffer, file.name);
        tab.board = board;
        invalidateDerivedBoard(tab);
        tab.selection = emptySelection;
        tab.searchQuery = '';
        await boardCache.put(file.name, file.size, file.lastModified, board);
        reparsed++;
      } catch (err) {
        log.parser.error(`Re-parse failed for ${tab.fileName}:`, err);
      }
    }
    log.cache.log(`Re-parsed ${reparsed} open tab(s)${skipped ? `, skipped ${skipped} (no File ref)` : ''}`);
    this.addToast(
      reparsed > 0
        ? `Re-parsed ${reparsed} open board${reparsed === 1 ? '' : 's'}.`
        : 'Board cache cleared.',
      'info',
    );
    this.notify();
  }

  /** Clear all PDF-related caches: IDB pdf-text store, in-memory tile
   *  bitmap cache, glyph/font cache, and per-document watermark skip
   *  sets. Board caches are left alone. */
  async resetPdfCaches(): Promise<void> {
    const { pdfStore } = await import('./pdf-store');
    const { invalidateTileCache } = await import('../pdf/tile-manager');
    const { clearFontCache } = await import('../pdf/glyph-extractor');
    await boardCache.clearPdfText();
    invalidateTileCache();
    clearFontCache();
    pdfStore.invalidateWatermarkSkipSets();
    log.cache.log('PDF caches cleared');
    this.addToast('PDF caches cleared.', 'info');
    this.notify();
  }

  setRotationFree(degrees: number) {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: ((degrees % 360) + 360) % 360 });
    this.notify();
  }

  flipHorizontal() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ mirrorX: !tab.mirrorX });
    this.notify();
  }

  flipVertical() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ mirrorY: !tab.mirrorY });
    this.notify();
  }

  toggleFlipAxis() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ flipAxis: tab.flipAxis === 'x' ? 'y' : 'x' });
    this.notify();
  }

  private _saveCurrentViewPrefs() {
    const tab = this.activeTab;
    if (!tab) return;
    saveViewPrefs({ showNetLines: tab.showNetLines, showNetDim: tab.showNetDim, showHoverInfo: tab.showHoverInfo, followPdf: tab.followPdf });
  }

  toggleNetLines() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showNetLines: !tab.showNetLines });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  toggleTraces() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showTraces: !tab.showTraces });
    this.notify();
  }

  toggleComponents() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showComponents: !tab.showComponents });
    this.notify();
  }

  toggleVias() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showVias: !tab.showVias });
    this.notify();
  }

  togglePins() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showPins: !tab.showPins });
    this.notify();
  }

  toggleOutlines() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showOutlines: !tab.showOutlines });
    this.notify();
  }

  toggleLabels() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showLabels: !tab.showLabels });
    this.notify();
  }

  toggleGhosts() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showGhosts: !tab.showGhosts });
    this.notify();
  }

  toggleLayer(layerIndex: number) {
    const tab = this.activeTab;
    if (!tab || layerIndex < 0 || layerIndex >= tab.layerStates.length) return;
    const states = [...tab.layerStates];
    states[layerIndex] = { ...states[layerIndex], visible: !states[layerIndex].visible };
    this.updateActiveTab({ layerStates: states });
    this.notify();
  }

  /** Toggle all trace layers on or off. If any are visible, turn all off; otherwise all on. */
  toggleAllLayers() {
    const tab = this.activeTab;
    if (!tab || tab.layerStates.length === 0) return;
    const anyVisible = tab.layerStates.some(l => l.visible);
    const states = tab.layerStates.map(l => ({ ...l, visible: !anyVisible }));
    this.updateActiveTab({ layerStates: states });
    this.notify();
  }

  setLayerColor(layerIndex: number, color: number) {
    const tab = this.activeTab;
    if (!tab || layerIndex < 0 || layerIndex >= tab.layerStates.length) return;
    const states = [...tab.layerStates];
    states[layerIndex] = { ...states[layerIndex], color };
    this.updateActiveTab({ layerStates: states });
    this.notify();
  }

  toggleNetDim() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showNetDim: !tab.showNetDim });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  toggleHoverInfo() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showHoverInfo: !tab.showHoverInfo });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  toggleFollowPdf() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ followPdf: !tab.followPdf });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  setSearch(query: string) {
    this.updateActiveTab({ searchQuery: query });
    this.notify();
  }

  // Cached search results — recomputed only when query or board changes
  private _cachedSearchQuery = '';
  private _cachedSearchBoard: BoardData | null = null;
  private _cachedSearchResults: Part[] = [];
  private _cachedSearchIndices: Set<number> = new Set();

  private _recomputeSearch() {
    const tab = this.activeTab;
    const q = tab?.searchQuery ?? '';
    const board = tab?.board ?? null;
    if (q === this._cachedSearchQuery && board === this._cachedSearchBoard) return;
    this._cachedSearchQuery = q;
    this._cachedSearchBoard = board;
    if (!board || !q) {
      this._cachedSearchResults = [];
      this._cachedSearchIndices = new Set();
      return;
    }
    const ql = q.toLowerCase();
    const results: Part[] = [];
    const indices = new Set<number>();
    for (let i = 0; i < board.parts.length; i++) {
      const p = board.parts[i];
      if (p.name.toLowerCase().includes(ql) ||
          p.pins.some(pin => pin.net.toLowerCase().includes(ql))) {
        results.push(p);
        indices.add(i);
      }
    }
    this._cachedSearchResults = results;
    this._cachedSearchIndices = indices;
  }

  get searchResults(): Part[] {
    this._recomputeSearch();
    return this._cachedSearchResults;
  }

  /** Part indices matching the current search query (for renderer highlighting). */
  get searchResultIndices(): Set<number> {
    this._recomputeSearch();
    return this._cachedSearchIndices;
  }

  /** Compute search results for a specific tab (used by per-panel sidebars). */
  searchForTab(tabId: number): Part[] {
    const tab = this.getTab(tabId);
    if (!tab?.board || !tab.searchQuery) return [];
    const ql = tab.searchQuery.toLowerCase();
    return tab.board.parts.filter(p =>
      p.name.toLowerCase().includes(ql) ||
      p.pins.some(pin => pin.net.toLowerCase().includes(ql))
    );
  }

  get focusRequest(): FocusRequest | null { return this._focusRequest; }

  consumeFocusRequest(): FocusRequest | null {
    const req = this._focusRequest;
    this._focusRequest = null;
    return req;
  }

  focusPart(name: string) {
    const tab = this.activeTab;
    if (!tab?.board) return;
    const upper = name.toUpperCase();
    const idx = tab.board.parts.findIndex(p => p.name.toUpperCase() === upper);
    if (idx < 0) return;

    const part = tab.board.parts[idx];

    // If the part is on the other side and we're not in butterfly mode, flip to it
    if (!tab.butterfly) {
      if (part.side === 'top' && !tab.showTop) {
        this.updateActiveTab({ showTop: true, showBottom: false });
      } else if (part.side === 'bottom' && !tab.showBottom) {
        this.updateActiveTab({ showTop: false, showBottom: true });
      }
    }

    this.updateActiveTab({
      selection: { partIndex: idx, pinIndex: null, highlightedNet: null },
    });
    this._focusRequest = { partIndex: idx, bounds: part.bounds };
    this.notify();
  }

  focusNet(name: string) {
    const tab = this.activeTab;
    if (!tab?.board) return;
    // Case-insensitive net lookup — try exact match first, then scan
    let net = tab.board.nets.get(name);
    if (!net) {
      const upper = name.toUpperCase();
      for (const [k, v] of tab.board.nets) {
        if (k.toUpperCase() === upper) { net = v; name = k; break; }
      }
    }
    if (!net || net.pinIndices.length === 0) return;

    // Compute bounding box of all pins on this net
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { partIndex, pinIndex } of net.pinIndices) {
      const pin = tab.board.parts[partIndex]?.pins[pinIndex];
      if (!pin) continue;
      if (pin.position.x < minX) minX = pin.position.x;
      if (pin.position.y < minY) minY = pin.position.y;
      if (pin.position.x > maxX) maxX = pin.position.x;
      if (pin.position.y > maxY) maxY = pin.position.y;
    }
    if (!isFinite(minX)) return;

    // Pad the bounds so a single-pin net doesn't zoom to infinity
    const pad = Math.max(maxX - minX, maxY - minY, 200) * 0.1;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;

    this.updateActiveTab({
      selection: { partIndex: null, pinIndex: null, highlightedNet: name },
    });
    this._focusRequest = { partIndex: null, bounds: { minX, minY, maxX, maxY } };
    this.notify();
  }
}

export const boardStore = new BoardStore();
