/**
 * Main PixiJS renderer — owns the Application, Viewport, and scene lifecycle.
 *
 * Responsibilities:
 *  - Creates and manages the PixiJS Application + pixi-viewport
 *  - Delegates scene graph construction to buildBoardScene() (renderer/board-scene.ts)
 *  - Handles multi-board tabs: builds one BoardScene per tab, switches between them
 *  - Manages selection state: hover, click, net highlight, selection rect
 *  - Butterfly mode: renders a mirrored side-by-side copy of the bottom layer
 *  - Net lines: draws connection lines between components sharing a net
 *  - Reacts to renderSettingsStore changes and rebuilds the scene as needed
 *
 */
import { Application, Graphics, Container, BitmapText, Text, RenderLayer } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { BoardData, Point, Part } from '../parsers';
import { pinDisplayId } from '../parsers/types';
import { boardStore } from '../store/board-store';
import { databankStore } from '../store/databank-store';
import { pdfStore } from '../store/pdf-store';
import { renderSettingsStore, computePinRadius, resolvePinColor, computePartRenderBounds, computePartRenderPoly, isNcNet } from '../store/render-settings';
import { themeStore, hexToInt } from '../store/themes';
import { looksLikeMouseWheel } from '../store/scroll-mode';
import { contextMenuStore } from '../store/context-menu-store';
import { viewCommands } from '../store/view-commands';
import type { PanDirection } from '../store/view-commands';
import { buildBoardScene, drawOutline, drawOutlineDebug, updateBorderWidths, BOARD_COLORS, drawPadShape } from './board-scene';
import type { BorderBatch, PadGeometry } from './board-scene';
import { getFormat } from '../parsers/registry';
import { log } from '../store/log-store';
import { ensurePdfPanel } from '../store/dockview-api';
import { fileInputRefs } from '../store/file-inputs';
import { obdNetLookup, extractBoardNumberFromFilename } from '../store/obd-store';

// Alias for local use — all colour references go through board-scene.ts
const COLORS = BOARD_COLORS;

/** Unique non-empty values pulled from a list via a getter. Used by the
 *  OBD tooltip formatter, which collapses readings across variants. */
function uniqOf<T>(items: T[], get: (x: T) => string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const it of items) {
    const v = get(it);
    if (v && !seen.has(v)) seen.add(v);
  }
  return Array.from(seen);
}

// Selected-part name currently uses a simple alpha fade when pin numbers come
// into view (see updateElevatedLabels). A read-under-text invert effect was
// prototyped via `blendMode: 'difference'` but it doesn't take effect for
// labels living inside a RenderLayer — see
// `docs/research/threejs-webgpu-vs-pixi.md` § "Label blending options" for
// the long-term plan.

/** Shape of the event object emitted by pixi-viewport's `clicked` event. */
interface ViewportClickEvent {
  world: Point;
  screen: { x: number; y: number };
  event: unknown;
}

/** Point-in-convex-polygon test using cross-product winding. */
function pointInConvexPoly(px: number, py: number, poly: [number, number][]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % n];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross === 0) continue;
    if (sign === 0) sign = cross > 0 ? 1 : -1;
    else if ((cross > 0 ? 1 : -1) !== sign) return false;
  }
  return true;
}



/** Pre-built scene graph for a single board */
interface BoardScene {
  root: Container;
  outlineGfx: Graphics;
  topLayer: Container;
  bottomLayer: Container;
  topFillLayer: Container;
  bottomFillLayer: Container;
  topPinLayer: Container;
  bottomPinLayer: Container;
  topOutlineLayer: Container;
  bottomOutlineLayer: Container;
  topLabelLayer: Container;
  bottomLabelLayer: Container;
  labels: import('pixi.js').BitmapText[];
  topLabels: import('pixi.js').BitmapText[];
  bottomLabels: import('pixi.js').BitmapText[];
  topPinLabels: Container[];
  bottomPinLabels: Container[];
  /** Pin labels per part index — used by selection highlight to brighten only
   *  the labels of the selected part. */
  pinLabelsByPartIndex: Map<number, Container[]>;
  borderBatches: BorderBatch[];
  fontSizeGroups: import('./board-scene').FontSizeGroup[];
  /** Group A: pin numbers + net names on circle/1-pin parts */
  topCircleLabelLayer: Container;
  bottomCircleLabelLayer: Container;
  circleFontSizeGroups: import('./board-scene').PinFontSizeGroup[];
  /** Group B: net names on 2-pin parts */
  topTwoPinNetLayer: Container;
  bottomTwoPinNetLayer: Container;
  twoPinFontSizeGroups: import('./board-scene').PinFontSizeGroup[];
  /** Part label by index — for brightening selected part name */
  partLabelByIndex: Map<number, import('pixi.js').BitmapText>;
  /** Top/bottom pin circle graphics by part index */
  topPinGfx: Map<number, import('pixi.js').Graphics>;
  bottomPinGfx: Map<number, import('pixi.js').Graphics>;
  /** Per-part max pin radius to prevent overlap (BGA etc). partIndex → maxRadius. */
  pinRadiusClamp: Map<number, number>;
  /** Per 2-pin part: per-pin pad polygons (4 corners each). Used for exact selection highlights. */
  twoPinPadPolys: Map<number, [number, number][][]>;
  /** PCB trace lines container — toggled by showTraces */
  traceLayer: Container | null;
  /** Per-layer trace containers for multi-layer boards (indexed by layer). Empty for single-layer. */
  traceLayerContainers: Container[];
  /** Silkscreen / assembly outlines — toggled by showSilkscreen */
  silkscreenLayer: Container | null;
  silkscreenTop: Container | null;
  silkscreenBottom: Container | null;
  /** Copper pad rectangles — toggled by showPads (attached pads only) */
  padsLayer: Container | null;
  padsTop: Container | null;
  padsBottom: Container | null;
  /** Standalone copper drops — toggled by showCopperDrops, default OFF */
  copperDropsLayer: Container | null;
  copperDropsTop: Container | null;
  copperDropsBottom: Container | null;
  /** Via/drill hole overlay container */
  viaLayer: Container | null;
  /** Via labels — tracked for counter-rotation on board flip */
  viaLabels: import('pixi.js').BitmapText[];
  /** Per-via connected layer indices (parallel to board.vias). Empty for single-layer boards. */
  viaConnectedLayers: number[][];
  /** Butterfly mode: a mirrored copy of the board for the bottom side */
  butterflyRoot: Container | null;
  butterflyOutline: Graphics | null;
}

/** Saved viewport transform for restoring on tab switch */
interface ViewportState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export class BoardRenderer {
  /** Whether top layer should be visible (accounts for butterfly mode) */
  private get isTopVisible() { return boardStore.showTop || boardStore.butterfly; }
  /** Whether bottom layer should be visible (accounts for butterfly mode) */
  private get isBottomVisible() { return boardStore.showBottom || boardStore.butterfly; }
  /** Whether a part should be visible given its side and current view mode.
   *  'both' parts live in topLayer, so they follow top-side visibility.
   *  Parts flagged `hidden: true` by `deriveBoardView` (outside the selected
   *  board) are never visible. */
  private isPartVisible(part: { side: string; hidden?: boolean }): boolean {
    if (part.hidden) return false;
    if (part.side === 'bottom') return this.isBottomVisible;
    return this.isTopVisible; // 'top' and 'both'
  }

  private app: Application;
  private viewport!: Viewport;
  private selectionGfx!: Graphics;
  private netDimGfx!: Graphics;
  /** Container for part-name labels drawn above the net-dim overlay */
  private netLabelLayer!: Container;
  private butterflySelectionGfx!: Graphics;
  private netLinesGfx!: Graphics;
  /** Render layer that lifts selection-related labels above netLinesGfx in render order.
   *  Labels keep scene.root as logical parent (for transform inheritance) but render
   *  after the net lines via this layer. */
  private selectionLabelLayer!: RenderLayer;
  /** Ghost outlines for cross-side net components (hidden side, semi-transparent + pulsing) */
  private crossSideGhostGfx!: Graphics;
  /** Part indices currently drawn as cross-side ghosts (for ticker-driven pulse redraw) */
  private crossSideGhostParts: number[] = [];
  private debugVertexLabels: Text[] = [];
  private debugVertexPositions: Array<{x: number; y: number}> = [];
  private board: BoardData | null = null;
  private unsubscribeBoard: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeTheme: (() => void) | null = null;
  private unsubscribeViewCommands: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private containerEl: HTMLDivElement;
  private initialized = false;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
  private boundDblClick: ((e: MouseEvent) => void) | null = null;
  private tooltipEl: HTMLDivElement | null = null;
  private tooltipNetSpan: HTMLSpanElement | null = null;
  private tooltipDetailSpan: HTMLSpanElement | null = null;
  private tooltipObdSpan: HTMLSpanElement | null = null;  // OBD diode/V/Ω line
  private tooltipCanvas: HTMLCanvasElement | null = null;  // canvas ref for listener cleanup
  private boundHover: ((e: PointerEvent) => void) | null = null;
  private boundHideTooltip: (() => void) | null = null;
  /** Net name currently under the pointer (for ambient dim hover highlight) */
  private hoverNet: string | null = null;
  /** Bound wheel wake-up handler for cleanup */
  private boundWheelWake: ((e: WheelEvent) => void) | null = null;
  /** Bound shift+wheel handler — intercepts before pixi-viewport to implement scroll bindings */
  private boundShiftWheel: ((e: WheelEvent) => void) | null = null;
  private boundDragZoomDown: ((e: PointerEvent) => void) | null = null;
  /** Set to true when a drag-to-zoom gesture actually moved (committed past the
   *  threshold). Consumed by the next `handleClick` to prevent a stale selection:
   *  pixi-viewport's InputManager never sees the pointermoves (drag-zoom
   *  stopPropagation's them), so it still emits 'clicked' on pointerup. */
  private dragZoomConsumedClick = false;
  /** If a drag-zoom gesture is active, holds its cleanup function so dispose()
   *  can force-remove the per-gesture window listeners. */
  private activeDragZoomCleanup: (() => void) | null = null;
  /** Timer to re-pause ticker after wheel activity on an unfocused panel */
  private wheelIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private hudEl: HTMLDivElement | null = null;
  private selectionOverlayEl: HTMLDivElement | null = null;
  private perfOverlayEl: HTMLDivElement | null = null;
  private perfToggleBtn: HTMLButtonElement | null = null;
  private perfToggleBtnHandler: (() => void) | null = null;
  private perfVisible = false;

  // Perf overlay accumulators (reset every ~500ms)
  private perfSamples = 0;
  private perfAccum = { lod: 0, selection: 0, netLines: 0, gpuRender: 0, frame: 0 };
  private perfDisplay = { lod: 0, selection: 0, netLines: 0, gpuRender: 0, frame: 0 };
  private perfThrottle = 0;

  // Elevated labels — persistent BitmapText + background Graphics for selected part/pin
  private elevatedPartLabel: BitmapText | null = null;
  private elevatedPartBg: Graphics | null = null;
  private elevatedPinLabel: BitmapText | null = null;
  private elevatedPinBg: Graphics | null = null;
  // Pin labels raised above the ambient dim overlay for the selected part.
  // Each entry remembers where to put the child back on the next update.
  private raisedPinLabels: { child: Container; parent: Container; index: number }[] = [];
  // The bright-white clone of the selected part's name label (lives in
  // netLabelLayer). Tracked so the per-tick loop can fade its alpha when the
  // part grows large enough on screen that the label would cover pins.
  private selectedPartLabelClone: BitmapText | null = null;

  // On-demand rendering: only render when something changed
  private needsRender = true;

  // LoD zoom tracking — updated by ticker
  private lastLodScale = -1;

  // Hide-text-during-zoom: detect actual zooming via per-frame scale comparison
  private zoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private textHiddenForZoom = false;
  private netLinesHiddenForZoom = false;
  private prevTickScale = -1;

  // Selection blink state (triggered by focusPart / PDF reverse search)
  private selectionBlinkPhase = 0;
  private selectionBlinkTimer: ReturnType<typeof setTimeout> | null = null;
  // Last-rendered selection — used to skip redundant renderSelection() on tab switch
  private lastRenderedSel = { partIndex: null as number | null, pinIndex: null as number | null, highlightedNet: null as string | null, searchLen: 0, board: null as BoardData | null, showNetDim: false, butterfly: false, showTop: true, showBottom: true, showGhosts: true };
  // Track previous top/bottom state for flip-to-center
  private prevShowTop = true;
  private prevShowBottom = false;

  // Net line pulse animation phase (0–1, driven by ticker)
  private netLinePulsePhase = 0;
  // Pool index for reusing BitmapText children in netLabelLayer
  private netLabelPoolIdx = 0;

  // Animated zoom state
  private zoomAnim: {
    fromX: number; fromY: number; fromScaleX: number; fromScaleY: number;
    toX: number; toY: number; toScaleX: number; toScaleY: number;
    elapsed: number; duration: number;
  } | null = null;

  // Net line geometry cache — avoid O(N) recomputation every frame for pulse/dash animation.
  // Only recomputed when selection, viewport, or visibility changes.
  private netLineSegments: { start: Point; end: Point }[] = [];
  private netLinesDirty = true;
  /** Extra state tracked for fade logic */
  private netLineFadeDist = 0;
  private netLineSettleTimer: ReturnType<typeof setTimeout> | null = null;

  // Scene cache: avoid rebuilding PixiJS objects on tab switch
  private sceneCache = new Map<string, BoardScene>();
  private boardRefs = new WeakMap<BoardData, number>();
  private boardRefCounter = 0;
  private sceneCacheKey(_board: BoardData): string {
    // Key on the raw board ref + filter state. Derived boards come and go on
    // each filter toggle, so keying on them would leak cache entries. Keying
    // on rawBoard lets repeated toggles reuse the same scene slots.
    const raw = boardStore.rawBoard ?? _board;
    let ref = this.boardRefs.get(raw);
    if (ref == null) { ref = ++this.boardRefCounter; this.boardRefs.set(raw, ref); }
    return `${ref}|${boardStore.foldMode}|${boardStore.selectedBoardIndex ?? 'all'}`;
  }
  private activeScene: BoardScene | null = null;
  /** Snapshot of settings at the last onSettingsUpdate — enables a cheap diff
   *  to skip full scene rebuilds when only interaction-only fields changed. */
  private lastSettingsSnapshot: import('../store/render-settings').RenderSettings | null = null;

  // Spatial hash for O(1) hit-testing — maps grid cell keys to part indices.
  // Cached per (raw board, foldMode, selectedBoardIndex) via `sceneCacheKey`
  // so filter toggles reuse the same grid entry instead of leaking a new
  // one per derived-board reference.
  private hitGrid: Map<string, number[]> = new Map();
  private hitGridCellSize = 0;
  private hitGridCache = new Map<string, { grid: Map<string, number[]>; cellSize: number }>();

  // WebGL context loss recovery
  private contextLost = false;
  private destroyed = false;
  private reinitializing = false;

  // Cached label counts for perf overlay — updated by applyLabelVisibility, not by iterating every 500ms
  private labelCounts = { partVis: 0, partTotal: 0, pinVis: 0, pinTotal: 0 };

  // HUD update throttle — shared across init/reinit ticker
  private hudThrottle = 0;

  // WebGL context loss handler refs (for cleanup in destroy)
  private boundContextLost: ((e: Event) => void) | null = null;
  private boundContextRestored: (() => void) | null = null;

  // Trackpad rotation gesture state
  private boundGestureStart: ((e: Event) => void) | null = null;
  private boundGestureChange: ((e: Event) => void) | null = null;

  // Pending fit-to-board: when set, the ResizeObserver will re-fit after layout stabilises.
  // This covers the case where fitToBoard() is called before a PDF panel opens and
  // shrinks the board panel — the resize triggers a deferred re-fit.
  private _pendingFit = false;
  private _pendingFitTimer: ReturnType<typeof setTimeout> | null = null;

  // PDF follow mode: debounce viewport movement before searching PDF
  private followDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFollowQuery = '';

  // applyFlips cache — skip O(N) label loop when transform params are unchanged
  private lastFlipParams: {
    butterfly: boolean;
    topRot: number; topSx: number; topSy: number;
    botRot: number; botSx: number; botSy: number;
  } | null = null;

  // Viewport state per board: restore pan/zoom on tab switch
  private viewportStates = new Map<BoardData, ViewportState>();

  /** The board tab ID this renderer is bound to (null = legacy single-renderer mode) */
  private tabId: number | null = null;

  constructor(container: HTMLDivElement, tabId?: number) {
    this.containerEl = container;
    this.tabId = tabId ?? null;
    this.app = new Application();
  }

  /** Safely stop the ticker — app or ticker may be null/destroyed. */
  private stopTicker() {
    try { this.app?.ticker?.stop(); } catch { /* context may be lost */ }
  }

  /** Shared ticker callback — used by both init() and reinitApp(). */
  private onTick = (ticker: import('pixi.js').Ticker) => {
    const perf = this.perfVisible;
    const frameStart = perf ? performance.now() : 0;

    // Drive animated zoom
    if (this.zoomAnim) {
      const a = this.zoomAnim;
      a.elapsed += ticker.deltaMS;
      const t = Math.min(a.elapsed / a.duration, 1);
      const e = this.easeOutCubic(t);
      this.viewport.scale.set(
        a.fromScaleX + (a.toScaleX - a.fromScaleX) * e,
        a.fromScaleY + (a.toScaleY - a.fromScaleY) * e,
      );
      this.viewport.position.set(
        a.fromX + (a.toX - a.fromX) * e,
        a.fromY + (a.toY - a.fromY) * e,
      );
      this.needsRender = true;
      this.netLinesDirty = true;
      if (t >= 1) this.zoomAnim = null;
    }

    // Detect active zooming by comparing scale between frames
    const curScale = Math.abs(this.viewport.scale.x);
    if (this.prevTickScale >= 0 && curScale !== this.prevTickScale) {
      this.onZoomFrame();
    }
    this.prevTickScale = curScale;

    let t0 = perf ? performance.now() : 0;
    if (this.updateLoD()) this.needsRender = true;
    if (perf) this.perfAccum.lod += performance.now() - t0;

    // Net line pulse animation — only when there's an active selection with net lines.
    // Skip during active zoom (net lines are hidden, no point redrawing).
    const hasGhosts = this.crossSideGhostParts.length > 0;
    if (!this.netLinesHiddenForZoom && ((boardStore.netLineMode !== 'off' && boardStore.selection.highlightedNet) || hasGhosts)) {
      const s = renderSettingsStore.settings;
      const needsPulse = s.netLineDashed || s.netLinePulse || hasGhosts;
      if (needsPulse) {
        this.netLinePulsePhase = (this.netLinePulsePhase + ticker.deltaMS / 1000) % 1;
        t0 = perf ? performance.now() : 0;
        this.renderNetLines();
        if (hasGhosts) this.renderCrossSideGhosts();
        if (perf) this.perfAccum.netLines += performance.now() - t0;
        this.needsRender = true;
      }
    }

    this.updateDebugVertexLabels();

    // On-demand GPU render — skip when nothing changed (e.g. idle at high zoom)
    // Also skip if WebGL context was lost — PixiJS internals are corrupted
    if (this.needsRender && !this.contextLost) {
      this.needsRender = false;
      t0 = perf ? performance.now() : 0;
      try {
        this.app.render();
      } catch (err) {
        this.handleRenderCrash(err);
        return;
      }
      if (perf) this.perfAccum.gpuRender += performance.now() - t0;
    }

    if (perf) {
      this.perfAccum.frame += performance.now() - frameStart;
      this.perfSamples++;
    }

    // HUD update (DOM only, no GPU cost) — throttle to ~4 updates/sec
    this.hudThrottle += ticker.deltaMS;
    if (this.hudThrottle >= 250) {
      this.hudThrottle = 0;
      this.updateHud(ticker.FPS);
    }

    // Perf overlay update — flush accumulators every ~500ms
    if (this.perfVisible) {
      this.perfThrottle += ticker.deltaMS;
      if (this.perfThrottle >= 500) {
        this.flushPerfOverlay();
        this.perfThrottle = 0;
      }
    }
  };

  /** Pause the renderer (stop ticker, zero CPU cost). Call when panel is hidden. */
  pause() {
    log.render.log('pause', 'tab=' + this.tabId);
    if (boardStore.activeTabId === this.tabId) {
      log.render.warn(`pausing the store-active renderer tab=${this.tabId} — possible spurious isActive=false`);
    } else {
      log.render.log(`pause tab=${this.tabId} storeActive=${boardStore.activeTabId}`);
    }
    // Cancel pending follow-PDF debounce
    if (this.followDebounceTimer) { clearTimeout(this.followDebounceTimer); this.followDebounceTimer = null; }
    // Just stop the ticker — do NOT destroy the Application.
    // PixiJS v8 uses module-level batch pools that get permanently corrupted
    // by app.destroy(), making all future Applications crash with
    // "_DefaultBatcher2.break: Cannot read properties of null (reading 'clear')".
    this.stopTicker();
  }

  /** Re-pause the ticker after wheel activity if this panel isn't the active Dockview panel. */
  private scheduleWheelIdlePause() {
    if (this.wheelIdleTimer) clearTimeout(this.wheelIdleTimer);
    this.wheelIdleTimer = setTimeout(() => {
      this.wheelIdleTimer = null;
      // Only auto-pause if this renderer's panel is NOT the active board tab
      if (boardStore.activeTabId !== this.tabId && this.app.ticker.started) {
        this.stopTicker();
      }
    }, 300);
  }

  /**
   * Tear down the scene and canvas without calling app.destroy().
   *
   * PixiJS v8's app.destroy() triggers GlobalResourceRegistry.clear() which
   * destroys the module-level batchPool shared by ALL Application instances.
   * This permanently corrupts rendering for every other renderer on the page.
   * Instead, we just remove the canvas from the DOM, clear scenes, and let GC
   * reclaim GPU resources when the Application becomes unreferenced.
   */
  private teardownForReinit() {
    log.render.log('teardownForReinit', 'tab=' + this.tabId);

    // Save viewport state
    if (this.board && this.viewport) {
      try {
        this.viewportStates.set(this.board, {
          x: this.viewport.x,
          y: this.viewport.y,
          scaleX: this.viewport.scale.x,
          scaleY: this.viewport.scale.y,
        });
      } catch { /* viewport may be in bad state */ }
    }

    // Stop the ticker first so no more callbacks fire during teardown
    this.stopTicker();

    // Evict scene cache (GPU objects will be invalid after new app)
    try { this.invalidateAllScenes(); } catch (e) { log.render.warn('teardown invalidateAllScenes error:', e); }
    this.activeScene = null;
    this.sceneCache.clear();
    this.hitGridCache.clear();

    // Remove canvas event listeners and canvas from DOM
    try {
      const canvas = this.app?.renderer?.canvas as HTMLCanvasElement | undefined;
      if (canvas && this.boundHover) {
        canvas.removeEventListener('pointermove', this.boundHover);
        canvas.removeEventListener('pointerleave', this.boundHideTooltip!);
        if (this.boundWheelWake) canvas.removeEventListener('wheel', this.boundWheelWake);
      }
      canvas?.parentElement?.removeChild(canvas);
    } catch (e) { log.render.warn('teardown canvas cleanup error:', e); }

    // Do NOT call app.destroy() — it corrupts the global batch pool.
    // Instead, explicitly release the WebGL context so the browser can reclaim the
    // GPU slot (browsers limit WebGL contexts to ~8-16). Then null out references
    // so GC can collect the Application and its scene graph.
    try {
      const gl = (this.app?.renderer as any)?.gl as WebGL2RenderingContext | undefined;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* ignore — renderer may already be gone */ }
    log.render.log(`teardownForReinit tab=${this.tabId} — old app released (context lost, no destroy)`);
  }

  /** Resume the renderer (restart ticker). Call when panel becomes visible. */
  resume() {
    if (this.destroyed) return;
    // GPU was released (pause/context loss) — need full re-init
    if (this.contextLost) {
      log.render.log(`resume → reinitApp tab=${this.tabId}`);
      this.reinitApp();
      return;
    }

    const w = this.containerEl.clientWidth;
    const h = this.containerEl.clientHeight;
    log.render.log(`resume tab=${this.tabId} size=${w}x${h} scene=${this.activeScene ? 'yes' : 'null'} ticker=${this.app.ticker.started} storeActive=${boardStore.activeTabId}`);
    this.app.ticker.start();
    this.needsRender = true;
    // Re-sync with container size (may have been 0 while hidden)
    if (w > 0 && h > 0 && this.viewport) {
      this.viewport.resize(w, h);
      this.app.renderer.resize(w, h);
    }
    // Sync with current store state
    this.onBoardUpdate();

    // If the container had 0 dimensions (dockview hasn't shown it yet), schedule
    // a deferred sync so the first render uses correct viewport size.
    if ((w === 0 || h === 0) && this.viewport) {
      requestAnimationFrame(() => {
        if (!this.app.ticker.started) return; // paused again before callback
        const dw = this.containerEl.clientWidth;
        const dh = this.containerEl.clientHeight;
        if (dw > 0 && dh > 0) {
          log.render.log('resume deferred resize', dw, 'x', dh);
          this.viewport.resize(dw, dh);
          this.app.renderer.resize(dw, dh);
          this.needsRender = true;
          this.onBoardUpdate();
        }
      });
    }
  }

  /** Force a full scene re-activation — use the restart button to recover a broken render. */
  restartRender() {
    log.render.log(`restartRender tab=${this.tabId} initialized=${this.initialized} contextLost=${this.contextLost} board=${this.board ? this.board.format : 'null'}`);
    if (!this.initialized) return;
    // Clear the contextLost flag so rendering can resume
    this.contextLost = false;
    // Use renderer's own board reference (works even if boardStore active tab is wrong)
    const board = this.board ?? boardStore.tabs.find(t => t.id === this.tabId)?.board ?? null;
    if (!board) {
      log.render.log(`restartRender: no board — nothing to rebuild`);
      return;
    }
    // Evict cached scene so buildBoardScene runs fresh, then re-activate directly
    const key = this.sceneCacheKey(board);
    this.sceneCache.delete(key);
    this.hitGridCache.delete(key);
    this.activateScene(board);
    this.board = board;
    // Resync board store so onBoardUpdate won't skip future notifications
    if (this.tabId != null) boardStore.switchTab(this.tabId);
    if (!this.app.ticker.started) {
      log.render.log(`restartRender: restarting stopped ticker`);
      this.app.ticker.start();
    }
    this.needsRender = true;
  }

  /**
   * Handle a crash during app.render() — typically caused by WebGL context loss
   * or PixiJS v8 batch pool corruption.
   *
   * We do NOT call app.destroy() here because that corrupts the global batch pool
   * and makes ALL renderers crash. Instead we just stop the ticker and let the user
   * use the "Restart Render" button (restartRender) which rebuilds the scene without
   * destroying the Application.
   */
  private handleRenderCrash(err: unknown) {
    if (this.contextLost) return; // already handled
    this.contextLost = true;
    log.render.error(`render crash tab=${this.tabId} — ticker stopped, use Restart Render to recover:`, err);
    this.stopTicker();
  }

  /** Install WebGL context loss/restore handlers on a canvas element. */
  private installContextLossHandlers(canvas: HTMLCanvasElement) {
    // Remove previous handlers if any (reinitApp creates a new canvas)
    this.removeContextLossHandlers();

    this.boundContextLost = (e: Event) => {
      e.preventDefault();
      if (this.destroyed) return;
      this.contextLost = true;
      log.render.warn(`WebGL context lost tab=${this.tabId} — will recover on resume`);
      this.stopTicker();
    };
    this.boundContextRestored = () => {
      log.render.log(`WebGL context restored event tab=${this.tabId} — deferring recovery to resume()`);
    };
    canvas.addEventListener('webglcontextlost', this.boundContextLost);
    canvas.addEventListener('webglcontextrestored', this.boundContextRestored);
  }

  /** Remove context loss handlers from the current canvas. */
  private removeContextLossHandlers() {
    const canvas = this.app?.renderer?.canvas as HTMLCanvasElement | undefined;
    if (canvas && this.boundContextLost) {
      canvas.removeEventListener('webglcontextlost', this.boundContextLost);
      canvas.removeEventListener('webglcontextrestored', this.boundContextRestored!);
    }
    this.boundContextLost = null;
    this.boundContextRestored = null;
  }

  /**
   * Full re-initialization after GPU release or WebGL context loss.
   * Creates a fresh PixiJS Application, preserving subscriptions, DOM overlays,
   * and board data. Called by resume() when contextLost is true.
   */
  private async reinitApp() {
    log.render.log('reinitApp ENTER', 'tab=' + this.tabId, 'contextLost=' + this.contextLost, 'board=' + (this.board ? this.board.format : 'null'));
    if (this.destroyed) return;
    if (this.reinitializing) {
      log.render.log('reinitApp SKIPPED (already reinitializing)', 'tab=' + this.tabId);
      return;
    }
    this.reinitializing = true;
    log.render.log(`reinitApp START tab=${this.tabId} board=${this.board ? this.board.format + '/' + this.board.parts.length + 'parts' : 'null'}`);

    const savedBoard = this.board;

    // Tear down old app's scene/canvas without calling app.destroy()
    this.teardownForReinit();
    this.contextLost = false;

    // --- Create fresh Application ---
    log.render.log(`reinitApp: creating new Application tab=${this.tabId}`);
    this.app = new Application();
    try {
      await this.app.init({
        background: COLORS.background,
        width: this.containerEl.clientWidth || 1,
        height: this.containerEl.clientHeight || 1,
        antialias: true,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true,
        powerPreference: 'high-performance',
      });
      log.render.log(`reinitApp: app.init succeeded tab=${this.tabId} size=${this.containerEl.clientWidth}x${this.containerEl.clientHeight}`);
    } catch (err) {
      log.render.error(`reinitApp: app.init FAILED tab=${this.tabId}:`, err);
      this.reinitializing = false;
      return;
    }

    this.containerEl.appendChild(this.app.canvas as HTMLCanvasElement);
    this.app.ticker.maxFPS = 60;
    this.app.ticker.remove(this.app.render, this.app);

    // --- Recreate Viewport ---
    this.viewport = new Viewport({
      screenWidth: this.containerEl.clientWidth || 1,
      screenHeight: this.containerEl.clientHeight || 1,
      events: this.app.renderer.events,
    });
    this.applyViewportPlugins();
    this.installShiftWheelHandler();
    this.installDragZoomHandler();
    this.viewport.on('moved', () => { this.needsRender = true; this.netLinesDirty = true; this.scheduleFollowDebounce(); });
    this.viewport.on('clicked', (e: ViewportClickEvent) => { this.handleClick(e.world); });
    this.app.stage.addChild(this.viewport);

    // --- Recreate overlay Graphics (old ones were destroyed with the old app) ---
    // zIndex values must match init() — see comments there for the full layering map.
    this.selectionGfx = new Graphics();
    this.selectionGfx.zIndex = 30;
    this.netDimGfx = new Graphics();
    this.netDimGfx.zIndex = 10;
    this.netLabelLayer = new Container();
    this.netLabelLayer.zIndex = 35;
    this.butterflySelectionGfx = new Graphics();
    this.netLinesGfx = new Graphics();
    this.crossSideGhostGfx = new Graphics();
    this.crossSideGhostGfx.zIndex = 15;
    this.selectionLabelLayer = new RenderLayer({ sortableChildren: true });
    this.viewport.addChild(this.netLinesGfx);
    this.viewport.addChild(this.selectionLabelLayer);

    // Recreate elevated labels (see init() for detailed comments)
    const labelStyle = { fontSize: 12, fill: BOARD_COLORS.labelPin, fontFamily: 'monospace' };
    this.elevatedPartBg = new Graphics();
    this.elevatedPartBg.zIndex = 100;
    this.elevatedPartLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPartLabel.anchor.set(0.5, 0.5);
    this.elevatedPartLabel.zIndex = 101;
    this.elevatedPartLabel.visible = false;
    this.elevatedPartBg.visible = false;
    this.elevatedPinBg = new Graphics();
    this.elevatedPinBg.zIndex = 102;
    this.elevatedPinLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPinLabel.anchor.set(0.5, 0.5);
    this.elevatedPinLabel.zIndex = 103;
    this.elevatedPinLabel.visible = false;
    this.elevatedPinBg.visible = false;

    // --- Reinstall canvas event listeners ---
    const newCanvas = this.app.renderer.canvas as HTMLCanvasElement;
    this.tooltipCanvas = newCanvas;
    if (this.boundHover) {
      newCanvas.addEventListener('pointermove', this.boundHover);
      newCanvas.addEventListener('pointerleave', this.boundHideTooltip!);
      if (this.boundWheelWake) newCanvas.addEventListener('wheel', this.boundWheelWake, { passive: true });
    }
    this.installContextLossHandlers(newCanvas);

    // Reinstall shared ticker callback
    this.hudThrottle = 0;
    this.app.ticker.add(this.onTick);

    // --- Reset state and rebuild scene ---
    log.render.log(`reinitApp: resetting state & rebuilding scene tab=${this.tabId}`);
    this.lastLodScale = -1;
    this.prevTickScale = -1;
    this.lastFlipParams = null;
    this.netLinesDirty = true;
    this.needsRender = true;

    if (savedBoard) {
      log.render.log(`reinitApp: activateScene for ${savedBoard.format}/${savedBoard.parts.length}parts tab=${this.tabId}`);
      this.activateScene(savedBoard);
      this.board = savedBoard;
    } else {
      log.render.warn(`reinitApp: no saved board — nothing to rebuild tab=${this.tabId}`);
    }

    this.initialized = true;
    this.app.ticker.start();
    this.reinitializing = false;

    // Sync with current store state (applies layer visibility, selection, etc.)
    this.onBoardUpdate();

    log.render.log(`reinitApp COMPLETE tab=${this.tabId} board=${savedBoard ? savedBoard.format : 'null'} tickerStarted=${this.app.ticker.started} scene=${this.activeScene ? 'yes' : 'null'}`);
  }

  async init() {
    log.render.log('init', this.containerEl.clientWidth, 'x', this.containerEl.clientHeight);
    try {
    await this.app.init({
      background: COLORS.background,
      width: this.containerEl.clientWidth,
      height: this.containerEl.clientHeight,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      powerPreference: 'high-performance',
    });
    // React StrictMode (and fast HMR) can run mount → unmount → remount while
    // `app.init()` is mid-await. The cleanup path calls destroy() synchronously,
    // which nulls `this.app` (see the bottom of destroy()). When the awaited
    // promise finally resolves we'd continue executing here with this.app ===
    // null, crashing at .canvas access. Bail out quietly in that case — the
    // remount will create a fresh BoardRenderer.
    if (this.destroyed || !this.app) {
      log.render.log(`init: aborted — renderer destroyed during app.init (tab=${this.tabId})`);
      return;
    }
    this.containerEl.appendChild(this.app.canvas as HTMLCanvasElement);
    this.initialized = true;

    this.app.ticker.maxFPS = 60;

    // Remove the TickerPlugin's auto-render so we control when GPU work happens.
    // The ticker still fires our callbacks; we call app.render() only when needsRender is set.
    this.app.ticker.remove(this.app.render, this.app);

    this.viewport = new Viewport({
      screenWidth: this.containerEl.clientWidth,
      screenHeight: this.containerEl.clientHeight,
      events: this.app.renderer.events,
    });

    this.applyViewportPlugins();
    this.installShiftWheelHandler();
    this.installDragZoomHandler();

    // Viewport pan/zoom/decelerate → mark dirty so we render
    this.viewport.on('moved', () => { this.needsRender = true; this.netLinesDirty = true; this.scheduleFollowDebounce(); });
    this.app.stage.addChild(this.viewport);

    // Overlay objects live inside scene.root (sortableChildren=true).
    // zIndex values define the render order — higher = rendered later = on top.
    //   0        board content (outline, layers, pins, labels) — default zIndex
    //   10       netDimGfx          — dim/fade non-selected nets
    //   30       selectionGfx       — yellow highlight rectangles around selected parts/pins
    //   35       netLabelLayer      — net/pin labels raised above dim + selection
    //   100-103  elevated labels    — part/pin name badges, always topmost
    this.selectionGfx = new Graphics();
    this.selectionGfx.zIndex = 30;
    this.netDimGfx = new Graphics();
    this.netDimGfx.zIndex = 10;
    this.netLabelLayer = new Container();
    this.netLabelLayer.zIndex = 35;
    this.butterflySelectionGfx = new Graphics();
    this.netLinesGfx = new Graphics();
    this.crossSideGhostGfx = new Graphics();
    this.crossSideGhostGfx.zIndex = 15; // above dim (10), below labels (20) and selection (30)
    this.selectionLabelLayer = new RenderLayer({ sortableChildren: true });

    // Elevated labels for selected part/pin — persistent objects reused across
    // scene switches. Visibility is toggled in updateElevatedLabels() each frame.
    // High zIndex ensures they render above all board content (pins, borders,
    // selection highlight) regardless of child insertion order.
    const labelStyle = { fontSize: 12, fill: BOARD_COLORS.labelPin, fontFamily: 'monospace' };
    this.elevatedPartBg = new Graphics();
    this.elevatedPartBg.zIndex = 100;
    this.elevatedPartLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPartLabel.anchor.set(0.5, 0.5);
    this.elevatedPartLabel.zIndex = 101;
    this.elevatedPartLabel.visible = false;
    this.elevatedPartBg.visible = false;
    this.elevatedPinBg = new Graphics();
    this.elevatedPinBg.zIndex = 102;
    this.elevatedPinLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPinLabel.anchor.set(0.5, 0.5);
    this.elevatedPinLabel.zIndex = 103;
    this.elevatedPinLabel.visible = false;
    this.elevatedPinBg.visible = false;
    this.viewport.addChild(this.netLinesGfx);
    this.viewport.addChild(this.selectionLabelLayer);

    this.viewport.on('clicked', (e: ViewportClickEvent) => {
      this.handleClick(e.world);
    });

    this.boundContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      this.handleRightClick(e);
    };
    this.containerEl.addEventListener('contextmenu', this.boundContextMenu);

    this.boundDblClick = (e: MouseEvent) => { this.handleDblClick(e); };
    this.containerEl.addEventListener('dblclick', this.boundDblClick);

    // Hover tooltip — listens directly on the PixiJS canvas (the actual event target)
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'pin-net-tooltip';
    this.tooltipNetSpan = document.createElement('span');
    this.tooltipNetSpan.className = 'pnt-net';
    this.tooltipDetailSpan = document.createElement('span');
    this.tooltipDetailSpan.className = 'pnt-detail';
    this.tooltipObdSpan = document.createElement('span');
    this.tooltipObdSpan.className = 'pnt-obd';
    this.tooltipObdSpan.style.display = 'none';
    this.tooltipObdSpan.style.fontFamily = 'monospace';
    this.tooltipObdSpan.style.fontSize = '11px';
    this.tooltipObdSpan.style.color = '#9f9';
    this.tooltipObdSpan.style.marginTop = '2px';
    this.tooltipEl.append(this.tooltipNetSpan, this.tooltipDetailSpan, this.tooltipObdSpan);
    this.containerEl.appendChild(this.tooltipEl);
    this.tooltipCanvas = this.app.renderer.canvas as HTMLCanvasElement;
    this.boundHover = (e: PointerEvent) => this.handleHover(e);
    this.boundHideTooltip = () => { this.hideTooltip(); this.setHoverNet(null); };
    this.tooltipCanvas.addEventListener('pointermove', this.boundHover);
    this.tooltipCanvas.addEventListener('pointerleave', this.boundHideTooltip);

    // Wheel wake-up: if the ticker is stopped (panel not focused), restart it
    // so zoom/scroll gestures render immediately without needing a click first.
    // The ticker auto-pauses after 300ms of idle when the panel isn't active.
    this.boundWheelWake = () => {
      if (!this.app.ticker.started && !this.destroyed && !this.contextLost) {
        this.app.ticker.start();
        this.needsRender = true;
      }
      this.scheduleWheelIdlePause();
    };
    this.tooltipCanvas.addEventListener('wheel', this.boundWheelWake, { passive: true });

    // WebGL context loss recovery — browser may reclaim context when canvas is hidden
    this.installContextLossHandlers(this.app.renderer.canvas as HTMLCanvasElement);

    // Rotation gestures disabled — they conflict with pinch-to-zoom on touch devices.
    // Suppress gesturestart/gesturechange to prevent accidental board rotation.
    this.boundGestureStart = (e: Event) => { e.preventDefault(); };
    this.boundGestureChange = (e: Event) => { e.preventDefault(); };
    this.containerEl.addEventListener('gesturestart', this.boundGestureStart, { passive: false });
    this.containerEl.addEventListener('gesturechange', this.boundGestureChange, { passive: false });

    this.unsubscribeBoard = boardStore.subscribe(() => this.onBoardUpdate());
    this.unsubscribeSettings = renderSettingsStore.subscribe(() => this.onSettingsUpdate());
    this.unsubscribeTheme = themeStore.subscribe(() => this.onThemeUpdate());
    this.unsubscribeViewCommands = viewCommands.subscribe((cmd, payload) => {
      if (cmd === 'pan' && this.tabId === boardStore.activeTabId) {
        this.panView(payload as PanDirection);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      const w = this.containerEl.clientWidth;
      const h = this.containerEl.clientHeight;
      // Skip 0-size resizes (panel hidden by dockview tab switch)
      if (w === 0 || h === 0) return;
      this.viewport.resize(w, h);
      this.app.renderer.resize(w, h);
      this.needsRender = true;
      // If ticker is stopped (panel inactive), do a one-shot render so the
      // resized canvas isn't left black until the user clicks.
      if (!this.app.ticker.started && !this.contextLost) {
        try { this.app.render(); } catch { /* ignore if context lost */ }
        this.needsRender = false;
      }

      // When a fit-to-board is pending (e.g. initial load), re-fit after each
      // resize. Debounce so we only fit once the layout has stabilised (e.g.
      // after a PDF panel finishes opening and the board panel stops resizing).
      if (this._pendingFit) {
        if (this._pendingFitTimer) clearTimeout(this._pendingFitTimer);
        this._pendingFitTimer = setTimeout(() => {
          this._pendingFitTimer = null;
          if (this._pendingFit && !this.destroyed) {
            this._pendingFit = false;
            this.fitToBoard();
          }
        }, 150);
      }
    });
    this.resizeObserver.observe(this.containerEl);

    // HUD overlay (zoom + FPS)
    this.hudEl = document.createElement('div');
    this.hudEl.className = 'board-hud';
    this.containerEl.style.position = 'relative';
    this.containerEl.appendChild(this.hudEl);

    // Selection overlay (big centered text showing component/net name)
    this.selectionOverlayEl = document.createElement('div');
    this.selectionOverlayEl.className = 'board-selection-overlay';
    this.containerEl.appendChild(this.selectionOverlayEl);

    // Perf overlay (per-phase CPU timings) + toggle button
    this.perfOverlayEl = document.createElement('div');
    this.perfOverlayEl.className = 'board-perf-overlay';
    this.perfOverlayEl.style.display = 'none';
    this.containerEl.appendChild(this.perfOverlayEl);

    this.perfToggleBtn = document.createElement('button');
    this.perfToggleBtn.className = 'board-perf-toggle';
    this.perfToggleBtn.textContent = 'i';
    this.perfToggleBtn.title = 'Toggle performance overlay';
    this.perfToggleBtnHandler = () => {
      this.perfVisible = !this.perfVisible;
      if (!this.perfVisible) {
        this.perfOverlayEl!.style.display = 'none';
        this.perfAccum = { lod: 0, selection: 0, netLines: 0, gpuRender: 0, frame: 0 };
        this.perfSamples = 0;
        this.perfThrottle = 0;
      }
    };
    this.perfToggleBtn.addEventListener('click', this.perfToggleBtnHandler);
    this.containerEl.appendChild(this.perfToggleBtn);

    // Combined ticker: LoD updates + net line animation + HUD + on-demand render
    this.hudThrottle = 0;
    this.app.ticker.add(this.onTick);
    this.app.ticker.start();

    // Pick up any board data that loaded during async init
    this.onBoardUpdate();
    const tabLabel = this.tabId !== null ? ` (tab ${this.tabId})` : '';
    log.render.log(`Initialized${tabLabel}: ${this.containerEl.clientWidth}×${this.containerEl.clientHeight}`);
    } catch (err) {
      log.render.error('init failed:', err);
      throw err;
    }
  }

  /** Update the HUD overlay with rendering stats */
  private updateHud(tickerFps: number) {
    if (!this.hudEl) return;

    const zoom = Math.round(Math.abs(this.viewport.scale.x) * 100);
    const fps = Math.round(tickerFps);
    const gpuText = this.needsRender ? '' : ' · gpu idle';

    let sceneText = '';
    const scene = this.activeScene;
    if (scene) {
      const labelCount = scene.topLabels.length + scene.bottomLabels.length
        + scene.topPinLabels.length + scene.bottomPinLabels.length;
      sceneText = ` · ${labelCount} labels`;
    }

    this.hudEl.textContent = `${zoom}% · ${fps} fps${sceneText}${gpuText}`;
  }

  /** Flush perf accumulators and update the perf overlay DOM */
  private flushPerfOverlay() {
    if (!this.perfOverlayEl || !this.perfVisible) return;

    const n = Math.max(this.perfSamples, 1);
    this.perfDisplay.lod = this.perfAccum.lod / n;
    this.perfDisplay.selection = this.perfAccum.selection / n;
    this.perfDisplay.netLines = this.perfAccum.netLines / n;
    this.perfDisplay.gpuRender = this.perfAccum.gpuRender / n;
    this.perfDisplay.frame = this.perfAccum.frame / n;

    // Reset accumulators
    this.perfAccum = { lod: 0, selection: 0, netLines: 0, gpuRender: 0, frame: 0 };
    this.perfSamples = 0;

    // Label sub-counts from cache — maintained by applyLabelVisibility(), zero per-label work here
    const { partVis, partTotal, pinVis, pinTotal } = this.labelCounts;

    const f = (ms: number) => ms < 0.01 ? '0' : ms.toFixed(2);
    const d = this.perfDisplay;
    this.perfOverlayEl.textContent =
      `frame: ${f(d.frame)}ms` +
      ` | lod: ${f(d.lod)}ms` +
      ` | sel: ${f(d.selection)}ms` +
      ` | net: ${f(d.netLines)}ms` +
      ` | gpu: ${f(d.gpuRender)}ms` +
      `\npart labels: ${partVis}/${partTotal}` +
      ` | pin labels: ${pinVis}/${pinTotal}`;
    this.perfOverlayEl.style.display = '';
  }

  /** Called per frame when viewport scale is actively changing (user is zooming) */
  private onZoomFrame() {
    const s = renderSettingsStore.settings;
    // Hide all labels on first zoom frame — O(1) container toggle, no per-label iteration
    if (s.hideTextDuringZoom && !this.textHiddenForZoom) {
      this.textHiddenForZoom = true;
      const scene = this.activeScene;
      if (scene) {
        scene.topCircleLabelLayer.visible = false;
        scene.bottomCircleLabelLayer.visible = false;
        scene.topTwoPinNetLayer.visible = false;
        scene.bottomTwoPinNetLayer.visible = false;
      }
    }
    // Hide net lines during active zoom instead of redrawing every frame.
    // The geometry changes with viewport scale (line widths are scale-dependent),
    // so deferring to the settle timer avoids expensive per-frame Graphics redraws.
    if (!this.netLinesHiddenForZoom && this.netLineSegments.length > 0) {
      this.netLinesHiddenForZoom = true;
      this.netLinesGfx.clear();
      this.crossSideGhostGfx.clear();
      this.needsRender = true;
    }
    // Rescale elevated selection labels to maintain constant screen-pixel size
    this.updateElevatedLabels(boardStore.selection, s);
    // Reset settle timer on every zoom frame
    if (this.zoomSettleTimer) clearTimeout(this.zoomSettleTimer);
    // Restore labels + net lines after zoom settles (~2 frames idle)
    this.zoomSettleTimer = setTimeout(() => {
      this.zoomSettleTimer = null;
      if (this.textHiddenForZoom) {
        this.textHiddenForZoom = false;
        this.applyLabelVisibility();
      }
      if (this.netLinesHiddenForZoom) {
        this.netLinesHiddenForZoom = false;
        this.netLinesDirty = true;
        this.renderNetLines();
        if (this.crossSideGhostParts.length > 0) this.renderCrossSideGhosts();
      }
      this.needsRender = true;
    }, 32);
  }

  /** Update level-of-detail based on current viewport zoom. Returns true if scale changed. */
  private updateLoD(): boolean {
    const scale = Math.abs(this.viewport.scale.x);
    if (scale === this.lastLodScale) return false;
    // Skip if scale change is negligible — 10% threshold avoids cascading LoD updates
    // from viewport deceleration drift (at high zoom, 5% was too loose).
    if (this.lastLodScale > 0 && Math.abs(scale - this.lastLodScale) / this.lastLodScale < 0.1) return false;
    this.lastLodScale = scale;

    const scene = this.activeScene;
    if (!scene) return true;
    const s = renderSettingsStore.settings;

    // Update label visibility via font-size groups (skip if text is hidden for zoom)
    if (!this.textHiddenForZoom) {
      this.applyLabelVisibility();
    }

    // Min border width: ensure borders are at least 1 screen pixel
    updateBorderWidths(scene.borderBatches, s.partBorderWidth, scale);

    return true;
  }


  /** Apply label visibility using font-size groups — O(groups) when nothing changes.
   *  Also keeps labelCounts cache in sync so flushPerfOverlay() never iterates labels. */
  private applyLabelVisibility() {
    const scene = this.activeScene;
    if (!scene) return;
    const s = renderSettingsStore.settings;
    const scale = Math.abs(this.viewport.scale.x);
    const minPx = s.labelMinScreenPx;
    const zoomOk = s.labelZoomHide <= 0 || scale >= s.labelZoomHide;

    let changed = false;
    for (const group of scene.fontSizeGroups) {
      const shouldBeVisible = zoomOk && group.minSize * scale >= minPx;
      if (shouldBeVisible !== group.visible) {
        group.visible = shouldBeVisible;
        for (const lbl of group.labels) lbl.visible = shouldBeVisible;
        changed = true;
      }
    }

    // Group A (circle/1-pin labels): progressive visibility by font-size bucket.
    if (!this.textHiddenForZoom) {
      const circleMinPx = s.circleLabelMinScreenPx;
      // Ensure containers are visible — individual items are toggled per group
      if (!scene.topCircleLabelLayer.visible)    { scene.topCircleLabelLayer.visible = true; changed = true; }
      if (!scene.bottomCircleLabelLayer.visible) { scene.bottomCircleLabelLayer.visible = true; changed = true; }
      for (const group of scene.circleFontSizeGroups) {
        const shouldBeVisible = zoomOk && group.minSize * scale >= circleMinPx;
        if (shouldBeVisible !== group.visible) {
          group.visible = shouldBeVisible;
          for (const item of group.items) item.visible = shouldBeVisible;
          changed = true;
        }
      }
    }

    // Group B (2-pin net labels): progressive visibility by font-size bucket.
    if (!this.textHiddenForZoom) {
      const twoPinMinPx = s.twoPinLabelMinScreenPx;
      if (!scene.topTwoPinNetLayer.visible)    { scene.topTwoPinNetLayer.visible = true; changed = true; }
      if (!scene.bottomTwoPinNetLayer.visible) { scene.bottomTwoPinNetLayer.visible = true; changed = true; }
      for (const group of scene.twoPinFontSizeGroups) {
        const shouldBeVisible = zoomOk && (twoPinMinPx <= 0 || group.minSize * scale >= twoPinMinPx);
        if (shouldBeVisible !== group.visible) {
          group.visible = shouldBeVisible;
          for (const item of group.items) item.visible = shouldBeVisible;
          changed = true;
        }
      }
    }

    if (changed) this.rebuildLabelCounts(scene);
  }

  /** Rebuild cached label counts from scratch — called once after scene switch or visibility change */
  private rebuildLabelCounts(scene: BoardScene) {
    let partVis = 0, partTotal = 0, pinVis = 0, pinTotal = 0;
    for (const lbl of scene.topLabels)    { partTotal++; if (lbl.visible) partVis++; }
    for (const lbl of scene.bottomLabels) { partTotal++; if (lbl.visible) partVis++; }
    for (const lbl of scene.topPinLabels)    { pinTotal++; if (lbl.visible) pinVis++; }
    for (const lbl of scene.bottomPinLabels) { pinTotal++; if (lbl.visible) pinVis++; }
    this.labelCounts = { partVis, partTotal, pinVis, pinTotal };
  }

  // --- Orientation ---

  /**
   * BVR files use Y-up math convention. Screen uses Y-down.
   * Always flip Y to convert, matching OpenBoardView's CoordToScreen (ty = -1 * ...).
   * User can toggle Mirror Y for manual override.
   */
  private needsYFlip(board: BoardData): boolean {
    if (board.flipY !== undefined) return board.flipY;
    return getFormat(board.format)?.flipY ?? false;
  }

  /** Apply per-layer trace, via, and component sub-layer visibility */
  private applyLayerVisibility(scene: BoardScene) {
    const { layerStates, showTraces, showVias, showSilkscreen, showPads, showCopperDrops, showComponents, showPins, showOutlines, showLabels, showTop, showBottom } = boardStore;
    // Trace layer master toggle
    if (scene.traceLayer) scene.traceLayer.visible = showTraces;
    // Per-layer trace containers
    for (let i = 0; i < scene.traceLayerContainers.length; i++) {
      const c = scene.traceLayerContainers[i];
      if (c) c.visible = showTraces && (i < layerStates.length ? layerStates[i].visible : true);
    }
    // Via overlay
    if (scene.viaLayer) scene.viaLayer.visible = showVias;
    // Silkscreen — master toggle, plus follow top/bottom side visibility
    if (scene.silkscreenLayer)  scene.silkscreenLayer.visible  = showSilkscreen;
    if (scene.silkscreenTop)    scene.silkscreenTop.visible    = showTop;
    if (scene.silkscreenBottom) scene.silkscreenBottom.visible = showBottom;
    // Copper pads — same pattern
    if (scene.padsLayer)        scene.padsLayer.visible        = showPads;
    if (scene.padsTop)          scene.padsTop.visible          = showTop;
    if (scene.padsBottom)       scene.padsBottom.visible       = showBottom;
    // Standalone copper drops (GND stitching, power-rail tie pads, mounting
    // pads). Default OFF — independent toggle from real pin pads.
    if (scene.copperDropsLayer)    scene.copperDropsLayer.visible    = showCopperDrops;
    if (scene.copperDropsTop)      scene.copperDropsTop.visible      = showTop;
    if (scene.copperDropsBottom)   scene.copperDropsBottom.visible   = showBottom;
    // Component sub-layer visibility (master: showComponents)
    scene.topFillLayer.visible       = showComponents;
    scene.bottomFillLayer.visible    = showComponents;
    scene.topPinLayer.visible        = showComponents && showPins;
    scene.bottomPinLayer.visible     = showComponents && showPins;
    scene.topOutlineLayer.visible    = showComponents && showOutlines;
    scene.bottomOutlineLayer.visible = showComponents && showOutlines;
    scene.topLabelLayer.visible      = showComponents && showLabels;
    scene.bottomLabelLayer.visible   = showComponents && showLabels;
  }

  // --- Flip management ---

  /** Apply orientation, view flips, user rotation and mirror to the scene root */
  private applyFlips(board: BoardData, scene: BoardScene) {
    // applyFlips — no logging (fires frequently from onBoardUpdate)
    const butterfly = boardStore.butterfly;
    const autoFlipY = this.needsYFlip(board);
    const rotation = boardStore.rotation * Math.PI / 180;
    const cx = (board.bounds.minX + board.bounds.maxX) / 2;
    const cy = (board.bounds.minY + board.bounds.maxY) / 2;

    // When the board is rotated 90° or 270°, the visual X and Y axes are swapped
    // relative to board coordinates. Mirror operations must work in visual/screen
    // space, so swap mirrorX↔mirrorY when the axes are transposed.
    const rot90 = Math.round(boardStore.rotation / 90) % 4;
    const axesSwapped = rot90 === 1 || rot90 === 3;
    const mirrorX = axesSwapped ? boardStore.mirrorY : boardStore.mirrorX;
    const mirrorY = axesSwapped ? boardStore.mirrorX : boardStore.mirrorY;

    if (butterfly) {
      // Butterfly mode: top above, bottom below — flipped as if hinging on the bottom edge
      this.setupButterfly(board, scene);

      const bw = board.bounds.maxX - board.bounds.minX;
      const bh = board.bounds.maxY - board.bounds.minY;

      // After rotation, compute visual extents to decide separation axis
      const sinR = Math.abs(Math.sin(rotation));
      const cosR = Math.abs(Math.cos(rotation));
      const visualW = bw * cosR + bh * sinR;
      const visualH = bw * sinR + bh * cosR;

      // Separate along the shorter visual axis (side-by-side when vertical);
      // equal dimensions: default to side-by-side
      const separateX = visualH >= visualW;
      const sepDim = separateX ? visualW : visualH;
      const gap = sepDim * 0.05;
      const halfSep = sepDim / 2 + gap / 2;

      const flipY = autoFlipY !== mirrorY;
      const sx = mirrorX ? -1 : 1;
      const topSy = flipY ? -1 : 1;

      // Butterfly bottom-half mirroring.
      //
      // X-fold boards (butterflyFoldAxis='x'): the parser already X-mirrored bottom
      // parts during fold processing — they're at their overlaid positions. No
      // additional mirror needed; both halves use the same scale.
      //
      // Y-fold boards (butterflyFoldAxis='y' or default): flip the perpendicular
      // axis (Y) to create the visual fold effect. The renderer must undo the
      // parser's Y-fold mirror so the bottom appears at its unfolded position.
      let botScaleX: number, botScaleY: number;
      if (board.butterflyFoldAxis === 'x') {
        botScaleX = sx;
        botScaleY = topSy;
      } else {
        const mirrorBoardX = board.butterflyFoldAxis === 'y'
          ? false
          : separateX !== axesSwapped;
        botScaleX = mirrorBoardX ? -sx : sx;
        botScaleY = -topSy;
      }

      const dx = separateX ? halfSep : 0;
      const dy = separateX ? 0 : halfSep;

      // Top half: shifted left/up
      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx - dx, cy - dy);
      scene.root.rotation = rotation;
      scene.root.scale.set(sx, topSy);

      // Bottom half: shifted right/down, mirrored along the fold axis
      const broot = scene.butterflyRoot!;
      broot.pivot.set(cx, cy);
      broot.position.set(cx + dx, cy + dy);
      broot.rotation = rotation;
      broot.scale.set(botScaleX, botScaleY);

      // Counter-flip labels + pin numbers for readability (handedness-aware)
      const topLabelRot = -rotation * sx * topSy;
      const botLabelRot = -rotation * botScaleX * botScaleY;
      const fp = this.lastFlipParams;
      if (!fp || !fp.butterfly ||
          fp.topRot !== topLabelRot || fp.topSx !== sx || fp.topSy !== topSy ||
          fp.botRot !== botLabelRot || fp.botSx !== botScaleX || fp.botSy !== botScaleY) {
        for (const arr of [scene.topLabels, scene.topPinLabels, scene.viaLabels]) {
          for (const label of arr) { label.rotation = topLabelRot; label.scale.set(sx, topSy); }
        }
        for (const arr of [scene.bottomLabels, scene.bottomPinLabels]) {
          for (const label of arr) { label.rotation = botLabelRot; label.scale.set(botScaleX, botScaleY); }
        }
        this.lastFlipParams = { butterfly: true, topRot: topLabelRot, topSx: sx, topSy, botRot: botLabelRot, botSx: botScaleX, botSy: botScaleY };
      }
    } else {
      // Normal mode
      this.teardownButterfly(scene);

      // When viewing bottom-only, auto-mirror to simulate physically flipping
      // the board over. flipAxis controls the hinge: 'x' flips around horizontal
      // axis (top-to-bottom), 'y' flips around vertical axis (left-to-right).
      const viewingBottom = !boardStore.showTop && boardStore.showBottom;
      const flipAroundY = viewingBottom && boardStore.flipAxis === 'y';
      const flipAroundX = viewingBottom && boardStore.flipAxis === 'x';
      const flipX = mirrorX !== flipAroundY;
      const flipY = (autoFlipY !== mirrorY) !== flipAroundX;

      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx, cy);
      scene.root.rotation = rotation;
      scene.root.scale.set(flipX ? -1 : 1, flipY ? -1 : 1);

      // Counter-flip labels + pin numbers so text stays readable.
      // When an odd number of axes are flipped, coordinate handedness reverses and
      // the counter-rotation sign must flip too: label.rotation = -R * lsx * lsy.
      const lsx = flipX ? -1 : 1;
      const lsy = flipY ? -1 : 1;
      const labelRot = -rotation * lsx * lsy;
      const fp2 = this.lastFlipParams;
      if (!fp2 || fp2.butterfly ||
          fp2.topRot !== labelRot || fp2.topSx !== lsx || fp2.topSy !== lsy) {
        for (const arr of [scene.labels, scene.topPinLabels, scene.bottomPinLabels, scene.viaLabels]) {
          for (const label of arr) { label.rotation = labelRot; label.scale.set(lsx, lsy); }
        }
        this.lastFlipParams = { butterfly: false, topRot: labelRot, topSx: lsx, topSy: lsy, botRot: 0, botSx: 1, botSy: 1 };
      }
    }
  }

  /** Set up butterfly mode: move bottom layer into its own root */
  private setupButterfly(board: BoardData, scene: BoardScene) {
    if (scene.butterflyRoot) {
      // Already built — re-attach to viewport if detached (happens after tab switch)
      if (!scene.butterflyRoot.parent) {
        this.viewport.addChild(scene.butterflyRoot);
        this.viewport.removeChild(this.netLinesGfx);
        this.viewport.addChild(this.netLinesGfx);
        this.viewport.removeChild(this.selectionLabelLayer);
        this.viewport.addChild(this.selectionLabelLayer);
      }
      return;
    }
    log.render.log('setupButterfly');

    // Create butterfly root with a copy of the outline
    const broot = new Container();
    const boutline = new Graphics();
    drawOutline(boutline, board, renderSettingsStore.settings, this.activeBoardColorHex());

    broot.addChild(boutline);

    // Move bottomLayer from root into butterfly root
    scene.root.removeChild(scene.bottomLayer);
    broot.addChild(scene.bottomLayer);

    scene.butterflyRoot = broot;
    scene.butterflyOutline = boutline;

    broot.addChild(this.butterflySelectionGfx);
    this.viewport.addChild(broot);

    // Keep net lines on top of butterfly content, then selection labels on top of net lines.
    this.viewport.removeChild(this.netLinesGfx);
    this.viewport.addChild(this.netLinesGfx);
    this.viewport.removeChild(this.selectionLabelLayer);
    this.viewport.addChild(this.selectionLabelLayer);
  }

  /** Tear down butterfly mode: move bottom layer back into root */
  private teardownButterfly(scene: BoardScene) {
    if (!scene.butterflyRoot) return;

    // Move bottom layer back to main root, then restore selectionGfx as last child.
    // addChild() on an existing child moves it to the end — selectionGfx must always
    // be the last child of scene.root so it renders above pins and borders.
    scene.butterflyRoot.removeChild(scene.bottomLayer);
    scene.root.addChild(scene.bottomLayer);
    scene.root.addChild(this.netDimGfx);
    scene.root.addChild(this.crossSideGhostGfx);
    scene.root.addChild(this.netLabelLayer);
    scene.root.addChild(this.selectionGfx);
    // Elevated labels must always be last (addChild on existing child moves it to end)
    scene.root.addChild(this.elevatedPinBg!);
    scene.root.addChild(this.elevatedPinLabel!);
    scene.root.addChild(this.elevatedPartBg!);
    scene.root.addChild(this.elevatedPartLabel!);

    // Detach butterfly selection gfx before destroying
    scene.butterflyRoot.removeChild(this.butterflySelectionGfx);
    this.butterflySelectionGfx.clear();

    // Remove butterfly container from viewport and destroy (bottomLayer already detached)
    this.viewport.removeChild(scene.butterflyRoot);
    scene.butterflyRoot.destroy({ children: true });
    scene.butterflyRoot = null;
    scene.butterflyOutline = null;
  }

  /** Convert world coords (viewport space) to scene-local coords */
  private worldToScene(world: Point, root?: Container): Point {
    const r = root ?? this.activeScene?.root;
    if (!r) return world;

    const sx = r.scale.x;
    const sy = r.scale.y;
    const theta = r.rotation;
    const cx = r.pivot.x;
    const cy = r.pivot.y;

    // Inverse: un-translate (position - pivot offset), un-rotate, un-scale
    const dx = world.x - r.position.x;
    const dy = world.y - r.position.y;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const rx = dx * cosT + dy * sinT;
    const ry = -dx * sinT + dy * cosT;
    return { x: cx + rx / sx, y: cy + ry / sy };
  }

  /** Convert scene-local coords to world coords (viewport space) */
  private sceneToWorld(point: Point, root?: Container): Point {
    const r = root ?? this.activeScene?.root;
    if (!r) return point;

    const sx = r.scale.x;
    const sy = r.scale.y;
    const theta = r.rotation;
    const cx = r.pivot.x;
    const cy = r.pivot.y;

    // Forward: scale, then rotate, then translate (position - pivot offset)
    const dx = (point.x - cx) * sx;
    const dy = (point.y - cy) * sy;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: r.position.x + dx * cosT - dy * sinT,
      y: r.position.y + dx * sinT + dy * cosT,
    };
  }

  // --- Scene cache management ---

  /**
   * Look up the metadata color hex for the active board file from the
   * databank store. Returns undefined when there's no active board, no file
   * record, or no resolver match for it.
   */
  private activeBoardColorHex(): string | undefined {
    const fileName = boardStore.fileName;
    if (!fileName) return undefined;
    const file = databankStore.fileByFilename(fileName);
    return file?.board_color_hex || undefined;
  }

  private buildScene(board: BoardData): BoardScene {
    const t0 = performance.now();
    try {
      const graph = buildBoardScene(board, renderSettingsStore.settings, this.activeBoardColorHex());
      const elapsed = (performance.now() - t0).toFixed(0);
      log.render.log(`Scene built in ${elapsed}ms: ${board.parts.length} parts, ${graph.topLabels.length + graph.bottomLabels.length} labels`);

      // Debug vertex overlay (toggled in settings)
      this.clearDebugVertexLabels();
      if (renderSettingsStore.settings.showVertexNumbers) {
        const positions = drawOutlineDebug(graph.outlineGfx, board);
        // Group vertices at the same coordinate → one label per unique position
        const posMap = new Map<string, { p: {x:number;y:number}; indices: number[] }>();
        positions.forEach((p, i) => {
          if (isNaN(p.x)) return;
          const key = `${Math.round(p.x)},${Math.round(p.y)}`;
          const entry = posMap.get(key);
          if (entry) { entry.indices.push(i); }
          else { posMap.set(key, { p, indices: [i] }); }
        });
        this.debugVertexPositions = [];
        for (const { p, indices } of posMap.values()) {
          this.debugVertexPositions.push(p);
          const label = indices.join(',');
          const color = indices.length > 1 ? 0xff6600 : 0xffff00; // orange = duplicates
          const t = new Text({ text: label, style: { fontSize: 11, fill: color, stroke: { color: 0x000000, width: 2 } } });
          t.anchor.set(0, 0.5);
          this.app.stage.addChild(t);
          this.debugVertexLabels.push(t);
        }
      }

      return { ...graph, butterflyRoot: null, butterflyOutline: null };
    } catch (err) {
      log.render.error('buildBoardScene failed — evicting cache entry so re-open will re-parse:', err);
      // Evict the cache entry so the user can re-open the file to get a fresh parse.
      boardStore.evictCacheForBoard(board);
      throw err;
    }
  }

  private clearDebugVertexLabels(): void {
    for (const t of this.debugVertexLabels) t.destroy();
    this.debugVertexLabels = [];
    this.debugVertexPositions = [];
  }

  private updateDebugVertexLabels(): void {
    if (!this.debugVertexLabels.length || !this.activeScene) return;
    let li = 0;
    for (const wp of this.debugVertexPositions) {
      if (isNaN(wp.x)) continue;
      const g = this.activeScene.root.toGlobal({ x: wp.x, y: wp.y });
      this.debugVertexLabels[li].position.set(g.x + 6, g.y);
      li++;
    }
  }

  private getOrBuildScene(board: BoardData): BoardScene {
    const key = this.sceneCacheKey(board);
    let scene = this.sceneCache.get(key);
    if (!scene) {
      scene = this.buildScene(board);
      this.sceneCache.set(key, scene);
    }
    return scene;
  }

  private saveViewportState() {
    if (this.board) {
      this.viewportStates.set(this.board, {
        x: this.viewport.x,
        y: this.viewport.y,
        scaleX: this.viewport.scale.x,
        scaleY: this.viewport.scale.y,
      });
    }
  }

  private restoreViewportState(board: BoardData) {
    const state = this.viewportStates.get(board);
    if (state) {
      this.viewport.scale.set(state.scaleX, state.scaleY);
      this.viewport.position.set(state.x, state.y);
    } else {
      this.fitToBoard(board);
      // Mark pending so ResizeObserver re-fits after layout settles (e.g.
      // a PDF panel opening shrinks this panel after initial fitToBoard).
      this._pendingFit = true;
    }
  }

  private activateScene(board: BoardData) {
    const scene = this.getOrBuildScene(board);
    log.render.log(`activateScene tab=${this.tabId} ${board.format}/${board.parts.length}pts cached=${this.activeScene === scene} ticker=${this.app.ticker.started}`);

    if (this.activeScene === scene) {
      // Same scene — just update layer visibility + flips
      log.render.log('activateScene: same scene, updating flips');
      scene.topLayer.visible = this.isTopVisible;
      scene.bottomLayer.visible = this.isBottomVisible;
      this.applyLayerVisibility(scene);
      this.applyFlips(board, scene);
      this.needsRender = true;
      return;
    }
    log.render.log('activateScene: switching to new scene, old=' + (this.activeScene ? 'yes' : 'null'));

    // Save current viewport state before switching
    this.saveViewportState();

    // Detach old scene (netDimGfx + selectionGfx + elevated labels live inside root)
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.netDimGfx);
      this.activeScene.root.removeChild(this.crossSideGhostGfx);
      this.activeScene.root.removeChild(this.netLabelLayer);
      this.activeScene.root.removeChild(this.selectionGfx);
      this.activeScene.root.removeChild(this.elevatedPartBg!);
      this.activeScene.root.removeChild(this.elevatedPartLabel!);
      this.activeScene.root.removeChild(this.elevatedPinBg!);
      this.activeScene.root.removeChild(this.elevatedPinLabel!);
      this.viewport.removeChild(this.activeScene.root);
      if (this.activeScene.butterflyRoot) {
        this.viewport.removeChild(this.activeScene.butterflyRoot);
      }
    }

    // Attach new scene + overlay objects inside root (so board flips apply to them too).
    // Render order is controlled by zIndex (root.sortableChildren=true), not addChild order:
    //   zIndex 0:       board content (outline, layers, pins, labels)
    //   zIndex 10:      netDimGfx (dim non-selected nets)
    //   zIndex 15:      crossSideGhostGfx (ghost outlines for hidden-side net components)
    //   zIndex 20:      netLabelLayer (net name labels)
    //   zIndex 30:      selectionGfx (yellow highlight)
    //   zIndex 100-103: elevated selection labels (always topmost)
    this.viewport.addChild(scene.root);
    scene.root.addChild(this.netDimGfx);
    scene.root.addChild(this.crossSideGhostGfx);
    scene.root.addChild(this.netLabelLayer);
    scene.root.addChild(this.selectionGfx);
    scene.root.addChild(this.elevatedPinBg!);
    scene.root.addChild(this.elevatedPinLabel!);
    scene.root.addChild(this.elevatedPartBg!);
    scene.root.addChild(this.elevatedPartLabel!);
    // Lift selection-related labels above netLinesGfx in render order. Logical
    // parent stays scene.root so they follow board flips/rotations; the render
    // layer only controls draw order (sorted by zIndex within the layer).
    this.selectionLabelLayer.attach(
      this.netLabelLayer,
      this.elevatedPartBg!,
      this.elevatedPartLabel!,
      this.elevatedPinBg!,
      this.elevatedPinLabel!,
    );
    this.activeScene = scene;
    this.lastFlipParams = null; // force full label transform on first applyFlips for this scene
    // Set correct label + pin layer visibility for this scene's zoom level
    if (!this.textHiddenForZoom) this.applyLabelVisibility();
    else {
      scene.topCircleLabelLayer.visible = false;
      scene.bottomCircleLabelLayer.visible = false;
      scene.topTwoPinNetLayer.visible = false;
      scene.bottomTwoPinNetLayer.visible = false;
    }
    this.rebuildLabelCounts(scene);

    // Keep net lines on top of all scene content, and the selection-label
    // render layer above the net lines so selection labels never get overdrawn.
    this.viewport.removeChild(this.netLinesGfx);
    this.viewport.addChild(this.netLinesGfx);
    this.viewport.removeChild(this.selectionLabelLayer);
    this.viewport.addChild(this.selectionLabelLayer);

    scene.topLayer.visible = this.isTopVisible;
    scene.bottomLayer.visible = this.isBottomVisible;
    this.applyLayerVisibility(scene);
    this.applyFlips(board, scene);

    // Restore viewport position or fit
    this.restoreViewportState(board);

    // Build spatial hash for fast hit-testing
    this.buildHitGrid(board);

    // Force LoD re-evaluation for the new scene
    this.lastLodScale = -1;
    this.updateLoD();

    this.needsRender = true;
  }

  private deactivateScene() {
    log.render.log(`deactivateScene tab=${this.tabId}`);
    this.saveViewportState();
    if (this.activeScene) {
      this.teardownButterfly(this.activeScene);
      this.activeScene.root.removeChild(this.netDimGfx);
      this.activeScene.root.removeChild(this.crossSideGhostGfx);
      this.activeScene.root.removeChild(this.netLabelLayer);
      this.activeScene.root.removeChild(this.selectionGfx);
      this.activeScene.root.removeChild(this.elevatedPartBg!);
      this.activeScene.root.removeChild(this.elevatedPartLabel!);
      this.activeScene.root.removeChild(this.elevatedPinBg!);
      this.activeScene.root.removeChild(this.elevatedPinLabel!);
      this.viewport.removeChild(this.activeScene.root);
      this.activeScene = null;
    }
    this.netDimGfx.clear();
    this.crossSideGhostGfx.clear();
    this.netLabelLayer.removeChildren();
    this.selectionGfx.clear();
  }

  private invalidateAllScenes() {
    // Detach all overlay objects from active scene before destroying — these
    // objects are persistent (reused across rebuilds) and must not be destroyed
    // when scene.root.destroy({ children: true }) is called below.
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.netDimGfx);
      this.activeScene.root.removeChild(this.crossSideGhostGfx);
      this.activeScene.root.removeChild(this.netLabelLayer);
      this.activeScene.root.removeChild(this.selectionGfx);
      this.activeScene.root.removeChild(this.elevatedPartBg!);
      this.activeScene.root.removeChild(this.elevatedPartLabel!);
      this.activeScene.root.removeChild(this.elevatedPinBg!);
      this.activeScene.root.removeChild(this.elevatedPinLabel!);
      this.viewport.removeChild(this.activeScene.root);
      if (this.activeScene.butterflyRoot) {
        // Move bottomLayer back before destroying
        this.activeScene.butterflyRoot.removeChild(this.butterflySelectionGfx);
        this.activeScene.butterflyRoot.removeChild(this.activeScene.bottomLayer);
        this.viewport.removeChild(this.activeScene.butterflyRoot);
      }
      this.butterflySelectionGfx.clear();
    }

    for (const [, scene] of this.sceneCache) {
      if (scene.butterflyRoot) {
        scene.butterflyRoot.removeChild(scene.bottomLayer);
        scene.butterflyRoot.destroy({ children: true });
        scene.butterflyRoot = null;
      }
      scene.root.destroy({ children: true });
    }
    this.sceneCache.clear();
    this.hitGridCache.clear();
    this.activeScene = null;
  }

  // --- Event handlers ---

  private onBoardUpdate() {
    if (this.contextLost || this.reinitializing) {
      log.render.log('onBoardUpdate SKIP: gpu released/reinitializing', 'tab=' + this.tabId);
      return;
    }
    if (!this.viewport) {
      log.render.log('onBoardUpdate SKIP: no viewport', 'tab=' + this.tabId);
      return;
    }
    // Only react when this renderer's tab is active (skip notifications for other tabs)
    if (this.tabId !== null && boardStore.activeTabId !== this.tabId) {
      log.render.log('onBoardUpdate SKIP: tab mismatch', 'mine=' + this.tabId, 'active=' + boardStore.activeTabId);
      return;
    }
    // boardStore.board now returns a DERIVED BoardData (filtered/folded) —
    // its reference changes whenever foldMode or selectedBoardIndex changes,
    // so the `boardStore.board !== this.board` check below naturally triggers
    // a scene rebuild on toggle. No separate filter-state tracking needed.

    // Notify settings store which board is active so per-board overrides take effect
    renderSettingsStore.setActiveBoard(boardStore.fileName);
    log.render.log('onBoardUpdate', 'tab=' + this.tabId,
      'board=' + (boardStore.board ? boardStore.board.format + '/' + boardStore.board.parts.length : 'null'),
      'prev=' + (this.board ? this.board.format + '/' + this.board.parts.length : 'null'),
      'same=' + (boardStore.board === this.board),
      'scene=' + (this.activeScene ? 'yes' : 'null'),
      'tickerStarted=' + this.app.ticker.started);
    // Only log when board reference actually changes (activation/deactivation), not on every store notify
    if (boardStore.board !== this.board) {
      log.render.log(`onBoardUpdate tab=${this.tabId} board=${boardStore.board ? boardStore.board.format + '/' + boardStore.board.parts.length : 'null'} prev=${this.board ? this.board.format + '/' + this.board.parts.length : 'null'} ticker=${this.app.ticker.started}`);
    }
    try {
      const board = boardStore.board;
      if (board !== this.board) {
        this.lastFollowQuery = '';
        log.render.log('onBoardUpdate: board changed', board ? 'activating' : 'deactivating');
        if (board) {
          this.activateScene(board);
        } else {
          this.deactivateScene();
        }
        this.board = board;
      } else if (board && !this.activeScene) {
        // Same board but scene was lost (e.g. settings update while paused failed
        // to rebuild, or invalidateAllScenes ran without a successful activateScene).
        // Re-activate to recover from blank render.
        log.render.log(`onBoardUpdate tab=${this.tabId} recovering lost scene for ${board.format}/${board.parts.length}`);
        this.activateScene(board);
      } else if (board && this.activeScene) {
        // Detect side flip (top↔bottom) for auto-centering
        const flipped = boardStore.showTop !== this.prevShowTop || boardStore.showBottom !== this.prevShowBottom;
        this.prevShowTop = boardStore.showTop;
        this.prevShowBottom = boardStore.showBottom;

        // Capture the viewport's world center + old flipX/flipY state before
        // applyFlips so we can mirror the center around the board center and
        // keep the same physical region visible.
        const oldVpCenter = flipped ? { x: this.viewport.center.x, y: this.viewport.center.y } : null;
        const oldScale = flipped ? { x: this.activeScene.root.scale.x, y: this.activeScene.root.scale.y } : null;

        // Same board — update layer visibility + flips
        this.activeScene.topLayer.visible = this.isTopVisible;
        this.activeScene.bottomLayer.visible = this.isBottomVisible;
        this.applyLayerVisibility(this.activeScene);
        this.applyFlips(board, this.activeScene);
        this.needsRender = true;

        // After flip: re-center on selected component so the user keeps focus.
        // NOTE: zoomToBounds disabled for now — it over-zooms tiny selections
        // (testpoints, single pads) because 0.25 view-fraction × small bounds
        // = massive zoom-in. Keep the code path around for a future cap-aware
        // version; for now the mirror-about-center branch below handles the
        // no-selection case and the selected case just falls through (scene
        // mirror keeps the part under the viewport since its position also
        // reflects about the board center when we're already centered on it).
        // if (flipped && boardStore.selection.partIndex !== null) {
        //   const part = board.parts[boardStore.selection.partIndex];
        //   if (part) {
        //     const s = renderSettingsStore.settings;
        //     const eb = computePartRenderBounds(part, s);
        //     this.zoomToBounds({ minX: eb.px, minY: eb.py, maxX: eb.px + eb.pw, maxY: eb.py + eb.ph }, this.rootForPart(part), 0.25);
        //   }
        // } else
        if (flipped && oldVpCenter && oldScale) {
          // Mirror the viewport center around the board center to keep the
          // user's physical focus in view after the flip.
          //
          // scene.root's transform is  world = (cx,cy) + R · S · (P - (cx,cy))
          // with R = rotation, S = diag(sx, sy). The world-space "delta
          // vector" before/after a sign flip is related by
          //   v_world_new = R · (S_new · S_old^-1) · R^-1 · v_world_old
          //
          // For any 90°-multiple rotation, R · diag(±1, ±1) · R^-1 is again a
          // diagonal ±1 matrix. Specifically:
          //   • 0° / 180° (axes NOT swapped):  (flipScene.x, flipScene.y)
          //                                    → (flipWorld.x, flipWorld.y)
          //   • 90° / 270° (axes SWAPPED):     (flipScene.x, flipScene.y)
          //                                    → (flipWorld.y, flipWorld.x)
          //
          // The old code assumed the 0°/180° mapping uniformly and broke the
          // preservation on rotated boards (the viewport would mirror around
          // the wrong axis).
          const newScale = this.activeScene.root.scale;
          const cx = (board.bounds.minX + board.bounds.maxX) / 2;
          const cy = (board.bounds.minY + board.bounds.maxY) / 2;
          const dxFlipped = Math.sign(newScale.x) !== Math.sign(oldScale.x);
          const dyFlipped = Math.sign(newScale.y) !== Math.sign(oldScale.y);
          const rot90 = Math.round(boardStore.rotation / 90) % 4;
          const swapped = rot90 === 1 || rot90 === 3;
          const mirrorWorldX = swapped ? dyFlipped : dxFlipped;
          const mirrorWorldY = swapped ? dxFlipped : dyFlipped;
          let nx = oldVpCenter.x;
          let ny = oldVpCenter.y;
          if (mirrorWorldX) nx = 2 * cx - nx;
          if (mirrorWorldY) ny = 2 * cy - ny;
          this.viewport.moveCenter(nx, ny);
        }
      }

      // Skip renderSelection() if all relevant state is unchanged (e.g. tab switch with no selection)
      const sel = boardStore.selection;
      const searchLen = boardStore.searchResultIndices?.size ?? 0;
      const lrs = this.lastRenderedSel;
      if (sel.partIndex !== lrs.partIndex
        || sel.pinIndex !== lrs.pinIndex
        || sel.highlightedNet !== lrs.highlightedNet
        || searchLen !== lrs.searchLen
        || this.board !== lrs.board
        || boardStore.showNetDim !== lrs.showNetDim
        || boardStore.butterfly !== lrs.butterfly
        || boardStore.showTop !== lrs.showTop
        || boardStore.showBottom !== lrs.showBottom
        || boardStore.showGhosts !== lrs.showGhosts) {
        this.renderSelection();
        this.lastRenderedSel = { partIndex: sel.partIndex, pinIndex: sel.pinIndex, highlightedNet: sel.highlightedNet, searchLen, board: this.board, showNetDim: boardStore.showNetDim, butterfly: boardStore.butterfly, showTop: boardStore.showTop, showBottom: boardStore.showBottom, showGhosts: boardStore.showGhosts };
      }

      // PDF follow mode: search for selected component
      if (boardStore.followPdf && boardStore.selection.partIndex !== null) {
        const followPart = this.board?.parts[boardStore.selection.partIndex];
        log.render.log(`selection trigger: partIndex=${boardStore.selection.partIndex} part=${followPart?.name ?? 'null'}`);
        if (followPart) this.triggerFollowPdf(followPart);
      }

      // Handle focus requests (animated zoom to part/net + blink selection)
      const focus = boardStore.consumeFocusRequest();
      if (focus) {
        const focusPart = focus.partIndex != null ? this.board?.parts[focus.partIndex] : undefined;
        const focusRoot = focusPart ? this.rootForPart(focusPart) : undefined;
        // Net-only focus: zoom to show all pins, use larger view fraction
        const viewFrac = focus.partIndex != null ? 0.25 : 0.6;
        this.zoomToBounds(focus.bounds, focusRoot, viewFrac);
        this.startSelectionBlink();
      }
    } catch (err) {
      log.render.error('onBoardUpdate crashed:', err);
    }
  }

  private zoomToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container, viewFraction = 0.25) {
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    if (sw === 0 || sh === 0) return;

    // Target scale magnitude — part should fill ~viewFraction of the smaller
    // screen dimension. Cap at 6 (= 600%) so tiny components (0402, 0201) don't
    // zoom past the practical pin-pick limit, where sub-pixel pan jitter makes
    // it hard to click an already-selected pin.
    const maxDim = Math.max(bw, bh, 1);
    const targetMag = Math.min((Math.min(sw, sh) * viewFraction) / maxDim, 6);

    // Preserve sign of current scale (negative = flipped)
    const signX = this.viewport.scale.x < 0 ? -1 : 1;
    const signY = this.viewport.scale.y < 0 ? -1 : 1;
    const toScaleX = signX * targetMag;
    const toScaleY = signY * targetMag;

    // Convert scene-local center to world coords for viewport
    const center = this.sceneToWorld({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    }, root);

    // Target viewport position: moveCenter(cx, cy) does position = -cx*scale + screen/2
    const toPosX = -center.x * toScaleX + sw / 2;
    const toPosY = -center.y * toScaleY + sh / 2;

    this.zoomAnim = {
      fromX: this.viewport.position.x,
      fromY: this.viewport.position.y,
      fromScaleX: this.viewport.scale.x,
      fromScaleY: this.viewport.scale.y,
      toX: toPosX,
      toY: toPosY,
      toScaleX,
      toScaleY,
      elapsed: 0,
      duration: 400,
    };

    // Ensure ticker is running for the animation
    if (!this.app.ticker.started) this.app.ticker.start();
  }

  /** Ease-out cubic: fast start, smooth deceleration */
  private easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
  }

  // ── PDF Follow Mode ───────────────────────────────────────────────────

  /**
   * Find the visible part with the most pins (>2) closest to the viewport center.
   * Returns the Part or null if nothing qualifies.
   */
  private findLargestPartNearCenter(): Part | null {
    if (!this.board || !this.viewport) return null;

    // Viewport center in scene coords
    const centerWorld = this.viewport.toWorld(
      this.viewport.screenWidth / 2,
      this.viewport.screenHeight / 2,
    );
    const centerScene = this.worldToScene(centerWorld);

    // Visible radius in scene coords (~60% of half-diagonal)
    const cornerWorld = this.viewport.toWorld(0, 0);
    const cornerScene = this.worldToScene(cornerWorld);
    const visibleRadius = Math.sqrt(
      (centerScene.x - cornerScene.x) ** 2 +
      (centerScene.y - cornerScene.y) ** 2,
    );
    const searchRadius = visibleRadius * 0.6;

    let bestPart: Part | null = null;
    let bestScore = -1;

    for (let i = 0; i < this.board.parts.length; i++) {
      const part = this.board.parts[i];
      if (!this.isPartVisible(part)) continue;
      if (part.pins.length <= 2) continue;

      const cx = (part.bounds.minX + part.bounds.maxX) / 2;
      const cy = (part.bounds.minY + part.bounds.maxY) / 2;
      const dist = Math.sqrt((cx - centerScene.x) ** 2 + (cy - centerScene.y) ** 2);
      if (dist > searchRadius) continue;

      const score = part.pins.length * (1 - dist / searchRadius);
      if (score > bestScore) {
        bestScore = score;
        bestPart = part;
      }
    }

    return bestPart;
  }

  /** Build a search query and trigger PDF text search for the given part. */
  /**
   * Trigger PDF follow for a selected component.
   * @param force If true, always overwrites the PDF search field (used by double-click).
   *              If false (single click), respects user-typed search and shows a hint instead.
   */
  private triggerFollowPdf(part: Part, force = false): void {
    const tab = boardStore.tabs.find(t => t.id === this.tabId);
    const pdfNames = tab?.pdfFileNames ?? [];
    if (pdfNames.length === 0) return;

    // Collect unique non-trivial net names, excluding common rails and power nets
    const nets = new Set<string>();
    for (const pin of part.pins) {
      if (!pin.net || pin.net === '(null)') continue;
      const upper = pin.net.toUpperCase();
      // Skip ground, power rails, and generic bus nets
      if (upper === 'GND' || upper === 'VCC' || upper === 'VDD' || upper === 'VSS' ||
          upper.startsWith('PP') || upper === 'VBAT' || upper === 'VBUS' ||
          upper === 'V5S' || upper === 'V3S' || upper === '5V' || upper === '3V3' ||
          upper === '12V' || upper === '1V8' || upper === '1V05') continue;
      nets.add(pin.net);
      if (nets.size >= 3) break; // limit to 3 distinctive nets
    }

    // Use @-syntax: net@component (find net on same page as component)
    const navQuery = nets.size > 0
      ? [[...nets][0], part.name].join('@')
      : part.name;

    if (navQuery === this.lastFollowQuery && !force) {
      log.render.log(`skip duplicate query: "${navQuery}"`);
      return;
    }
    this.lastFollowQuery = navQuery;

    const pdfName = pdfNames[0];
    pdfStore.switchTo(pdfName);

    // Check if the PDF search field has user-typed content
    const searchSource = pdfStore.getDocSearchSource(pdfName);

    if (force || searchSource !== 'user') {
      // Empty, lookup-filled, or force → overwrite search with component name
      // searchText handles page navigation to first match; no selection rectangle needed.
      log.render.log(`triggerFollowPdf: search query="${part.name}" pdf="${pdfName}" force=${force}`);
      pdfStore.searchText(part.name, 'lookup');
    } else {
      // User-typed search → navigate + selection rectangle + tooltip for double-click
      log.render.log(`triggerFollowPdf: navigate-only query="${navQuery}" pdf="${pdfName}" (user search preserved)`);
      pdfStore.navigateToText(navQuery);
      pdfStore.setLookupHint(pdfName, part.name);
    }

    // Explicit user action (double-click) → activate the PDF panel and focus
    // the search field. Passive follow mode (force=false) stays silent so
    // board clicks don't constantly steal focus.
    if (force) {
      ensurePdfPanel(pdfName);
      // Wait a tick for the PDF panel onDidActiveChange effect to register
      // searchInputRef.current into fileInputRefs.pdfSearch.
      setTimeout(() => {
        const input = fileInputRefs.pdfSearch;
        if (!input) return;
        input.focus();
        input.select();
      }, 0);
    }
  }

  /** Schedule a debounced follow-PDF lookup after viewport movement settles. */
  private scheduleFollowDebounce(): void {
    if (!boardStore.followPdf) return;
    if (this.followDebounceTimer) clearTimeout(this.followDebounceTimer);
    this.followDebounceTimer = setTimeout(() => {
      this.followDebounceTimer = null;
      if (!boardStore.followPdf) return;
      if (boardStore.selection.partIndex !== null) {
        const selName = this.board?.parts[boardStore.selection.partIndex]?.name ?? '?';
        log.render.log(`debounce skip: component selected: ${selName} (partIndex=${boardStore.selection.partIndex})`);
        return;
      }
      const part = this.findLargestPartNearCenter();
      log.render.log(`debounce fired: centerPart=${part?.name ?? 'none'} pins=${part?.pins.length ?? 0}`);
      if (part) this.triggerFollowPdf(part);
    }, 500);
  }

  /** (Re)configure viewport drag/pinch/wheel/decelerate plugins from current settings. */
  private applyViewportPlugins(): void {
    const s = renderSettingsStore.settings;
    // Remove existing plugins so we can re-add with new options
    for (const name of ['drag', 'pinch', 'wheel', 'decelerate', 'clamp-zoom'] as const) {
      this.viewport.plugins.remove(name);
    }
    this.viewport
      .drag({ wheel: s.twoFingerPan })
      .pinch({ percent: 2 })
      .wheel({
        smooth: s.wheelSmooth,
        percent: 0.3,
        trackpadPinch: true,
        wheelZoom: !s.twoFingerPan,  // disable scroll-to-zoom in two-finger-pan mode
      })
      .clampZoom({ minScale: 0.001, maxScale: 10 });
    if (!s.disableInertia) {
      this.viewport.decelerate({ friction: 0.95 });
    }
  }

  /**
   * Install a capture-phase wheel listener that intercepts Shift+Scroll before
   * pixi-viewport sees it, implementing the scroll-binding swap shown in Settings.
   *
   * pixi-viewport has no shift-key awareness — its Wheel plugin always zooms
   * (using deltaY, which is 0 when shift is held) and its Drag plugin always
   * pans.  This handler provides the missing modifier-key dispatch so the
   * BoardScrollBindingsEditor UI actually works.
   */
  private installShiftWheelHandler(): void {
    // Remove previous listener if viewport was recreated (e.g. context-loss reinit)
    if (this.boundShiftWheel) {
      this.containerEl.removeEventListener('wheel', this.boundShiftWheel, true);
    }
    this.boundShiftWheel = (e: WheelEvent) => {
      // Let Ctrl/Meta combos (trackpad pinch, browser zoom) pass through.
      if (e.ctrlKey || e.metaKey) return;

      const s = renderSettingsStore.settings;

      // Safety net: classic mouse wheel in pan mode would pan jerkily. Route
      // it to the same mouse-centered zoom path as Shift+scroll when the
      // wheelDetection heuristic matches.
      const safetyNetFires =
        s.wheelDetection && s.twoFingerPan && !e.shiftKey && looksLikeMouseWheel(e);

      if ((e.shiftKey && s.twoFingerPan) || safetyNetFires) {
        const raw = e.deltaY || e.deltaX;
        this.zoomAtScreen(e.offsetX, e.offsetY, raw);
      } else if (e.shiftKey && !s.twoFingerPan) {
        // Alternate mode: bare = zoom, shift+scroll = pan.
        const dx = e.deltaX || e.deltaY;
        this.viewport.x -= dx;
      } else {
        // No modifier and safety net did not fire — let pixi-viewport handle it.
        return;
      }

      this.viewport.emit('moved', { viewport: this.viewport, type: 'wheel' });
      this.needsRender = true;
      this.netLinesDirty = true;
      e.preventDefault();
      e.stopPropagation();
    };
    this.containerEl.addEventListener('wheel', this.boundShiftWheel, { capture: true, passive: false });
  }

  /** Mouse-centered zoom at a screen point using the same formula the
   *  shift+wheel handler uses, so drag-zoom and wheel-zoom feel identical.
   *  `rawDelta` is an incremental signed pixel delta: positive = zoom out,
   *  negative = zoom in (matches wheel deltaY sign convention). */
  private zoomAtScreen(screenX: number, screenY: number, rawDelta: number): void {
    const factor = Math.pow(2, (1 + 0.3) * (-rawDelta / 500));
    const before = this.viewport.toWorld(screenX, screenY);
    this.viewport.scale.set(
      Math.max(0.001, Math.min(10, this.viewport.scale.x * factor)),
      Math.max(0.001, Math.min(10, this.viewport.scale.y * factor)),
    );
    const after = this.viewport.toWorld(screenX, screenY);
    this.viewport.x += (after.x - before.x) * this.viewport.scale.x;
    this.viewport.y += (after.y - before.y) * this.viewport.scale.y;
  }

  /**
   * Capture-phase pointerdown handler that implements drag-to-zoom when the
   * resolved action (from dragToZoom + shiftKey) is 'zoom'. If the action is
   * 'pan', the handler returns without consuming the event so pixi-viewport's
   * drag plugin sees it in bubble phase and pans normally.
   *
   * Zoom is vertical-delta, anchored at the INITIAL click point for the
   * duration of the gesture, and delegated to the same mouse-centered zoom
   * helper the wheel handler uses. Sensitivity is 2× that of the scroll
   * wheel so a short drag feels responsive.
   *
   * A 3-px click-vs-drag threshold gates the zoom loop so simple clicks
   * still select parts normally.
   */
  private installDragZoomHandler(): void {
    if (this.boundDragZoomDown) {
      this.containerEl.removeEventListener('pointerdown', this.boundDragZoomDown, true);
    }

    const DRAG_THRESHOLD = 3;
    const DRAG_ZOOM_SPEED = 2; // drag-zoom is 2× as sensitive as wheel

    this.boundDragZoomDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const s = renderSettingsStore.settings;
      const action: 'pan' | 'zoom' =
        s.dragToZoom === e.shiftKey ? 'pan' : 'zoom';
      if (action === 'pan') return; // pixi-viewport handles it

      const rect = this.containerEl.getBoundingClientRect();
      const anchorX = e.clientX - rect.left;
      const anchorY = e.clientY - rect.top;
      const startX = e.clientX;
      const startY = e.clientY;
      const pointerId = e.pointerId;
      let lastY = startY;
      let committed = false;

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        if (!committed) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return;
          committed = true;
          try { (this.containerEl as Element).setPointerCapture?.(pointerId); } catch { /* ignore */ }
          lastY = ev.clientY;
        }
        const incDy = ev.clientY - lastY;
        lastY = ev.clientY;
        if (incDy !== 0) {
          // Same sign convention as wheel deltaY: positive = zoom out, negative = zoom in.
          // Anchor is fixed at the initial click point; speed is 2× wheel sensitivity.
          this.zoomAtScreen(anchorX, anchorY, incDy * DRAG_ZOOM_SPEED);
          this.viewport.emit('moved', { viewport: this.viewport, type: 'wheel' });
          this.needsRender = true;
          this.netLinesDirty = true;
        }
        this.containerEl.style.cursor = incDy < 0 ? 'zoom-in' : 'zoom-out';
        ev.preventDefault();
        ev.stopPropagation();
      };

      const forceCleanup = () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', cleanup, true);
        window.removeEventListener('pointercancel', cleanup, true);
        try { (this.containerEl as Element).releasePointerCapture?.(pointerId); } catch { /* ignore */ }
        this.containerEl.style.cursor = '';
        if (this.activeDragZoomCleanup === forceCleanup) this.activeDragZoomCleanup = null;
      };

      const cleanup = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return;
        forceCleanup();
        if (committed) {
          // Block the stale 'clicked' that pixi-viewport will still emit —
          // its InputManager never saw the moves, so it thinks the drag was a click.
          this.dragZoomConsumedClick = true;
          ev.preventDefault();
          ev.stopPropagation();
        }
      };

      window.addEventListener('pointermove', onMove, { capture: true, passive: false });
      window.addEventListener('pointerup', cleanup, { capture: true });
      window.addEventListener('pointercancel', cleanup, { capture: true });
      this.activeDragZoomCleanup = forceCleanup;
    };

    this.containerEl.addEventListener('pointerdown', this.boundDragZoomDown, { capture: true });
  }

  private onSettingsUpdate() {
    if (!this.board || this.contextLost || this.reinitializing) return;
    // onSettingsUpdate — no logging (fires on every settings change)
    try {
      const cur = renderSettingsStore.settings;
      const prev = this.lastSettingsSnapshot;

      // Fast path: if only interaction-only fields differ, skip the expensive
      // scene rebuild and just reconfigure viewport plugins. Interaction-only
      // fields (twoFingerPan etc.) affect input handling but never the scene.
      // applyGlobal structuredClones the settings, so object/array fields get
      // fresh references each call — use JSON equality for deep comparison.
      const INTERACTION_ONLY = new Set<string>([
        'twoFingerPan', 'wheelDetection', 'wheelSmooth', 'disableInertia', 'dragToZoom',
      ]);
      if (prev) {
        let visualChanged = false;
        for (const k of Object.keys(cur) as Array<keyof typeof cur>) {
          if (INTERACTION_ONLY.has(k as string)) continue;
          const a = cur[k];
          const b = prev[k];
          if (a === b) continue;
          if (typeof a === 'object' && a !== null) {
            if (JSON.stringify(a) !== JSON.stringify(b)) { visualChanged = true; break; }
          } else {
            visualChanged = true;
            break;
          }
        }
        if (!visualChanged) {
          this.applyViewportPlugins();
          this.lastSettingsSnapshot = cur;
          return;
        }
      }

      // Cancel any pending zoom-settle timers (scene is about to be rebuilt)
      if (this.zoomSettleTimer) { clearTimeout(this.zoomSettleTimer); this.zoomSettleTimer = null; }

      this.textHiddenForZoom = false;
      this.netLinesHiddenForZoom = false;
      // Update viewport interaction plugins
      this.applyViewportPlugins();
      // Save viewport, invalidate all scenes, rebuild current
      this.saveViewportState();
      this.invalidateAllScenes();
      this.activateScene(this.board);
      this.renderSelection();
      // Force LoD re-evaluation on next tick (new scene, thresholds may have changed)
      this.lastLodScale = -1;
      this.lastSettingsSnapshot = cur;
    } catch (err) {
      log.render.error(`onSettingsUpdate crashed tab=${this.tabId} scene=${this.activeScene ? 'yes' : 'NULL'} ticker=${this.app.ticker.started}:`, err);
      // activeScene may be null after invalidateAllScenes + failed activateScene.
      // The next onBoardUpdate (on resume or tab switch) will detect the missing
      // scene and re-activate it via the "recovering lost scene" path.
    }
  }

  /**
   * Theme switched — swap the live PixiJS background color and trigger a full
   * scene rebuild so getter-driven BOARD_COLORS values take effect.
   */
  private onThemeUpdate(): void {
    if (this.app && this.app.renderer) {
      this.app.renderer.background.color = hexToInt(themeStore.activeTheme().board.canvasBackground);
    }
    // Reuse the settings-change rebuild path — drops the cached scene and
    // rebuilds with the new BOARD_COLORS values on next activate.
    this.onSettingsUpdate();
  }

  // --- Selection blink ---

  private startSelectionBlink() {
    // Clear any existing blink
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    this.selectionBlinkPhase = 1;
    this.renderSelection();

    const blinkInterval = 250; // ms per phase
    const totalPhases = 12;    // 12 × 250ms = 3 seconds

    const tick = (phase: number) => {
      this.selectionBlinkPhase = phase;
      this.renderSelection();
      if (phase < totalPhases) {
        this.selectionBlinkTimer = setTimeout(() => tick(phase + 1), blinkInterval);
      } else {
        this.selectionBlinkPhase = 0;
        this.selectionBlinkTimer = null;
        this.renderSelection();
      }
      // Flush to GPU even if ticker is paused (e.g. panel inactive during search focus)
      if (!this.app.ticker.started && !this.contextLost) {
        try { this.app.render(); } catch (err) { this.handleRenderCrash(err); }
      }
    };

    this.selectionBlinkTimer = setTimeout(() => tick(2), blinkInterval);
  }

  // --- Selection rendering (always rebuilt, lightweight) ---

  /** Reuse or create a BitmapText in the net label pool, copying properties from a source label.
   *  Inherits the source's `fontFamily` so the clone binds to the same BitmapFont atlas —
   *  otherwise a shadow-baked source label gets cloned onto a plain 'monospace' atlas with
   *  different glyph metrics, producing a low-res ghost sitting a few pixels above the original. */
  private acquireNetLabel(srcLabel: BitmapText) {
    const srcFontSize = srcLabel.style.fontSize as number;
    const srcFontFamily = srcLabel.style.fontFamily as string;
    let label: BitmapText;
    if (this.netLabelPoolIdx < this.netLabelLayer.children.length) {
      label = this.netLabelLayer.children[this.netLabelPoolIdx] as BitmapText;
      label.text = srcLabel.text;
      label.style.fontSize = srcFontSize;
      label.style.fontFamily = srcFontFamily;
    } else {
      label = new BitmapText({
        text: srcLabel.text,
        style: { fontSize: srcFontSize, fill: BOARD_COLORS.labelPin, fontFamily: srcFontFamily },
      });
      label.anchor.set(0.5, 0.5);
      this.netLabelLayer.addChild(label);
    }
    label.x = srcLabel.x;
    label.y = srcLabel.y;
    label.rotation = srcLabel.rotation;
    label.scale.copyFrom(srcLabel.scale);
    label.alpha = 1;
    label.visible = true;
    this.netLabelPoolIdx++;
  }

  private renderSelection() {
    const perf = this.perfVisible;
    const selStart = perf ? performance.now() : 0;

    this.needsRender = true;
    this.netLinesDirty = true; // selection changed → recompute net line geometry
    // Cancel any in-progress blink from a previous selection
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    this.selectionBlinkPhase = 0;
    this.netDimGfx.clear();
    // Restore any pin labels previously raised above the dim overlay back to
    // their original parents (top/bottom pin layers inside the part container).
    // Visibility is not touched here — LoD (applyLabelVisibility) owns the
    // .visible flag for these labels whether raised or restored.
    if (this.raisedPinLabels.length > 0) {
      for (let i = this.raisedPinLabels.length - 1; i >= 0; i--) {
        const { child, parent, index } = this.raisedPinLabels[i];
        if (child.parent === this.netLabelLayer) {
          this.netLabelLayer.removeChild(child);
        }
        const insertAt = Math.min(index, parent.children.length);
        parent.addChildAt(child, insertAt);
      }
      this.raisedPinLabels.length = 0;
    }
    // Hide all pooled net labels instead of removing (avoids GC churn)
    for (let i = 0; i < this.netLabelLayer.children.length; i++) {
      this.netLabelLayer.children[i].visible = false;
    }
    this.netLabelPoolIdx = 0;
    this.selectionGfx.clear();
    this.butterflySelectionGfx.clear();
    this.crossSideGhostGfx.clear();
    this.crossSideGhostParts = [];
    if (!this.board) return;

    const s = renderSettingsStore.settings;
    const sel = boardStore.selection;
    const butterfly = boardStore.butterfly && !!this.activeScene?.butterflyRoot;

    // Highlight the selected part's in-scene name label by cloning it as a white
    // BitmapText into netLabelLayer (zIndex 20, above board content at zIndex 0).
    // This is the same mechanism used by the net dim code when a pin is selected —
    // acquireNetLabel creates a fill:0xffffff clone at the same position, so the
    // visual result is identical regardless of whether a pin or only a part is selected.
    // (BitmapText style.fill has no runtime effect and tint can't brighten past fill,
    // so modifying the original label in-place cannot achieve full white.)
    this.selectedPartLabelClone = null;
    if (sel.partIndex !== null && this.activeScene) {
      const lbl = this.activeScene.partLabelByIndex.get(sel.partIndex);
      if (lbl && lbl.visible) {
        this.acquireNetLabel(lbl);
        // The selected part's name clone is always the first pool entry consumed
        // in this pass. Track it so updateSelectedPartLabelAlpha() can fade it
        // when the part fills the screen.
        this.selectedPartLabelClone = this.netLabelLayer.children[this.netLabelPoolIdx - 1] as BitmapText;
      }
    }

    // Pick the right Graphics target for a part (butterfly bottom → butterflySelectionGfx)
    const gfxFor = (part: { side: string }) =>
      butterfly && part.side === 'bottom' ? this.butterflySelectionGfx : this.selectionGfx;

    // Draw part outline as OBB polygon (diagonal) or AABB rect, with selection padding
    /** Expand a convex polygon outward by `sp` mils along edge normals. */
    const expandPoly = (poly: [number, number][], sp: number): [number, number][] => {
      const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
      const cy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
      return poly.map(([px, py]) => {
        const dx = px - cx, dy = py - cy;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) return [px, py] as [number, number];
        return [px + dx / len * sp, py + dy / len * sp] as [number, number];
      });
    };

    const drawPoly = (gfx: Graphics, poly: [number, number][]) => {
      gfx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < poly.length; i++) gfx.lineTo(poly[i][0], poly[i][1]);
      gfx.closePath();
    };

    const drawPartOutline = (gfx: Graphics, part: typeof this.board.parts[0], sp: number) => {
      const poly = computePartRenderPoly(part, s);
      if (poly) {
        drawPoly(gfx, expandPoly(poly, sp));
      } else {
        const rb = computePartRenderBounds(part, s);
        gfx.rect(rb.px - sp, rb.py - sp, rb.pw + sp * 2, rb.ph + sp * 2);
      }
    };

    // ── Highlight all search results ──
    const searchIndices = boardStore.searchResultIndices;
    if (searchIndices.size > 0) {
      const topSearchOutlines: (() => void)[] = [];
      const botSearchOutlines: (() => void)[] = [];
      for (const idx of searchIndices) {
        if (idx === sel.partIndex) continue; // selected part drawn separately
        const part = this.board.parts[idx];
        if (!part || !this.isPartVisible(part)) continue;
        const gfx = gfxFor(part);
        const outlines = gfx === this.butterflySelectionGfx ? botSearchOutlines : topSearchOutlines;
        if (part.pins.length === 1) {
          const pin = part.pins[0];
          const r = computePinRadius(s, pin.radius) + s.selectionPadding;
          outlines.push(() => gfx.circle(pin.position.x, pin.position.y, r));
        } else {
          outlines.push(() => drawPartOutline(gfx, part, s.selectionPadding));
        }
      }
      for (const fn of topSearchOutlines) fn();
      if (topSearchOutlines.length > 0) {
        this.selectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha * 0.5 });
        this.selectionGfx.stroke({ width: s.selectionWidth * 0.7, color: BOARD_COLORS.butterflySelection, alpha: 0.5 });
      }
      for (const fn of botSearchOutlines) fn();
      if (botSearchOutlines.length > 0) {
        this.butterflySelectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha * 0.5 });
        this.butterflySelectionGfx.stroke({ width: s.selectionWidth * 0.7, color: BOARD_COLORS.butterflySelection, alpha: 0.5 });
      }
    }

    if (sel.partIndex !== null) {
      const part = this.board.parts[sel.partIndex];
      if (part) {
        const gfx = gfxFor(part);
        if (part.pins.length === 1) {
          const pin = part.pins[0];
          const r = computePinRadius(s, pin.radius) + s.selectionPadding;
          gfx.circle(pin.position.x, pin.position.y, r);
        } else {
          drawPartOutline(gfx, part, s.selectionPadding);
        }
        gfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha });
        // Blink red on odd phases, orange on even (0 = no blink = normal orange)
        const blinkRed = this.selectionBlinkPhase > 0 && this.selectionBlinkPhase % 2 === 1;
        const selColor = blinkRed ? 0xcc2222 : COLORS.partSelected;
        gfx.stroke({ width: s.selectionWidth, color: selColor, alpha: 0.9 });
      }

      // Raise the selected part's pin labels into netLabelLayer so they render
      // above the selection fill (zIndex 30) and the netDim overlay alike.
      // Skip butterfly-bottom labels — they live in butterflyRoot and would
      // render mirrored if moved into scene.root's netLabelLayer.
      // Visibility is NOT forced here — LoD (applyLabelVisibility) still owns
      // the .visible flag, so a label that LoD has hidden (pin numbers not yet
      // rendering at the current zoom) stays hidden even when its part is
      // selected. That matches "pin number / net name labels should only render
      // as soon as pin numbers are" for the selected part.
      const selPart = this.board.parts[sel.partIndex];
      const skipRaise = butterfly && selPart?.side === 'bottom';
      if (selPart && this.isPartVisible(selPart) && !skipRaise && this.activeScene) {
        const pinLabels = this.activeScene.pinLabelsByPartIndex.get(sel.partIndex);
        if (pinLabels) {
          for (const child of pinLabels) {
            if (!child.parent || child.parent === this.netLabelLayer) continue;
            const parent = child.parent as Container;
            const index = parent.getChildIndex(child);
            this.raisedPinLabels.push({ child, parent, index });
            parent.removeChild(child);
            this.netLabelLayer.addChild(child);
          }
        }
      }
    }

    // ── Determine the effective net to highlight (selection or hover in ambient dim) ──
    const effectiveNet = sel.highlightedNet
      || (s.ambientDim && boardStore.showNetDim && boardStore.showHoverInfo ? this.hoverNet : null);
    // Ambient dim: draw overlay even when nothing is selected/hovered
    const showDim = boardStore.showNetDim;
    const needsAmbientDim = s.ambientDim && showDim && !effectiveNet;

    if (needsAmbientDim) {
      const b = this.board.bounds;
      const bw = b.maxX - b.minX;
      const bh = b.maxY - b.minY;
      const pad = Math.max(bw, bh) * 5;
      const cx = (b.minX + b.maxX) / 2;
      const cy = (b.minY + b.maxY) / 2;
      this.netDimGfx.rect(cx - pad, cy - pad, pad * 2, pad * 2);
      this.netDimGfx.fill({ color: 0x000000, alpha: s.dimOverlayAlpha });

      // Part-only selection under ambient dim: the whole board is dimmed but
      // the `effectiveNet` branch below won't run, so the selected part's pins
      // and label would stay faded. Re-draw them above the dim here.
      if (sel.partIndex !== null) {
        const selPart = this.board.parts[sel.partIndex];
        if (selPart && this.isPartVisible(selPart)) {
          const gfx = gfxFor(selPart);
          const pinDrawsByColor = new Map<number, (() => void)[]>();
          const storedPads = selPart.pins.length === 2 ? this.activeScene?.twoPinPadPolys.get(sel.partIndex) : null;
          const clamp = this.activeScene?.pinRadiusClamp.get(sel.partIndex) ?? Infinity;

          for (let pi = 0; pi < selPart.pins.length; pi++) {
            const pin = selPart.pins[pi];
            const isPin1 = pi === 0 && selPart.pins.length > 2;
            const pinColor = (isPin1 && s.showPin1Marker) ? COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);
            let arr = pinDrawsByColor.get(pinColor);
            if (!arr) { arr = []; pinDrawsByColor.set(pinColor, arr); }
            const pb = pin.padBounds;
            if (storedPads && storedPads[pi]) {
              const padPoly = storedPads[pi];
              arr.push(() => drawPoly(gfx, padPoly));
            } else if (pb) {
              const padGeom: PadGeometry = {
                bounds: pb,
                shape: pin.padShape,
                width: pin.padWidth,
                height: pin.padHeight,
                angleDeg: pin.padAngleDeg,
                cornerRadius: pin.padCornerRadius,
              };
              arr.push(() => drawPadShape(gfx, padGeom));
            } else {
              const r = Math.min(computePinRadius(s, pin.radius), clamp);
              arr.push(() => gfx.circle(pin.position.x, pin.position.y, r));
            }
          }
          for (const [color, fns] of pinDrawsByColor) {
            for (const fn of fns) fn();
            gfx.fill({ color, alpha: 1.0 });
          }

          // The selected part's name clone is already acquired unconditionally
          // at the top of renderSelection; duplicating here renders the same
          // label twice on top of itself. Pin labels are already raised into
          // netLabelLayer above (unconditional raise in the part-outline branch).
        }
      }
    }

    if (effectiveNet) {
      const net = this.board.nets.get(effectiveNet);
      if (net) {
        // ── Dim the entire board (if enabled) ────────────────────────────────
        if (showDim) {
          const b = this.board.bounds;
          const bw = b.maxX - b.minX;
          const bh = b.maxY - b.minY;
          const pad = Math.max(bw, bh) * 5;
          const cx = (b.minX + b.maxX) / 2;
          const cy = (b.minY + b.maxY) / 2;
          this.netDimGfx.rect(cx - pad, cy - pad, pad * 2, pad * 2);
          this.netDimGfx.fill({ color: 0x000000, alpha: s.dimOverlayAlpha });
        }

        // ── Highlight parts containing net pins (selection-style outlines) ──
        const seenParts = new Set<number>();
        const topPartOutlines: (() => void)[] = [];
        const botPartOutlines: (() => void)[] = [];
        const ghostPartIndices: number[] = []; // hidden-side parts for cross-side ghost
        // GND/NC nets connect too many components or aren't real — skip cross-side ghosts
        const netUpper = effectiveNet!.toUpperCase();
        const skipGhosts = netUpper.includes('GND') || isNcNet(netUpper, s.ncNetPatterns);

        for (const ref of net.pinIndices) {
          if (seenParts.has(ref.partIndex)) continue;
          seenParts.add(ref.partIndex);
          const part = this.board.parts[ref.partIndex];
          if (!part) continue;
          // Collect hidden-side parts as ghosts (skip butterfly mode, GND/NC nets, and when ghosts disabled)
          if (!this.isPartVisible(part)) {
            if (!butterfly && !skipGhosts && boardStore.showGhosts) ghostPartIndices.push(ref.partIndex);
            continue;
          }

          const gfx = gfxFor(part);
          const outlines = gfx === this.butterflySelectionGfx ? botPartOutlines : topPartOutlines;

          if (part.pins.length === 1) {
            const pin = part.pins[0];
            const r = computePinRadius(s, pin.radius) + s.selectionPadding;
            outlines.push(() => gfx.circle(pin.position.x, pin.position.y, r));
          } else {
            outlines.push(() => drawPartOutline(gfx, part, s.selectionPadding));
          }
        }

        for (const fn of topPartOutlines) fn();
        if (topPartOutlines.length > 0) {
          this.selectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha });
          this.selectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
        }
        for (const fn of botPartOutlines) fn();
        if (botPartOutlines.length > 0) {
          this.butterflySelectionGfx.fill({ color: BOARD_COLORS.labelPin, alpha: s.selectionFillAlpha });
          this.butterflySelectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
        }

        // ── Re-draw affected part name labels above the dim overlay ─────────
        // Skip the selected part — its label was already cloned at the top of
        // renderSelection; cloning it again here stacks two identical labels
        // on top of each other (visible as a slight doubling once the
        // fontFamily mismatch was fixed).
        if (showDim && this.activeScene) {
          // In butterfly mode, track which sides have affected parts to avoid
          // cloning labels from the wrong side (which would appear mirrored).
          const selectedPartName = sel.partIndex !== null ? this.board.parts[sel.partIndex]?.name : null;
          const affectedTopNames = new Set<string>();
          const affectedBotNames = new Set<string>();
          for (const pi of seenParts) {
            if (pi === sel.partIndex) continue;
            const p = this.board.parts[pi];
            if (!p) continue;
            if (p.side === 'bottom') affectedBotNames.add(p.name);
            else affectedTopNames.add(p.name);
          }

          if (this.isTopVisible) {
            for (const srcLabel of this.activeScene.topLabels) {
              if (!srcLabel.visible || !affectedTopNames.has(srcLabel.text)) continue;
              if (selectedPartName && srcLabel.text === selectedPartName) continue;
              this.acquireNetLabel(srcLabel);
            }
          }
          if (this.isBottomVisible && !butterfly) {
            // Non-butterfly: bottom labels live in scene.root, safe to clone into netLabelLayer.
            // In butterfly mode, bottom labels are in butterflyRoot — cloning into scene.root
            // would render them mirrored at wrong positions, so skip.
            for (const srcLabel of this.activeScene.bottomLabels) {
              if (!srcLabel.visible || !affectedBotNames.has(srcLabel.text)) continue;
              if (selectedPartName && srcLabel.text === selectedPartName) continue;
              this.acquireNetLabel(srcLabel);
            }
          }
        }

        // ── Re-draw highlighted pins on top of dim with full brightness ────
        const topByColor = new Map<number, (() => void)[]>();
        const botByColor = new Map<number, (() => void)[]>();
        const topHighlights: (() => void)[] = [];
        const botHighlights: (() => void)[] = [];

        for (const ref of net.pinIndices) {
          const part = this.board.parts[ref.partIndex];
          const pin = part?.pins[ref.pinIndex];
          if (!pin || !part || !this.isPartVisible(part)) continue;

          const gfx = gfxFor(part);
          const isBotGfx = gfx === this.butterflySelectionGfx;
          const highlights = isBotGfx ? botHighlights : topHighlights;

          const isPin1 = ref.pinIndex === 0 && part.pins.length > 2;
          const pinColor = (isPin1 && s.showPin1Marker) ? COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);

          const storedPads = part.pins.length === 2 ? this.activeScene?.twoPinPadPolys.get(ref.partIndex) : null;
          const pb = pin.padBounds;
          if (storedPads && storedPads[ref.pinIndex]) {
            // 2-pin: reuse exact pad polygon from scene build — same size as rendered pin
            const padPoly = storedPads[ref.pinIndex];
            if (showDim) {
              const colorMap = isBotGfx ? botByColor : topByColor;
              let arr = colorMap.get(pinColor);
              if (!arr) { arr = []; colorMap.set(pinColor, arr); }
              arr.push(() => drawPoly(gfx, padPoly));
            }
            highlights.push(() => drawPoly(gfx, padPoly));
          } else if (pb) {
            // Parser exposed a copper pad — draw highlight using the actual
            // pad shape (round → circle, roundrect → rounded rect, etc.) so
            // a selected pin reads as the real geometry, not a square halo.
            const grow = s.netHighlightGrow;
            const padGeom: PadGeometry = {
              bounds: pb,
              shape: pin.padShape,
              width: pin.padWidth,
              height: pin.padHeight,
              angleDeg: pin.padAngleDeg,
              cornerRadius: pin.padCornerRadius,
            };
            if (showDim) {
              const colorMap = isBotGfx ? botByColor : topByColor;
              let arr = colorMap.get(pinColor);
              if (!arr) { arr = []; colorMap.set(pinColor, arr); }
              arr.push(() => drawPadShape(gfx, padGeom));
            }
            highlights.push(() => drawPadShape(gfx, padGeom, grow));
          } else {
            const clamp = this.activeScene?.pinRadiusClamp.get(ref.partIndex) ?? Infinity;
            const r = Math.min(computePinRadius(s, pin.radius), clamp);
            if (showDim) {
              const colorMap = isBotGfx ? botByColor : topByColor;
              let arr = colorMap.get(pinColor);
              if (!arr) { arr = []; colorMap.set(pinColor, arr); }
              arr.push(() => gfx.circle(pin.position.x, pin.position.y, r));
            }
            highlights.push(() => gfx.circle(pin.position.x, pin.position.y, r + s.netHighlightGrow));
          }
        }

        // Draw bright pins per color (full alpha, above the dim overlay)
        for (const [color, fns] of topByColor) {
          for (const fn of fns) fn();
          this.selectionGfx.fill({ color, alpha: 1.0 });
        }
        for (const [color, fns] of botByColor) {
          for (const fn of fns) fn();
          this.butterflySelectionGfx.fill({ color, alpha: 1.0 });
        }

        // Yellow highlight glow on top
        for (const fn of topHighlights) fn();
        if (topHighlights.length > 0) {
          this.selectionGfx.fill({ color: COLORS.netHighlight, alpha: s.netHighlightAlpha });
        }
        for (const fn of botHighlights) fn();
        if (botHighlights.length > 0) {
          this.butterflySelectionGfx.fill({ color: COLORS.netHighlight, alpha: s.netHighlightAlpha });
        }

        // Pin labels for the selected part are already raised into netLabelLayer
        // (unconditional raise in the part-outline branch above).

        // ── Highlight PCB traces belonging to the selected net ──────────
        // Traces are colored by their layer's palette color to show which layer each segment is on.
        if (this.board.traces && this.board.traces.length > 0 && boardStore.showTraces) {
          const netName = effectiveNet!;
          const { layerStates } = boardStore;

          // Group trace segments by layer color for batched strokes
          const traceByColor = new Map<number, { sx: number; sy: number; ex: number; ey: number }[]>();
          for (const t of this.board.traces) {
            if (t.net !== netName) continue;
            let color: number = COLORS.netHighlight;
            if (t.layer != null && t.layer < layerStates.length) {
              color = layerStates[t.layer].color;
            }
            let arr = traceByColor.get(color);
            if (!arr) { arr = []; traceByColor.set(color, arr); }
            arr.push({ sx: t.start.x, sy: t.start.y, ex: t.end.x, ey: t.end.y });
          }
          for (const [c, segs] of traceByColor) {
            for (const s2 of segs) {
              this.selectionGfx.moveTo(s2.sx, s2.sy);
              this.selectionGfx.lineTo(s2.ex, s2.ey);
            }
            this.selectionGfx.stroke({ width: 3, color: c as number & 0xffffff, alpha: 0.9, join: 'round', cap: 'round' });
          }
        }

        // ── Highlight vias belonging to the selected net ─────────────
        // Via color = the "other" layer relative to where the signal is coming from.
        // We determine source layer from the selected part's layer, then for each via
        // pick the connected layer that is NOT the source → that's the destination color.
        if (this.board.vias && this.board.vias.length > 0 && boardStore.showVias && this.activeScene) {
          const netName = effectiveNet!;
          const { layerStates } = boardStore;
          const connMap = this.activeScene.viaConnectedLayers;

          // Determine the source layer from the selected part
          const selectedPart = sel.partIndex !== null ? this.board.parts[sel.partIndex] : null;
          const sourceLayer = selectedPart?.layer ?? -1;

          // Group vias by their target layer color for batched strokes
          const byColor = new Map<number, { x: number; y: number }[]>();

          for (let vi = 0; vi < this.board.vias.length; vi++) {
            const via = this.board.vias[vi];
            if (via.net !== netName) continue;
            const connected = connMap[vi] ?? [];

            let color: number = COLORS.netHighlight; // fallback yellow
            if (connected.length >= 2 && layerStates.length > 0) {
              // Pick the layer that is NOT the source layer (= destination)
              // If source is connected[0], destination is connected[last] and vice versa
              let targetIdx: number;
              if (connected[0] === sourceLayer) {
                targetIdx = connected[connected.length - 1];
              } else if (connected[connected.length - 1] === sourceLayer) {
                targetIdx = connected[0];
              } else {
                // Source layer not directly in this via — pick the farther end from source
                targetIdx = Math.abs(connected[0] - sourceLayer) > Math.abs(connected[connected.length - 1] - sourceLayer)
                  ? connected[0]
                  : connected[connected.length - 1];
              }
              if (targetIdx < layerStates.length) color = layerStates[targetIdx].color;
            } else if (connected.length === 1 && layerStates.length > 0) {
              const idx = connected[0];
              if (idx < layerStates.length) color = layerStates[idx].color;
            }

            let arr = byColor.get(color);
            if (!arr) { arr = []; byColor.set(color, arr); }
            arr.push(via.position);
          }

          for (const [c, positions] of byColor) {
            for (const { x, y } of positions) {
              this.selectionGfx.moveTo(x - 12, y).lineTo(x + 12, y);
              this.selectionGfx.moveTo(x, y - 12).lineTo(x, y + 12);
              this.selectionGfx.circle(x, y, 10);
            }
            this.selectionGfx.stroke({ width: 2.5, color: c as number & 0xffffff, alpha: 0.95 });
          }
        }
        this.crossSideGhostParts = ghostPartIndices;
      }
    }

    // ── Cross-side ghost components (hidden side, pulsing semi-transparent) ──
    this.renderCrossSideGhosts();

    // ── Elevated labels for selected part/pin ───────────────────────────────
    this.updateElevatedLabels(sel, s);

    // ── Selection overlay (big centered text) ─────────────────────────────
    this.updateSelectionOverlay(sel, s);

    if (perf) this.perfAccum.selection += performance.now() - selStart;

    const nlStart = perf ? performance.now() : 0;
    this.renderNetLines();
    if (perf) this.perfAccum.netLines += performance.now() - nlStart;
  }

  /**
   * Elevated selection labels — floating name badges for the selected part and pin.
   *
   * These are the primary visual feedback for the current selection and must render
   * on top of ALL board content. They use zIndex 100-103 on scene.root (which has
   * sortableChildren=true) so they overlap pins, borders, and the selection highlight.
   *
   * Architecture:
   *   - 4 persistent PixiJS objects: partBg + partLbl, pinBg + pinLbl
   *   - Created once in init(), reused across scene switches (never destroyed mid-session)
   *   - Attached to scene.root so they follow board flips/rotations
   *   - Counter-flip transform keeps text readable when the board is flipped/rotated
   *
   * Customisation points (for manual editing):
   *   - screenFontPx: label font size in screen pixels (constant across zoom levels)
   *   - pad / cornerR: background padding and corner radius
   *   - partBg fill: color 0x000000, alpha 0.75 (dark semi-transparent)
   *   - pinBg fill: color 0x1a1a2e, alpha 0.85 (dark blue semi-transparent)
   *   - Pin label placement: tries above pin first, flips below if overlapping part label
   */
  private updateElevatedLabels(
    sel: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null },
    s: import('../store/render-settings').RenderSettings,
  ) {
    const partBg = this.elevatedPartBg!;
    const partLbl = this.elevatedPartLabel!;
    const pinBg = this.elevatedPinBg!;
    const pinLbl = this.elevatedPinLabel!;

    // Hide all labels by default — early returns leave them hidden
    partBg.visible = false;
    partLbl.visible = false;
    pinBg.visible = false;
    pinLbl.visible = false;

    if (!this.board || sel.partIndex === null || !this.activeScene) return;
    const part = this.board.parts[sel.partIndex];
    if (!part) return;

    // Once pin numbers start rendering at the current zoom the bright-white
    // part-name clone would otherwise cover the pins and pin-number labels
    // beneath it, so fade it to 0.55 alpha at that threshold. A read-under
    // blend (difference / exclusion) would be ideal but advanced blend modes
    // don't take effect for renderables attached to a RenderLayer — see
    // `docs/research/threejs-webgpu-vs-pixi.md` § "Label blending options".
    const clone = this.selectedPartLabelClone;
    if (clone && clone.visible) {
      const fadeScale = Math.abs(this.viewport.scale.x);
      const zoomOk = s.labelZoomHide <= 0 || fadeScale >= s.labelZoomHide;
      const groups = this.activeScene.circleFontSizeGroups;
      const pinNumbersVisible = zoomOk && groups.some(g => g.minSize * fadeScale >= s.circleLabelMinScreenPx);
      clone.alpha = pinNumbersVisible ? 0.55 : 1;
    }

    // Font size is constant in screen pixels — divide by viewport scale to get world units
    const vpScale = Math.abs(this.viewport.scale.x);
    const screenFontPx = 18;                       // ← change this to resize labels
    const fontSize = screenFontPx / vpScale;
    const pad = 4 / vpScale;                        // ← background padding around text
    const cornerR = 3 / vpScale;                    // ← background corner radius

    // Counter-flip: scene root may be flipped (scale.x or scale.y negative) or rotated.
    // Labels must stay upright and readable, so we invert the root's transform on each label.
    const root = this.activeScene.root;
    const lsx = Math.sign(root.scale.x) || 1;       // -1 when horizontally flipped
    const lsy = Math.sign(root.scale.y) || 1;       // -1 when vertically flipped
    const labelRot = -root.rotation * lsx * lsy;     // cancel root rotation

    const applyCounterFlip = (lbl: BitmapText) => {
      lbl.scale.set(lsx, lsy);
      lbl.rotation = labelRot;
    };

    const applyCounterFlipGfx = (gfx: Graphics, cx: number, cy: number) => {
      gfx.position.set(cx, cy);
      gfx.scale.set(lsx, lsy);
      gfx.rotation = labelRot;
    };

    // Estimate text dimensions directly from font metrics (avoids stale getBounds during zoom)
    const charW = fontSize * 0.6;   // approximate character width for bitmap font
    const lineH = fontSize * 1.15;  // approximate line height
    const measure = (text: string) => ({
      w: text.length * charW + pad * 2,
      h: lineH + pad * 2,
    });

    // ── Part label: centered on the part's bounding box ──
    let partLabelCx = 0, partLabelCy = 0, partLabelHW = 0, partLabelHH = 0;
    if (s.showElevatedPartLabel) {
      const rb = computePartRenderBounds(part, s);
      partLabelCx = rb.px + rb.pw / 2;
      partLabelCy = rb.py + rb.ph / 2;
      partLbl.style.fontSize = fontSize;
      partLbl.text = part.name;
      partLbl.x = partLabelCx;
      partLbl.y = partLabelCy;
      applyCounterFlip(partLbl);
      partLbl.visible = true;

      const pm = measure(part.name);
      partLabelHW = pm.w / 2;
      partLabelHH = pm.h / 2;
      partBg.clear();
      partBg.roundRect(-partLabelHW, -partLabelHH, pm.w, pm.h, cornerR);
      partBg.fill({ color: 0x000000, alpha: 0.75 });
      applyCounterFlipGfx(partBg, partLabelCx, partLabelCy);
      partBg.visible = true;
    }

    // ── Pin label: positioned above (or below) the selected pin ──
    if (s.showElevatedPinLabel && sel.pinIndex !== null && sel.pinIndex >= 0) {
      const pin = part.pins[sel.pinIndex];
      if (pin) {
        const pinId = pinDisplayId(pin, sel.pinIndex);
        const hasNet = pin.net && pin.net !== '(null)' && pin.net !== '';
        const pinText = hasNet ? `${pin.net} (${pinId})` : pinId;
        pinLbl.style.fontSize = fontSize;
        pinLbl.text = pinText;
        const cx = pin.position.x;
        const clamp = this.activeScene?.pinRadiusClamp.get(sel.partIndex!) ?? Infinity;
        const r = Math.min(computePinRadius(s, pin.radius), clamp);
        const yOffset = (r + fontSize * 0.8) * lsy;

        const pnm = measure(pinText);
        const pinHalfW = pnm.w / 2;
        const pinHalfH = pnm.h / 2;

        // Default: above the pin. If that overlaps the part label, flip below.
        let cy = pin.position.y - yOffset;
        if (s.showElevatedPartLabel) {
          const overlaps = cx + pinHalfW > partLabelCx - partLabelHW &&
                           cx - pinHalfW < partLabelCx + partLabelHW &&
                           cy + pinHalfH > partLabelCy - partLabelHH &&
                           cy - pinHalfH < partLabelCy + partLabelHH;
          if (overlaps) {
            // Try below the pin
            cy = pin.position.y + yOffset;
            // If still overlapping, push pin label fully clear of part label
            const stillOverlaps = cx + pinHalfW > partLabelCx - partLabelHW &&
                                  cx - pinHalfW < partLabelCx + partLabelHW &&
                                  cy + pinHalfH > partLabelCy - partLabelHH &&
                                  cy - pinHalfH < partLabelCy + partLabelHH;
            if (stillOverlaps) {
              cy = partLabelCy + partLabelHH + pinHalfH + pad;
            }
          }
        }

        pinLbl.x = cx;
        pinLbl.y = cy;
        applyCounterFlip(pinLbl);
        pinLbl.visible = true;

        pinBg.clear();
        pinBg.roundRect(-pinHalfW, -pinHalfH, pnm.w, pnm.h, cornerR);
        pinBg.fill({ color: 0x1a1a2e, alpha: 0.85 });
        applyCounterFlipGfx(pinBg, cx, cy);
        pinBg.visible = true;
      }
    }

    // Z-priority swap: when a pin is selected, its label should render above the
    // part label. When only a part is selected, reverse the order.
    // scene.root.sortableChildren=true uses zIndex for ordering.
    if (sel.pinIndex !== null && sel.pinIndex >= 0) {
      // Pin selected → pin badge on very top (zIndex 102/103 > 100/101)
      partBg.zIndex = 100;
      partLbl.zIndex = 101;
      pinBg.zIndex = 102;
      pinLbl.zIndex = 103;
    } else {
      // Only part selected → part badge on very top
      pinBg.zIndex = 100;
      pinLbl.zIndex = 101;
      partBg.zIndex = 102;
      partLbl.zIndex = 103;
    }
  }

  /** Update the DOM selection overlay at top-center of the board view */
  private updateSelectionOverlay(
    sel: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null },
    s: import('../store/render-settings').RenderSettings,
  ) {
    if (!this.selectionOverlayEl) return;
    if (!s.showSelectionOverlay || !this.board || sel.partIndex === null) {
      this.selectionOverlayEl.style.display = 'none';
      return;
    }
    const part = this.board.parts[sel.partIndex];
    if (!part) {
      this.selectionOverlayEl.style.display = 'none';
      return;
    }

    let text: string;
    if (sel.pinIndex !== null) {
      const pin = part.pins[sel.pinIndex];
      const pinName = pin?.name ?? `${sel.pinIndex}`;
      const net = sel.highlightedNet && sel.highlightedNet !== '(null)' && sel.highlightedNet !== ''
        ? sel.highlightedNet : null;
      text = net ? `${part.name} → ${pinName} → ${net}` : `${part.name} → ${pinName}`;
    } else {
      text = part.name;
    }

    this.selectionOverlayEl.textContent = text;
    this.selectionOverlayEl.style.display = '';
  }

  // --- Net lines rendering ---

  /** Recompute cached net line segments (start/end points) when selection or viewport changes */
  private recomputeNetLineSegments() {
    this.netLineSegments = [];
    this.netLineFadeDist = 0;
    this.netLinesDirty = false;

    const mode = boardStore.netLineMode;
    if (!this.board || mode === 'off') return;

    const sel = boardStore.selection;
    if (!sel.highlightedNet) return;

    const net = this.board.nets.get(sel.highlightedNet);
    if (!net) return;

    const s = renderSettingsStore.settings;

    // Skip GND/NC nets — GND connects too many components, NC is not a real net.
    const netUpper = sel.highlightedNet.toUpperCase();
    if (netUpper.includes('GND') || isNcNet(netUpper, s.ncNetPatterns)) return;

    // Star needs an anchor (selected part). When the highlight came from a PDF
    // net lookup or trace click, partIndex is null — fall through to chain so
    // the user still sees the connectivity.
    if (mode === 'star' && sel.partIndex !== null) {
      // ── Star topology from selected part to all others on the net ──
      const selectedPartIdx = sel.partIndex;
      const selectedPart = this.board.parts[selectedPartIdx];
      if (!selectedPart) return;

      const selectedRoot = this.rootForPart(selectedPart);
      const selEB = computePartRenderBounds(selectedPart, s);
      const selectedPin = sel.pinIndex !== null ? selectedPart.pins[sel.pinIndex] : null;
      const selCenterW = selectedPin
        ? this.sceneToWorld(selectedPin.position, selectedRoot)
        : this.sceneToWorld({ x: selEB.px + selEB.pw / 2, y: selEB.py + selEB.ph / 2 }, selectedRoot);

      // Group net pin indices by target part
      const partNetPins = new Map<number, number[]>();
      for (const ref of net.pinIndices) {
        if (ref.partIndex === sel.partIndex) continue;
        let arr = partNetPins.get(ref.partIndex);
        if (!arr) { arr = []; partNetPins.set(ref.partIndex, arr); }
        arr.push(ref.pinIndex);
      }

      let targetCount = 0;
      for (const [partIndex, pinIndices] of partNetPins) {
        const part = this.board.parts[partIndex];
        if (!part) continue;
        const isGhost = !this.isPartVisible(part) && this.crossSideGhostParts.includes(partIndex);
        if (!this.isPartVisible(part) && !isGhost) continue;

        const root = isGhost ? this.activeScene?.root : this.rootForPart(part);

        // Find the net pin closest to the selection origin
        let bestPin: Point | null = null;
        let bestDist = Infinity;
        for (const pi of pinIndices) {
          const pin = part.pins[pi];
          if (!pin) continue;
          const pw = this.sceneToWorld(pin.position, root);
          const dx = pw.x - selCenterW.x;
          const dy = pw.y - selCenterW.y;
          const d = dx * dx + dy * dy;
          if (d < bestDist) { bestDist = d; bestPin = pw; }
        }

        if (bestPin) {
          const start = this.clipToRectEdge(selCenterW, bestPin, selEB, selectedRoot);
          this.netLineSegments.push({ start, end: bestPin });
        }
        targetCount++;
      }

      const vpScale = Math.abs(this.viewport.scale.x);
      this.netLineFadeDist = targetCount > 8 ? 60 / vpScale : 0;
    } else {
      // ── Chain mode: greedy MST connecting every part on the net ──
      // Collect visible parts with world-space centers (only computed for this mode).
      type NetPartInfo = { partIndex: number; center: Point; eb: ReturnType<typeof computePartRenderBounds>; root: Container | undefined };
      const netParts: NetPartInfo[] = [];
      const seenParts = new Set<number>();
      for (const ref of net.pinIndices) {
        if (seenParts.has(ref.partIndex)) continue;
        seenParts.add(ref.partIndex);
        const part = this.board.parts[ref.partIndex];
        if (!part) continue;
        const isGhost = !this.isPartVisible(part) && this.crossSideGhostParts.includes(ref.partIndex);
        if (!this.isPartVisible(part) && !isGhost) continue;
        const root = isGhost ? this.activeScene?.root : this.rootForPart(part);
        const eb = computePartRenderBounds(part, s);
        const center = this.sceneToWorld({ x: eb.px + eb.pw / 2, y: eb.py + eb.ph / 2 }, root);
        netParts.push({ partIndex: ref.partIndex, center, eb, root });
      }
      if (netParts.length < 2) return;

      // Build a greedy minimum spanning tree so each part connects to its closest neighbor.
      const connected = new Set<number>([0]);
      const remaining = new Set<number>();
      for (let i = 1; i < netParts.length; i++) remaining.add(i);

      while (remaining.size > 0) {
        let bestI = -1, bestJ = -1, bestDist = Infinity;
        for (const ci of connected) {
          const a = netParts[ci].center;
          for (const ri of remaining) {
            const b = netParts[ri].center;
            const dx = b.x - a.x, dy = b.y - a.y;
            const d = dx * dx + dy * dy;
            if (d < bestDist) { bestDist = d; bestI = ci; bestJ = ri; }
          }
        }
        if (bestJ < 0) break;
        connected.add(bestJ);
        remaining.delete(bestJ);

        const a = netParts[bestI], b = netParts[bestJ];
        const start = this.clipToRectEdge(a.center, b.center, a.eb, a.root);
        const end = this.clipToRectEdge(b.center, a.center, b.eb, b.root);
        this.netLineSegments.push({ start, end });
      }
    }
  }

  /** Draw cached net line segments with current animation state */
  private renderNetLines() {
    this.needsRender = true;
    this.netLinesGfx.clear();

    // Recompute geometry only when dirty (selection/viewport changed)
    if (this.netLinesDirty) this.recomputeNetLineSegments();
    if (this.netLineSegments.length === 0) return;

    const s = renderSettingsStore.settings;
    const vpScale = Math.abs(this.viewport.scale.x);
    const lineW = s.netLineWidth / vpScale;

    // Pulse color: oscillate between net line color and red
    const pulseT = s.netLinePulse ? (Math.sin(this.netLinePulsePhase * Math.PI * 2) + 1) / 2 : 0;
    const baseColor = s.netLineColor;
    const pulseColor = 0xcc2222;
    const color = s.netLinePulse ? this.lerpColor(baseColor, pulseColor, pulseT) : baseColor;

    // Dash offset animation (screen pixels converted to world)
    const dashLen = s.netLineDashLength / vpScale;
    const dashOffset = s.netLineDashed ? (this.netLinePulsePhase * dashLen * 2) : 0;

    const useFade = this.netLineFadeDist > 0;
    const fadeDist = useFade ? 60 / vpScale : 0;

    if (!useFade && !s.netLineDashed) {
      // Fast path: batch all segments into a single stroke() call
      for (const { start, end } of this.netLineSegments) {
        this.netLinesGfx.moveTo(start.x, start.y);
        this.netLinesGfx.lineTo(end.x, end.y);
      }
      this.netLinesGfx.stroke({ width: lineW, color, alpha: s.netLineAlpha });
    } else {
      for (const { start, end } of this.netLineSegments) {
        if (useFade) {
          this.drawNetLineWithFade(start, end, fadeDist, lineW, color, s.netLineAlpha, s.netLineDashed, dashLen, dashOffset);
        } else {
          this.drawDashedLine(start, end, dashLen, dashOffset, lineW, color, s.netLineAlpha);
        }
      }
    }
  }

  /**
   * Draw cross-side ghost outlines for net-connected parts on the hidden board side.
   * Called from renderSelection() and the ticker for pulse animation.
   * Ghosts are semi-transparent with a pulsing opacity driven by netLinePulsePhase.
   */
  private renderCrossSideGhosts() {
    this.crossSideGhostGfx.clear();
    if (this.crossSideGhostParts.length === 0 || !this.board) return;

    const s = renderSettingsStore.settings;
    // Pulse alpha between 0.12 and 0.35
    const pulse = (Math.sin(this.netLinePulsePhase * Math.PI * 2) + 1) / 2;
    const ghostAlpha = 0.12 + pulse * 0.23;
    const outlineAlpha = 0.25 + pulse * 0.35;
    const ghostColor = 0x44ccff; // cyan tint to distinguish from normal highlights

    const gfx = this.crossSideGhostGfx;

    for (const partIndex of this.crossSideGhostParts) {
      const part = this.board.parts[partIndex];
      if (!part) continue;

      // Draw part body outline
      const poly = computePartRenderPoly(part, s);
      if (poly) {
        gfx.moveTo(poly[0][0], poly[0][1]);
        for (let i = 1; i < poly.length; i++) gfx.lineTo(poly[i][0], poly[i][1]);
        gfx.closePath();
      } else {
        const rb = computePartRenderBounds(part, s);
        gfx.rect(rb.px, rb.py, rb.pw, rb.ph);
      }
      gfx.fill({ color: ghostColor, alpha: ghostAlpha * 0.5 });
      gfx.stroke({ width: s.selectionWidth, color: ghostColor, alpha: outlineAlpha });

      // Draw pins
      for (const pin of part.pins) {
        const clamp = this.activeScene?.pinRadiusClamp.get(partIndex) ?? Infinity;
        const r = Math.min(computePinRadius(s, pin.radius), clamp);
        gfx.circle(pin.position.x, pin.position.y, r);
      }
      if (part.pins.length > 0) {
        gfx.fill({ color: ghostColor, alpha: ghostAlpha });
      }
    }

    this.needsRender = true;
  }

  /** Clip a ray from `from` toward `to` to the edge of a part's bounding rect, returning world coords */
  private clipToRectEdge(from: Point, to: Point, eb: { px: number; py: number; pw: number; ph: number }, root?: Container): Point {
    const tl = this.sceneToWorld({ x: eb.px, y: eb.py }, root);
    const br = this.sceneToWorld({ x: eb.px + eb.pw, y: eb.py + eb.ph }, root);
    const minX = Math.min(tl.x, br.x), maxX = Math.max(tl.x, br.x);
    const minY = Math.min(tl.y, br.y), maxY = Math.max(tl.y, br.y);

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return from;

    // Find intersection with each of the 4 rect edges, pick the one closest to `to` (largest t)
    let bestT = 0;
    const corners: Point[] = [
      { x: minX, y: minY }, { x: maxX, y: minY },
      { x: maxX, y: maxY }, { x: minX, y: maxY },
    ];
    for (let i = 0; i < 4; i++) {
      const t = this.rayEdgeIntersect(from, to, corners[i], corners[(i + 1) % 4]);
      if (t !== null && t > bestT) bestT = t;
    }

    return { x: from.x + dx * bestT, y: from.y + dy * bestT };
  }

  /** Find parametric t along ray (from→to) where it intersects edge segment (a→b). Returns null if no hit. */
  private rayEdgeIntersect(from: Point, to: Point, a: Point, b: Point): number | null {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = dx * ey - dy * ex;
    if (Math.abs(denom) < 1e-10) return null;
    const t = ((a.x - from.x) * ey - (a.y - from.y) * ex) / denom;
    const u = ((a.x - from.x) * dy - (a.y - from.y) * dx) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return t;
    return null;
  }

  /** Draw a dashed line between two world-space points */
  private drawDashedLine(from: Point, to: Point, dashLen: number, dashOffset: number, width: number, color: number, alpha: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 0.001) return;

    const ux = dx / totalLen;
    const uy = dy / totalLen;
    const gapLen = dashLen;
    const segLen = dashLen + gapLen;

    // Batch all dash segments, then stroke once
    let pos = -(dashOffset % segLen);
    let hasSegments = false;
    while (pos < totalLen) {
      const segStart = Math.max(0, pos);
      const segEnd = Math.min(totalLen, pos + dashLen);
      if (segEnd > segStart) {
        this.netLinesGfx.moveTo(from.x + ux * segStart, from.y + uy * segStart);
        this.netLinesGfx.lineTo(from.x + ux * segEnd, from.y + uy * segEnd);
        hasSegments = true;
      }
      pos += segLen;
    }
    if (hasSegments) {
      this.netLinesGfx.stroke({ width, color, alpha });
    }
  }

  /** Draw a net line with alpha fade-in near the start to reduce clutter with many lines.
   *  Non-dashed mode: batches all fade segments per alpha level into a single stroke call. */
  private drawNetLineWithFade(from: Point, to: Point, fadeDist: number, width: number, color: number, alpha: number, dashed: boolean, dashLen: number, dashOffset: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 0.001) return;

    const ux = dx / totalLen;
    const uy = dy / totalLen;
    const fadeEnd = Math.min(fadeDist, totalLen * 0.4);

    if (dashed) {
      // Dashed: each drawDashedLine call already batches internally
      const fadeSteps = 4;
      for (let i = 0; i < fadeSteps; i++) {
        const t0 = (i / fadeSteps) * fadeEnd;
        const t1 = ((i + 1) / fadeSteps) * fadeEnd;
        const stepAlpha = alpha * ((i + 1) / fadeSteps) * 0.7;
        const segFrom: Point = { x: from.x + ux * t0, y: from.y + uy * t0 };
        const segTo: Point = { x: from.x + ux * t1, y: from.y + uy * t1 };
        this.drawDashedLine(segFrom, segTo, dashLen, dashOffset + t0, width, color, stepAlpha);
      }
      if (fadeEnd < totalLen) {
        const remainFrom: Point = { x: from.x + ux * fadeEnd, y: from.y + uy * fadeEnd };
        this.drawDashedLine(remainFrom, to, dashLen, dashOffset + fadeEnd, width, color, alpha);
      }
    } else {
      // Non-dashed: batch all fade segments by alpha level, one stroke() per level
      const fadeSteps = 4;
      for (let i = 0; i < fadeSteps; i++) {
        const t0 = (i / fadeSteps) * fadeEnd;
        const t1 = ((i + 1) / fadeSteps) * fadeEnd;
        const stepAlpha = alpha * ((i + 1) / fadeSteps) * 0.7;
        this.netLinesGfx.moveTo(from.x + ux * t0, from.y + uy * t0);
        this.netLinesGfx.lineTo(from.x + ux * t1, from.y + uy * t1);
        this.netLinesGfx.stroke({ width, color, alpha: stepAlpha });
      }
      // Remaining line at full alpha
      if (fadeEnd < totalLen) {
        this.netLinesGfx.moveTo(from.x + ux * fadeEnd, from.y + uy * fadeEnd);
        this.netLinesGfx.lineTo(to.x, to.y);
        this.netLinesGfx.stroke({ width, color, alpha });
      }
    }
  }

  /** Linearly interpolate between two hex colors */
  private lerpColor(a: number, b: number, t: number): number {
    const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
    const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
    const r = Math.round(ar + (br - ar) * t);
    const g = Math.round(ag + (bg - ag) * t);
    const bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  }

  // --- Hit testing ---

  /** Build a spatial hash grid for O(1) hit-test lookups.
   *  Each part is inserted into every grid cell its bounding box overlaps.
   *  Results are cached per-board so tab switches are instant. */
  private buildHitGrid(board: BoardData) {
    const cacheKey = this.sceneCacheKey(board);
    const cached = this.hitGridCache.get(cacheKey);
    if (cached) {
      this.hitGrid = cached.grid;
      this.hitGridCellSize = cached.cellSize;
      return;
    }

    const grid = new Map<string, number[]>();
    if (board.parts.length === 0) {
      this.hitGrid = grid;
      this.hitGridCellSize = 1;
      this.hitGridCache.set(cacheKey, { grid, cellSize: 1 });
      return;
    }
    // Cell size: use board bounds divided into a reasonable grid (~50x50 cells)
    const bw = board.bounds.maxX - board.bounds.minX || 1;
    const bh = board.bounds.maxY - board.bounds.minY || 1;
    const cellSize = Math.max(bw, bh) / 50;
    this.hitGridCellSize = cellSize;

    for (let pi = 0; pi < board.parts.length; pi++) {
      const part = board.parts[pi];
      if (part.hidden) continue; // skip parts filtered out by deriveBoardView
      // Use part bounds (authoritative, already includes pin positions)
      const b = part.bounds;
      if (b.minX === b.maxX && b.minY === b.maxY && part.pins.length === 0) continue;
      let minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY;
      // Expand by a margin for click tolerance
      const margin = cellSize * 0.5;
      minX -= margin; minY -= margin; maxX += margin; maxY += margin;

      const x0 = Math.floor(minX / cellSize);
      const y0 = Math.floor(minY / cellSize);
      const x1 = Math.floor(maxX / cellSize);
      const y1 = Math.floor(maxY / cellSize);
      for (let gx = x0; gx <= x1; gx++) {
        for (let gy = y0; gy <= y1; gy++) {
          const key = `${gx},${gy}`;
          let cell = grid.get(key);
          if (!cell) { cell = []; grid.set(key, cell); }
          cell.push(pi);
        }
      }
    }
    this.hitGrid = grid;
    this.hitGridCache.set(cacheKey, { grid, cellSize });
  }

  /** Get candidate part indices from the spatial hash for a given scene-space point */
  private hitGridCandidates(x: number, y: number): number[] {
    if (this.hitGridCellSize <= 0) return [];
    const gx = Math.floor(x / this.hitGridCellSize);
    const gy = Math.floor(y / this.hitGridCellSize);
    return this.hitGrid.get(`${gx},${gy}`) ?? [];
  }

  /** Get the root container a part belongs to (different in butterfly mode) */
  private rootForPart(part: { side: string }): Container | undefined {
    if (!this.activeScene) return undefined;
    if (boardStore.butterfly && this.activeScene.butterflyRoot && part.side === 'bottom') {
      return this.activeScene.butterflyRoot;
    }
    return this.activeScene.root;
  }

  /** Find the part (and optionally pin) under a world-space point */
  private hitTest(world: Point): { partIndex: number; pinIndex: number } | null {
    // hitTest logging removed — fires on every pointer interaction, too noisy
    if (!this.board) return null;

    const s = renderSettingsStore.settings;
    const butterfly = boardStore.butterfly && this.activeScene?.butterflyRoot;

    // In butterfly mode, we need to convert world coords per-part using the correct root.
    // Pre-compute local coords for top and bottom roots.
    const localTop = this.worldToScene(world, this.activeScene?.root);
    const localBot = butterfly
      ? this.worldToScene(world, this.activeScene!.butterflyRoot!)
      : localTop;

    // Use spatial hash to get candidate parts near the pointer (O(1) vs O(N))
    // Query both top and bottom local coords to cover butterfly mode
    const candidateSet = new Set<number>();
    for (const pi of this.hitGridCandidates(localTop.x, localTop.y)) candidateSet.add(pi);
    if (butterfly) {
      for (const pi of this.hitGridCandidates(localBot.x, localBot.y)) candidateSet.add(pi);
    }

    // First pass: try to hit a specific pin
    let bestDist = Infinity;
    let bestPartIdx = -1;
    let bestPinIdx = -1;

    for (const pi of candidateSet) {
      const part = this.board.parts[pi];
      if (!this.isPartVisible(part)) continue;

      const local = part.side === 'bottom' ? localBot : localTop;
      // Use stored pad polygons for 2-pin parts (both axis-aligned and diagonal)
      const padPolys = part.pins.length === 2 ? this.activeScene?.twoPinPadPolys.get(pi) : null;

      if (padPolys) {
        for (let pni = 0; pni < 2; pni++) {
          const poly = padPolys[pni];
          if (pointInConvexPoly(local.x, local.y, poly)) {
            const cx = poly.reduce((s: number, p: [number, number]) => s + p[0], 0) / poly.length;
            const cy = poly.reduce((s: number, p: [number, number]) => s + p[1], 0) / poly.length;
            const dist = Math.sqrt((local.x - cx) ** 2 + (local.y - cy) ** 2);
            if (dist < bestDist) {
              bestDist = dist;
              bestPartIdx = pi;
              bestPinIdx = pni;
            }
          }
        }
      } else {
        const threshold = s.clickThreshold / Math.abs(this.viewport.scale.x);
        for (let pni = 0; pni < part.pins.length; pni++) {
          const pin = part.pins[pni];
          // Prefer the actual copper-pad bbox when the parser exposes one —
          // gives a tap anywhere on the pad the same effect as tapping the pin
          // sprite, which matches what users expect after seeing the pad layer.
          const pb = pin.padBounds;
          if (pb && local.x >= pb.minX && local.x <= pb.maxX
                 && local.y >= pb.minY && local.y <= pb.maxY) {
            const cx = (pb.minX + pb.maxX) / 2;
            const cy = (pb.minY + pb.maxY) / 2;
            const dist = Math.sqrt((local.x - cx) ** 2 + (local.y - cy) ** 2);
            if (dist < bestDist) {
              bestDist = dist;
              bestPartIdx = pi;
              bestPinIdx = pni;
            }
            continue;
          }
          const dx = pin.position.x - local.x;
          const dy = pin.position.y - local.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist && dist < threshold) {
            bestDist = dist;
            bestPartIdx = pi;
            bestPinIdx = pni;
          }
        }
      }
    }

    if (bestPartIdx >= 0) {
      return { partIndex: bestPartIdx, pinIndex: bestPinIdx };
    }

    // Second pass: check part bounds (same candidate set)
    for (const pi of candidateSet) {
      const part = this.board.parts[pi];
      if (!this.isPartVisible(part)) continue;

      const local = part.side === 'bottom' ? localBot : localTop;
      const rb = computePartRenderBounds(part, s);
      if (local.x >= rb.px && local.x <= rb.px + rb.pw &&
          local.y >= rb.py && local.y <= rb.py + rb.ph) {
        return { partIndex: pi, pinIndex: -1 };
      }
    }

    return null;
  }

  /** Find the trace segment closest to a world-space point, respecting layer visibility */
  private traceHitTest(world: Point): { traceIndex: number; net: string } | null {
    if (!this.board?.traces || !boardStore.showTraces) return null;

    const { layerStates } = boardStore;
    const local = this.worldToScene(world, this.activeScene?.root);
    // Threshold: half trace width + a generous pointer tolerance scaled by zoom
    const zoomScale = Math.abs(this.viewport.scale.x);
    const pointerTol = 8 / zoomScale; // 8 CSS px converted to scene units

    let bestDist = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < this.board.traces.length; i++) {
      const t = this.board.traces[i];
      // Skip traces on hidden layers
      if (t.layer != null && t.layer < layerStates.length && !layerStates[t.layer].visible) continue;

      const halfW = (t.width || 1) / 2;
      const threshold = halfW + pointerTol;

      // Point-to-line-segment distance
      const ax = t.start.x, ay = t.start.y;
      const bx = t.end.x, by = t.end.y;
      const abx = bx - ax, aby = by - ay;
      const len2 = abx * abx + aby * aby;
      let dist: number;
      if (len2 < 0.001) {
        // Degenerate segment (zero length)
        const dx = local.x - ax, dy = local.y - ay;
        dist = Math.sqrt(dx * dx + dy * dy);
      } else {
        const t0 = Math.max(0, Math.min(1, ((local.x - ax) * abx + (local.y - ay) * aby) / len2));
        const px = ax + t0 * abx, py = ay + t0 * aby;
        const dx = local.x - px, dy = local.y - py;
        dist = Math.sqrt(dx * dx + dy * dy);
      }
      if (dist < threshold && dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      return { traceIndex: bestIdx, net: this.board.traces[bestIdx].net };
    }
    return null;
  }

  // --- Click handling ---

  private handleHover(e: PointerEvent) {
    if (!this.board || !this.activeScene || !boardStore.showHoverInfo) {
      this.hideTooltip();
      this.setHoverNet(null);
      return;
    }

    // e.offsetX/Y are canvas-relative — same as containerEl coords since canvas fills the container
    const world = this.viewport.toWorld(e.offsetX, e.offsetY);
    const hit = this.hitTest(world);
    if (hit && hit.pinIndex >= 0) {
      const part = this.board.parts[hit.partIndex];
      const pin = part?.pins[hit.pinIndex];
      if (pin && part) {
        const pinId = pin.number || String(hit.pinIndex + 1);
        this.showTooltip(e.offsetX, e.offsetY, { net: pin.net ?? '', part: part.name, pin: pinId });
        this.setHoverNet(pin.net || null);
        return;
      }
    }
    // Fallback: check traces
    const traceHit = this.traceHitTest(world);
    if (traceHit) {
      const t = this.board.traces![traceHit.traceIndex];
      const layerName = t.layer != null && this.board.layerNames?.[t.layer]
        ? this.board.layerNames[t.layer] : '';
      this.showTooltip(e.offsetX, e.offsetY, { net: traceHit.net, part: layerName, pin: 'trace' });
      this.setHoverNet(traceHit.net || null);
      return;
    }
    this.hideTooltip();
    this.setHoverNet(null);
  }

  /** Update hover net and redraw selection overlay if ambient dim needs it */
  private setHoverNet(net: string | null) {
    if (net === this.hoverNet) return;
    this.hoverNet = net;
    // In ambient dim mode, hover changes which pins are punched through the overlay
    if (renderSettingsStore.settings.ambientDim && boardStore.showNetDim) {
      this.renderSelection();
    }
  }

  private showTooltip(x: number, y: number, info: { net: string; part: string; pin: string }) {
    const el = this.tooltipEl;
    if (!el) return;

    const hasNet = info.net && info.net !== '(null)';
    // Reuse pre-created spans — avoids DOM allocation + forced reflow on every mousemove
    if (this.tooltipNetSpan) {
      this.tooltipNetSpan.textContent = hasNet ? info.net : '';
      this.tooltipNetSpan.style.display = hasNet ? '' : 'none';
    }
    if (this.tooltipDetailSpan) {
      this.tooltipDetailSpan.textContent = `${info.part} · pin ${info.pin}`;
    }
    // OBD enrichment: if the hovered net has cached OpenBoardData readings,
    // append a compact "d 0.45 · 3.30 V · 47k Ω · 📝" line.
    if (this.tooltipObdSpan) {
      const obdLine = hasNet ? this.formatObdForNet(info.net) : '';
      this.tooltipObdSpan.textContent = obdLine;
      this.tooltipObdSpan.style.display = obdLine ? '' : 'none';
    }

    el.style.display = 'block';
    el.style.left = '0';
    el.style.top = '0';
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const offset = 14;
    const left = Math.max(2, Math.min(x - tw / 2, this.containerEl.clientWidth - tw - 2));
    const top = y - th - offset < 2 ? y + offset : y - th - offset;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  private hideTooltip() {
    if (this.tooltipEl) this.tooltipEl.style.display = 'none';
  }

  /** Compose the OBD reading line for the currently-hovered net. Empty
   *  string when there is no board number, no cached OBD data, or no net
   *  match — the caller hides the span in that case. Hot path: called on
   *  every pin-hover move, so the work beyond a Map lookup must be cheap.
   *  Wrapped in try/catch because a throw here would propagate up through
   *  the pointermove handler and noisily fill the console on every move. */
  private formatObdForNet(netName: string): string {
    try {
      const bn = extractBoardNumberFromFilename(boardStore.fileName);
      if (!bn) return '';
      const nets = obdNetLookup(bn, netName);
      if (nets.length === 0) return '';
      const diodes = uniqOf(nets, n => n.diode);
      const volts = uniqOf(nets, n => n.voltage);
      const ohms = uniqOf(nets, n => n.resistance);
      const hasComment = nets.some(n => Array.isArray(n.comments) && n.comments.length > 0);
      const parts: string[] = [];
      if (diodes.length) parts.push(`d ${diodes.join('/')}`);
      if (volts.length) parts.push(`${volts.join('/')} V`);
      if (ohms.length) parts.push(`${ohms.join('/')} Ω`);
      if (parts.length === 0 && !hasComment) return '';
      return (parts.join(' · ') + (hasComment ? ' 📝' : '')).trim();
    } catch (e) {
      log.render.warn('OBD tooltip lookup failed', e);
      return '';
    }
  }

  private handleClick(world: Point) {
    if (this.dragZoomConsumedClick) {
      this.dragZoomConsumedClick = false;
      return;
    }
    const hit = this.hitTest(world);
    if (hit) {
      if (hit.pinIndex >= 0) {
        boardStore.selectPin(hit.partIndex, hit.pinIndex);
      } else {
        boardStore.selectPart(hit.partIndex);
      }
      return;
    }
    // Fallback: click on trace → highlight its net
    const traceHit = this.traceHitTest(world);
    if (traceHit && traceHit.net) {
      boardStore.highlightNet(
        boardStore.selection.highlightedNet === traceHit.net ? null : traceHit.net
      );
      return;
    }
    boardStore.selectPart(null);
  }

  /** Double-click on a component → force-search it in the linked PDF (overwrites user search). */
  private handleDblClick(e: MouseEvent) {
    if (!this.board) return;
    const rect = this.containerEl.getBoundingClientRect();
    const worldPoint = this.viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const hit = this.hitTest(worldPoint);
    if (!hit) return;
    const part = this.board.parts[hit.partIndex];
    if (part) this.triggerFollowPdf(part, true);
  }

  private handleRightClick(e: MouseEvent) {
    if (!this.board) return;
    const rect = this.containerEl.getBoundingClientRect();
    const worldPoint = this.viewport.toWorld(
      e.clientX - rect.left,
      e.clientY - rect.top,
    );
    const hit = this.hitTest(worldPoint);
    if (hit) {
      const part = this.board.parts[hit.partIndex];
      if (part) {
        const pin = hit.pinIndex >= 0 ? part.pins[hit.pinIndex] : null;
        const pinId = pin ? pinDisplayId(pin, hit.pinIndex) : null;
        const netName = pin?.net || null;
        contextMenuStore.showBoard(e.clientX, e.clientY, part.name, pinId, netName);
      }
    }
  }

  fitToBoard(board?: BoardData) {
    const b = board?.bounds ?? this.board?.bounds;
    if (!b) return;

    // Sync viewport dimensions to current container size — the container may have
    // been resized (e.g. dockview panel split) since the viewport was created.
    const cw = this.containerEl.clientWidth;
    const ch = this.containerEl.clientHeight;
    if (cw > 0 && ch > 0) {
      this.viewport.resize(cw, ch);
      this.app.renderer.resize(cw, ch);
    }

    const pad = renderSettingsStore.settings.fitPadding;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;

    if (boardStore.butterfly) {
      // Butterfly separates along the shorter visual axis (mirrors applyFlips logic).
      const rotation = boardStore.rotation * Math.PI / 180;
      const sinR = Math.abs(Math.sin(rotation));
      const cosR = Math.abs(Math.cos(rotation));
      const visualW = bw * cosR + bh * sinR;
      const visualH = bw * sinR + bh * cosR;
      const separateX = visualH >= visualW;
      const sepDim = separateX ? visualW : visualH;
      const gap = sepDim * 0.05;
      // Double the dimension along the separation axis
      const fitW = separateX ? bw * 2 + gap + pad * 2 : bw + pad * 2;
      const fitH = separateX ? bh + pad * 2 : bh * 2 + gap + pad * 2;
      this.viewport.fit(false, fitW, fitH);
    } else {
      this.viewport.fit(false, bw + pad * 2, bh + pad * 2);
    }
    this.viewport.moveCenter((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    this.needsRender = true;
    if (!this.app.ticker.started) this.app.ticker.start();
  }

  private panView(direction: PanDirection) {
    if (!this.viewport) return;
    const step = this.viewport.screenWidth * 0.15;
    const dx = direction === 'left' ? step : direction === 'right' ? -step : 0;
    const dy = direction === 'up' ? step : direction === 'down' ? -step : 0;
    this.viewport.position.set(this.viewport.position.x + dx, this.viewport.position.y + dy);
    this.needsRender = true;
    this.netLinesDirty = true;
  }

  destroy() {
    this.destroyed = true;
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    if (this.zoomSettleTimer) { clearTimeout(this.zoomSettleTimer); this.zoomSettleTimer = null; }
    if (this.netLineSettleTimer) { clearTimeout(this.netLineSettleTimer); this.netLineSettleTimer = null; }
    if (this._pendingFitTimer) { clearTimeout(this._pendingFitTimer); this._pendingFitTimer = null; }
    if (this.wheelIdleTimer) { clearTimeout(this.wheelIdleTimer); this.wheelIdleTimer = null; }
    if (this.followDebounceTimer) { clearTimeout(this.followDebounceTimer); this.followDebounceTimer = null; }
    this.unsubscribeBoard?.();
    this.unsubscribeSettings?.();
    this.unsubscribeTheme?.();
    this.unsubscribeViewCommands?.();
    this.resizeObserver?.disconnect();
    if (this.boundShiftWheel) {
      this.containerEl.removeEventListener('wheel', this.boundShiftWheel, true);
      this.boundShiftWheel = null;
    }
    // Force-cleanup any in-flight drag-zoom gesture so its window-scoped
    // listeners don't outlive this BoardRenderer and then dereference a
    // disposed viewport on the next pointerup.
    if (this.activeDragZoomCleanup) {
      this.activeDragZoomCleanup();
      this.activeDragZoomCleanup = null;
    }
    if (this.boundDragZoomDown) {
      this.containerEl.removeEventListener('pointerdown', this.boundDragZoomDown, true);
      this.boundDragZoomDown = null;
    }
    if (this.boundContextMenu) {
      this.containerEl.removeEventListener('contextmenu', this.boundContextMenu);
    }
    if (this.boundDblClick) {
      this.containerEl.removeEventListener('dblclick', this.boundDblClick);
      this.boundDblClick = null;
    }
    if (this.tooltipCanvas && this.boundHover) {
      this.tooltipCanvas.removeEventListener('pointermove', this.boundHover);
      this.tooltipCanvas.removeEventListener('pointerleave', this.boundHideTooltip!);
      if (this.boundWheelWake) this.tooltipCanvas.removeEventListener('wheel', this.boundWheelWake);
      this.tooltipCanvas = null;
    }
    this.boundHover = null;
    this.boundHideTooltip = null;
    this.boundWheelWake = null;
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.tooltipNetSpan = null;
    this.tooltipDetailSpan = null;
    if (this.boundGestureStart) {
      this.containerEl.removeEventListener('gesturestart', this.boundGestureStart);
      this.boundGestureStart = null;
    }
    if (this.boundGestureChange) {
      this.containerEl.removeEventListener('gesturechange', this.boundGestureChange);
      this.boundGestureChange = null;
    }
    if (this.perfToggleBtn && this.perfToggleBtnHandler) {
      this.perfToggleBtn.removeEventListener('click', this.perfToggleBtnHandler);
      this.perfToggleBtnHandler = null;
    }
    if (this.hudEl) {
      this.hudEl.remove();
      this.hudEl = null;
    }
    this.selectionOverlayEl?.parentElement?.removeChild(this.selectionOverlayEl);
    this.selectionOverlayEl = null;
    this.perfOverlayEl?.parentElement?.removeChild(this.perfOverlayEl);
    this.perfOverlayEl = null;
    this.perfToggleBtn?.parentElement?.removeChild(this.perfToggleBtn);
    this.perfToggleBtn = null;
    if (this.initialized) {
      // Clean up scene objects
      try { this.invalidateAllScenes(); } catch { /* ignore */ }
      try { this.netDimGfx?.clear(); } catch { /* ignore */ }
      try { this.netLabelLayer?.removeChildren(); } catch { /* ignore */ }
      try { this.selectionGfx?.clear(); } catch { /* ignore */ }
      try { this.netLinesGfx?.clear(); } catch { /* ignore */ }
      this.stopTicker();
    }
    // Remove context loss listeners before discarding the canvas
    this.removeContextLossHandlers();
    // Do NOT call app.destroy() — it triggers GlobalResourceRegistry.clear()
    // which corrupts the module-level batchPool shared by ALL PixiJS Applications.
    // Instead: remove canvas, force-release the WebGL context so the browser can
    // reclaim the GPU slot (browsers limit to ~8-16 contexts), then null out all
    // PixiJS references to break the closure cycle (onTick arrow fn → this → app).
    try {
      const canvas = this.app?.renderer?.canvas as HTMLCanvasElement | undefined;
      canvas?.parentElement?.removeChild(canvas);
      // Force browser to release the WebGL context immediately
      const gl = (this.app?.renderer as any)?.gl as WebGL2RenderingContext | undefined;
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch { /* ignore */ }

    // Break strong reference cycles so GC can collect the Application + scene graph.
    // The onTick arrow function captures `this`, so we must sever the chain:
    //   BoardRenderer → app → ticker → onTick → BoardRenderer
    this.activeScene = null;
    this.sceneCache.clear();
    this.hitGridCache.clear();
    this.viewportStates.clear();
    this.board = null;
    (this as any).app = null;
    (this as any).viewport = null;
  }
}
