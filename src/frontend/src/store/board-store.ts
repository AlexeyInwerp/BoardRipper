import type { BoardData, BoardRevision, Part, Pin } from '../parsers';
import { Emitter } from './emitter';
import { boardCache } from './board-cache';
import { parseBoardFile, getFormat } from '../parsers';
import { FZKeyError } from '../parsers/fz-parser';
import { fzKeyStore } from './fz-key-store';
import { computeBBox, generateSyntheticOutline, detectGhostComponents, computeAdjacentNets, buildNets, flagMechanicalParts } from '../parsers/types';
import { renderSettingsStore, partBridgesHierarchy } from './render-settings';
import { log } from './log-store';
import { createLayerStates } from './layer-store';
import type { LayerState } from './layer-store';
import { deriveBoardView } from './derive-board-view';
import type { FoldMode } from './derive-board-view';


export interface SelectionState {
  partIndex: number | null;
  pinIndex: number | null;
  highlightedNet: string | null;
  /** Nets reachable from `highlightedNet` through 2-pin components, populated
   *  only when `netLineMode === 'chain-adjacent'`. Empty otherwise. Derived
   *  state — recomputed in `highlightNet()` and `cycleNetLineMode()`,
   *  not persisted. */
  adjacentNets: Set<string>;
}

/**
 * Net-line visualization mode. Cycles via the toolbar button:
 *   off            → no connecting lines drawn
 *   star           → lines radiate from the selected pin/part to nearest
 *                    pin on every other part on the net (anchor required)
 *   chain          → greedy minimum-spanning tree across all parts on the
 *                    selected net
 *   chain-adjacent → chain mode + propagate the highlight one hop through
 *                    2-pin components to adjacent nets (drawn in
 *                    `adjacentNetLineColor`); ground nets are skipped,
 *                    power rails terminate (no further recursion)
 */
export type NetLineMode = 'off' | 'star' | 'chain' | 'chain-adjacent';

/** Tri-state ghost-button mode (cycled by GhostsButton):
 *   - 'off'    — no cross-side hint at all
 *   - 'ghosts' — when a net is highlighted, hidden-side parts on that net
 *                draw as cyan ghost outlines
 *   - 'disco'  — same-net parts (both sides) get a red heartbeat halo */
export type GhostMode = 'off' | 'ghosts' | 'disco';

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
  netLineMode: NetLineMode;
  /** When true, nets shared by ≥2 multi-selected parts (the cyan selection
   *  set, typically loaded from a worklist) are highlighted on the canvas.
   *  Connecting net-lines are NOT drawn for these — only an explicitly
   *  selected net gets lines. Toggled from the Worklist "Connections" button. */
  connectionHighlight: boolean;
  dimMode: 'off' | 'dim' | 'darklight';
  showHoverInfo: boolean;
  followPdf: boolean;
  showTraces: boolean;
  showComponents: boolean;
  showVias: boolean;
  showSilkscreen: boolean;
  showPads: boolean;
  /** Show standalone copper pads not bound to any component pin (GND
   *  stitching, power-rail drops, mounting-hole pads). Default OFF — these
   *  visually clutter the board around components but carry no schematic
   *  meaning. Only TVW currently tags pads with `attached`; for other
   *  formats this flag is a no-op. */
  showCopperDrops: boolean;
  showPins: boolean;
  showOutlines: boolean;
  showLabels: boolean;
  /** See [[GhostMode]]. Default `'ghosts'`, persisted per-tab. The boolean
   *  getters `showGhosts` / `discoHighlight` are derived from this. */
  ghostMode: GhostMode;
  /** Per-layer visibility and color state (multi-layer boards only) */
  layerStates: LayerState[];
  /** Layer whose traces are bumped to the top of the z-stack while nothing is
   *  pinned (transient — set by clicking a layer row). null = none. */
  selectedLayerIndex: number | null;
  /** Pinned layer whose traces stay on top regardless of selection. Exactly
   *  one at a time; overrides selectedLayerIndex while set. null = none. */
  fixatedLayerIndex: number | null;
  pdfFileNames: string[];  // references into pdfFiles registry (1:N)
  /** When true, parts flagged in board.ghosts are filtered from the rendered
   *  parts list. Set via toggleHideGhosts(). Persists across revision switches
   *  on the same tab. */
  hideGhosts: boolean;
  /** Per-pair role overrides for the ghost detector. Set entries are pair
   *  signatures `${minIdx}-${maxIdx}` whose role is flipped (the auto-detected
   *  dominator is treated as the stale one and vice-versa). Used by the
   *  Revisions tab swap button so the user can override the detector when
   *  the heuristic picks the wrong side. */
  swappedGhostPairs: Set<string>;
  /** When true, every member of every BOM-alternate cluster is rendered
   *  (overlapping). When false (default), only the cluster's selected primary
   *  is shown — secondaries are filtered from the rendered parts list. */
  showBomAlternates: boolean;
  /** Per-cluster primary overrides. Key is a stable cluster signature (sorted
   *  member refdes joined by `,`); value is the chosen member's refdes. Empty
   *  for clusters where the auto-picked default is fine. */
  bomClusterSelections: Map<string, string>;
  /** Per-part user overrides. Keyed by stable partName (refdes) so the entry
   *  survives derive-board-view re-runs even though partIndex can shift in
   *  some fold modes. `hidden` removes the part entirely (no fill, no border,
   *  no pins); `sendToBack` is identical to the auto `mechanical` flag (fill
   *  is skipped). Cleared via the right-click menu's "Show part normally". */
  partOverrides: Map<string, { hidden?: boolean; sendToBack?: boolean }>;
  /** XZZ fold resolution. 'suggested' uses the parser's auto-fold output;
   *  'all-sides' renders the raw pre-fold layout (both halves side-by-side). */
  foldMode: FoldMode;
  /** XZZ multi-board selection. null = show all boards. An index selects the
   *  group at that position in `board.boardGroups`. */
  selectedBoardIndex: number | null;
  /** True while the current selection was established via focusPart() or
   *  focusNet() (search-style paths). Cleared by canvas clicks (selectPart,
   *  selectPin), by highlightNet, and by any method that resets to
   *  emptySelection. Used by the renderer to OR-in auto-dim even when the
   *  user's dimMode is 'off'. */
  searchSelectionActive: boolean;
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

const emptySelection: SelectionState = {
  partIndex: null,
  pinIndex: null,
  highlightedNet: null,
  adjacentNets: new Set<string>(),
};

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

/** Auto-rotate tall boards 90°/270° so they display wide on screen.
 *  270° when the format's Y axis is flipped (most boardview formats),
 *  otherwise 90°. Matches the convention `loadFile` has always used. */
function computeAutoRotation(board: BoardData): number {
  const w = board.bounds.maxX - board.bounds.minX;
  const h = board.bounds.maxY - board.bounds.minY;
  if (h <= w) return 0;
  const flipY = board.flipY ?? getFormat(board.format)?.flipY ?? false;
  return flipY ? 270 : 90;
}

/** Pick `flipAxis` so the on-screen flip is always a top-bottom mirror
 *  (hinge = horizontal screen axis), regardless of how the board is rotated.
 *
 *  - Unrotated (0°/180°):  scale.y=-1 flips Y directly in screen space →
 *    need `flipAxis='x'` (which sets `flipY` sign).
 *  - Rotated (90°/270°):   scene X maps to screen Y after rotation, so we
 *    need `scale.x=-1` instead → `flipAxis='y'` (which sets `flipX` sign).
 */
function flipAxisForRotation(rotationDeg: number): 'x' | 'y' {
  const rot90 = Math.round(rotationDeg / 90) % 4;
  const axesSwapped = rot90 === 1 || rot90 === 3;
  return axesSwapped ? 'y' : 'x';
}

/** When the rotation crosses an axes-swap boundary (90°↔0°, 270°↔180°, …),
 *  flip the board-axis hinge identifier so the *screen* direction the user
 *  selected stays the same. Without this, manual rotation silently inverts
 *  the meaning of the flip-axis toggle every 90°. */
function rotateFlipAxis(flipAxis: 'x' | 'y', oldRotationDeg: number, newRotationDeg: number): 'x' | 'y' {
  const oldSwapped = Math.round(oldRotationDeg / 90) % 2 === 1;
  const newSwapped = Math.round(newRotationDeg / 90) % 2 === 1;
  if (oldSwapped === newSwapped) return flipAxis;
  return flipAxis === 'x' ? 'y' : 'x';
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
  const rotation = computeAutoRotation(derived);
  tab.rotation = rotation;

  tab.flipAxis = flipAxisForRotation(rotation);

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
  netLineMode: NetLineMode;
  dimMode: 'off' | 'dim' | 'darklight';
  showHoverInfo: boolean;
  followPdf: boolean;
  /** When true, newly opened single-layer boards default to butterfly mode.
   *  Toggled by the user clicking the butterfly toolbar button. */
  defaultButterfly: boolean;
}

const DEFAULT_VIEW_PREFS: ViewPrefs = { netLineMode: 'off', dimMode: 'dim', showHoverInfo: true, followPdf: false, defaultButterfly: false };

/**
 * Build a renderable BoardData from a base board + a chosen revision +
 * the current "hide ghosts" state. When hideGhosts is on, ghost-flagged
 * parts are filtered out and bounds/outline are recomputed from the
 * remaining geometry. When off, the revision's full part list is used.
 * Returns a NEW object reference so the renderer's identity check fires.
 */
/** Symmetric signature for a ghost-detector pair; used as a Set key. */
export function ghostPairSig(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

/** Stable empty-set fallback so the snapshot getter doesn't churn identity. */
const EMPTY_GHOST_SWAPS: ReadonlySet<string> = new Set<string>();
const EMPTY_PART_OVERRIDES: ReadonlyMap<string, { hidden?: boolean; sendToBack?: boolean }> = new Map();
/** Stable empty-map fallback for the bomClusterSelections snapshot getter. */
const EMPTY_BOM_SELECTIONS: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * Stable signature for a BOM-alternate cluster: sorted member refdes joined
 * by `,`. Survives parser re-runs as long as the cluster's membership is
 * unchanged (parts at the same overlap site with the same ref-des set).
 */
export function bomClusterSig(memberRefdes: readonly string[]): string {
  return [...memberRefdes].sort().join(',');
}

function buildRenderedBoard(
  base: BoardData,
  rev: BoardRevision,
  hideGhosts: boolean,
  swappedPairs: Set<string>,
  showBomAlternates: boolean,
  bomSelections: ReadonlyMap<string, string>,
): BoardData {
  // Per-revision traces/vias/layerNames override global ones when present
  const traceOverrides: Partial<BoardData> = {};
  if (rev.traces)     traceOverrides.traces = rev.traces;
  if (rev.vias)       traceOverrides.vias = rev.vias;
  if (rev.layerNames) traceOverrides.layerNames = rev.layerNames;

  // Build the set of part indices to drop from the rendered list.
  const drop = new Set<number>();

  // Ghost filtering — hide whichever side of each pair the user has currently
  // chosen as the ghost (auto-detected `partIndex` by default, `dominatorIndex`
  // when the pair's role has been swapped via the Revisions tab).
  if (hideGhosts) {
    for (const g of rev.ghosts) {
      const sig = ghostPairSig(g.partIndex, g.dominatorIndex);
      drop.add(swappedPairs.has(sig) ? g.dominatorIndex : g.partIndex);
    }
  }

  // BOM-alternate filtering — when `showBomAlternates` is off (default), each
  // cluster contributes only its selected primary; the rest are dropped. The
  // selected primary is the user's per-cluster override (when present and
  // pointing at a current member) or the auto-picked default from the parser.
  const clusters = rev.bomClusters;
  if (!showBomAlternates && clusters && clusters.length > 0) {
    for (const c of clusters) {
      const sig = bomClusterSig(c.memberRefdes);
      const requested = bomSelections.get(sig);
      const chosenRefdes = requested && c.memberRefdes.includes(requested)
        ? requested
        : c.defaultPrimaryRefdes;
      for (let k = 0; k < c.memberIndices.length; k++) {
        if (c.memberRefdes[k] !== chosenRefdes) drop.add(c.memberIndices[k]);
      }
    }
  }

  if (drop.size === 0) {
    return {
      ...base,
      ...traceOverrides,
      parts: rev.parts,
      bounds: rev.bounds,
      outline: rev.outline,
      nets: rev.nets,
      ghosts: rev.ghosts.length > 0 ? rev.ghosts : undefined,
      bomClusters: clusters && clusters.length > 0 ? clusters : undefined,
      activeRevision: rev.index,
    };
  }

  const filteredParts: Part[] = [];
  for (let i = 0; i < rev.parts.length; i++) {
    if (!drop.has(i)) filteredParts.push(rev.parts[i]);
  }
  const allPoints = filteredParts.flatMap(p => p.pins.map(pin => pin.position));
  const outline = generateSyntheticOutline(allPoints);
  const bounds = computeBBox([...outline, ...allPoints]);
  // Net pinIndices are partIndex-based against the parts array they were built
  // from. After dropping parts the indices shift, so rebuild nets against the
  // filtered array — otherwise highlights, net-lines and adjacency all resolve
  // pins to whichever part now occupies the original index.
  return {
    ...base,
    ...traceOverrides,
    parts: filteredParts,
    bounds,
    outline,
    nets: buildNets(filteredParts),
    ghosts: rev.ghosts.length > 0 ? rev.ghosts : undefined,
    bomClusters: clusters && clusters.length > 0 ? clusters : undefined,
    activeRevision: rev.index,
  };
}

/** Apply the current tab's filters (hideGhosts + BOM-alternate hiding) to the
 *  raw `tab.board` set by loadFile. No-op when neither filter would drop any
 *  parts (avoids the bounds/outline rebuild on clean files). */
function applyBoardFilters(tab: BoardTab): void {
  if (!tab.board) return;
  const hasBomClusters = !!tab.board.bomClusters && tab.board.bomClusters.length > 0;
  const hasGhostsToFilter = tab.hideGhosts && !!tab.board.ghosts && tab.board.ghosts.length > 0;
  const hasBomFilter = !tab.showBomAlternates && hasBomClusters;
  if (!hasGhostsToFilter && !hasBomFilter) return;
  const rev = tab.board.revisions?.find(r => r.index === tab.board?.activeRevision)
    ?? syntheticRevisionFromBoard(tab.board);
  tab.board = buildRenderedBoard(
    tab.board, rev, tab.hideGhosts, tab.swappedGhostPairs,
    tab.showBomAlternates, tab.bomClusterSelections,
  );
  invalidateDerivedBoard(tab);
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
    bomClusters: b.bomClusters,
  };
}

function loadViewPrefs(): ViewPrefs {
  try {
    const raw = localStorage.getItem(VIEW_PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ViewPrefs> & { showNetLines?: boolean; showNetDim?: boolean };
      // Migrate legacy boolean: false → 'off', true → 'star' (the most common
      // previous behavior, since users typically had a part selected when
      // net lines were on; PDF lookups still get chain regardless).
      const merged: ViewPrefs = { ...DEFAULT_VIEW_PREFS, ...parsed };
      if (parsed.netLineMode === undefined && typeof parsed.showNetLines === 'boolean') {
        merged.netLineMode = parsed.showNetLines ? 'star' : 'off';
      }
      // Sanitize against invalid persisted values
      if (
        merged.netLineMode !== 'off' &&
        merged.netLineMode !== 'star' &&
        merged.netLineMode !== 'chain' &&
        merged.netLineMode !== 'chain-adjacent'
      ) {
        merged.netLineMode = 'off';
      }
      // Migrate legacy showNetDim boolean → dimMode tri-state
      if (merged.dimMode === undefined || (merged.dimMode !== 'off' && merged.dimMode !== 'dim' && merged.dimMode !== 'darklight')) {
        if (typeof parsed.showNetDim === 'boolean') {
          merged.dimMode = parsed.showNetDim ? 'dim' : 'off';
        } else {
          merged.dimMode = 'dim';
        }
      }
      return merged;
    }
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

  constructor() {
    super();
    // Live-update chain-adjacent adjacency when the part-type hierarchyBridge
    // flags change under an active highlight, so Settings ▸ Part Types toggles
    // take effect without re-selecting the net. Singleton — never unsubscribed.
    renderSettingsStore.subscribe(() => this.refreshAdjacency());
  }

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
  get netLineMode(): NetLineMode { return this.activeTab?.netLineMode ?? 'off'; }
  get connectionHighlight(): boolean { return this.activeTab?.connectionHighlight ?? false; }
  get showTraces(): boolean { return this.activeTab?.showTraces ?? true; }
  get showComponents(): boolean { return this.activeTab?.showComponents ?? true; }
  get showVias(): boolean { return this.activeTab?.showVias ?? false; }
  get showSilkscreen(): boolean { return this.activeTab?.showSilkscreen ?? true; }
  get showPads(): boolean { return this.activeTab?.showPads ?? true; }
  get showCopperDrops(): boolean { return this.activeTab?.showCopperDrops ?? false; }
  get showPins(): boolean { return this.activeTab?.showPins ?? true; }
  get showOutlines(): boolean { return this.activeTab?.showOutlines ?? true; }
  get showLabels(): boolean { return this.activeTab?.showLabels ?? true; }
  get ghostMode(): GhostMode { return this.activeTab?.ghostMode ?? 'ghosts'; }
  get showGhosts(): boolean { return this.ghostMode !== 'off'; }
  get discoHighlight(): boolean { return this.ghostMode === 'disco'; }
  get hideGhosts(): boolean { return this.activeTab?.hideGhosts ?? false; }
  get swappedGhostPairs(): ReadonlySet<string> { return this.activeTab?.swappedGhostPairs ?? EMPTY_GHOST_SWAPS; }
  get showBomAlternates(): boolean { return this.activeTab?.showBomAlternates ?? false; }
  get bomClusterSelections(): ReadonlyMap<string, string> { return this.activeTab?.bomClusterSelections ?? EMPTY_BOM_SELECTIONS; }
  get partOverrides(): ReadonlyMap<string, { hidden?: boolean; sendToBack?: boolean }> { return this.activeTab?.partOverrides ?? EMPTY_PART_OVERRIDES; }
  get foldMode(): FoldMode { return this.activeTab?.foldMode ?? 'suggested'; }
  get selectedBoardIndex(): number | null { return this.activeTab?.selectedBoardIndex ?? null; }
  get layerStates(): LayerState[] { return this.activeTab?.layerStates ?? []; }
  get selectedLayerIndex(): number | null { return this.activeTab?.selectedLayerIndex ?? null; }
  get fixatedLayerIndex(): number | null { return this.activeTab?.fixatedLayerIndex ?? null; }
  get dimMode(): 'off' | 'dim' | 'darklight' { return this.activeTab?.dimMode ?? 'dim'; }
  /** @deprecated alias kept for backward compat — callers should migrate to dimMode */
  get showNetDim(): boolean { return this.dimMode === 'dim'; }
  get showHoverInfo(): boolean { return this.activeTab?.showHoverInfo ?? true; }
  get followPdf(): boolean { return this.activeTab?.followPdf ?? false; }
  get searchSelectionActive(): boolean { return this.activeTab?.searchSelectionActive ?? false; }

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

  /** Bind a newly-opened PDF to an open board tab whose filename matches.
   *  Returns the matched tab's filename so the caller can promote a strong
   *  match to a persistent DB binding (in databank-store). Returns null when
   *  no name match exists — we no longer fall back to the active tab,
   *  because that caused the active board to "absorb" any stray PDF the
   *  user opened, including PDFs unrelated to it. */
  autoBindPdf(pdfFileName: string): string | null {
    const matchName = findBestNameMatch(pdfFileName, this._tabs.map(t => t.fileName));
    if (!matchName) return null;
    const tab = this._tabs.find(t => t.fileName === matchName);
    if (!tab) return null;
    if (!tab.pdfFileNames.includes(pdfFileName)) {
      tab.pdfFileNames.push(pdfFileName);
      const entry = this._pdfFiles.get(pdfFileName);
      if (entry) entry.boundTabIds.add(tab.id);
      this.notify();
    }
    return matchName;
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
        selection: { ...emptySelection, adjacentNets: new Set<string>() },
        showTop: true,
        showBottom: false,
        butterfly: false,
        searchQuery: '',
        rotation: 0,
        mirrorX: false,
        mirrorY: false,
        flipAxis: 'x',
        netLineMode: vp.netLineMode,
        connectionHighlight: false,
        dimMode: vp.dimMode,
        showHoverInfo: vp.showHoverInfo,
        followPdf: vp.followPdf,
        showTraces: true,
        showComponents: true,
        showVias: false,
        showSilkscreen: true,
        showPads: true,
        showCopperDrops: false,
        showPins: true,
        showOutlines: true,
        showLabels: true,
        ghostMode: 'ghosts',
        layerStates: [],
        selectedLayerIndex: null,
        fixatedLayerIndex: null,
        pdfFileNames: [],
        cacheKey: '',
        hideGhosts: false,
        swappedGhostPairs: new Set<string>(),
        showBomAlternates: false,
        bomClusterSelections: new Map<string, string>(),
        partOverrides: new Map(),
        foldMode: 'suggested',
        selectedBoardIndex: null,
        searchSelectionActive: false,
      };

      this._tabs.push(tab);
      this._activeTabId = id;
      this.notify(); // notify immediately so existing renderers know the active tab changed

      try {
        this._openFiles.set(file.name, file);
        const cached = await boardCache.get(file.name, file.size, file.lastModified);
        if (cached) {
          log.cache.log(`Loaded from cache: ${file.name} (${cached.parts.length} parts, ${cached.nets.size} nets)`);
          // Mechanical-flag pass is cheap and side-effect-only on parts[i].mechanical;
          // cached boards may pre-date this flag so always re-run on load.
          flagMechanicalParts(cached.parts);
          tab.board = cached;
          invalidateDerivedBoard(tab);
          applyBoardFilters(tab);
          tab.cacheKey = boardCache.makeCacheKey(file.name, file.size, file.lastModified);
          tab.rotation = this.autoRotation(cached);
          tab.flipAxis = flipAxisForRotation(tab.rotation);
          if (cached.butterflyFoldAxis === 'x') tab.mirrorY = true;
          if (cached.flipAxis) tab.flipAxis = cached.flipAxis;
          const cachedFmt = getFormat(cached.format);
          // Initial side = user's perception of "top". For inverted files
          // (primarySide='bottom'), the user's "Top" button is mapped to the
          // file's side='bottom' in selectTop, so set showBottom=true on open.
          const wantsBottomOnOpen = cachedFmt?.swapSides || cached.primarySide === 'bottom';
          if (wantsBottomOnOpen) {
            tab.showTop = false;
            tab.showBottom = true;
          }
          // Trace-layer default is always TOP regardless of primarySide. The
          // primarySide swap drives only the user-facing side toggle (which
          // happened above); the layer list represents the file's etch stack
          // so users expect TOP-of-stack visible on first open.
          if (cached.layerNames) tab.layerStates = createLayerStates(cached.layerNames);
          if (vp.defaultButterfly && !(cached.layerNames && cached.layerNames.length > 0)) {
            tab.butterfly = true;
            tab.showTop = true;
            tab.showBottom = true;
          }
          if (cached.parserNotes) {
            for (const note of cached.parserNotes) this.addToast(note, 'info');
          }
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
        let board;
        try {
          board = await parseBoardFile(buffer, file.name);
        } catch (e) {
          // Encrypted FZ files need a user-supplied key. Both "missing" and
          // "invalid" reasons open the dialog so the user can fetch/paste/replace.
          if (e instanceof FZKeyError) {
            if (e.reason === 'invalid') fzKeyStore.clearKey();
            const ok = await fzKeyStore.ensureFzKey();
            if (!ok) throw e;
            board = await parseBoardFile(buffer, file.name);
          } else {
            throw e;
          }
        }
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

        flagMechanicalParts(board.parts);
        tab.board = board;
        invalidateDerivedBoard(tab);
        applyBoardFilters(tab);
        tab.rotation = this.autoRotation(board);
        tab.flipAxis = flipAxisForRotation(tab.rotation);
        if (board.butterflyFoldAxis === 'x') tab.mirrorY = true;
        if (board.flipAxis) tab.flipAxis = board.flipAxis;
        const wantsBottomOnOpen = fmt?.swapSides || board.primarySide === 'bottom';
        if (wantsBottomOnOpen) {
          tab.showTop = false;
          tab.showBottom = true;
        }
        if (board.layerNames) tab.layerStates = createLayerStates(board.layerNames);
        if (vp.defaultButterfly && !(board.layerNames && board.layerNames.length > 0)) {
          tab.butterfly = true;
          tab.showTop = true;
          tab.showBottom = true;
        }

        await boardCache.put(file.name, file.size, file.lastModified, board);

        if (board.parserNotes) {
          for (const note of board.parserNotes) this.addToast(note, 'info');
        }

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
    return computeAutoRotation(board);
  }

  async loadFiles(files: FileList | File[]) {
    for (const file of files) {
      await this.loadFile(file);
    }
  }

  /**
   * Open a tab from an already-parsed BoardData (test/dev helper — skips parsing
   * and cache). Exposed on `window.__boardStore` in DEV builds for Playwright tests.
   */
  openBoardFromData(fileName: string, board: BoardData) {
    const id = nextTabId++;
    const vp = loadViewPrefs();
    const rotation = computeAutoRotation(board);
    const tab: BoardTab = {
      id,
      fileName,
      board,
      cacheKey: '',
      selection: { ...emptySelection, adjacentNets: new Set<string>() },
      showTop: true,
      showBottom: false,
      butterfly: false,
      searchQuery: '',
      rotation,
      mirrorX: false,
      mirrorY: false,
      flipAxis: flipAxisForRotation(rotation),
      netLineMode: vp.netLineMode,
      connectionHighlight: false,
      dimMode: vp.dimMode,
      showHoverInfo: vp.showHoverInfo,
      followPdf: vp.followPdf,
      showTraces: true,
      showComponents: true,
      showVias: false,
      showSilkscreen: true,
      showPads: true,
      showCopperDrops: false,
      showPins: true,
      showOutlines: true,
      showLabels: true,
      ghostMode: 'ghosts',
      layerStates: [],
      selectedLayerIndex: null,
      fixatedLayerIndex: null,
      pdfFileNames: [],
      hideGhosts: false,
      swappedGhostPairs: new Set<string>(),
      showBomAlternates: false,
      bomClusterSelections: new Map<string, string>(),
      partOverrides: new Map(),
      foldMode: 'suggested',
      selectedBoardIndex: null,
      searchSelectionActive: false,
    };
    applyBoardFilters(tab);
    this._tabs.push(tab);
    this._activeTabId = id;
    this.notify();
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
    // Hierarchical net-lines (chain-adjacent): selecting a 2-pin component by
    // its body — which otherwise highlights no net — seeds the highlight from
    // one pin's net so the one-hop adjacency lights up the *other* pin's net
    // too, drawing chains for BOTH pins. Other modes / pin counts keep the
    // plain part-only selection (no net highlighted).
    let highlightedNet: string | null = null;
    if (partIndex !== null && this.activeTab?.netLineMode === 'chain-adjacent') {
      const part = this.activeTab.board?.parts[partIndex];
      if (part && part.pins.length === 2) {
        highlightedNet = part.pins.find(p => p.net)?.net ?? null;
      }
    }
    this.updateActiveTab({
      selection: { partIndex, pinIndex: null, highlightedNet, adjacentNets: this._resolveAdjacentNets(highlightedNet) },
      searchSelectionActive: false,
    });
    this.notify();
  }

  selectPin(partIndex: number, pinIndex: number) {
    const tab = this.activeTab;
    const part = tab?.board?.parts[partIndex];
    const pin = part?.pins[pinIndex];
    this.updateActiveTab({
      selection: { partIndex, pinIndex, highlightedNet: pin?.net || null, adjacentNets: this._resolveAdjacentNets(pin?.net || null) },
      searchSelectionActive: false,
    });
    this.notify();
  }

  /** Returns `computeAdjacentNets(board, netName, hierarchyDepth)` when the
   *  current `netLineMode` is `'chain-adjacent'` and the board is loaded;
   *  otherwise returns an empty Set.  Centralises the "should we populate
   *  adjacency?" decision so every call-site stays a one-liner. */
  private _resolveAdjacentNets(netName: string | null): Set<string> {
    const tab = this.activeTab;
    if (!tab?.board || !netName) return new Set<string>();
    if (tab.netLineMode !== 'chain-adjacent') return new Set<string>();
    return computeAdjacentNets(tab.board, netName, renderSettingsStore.settings.hierarchyDepth, this._hierarchyBridgePred());
  }

  /** Predicate for `computeAdjacentNets` — marks parts whose PartType opted
   *  into hierarchy bridging (>2-pin pass-through, e.g. current-sense
   *  resistors). Resolved against the live render settings each call. */
  private _hierarchyBridgePred(): (part: Part) => boolean {
    const s = renderSettingsStore.settings;
    return (part: Part) => partBridgesHierarchy(part.name, s);
  }

  /** Recompute adjacentNets for the live selection — invoked when the
   *  hierarchyBridge part-type flags change under an active chain-adjacent
   *  highlight. No-op (and no notify) when the mode is inactive or the
   *  resulting set is unchanged, so unrelated settings edits stay quiet. */
  private refreshAdjacency(): void {
    const tab = this.activeTab;
    if (!tab?.board || tab.netLineMode !== 'chain-adjacent') return;
    const net = tab.selection.highlightedNet;
    if (!net) return;
    const next = computeAdjacentNets(tab.board, net, renderSettingsStore.settings.hierarchyDepth, this._hierarchyBridgePred());
    const cur = tab.selection.adjacentNets;
    if (next.size === cur.size) {
      let same = true;
      for (const n of next) if (!cur.has(n)) { same = false; break; }
      if (same) return;
    }
    this.updateActiveTab({ selection: { ...tab.selection, adjacentNets: next } });
    this.notify();
  }

  highlightNet(netName: string | null) {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({
      selection: { ...tab.selection, highlightedNet: netName, adjacentNets: this._resolveAdjacentNets(netName) },
      searchSelectionActive: false,
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
    // Persist the user's choice so subsequent board opens default to it.
    saveViewPrefs({ ...loadViewPrefs(), defaultButterfly: newButterfly });
    this.notify();
  }

  rotateCW() {
    const tab = this.activeTab;
    if (!tab) return;
    const newRotation = (tab.rotation + 90) % 360;
    this.updateActiveTab({ rotation: newRotation, flipAxis: rotateFlipAxis(tab.flipAxis, tab.rotation, newRotation) });
    this.notify();
  }

  rotateCCW() {
    const tab = this.activeTab;
    if (!tab) return;
    const newRotation = (tab.rotation + 270) % 360;
    this.updateActiveTab({ rotation: newRotation, flipAxis: rotateFlipAxis(tab.flipAxis, tab.rotation, newRotation) });
    this.notify();
  }

  /** 180° rotation — the common case for boards photographed from the wrong
   *  end. flipAxis is invariant under a 180° turn (the screen axis-swap parity
   *  is unchanged), so no flipAxis adjustment needed. */
  rotate180() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ rotation: (tab.rotation + 180) % 360 });
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
    tab.board = buildRenderedBoard(tab.board, target, tab.hideGhosts, tab.swappedGhostPairs, tab.showBomAlternates, tab.bomClusterSelections);
    invalidateDerivedBoard(tab);
    tab.selection = emptySelection;
    tab.searchSelectionActive = false;
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
    tab.board = buildRenderedBoard(tab.board, rev, next, tab.swappedGhostPairs, tab.showBomAlternates, tab.bomClusterSelections);
    invalidateDerivedBoard(tab);
    tab.selection = emptySelection;
    tab.searchSelectionActive = false;
    this.notify();
  }

  /**
   * Toggle which side of an overlap pair is treated as the ghost. By default
   * the part with the smaller pin count is flagged; calling this swaps the
   * two so the dominator is hidden instead. Rebuilds the rendered board only
   * when hide-mode is on (otherwise just notifies so the UI restyles).
   */
  swapGhostPair(partIndex: number, dominatorIndex: number) {
    const tab = this.activeTab;
    if (!tab || !tab.board) return;
    const sig = ghostPairSig(partIndex, dominatorIndex);
    // Replace the Set so identity changes (snapshot consumers rerender).
    const next = new Set(tab.swappedGhostPairs);
    if (next.has(sig)) next.delete(sig); else next.add(sig);
    tab.swappedGhostPairs = next;
    if (tab.hideGhosts) {
      const rev = tab.board.revisions?.find(r => r.index === tab.board?.activeRevision)
        ?? syntheticRevisionFromBoard(tab.board);
      tab.board = buildRenderedBoard(tab.board, rev, true, next, tab.showBomAlternates, tab.bomClusterSelections);
      invalidateDerivedBoard(tab);
      tab.selection = emptySelection;
    }
    this.notify();
  }

  /**
   * Toggle whether every BOM-alternate cluster member is rendered (overlapping
   * X-ray view) or only the chosen primary per cluster (default). Selection
   * resets to avoid dangling indices into the filtered array.
   */
  toggleShowBomAlternates() {
    const tab = this.activeTab;
    if (!tab || !tab.board) return;
    const next = !tab.showBomAlternates;
    tab.showBomAlternates = next;
    const rev = tab.board.revisions?.find(r => r.index === tab.board?.activeRevision)
      ?? syntheticRevisionFromBoard(tab.board);
    tab.board = buildRenderedBoard(tab.board, rev, tab.hideGhosts, tab.swappedGhostPairs, next, tab.bomClusterSelections);
    invalidateDerivedBoard(tab);
    tab.selection = emptySelection;
    this.notify();
  }

  /**
   * Per-part visibility override. Keyed by refdes (stable across derives).
   * `mode === 'hide'`         → fill, border, pins all skipped.
   * `mode === 'sendToBack'`   → fill skipped (same effect as auto-mechanical);
   *                             border and pins still draw.
   * `mode === null`           → clear override, render normally.
   * Toggling a part already in the requested mode also clears the override.
   * Replaces the Map so snapshot consumers rerender.
   */
  setPartOverride(partName: string, mode: 'hide' | 'sendToBack' | null) {
    const tab = this.activeTab;
    if (!tab) return;
    const next = new Map(tab.partOverrides);
    const existing = next.get(partName);
    if (mode === null) {
      if (!existing) return;
      next.delete(partName);
    } else if (mode === 'hide') {
      if (existing?.hidden) { next.delete(partName); }
      else { next.set(partName, { hidden: true }); }
    } else {
      if (existing?.sendToBack) { next.delete(partName); }
      else { next.set(partName, { sendToBack: true }); }
    }
    tab.partOverrides = next;
    // If we just hid the currently-selected part, clear selection.
    if (mode === 'hide' && tab.selection.partIndex !== null) {
      const part = tab.board?.parts[tab.selection.partIndex];
      if (part?.name === partName) {
        tab.selection = emptySelection;
        tab.searchSelectionActive = false;
      }
    }
    this.notify();
  }

  /**
   * Override which member of a BOM-alternate cluster is treated as the primary
   * (i.e. the one rendered when `showBomAlternates` is off). Pass the cluster
   * signature (`bomClusterSig` over the full member refdes list) and the
   * chosen member's refdes. Calling with `chosenRefdes === ''` clears the
   * override and falls back to the parser's auto-pick.
   */
  selectBomClusterPrimary(clusterSig: string, chosenRefdes: string) {
    const tab = this.activeTab;
    if (!tab || !tab.board) return;
    // Replace the Map so identity changes (snapshot consumers rerender).
    const next = new Map(tab.bomClusterSelections);
    if (chosenRefdes) next.set(clusterSig, chosenRefdes);
    else next.delete(clusterSig);
    tab.bomClusterSelections = next;
    if (!tab.showBomAlternates) {
      const rev = tab.board.revisions?.find(r => r.index === tab.board?.activeRevision)
        ?? syntheticRevisionFromBoard(tab.board);
      tab.board = buildRenderedBoard(tab.board, rev, tab.hideGhosts, tab.swappedGhostPairs, false, next);
      invalidateDerivedBoard(tab);
      tab.selection = emptySelection;
      tab.searchSelectionActive = false;
    }
    this.notify();
  }

  setFoldMode(mode: FoldMode): void {
    const tab = this.activeTab;
    if (!tab || tab.foldMode === mode) return;
    this.updateActiveTab({ foldMode: mode });
    invalidateDerivedBoard(tab);
    // Clear any stale selection so it doesn't point at a now-hidden part.
    tab.selection = { ...emptySelection };
    tab.searchSelectionActive = false;
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
    tab.searchSelectionActive = false;
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

  /** Local debug helper: returns the original File for the active tab so debug
   *  tooling (per-layer PNG export, hex dumps) can re-read the raw bytes. */
  getActiveFile(): File | null {
    const tab = this.activeTab;
    if (!tab) return null;
    return this._openFiles.get(tab.fileName) ?? null;
  }

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
      applyBoardFilters(tab);
      tab.selection = emptySelection;
      tab.searchSelectionActive = false;
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
        applyBoardFilters(tab);
        tab.selection = emptySelection;
        tab.searchSelectionActive = false;
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
   *  bitmap cache, and glyph/font cache. Watermark filtering moved into
   *  the patched pdf.js worker; nothing to invalidate there. Board caches
   *  are left alone. */
  async resetPdfCaches(): Promise<void> {
    const { invalidateTileCache } = await import('../pdf/tile-manager');
    const { clearFontCache } = await import('../pdf/glyph-extractor');
    await boardCache.clearPdfText();
    invalidateTileCache();
    clearFontCache();
    log.cache.log('PDF caches cleared');
    this.addToast('PDF caches cleared.', 'info');
    this.notify();
  }

  setRotationFree(degrees: number) {
    const tab = this.activeTab;
    if (!tab) return;
    const newRotation = ((degrees % 360) + 360) % 360;
    this.updateActiveTab({ rotation: newRotation, flipAxis: rotateFlipAxis(tab.flipAxis, tab.rotation, newRotation) });
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
    // Merge with stored prefs so fields not derived from the active tab
    // (e.g. defaultButterfly) survive partial updates.
    saveViewPrefs({ ...loadViewPrefs(), netLineMode: tab.netLineMode, dimMode: tab.dimMode, showHoverInfo: tab.showHoverInfo, followPdf: tab.followPdf });
  }

  /** Cycle the net-line visualization: off → star → chain → chain-adjacent → off. */
  cycleNetLineMode() {
    const tab = this.activeTab;
    if (!tab) return;
    const next: NetLineMode =
      tab.netLineMode === 'off' ? 'star' :
      tab.netLineMode === 'star' ? 'chain' :
      tab.netLineMode === 'chain' ? 'chain-adjacent' : 'off';

    // When entering chain-adjacent: populate adjacentNets from the current
    // highlighted net.  When leaving chain-adjacent: clear the set.
    const net = tab.selection.highlightedNet;
    const adjacentNets = (next === 'chain-adjacent' && tab.board && net)
      ? computeAdjacentNets(tab.board, net, renderSettingsStore.settings.hierarchyDepth, this._hierarchyBridgePred())
      : new Set<string>();

    this.updateActiveTab({
      netLineMode: next,
      selection: { ...tab.selection, adjacentNets },
    });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  /** Toggle/set "highlight connections" — glow nets shared by ≥2 parts in the
   *  cyan selection set. Visual only; net-lines are unaffected. Per-tab, not
   *  persisted (it's tied to an ephemeral selection that doesn't survive
   *  reload). */
  setConnectionHighlight(on: boolean) {
    const tab = this.activeTab;
    if (!tab || tab.connectionHighlight === on) return;
    this.updateActiveTab({ connectionHighlight: on });
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

  toggleSilkscreen() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showSilkscreen: !tab.showSilkscreen });
    this.notify();
  }

  togglePads() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showPads: !tab.showPads });
    this.notify();
  }

  toggleCopperDrops() {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateActiveTab({ showCopperDrops: !tab.showCopperDrops });
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

  /** Cycle off → ghosts → disco → off. */
  cycleGhostMode() {
    const tab = this.activeTab;
    if (!tab) return;
    const next: GhostMode =
      tab.ghostMode === 'off'    ? 'ghosts' :
      tab.ghostMode === 'ghosts' ? 'disco'  : 'off';
    this.updateActiveTab({ ghostMode: next });
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

  /** Turn a layer on if it's currently hidden — so bumping/pinning it actually
   *  reveals something. No-op when already visible or index out of range. */
  private _revealLayer(layerIndex: number) {
    const tab = this.activeTab;
    if (!tab || layerIndex < 0 || layerIndex >= tab.layerStates.length) return;
    if (tab.layerStates[layerIndex].visible) return;
    const states = [...tab.layerStates];
    states[layerIndex] = { ...states[layerIndex], visible: true };
    tab.layerStates = states;
  }

  /** Bump a layer's traces to the top of the z-stack (transient). Passing the
   *  currently-selected index clears it. Selecting reveals the layer *while
   *  selected* (the renderer shows it even if its visibility toggle is off) but
   *  does NOT mutate the toggle — deselecting reverts it. Has no z-order effect
   *  while a layer is pinned (see fixateLayer). */
  selectLayer(layerIndex: number | null) {
    const tab = this.activeTab;
    if (!tab) return;
    const valid = layerIndex != null && layerIndex >= 0 && layerIndex < tab.layerStates.length;
    // Toggle off when re-selecting the same layer.
    const next = valid && tab.selectedLayerIndex !== layerIndex ? layerIndex : null;
    tab.selectedLayerIndex = next;
    this.notify();
  }

  /** Pin one layer's traces on top (sticky — survives selection changes).
   *  Passing the currently-pinned index unpins it. Pinning a layer reveals it
   *  (turns it on if hidden). Only one layer can be pinned; setting a new index
   *  replaces any previous pin. */
  fixateLayer(layerIndex: number | null) {
    const tab = this.activeTab;
    if (!tab) return;
    const valid = layerIndex != null && layerIndex >= 0 && layerIndex < tab.layerStates.length;
    const next = valid && tab.fixatedLayerIndex !== layerIndex ? layerIndex : null;
    tab.fixatedLayerIndex = next;
    if (next != null) this._revealLayer(next);
    this.notify();
  }

  cycleDimMode() {
    const tab = this.activeTab;
    if (!tab) return;
    const next: BoardTab['dimMode'] =
      tab.dimMode === 'off'       ? 'dim'
      : tab.dimMode === 'dim'     ? 'darklight'
      :                             'off';
    this.updateActiveTab({ dimMode: next });
    this._saveCurrentViewPrefs();
    this.notify();
  }

  /** @deprecated — use cycleDimMode() */
  toggleNetDim() {
    this.cycleDimMode();
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

    // Preserve the active net highlight when focusing a part that touches it
    // (e.g. clicking a component inside the search Nets spoiler). Otherwise
    // clear it — selecting an unrelated part shouldn't keep stale net state.
    const prevNet = tab.selection.highlightedNet;
    const keepNet = prevNet != null && part.pins.some(p => p.net === prevNet);

    this.updateActiveTab({
      selection: { partIndex: idx, pinIndex: null, highlightedNet: keepNet ? prevNet : null, adjacentNets: keepNet ? this._resolveAdjacentNets(prevNet) : new Set<string>() },
      searchSelectionActive: true,
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
      selection: { partIndex: null, pinIndex: null, highlightedNet: name, adjacentNets: this._resolveAdjacentNets(name) },
      searchSelectionActive: true,
    });
    this._focusRequest = { partIndex: null, bounds: { minX, minY, maxX, maxY } };
    this.notify();
  }
}

export const boardStore = new BoardStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __boardStore?: typeof boardStore }).__boardStore = boardStore;
}
