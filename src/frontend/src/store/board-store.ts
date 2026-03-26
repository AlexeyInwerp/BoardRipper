import type { BoardData, Part, Pin } from '../parsers';
import { boardCache } from './board-cache';
import { parseBoardFile, getFormat } from '../parsers';
import { log } from './log-store';
import { createLayerStates } from './layer-store';
import type { LayerState } from './layer-store';

export type BoardStoreListener = () => void;

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
  /** Per-layer visibility and color state (multi-layer boards only) */
  layerStates: LayerState[];
  pdfFileNames: string[];  // references into pdfFiles registry (1:N)
}

export interface PdfEntry {
  file: File;
  /** Board tab IDs this PDF is bound to (empty = unbound) */
  boundTabIds: Set<number>;
}

export interface FocusRequest {
  partIndex: number;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const emptySelection: SelectionState = { partIndex: null, pinIndex: null, highlightedNet: null };

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

class BoardStore {
  private _tabs: BoardTab[] = [];
  private _activeTabId: number | null = null;
  private _focusRequest: FocusRequest | null = null;
  private _pdfFiles: Map<string, PdfEntry> = new Map();
  private _listeners = new Set<BoardStoreListener>();
  /** Callback fired when a new board tab is created (tabId, fileName) */
  onTabCreated: ((tabId: number, fileName: string) => void) | null = null;
  /** Callback fired when a board tab is closed (tabId) */
  onTabClosed: ((tabId: number) => void) | null = null;

  get tabs(): BoardTab[] { return this._tabs; }
  get activeTabId(): number | null { return this._activeTabId; }
  get pdfFiles(): Map<string, PdfEntry> { return this._pdfFiles; }

  /** Look up a specific tab by id (for per-panel sidebar use). */
  getTab(tabId: number): BoardTab | null {
    return this._tabs.find(t => t.id === tabId) ?? null;
  }

  private get activeTab(): BoardTab | null {
    return this._tabs.find(t => t.id === this._activeTabId) ?? null;
  }

  get board(): BoardData | null { return this.activeTab?.board ?? null; }
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
  get showVias(): boolean { return this.activeTab?.showVias ?? true; }
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

  subscribe(listener: BoardStoreListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
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
      showVias: true,
      layerStates: [],
      pdfFileNames: [],
      cacheKey: '',
    };

    this._tabs.push(tab);
    this._activeTabId = id;
    this.notify(); // notify immediately so existing renderers know the active tab changed

    try {
      const cached = await boardCache.get(file.name, file.size, file.lastModified);
      if (cached) {
        log.cache.log(`Loaded from cache: ${file.name} (${cached.parts.length} parts, ${cached.nets.size} nets)`);
        tab.board = cached;
        tab.cacheKey = boardCache.makeCacheKey(file.name, file.size, file.lastModified);
        tab.rotation = this.autoRotation(cached);
        if (cached.initialMirrorY) tab.mirrorY = true;
        const cachedFmt = getFormat(cached.format);
        if (cachedFmt?.swapSides) {
          tab.showTop = false;
          tab.showBottom = true;
        }
        if (cached.layerNames) tab.layerStates = createLayerStates(cached.layerNames, cachedFmt?.swapSides ? 'bottom' : 'top');
        this.autoBindBoard(file.name);
        // Create panel AFTER board + rotation are ready so the renderer sees correct state
        this.onTabCreated?.(id, file.name);
        this.notify();
        return;
      }

      log.parser.log(`Parsing: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
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
      tab.rotation = this.autoRotation(board);
      if (board.initialMirrorY) tab.mirrorY = true;
      if (fmt?.swapSides) {
        tab.showTop = false;
        tab.showBottom = true;
      }
      if (board.layerNames) tab.layerStates = createLayerStates(board.layerNames, fmt?.swapSides ? 'bottom' : 'top');

      await boardCache.put(file.name, file.size, file.lastModified, board);

      this.autoBindBoard(file.name);
    } catch (err) {
      log.cache.error(`Failed to load ${file.name}:`, err);
      const idx = this._tabs.indexOf(tab);
      if (idx !== -1) this._tabs.splice(idx, 1);
      if (this._activeTabId === tab.id) {
        this._activeTabId = this._tabs.length > 0 ? this._tabs[this._tabs.length - 1].id : null;
      }
    }

    // Create panel AFTER board + rotation are ready so the renderer sees correct state
    this.onTabCreated?.(id, file.name);
    this.notify();
  }

  private autoRotation(board: BoardData): number {
    const w = board.bounds.maxX - board.bounds.minX;
    const h = board.bounds.maxY - board.bounds.minY;
    if (h <= w) return 0;
    // X-fold boards set initialMirrorY — use 270° so flipY + mirrorY + 270° = correct.
    // All other tall boards use standard 90° rotation.
    return board.initialMirrorY ? 270 : 90;
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
      this.updateActiveTab({ showTop: true, showBottom: false, butterfly: false });
    }
    this.notify();
  }

  selectBottom(both = false) {
    const tab = this.activeTab;
    if (!tab) return;
    if (both) {
      this.updateActiveTab({ showTop: true, showBottom: true, butterfly: false });
    } else {
      this.updateActiveTab({ showTop: false, showBottom: true, butterfly: false });
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
      this.updateActiveTab({ butterfly: false });
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
}

export const boardStore = new BoardStore();
