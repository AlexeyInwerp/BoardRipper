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
 * Debug logging: set `window.__BV_DEBUG = 1` (or 2 for verbose) in the browser console.
 */
import { Application, Graphics, Container, BitmapText, Text } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { BoardData, Point } from '../parsers';
import { pinDisplayId } from '../parsers/types';
import { boardStore } from '../store/board-store';
import { renderSettingsStore, computePinRadius, computeEffectiveBounds, resolvePinColor } from '../store/render-settings';
import { contextMenuStore } from '../store/context-menu-store';
import { viewCommands } from '../store/view-commands';
import type { PanDirection } from '../store/view-commands';
import { buildBoardScene, drawOutline, drawOutlineDebug, updateBorderWidths, BOARD_COLORS } from './board-scene';
import type { BorderBatch } from './board-scene';
import { getFormat } from '../parsers/registry';
import { logStore } from '../store/log-store';

// Alias for local use — all colour references go through board-scene.ts
const COLORS = BOARD_COLORS;

// Debug logging — set via browser console: window.__BV_DEBUG = 1 (or 2 for verbose)
type DebugLevel = 0 | 1 | 2;
function dbg(level: DebugLevel, ...args: unknown[]) {
  const current = (globalThis as Record<string, unknown>).__BV_DEBUG as number ?? 0;
  if (current >= level) console.log('[BoardRenderer]', ...args);
}

/** Pre-built scene graph for a single board */
interface BoardScene {
  root: Container;
  outlineGfx: Graphics;
  topLayer: Container;
  bottomLayer: Container;
  labels: import('pixi.js').BitmapText[];
  topLabels: import('pixi.js').BitmapText[];
  bottomLabels: import('pixi.js').BitmapText[];
  topPinLabels: import('pixi.js').BitmapText[];
  bottomPinLabels: import('pixi.js').BitmapText[];
  borderBatches: BorderBatch[];
  fontSizeGroups: import('./board-scene').FontSizeGroup[];
  /** Flat containers for pin/net labels only — toggling .visible hides them in O(1) during zoom */
  topPinLabelsLayer: Container;
  bottomPinLabelsLayer: Container;
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

  private app: Application;
  private viewport!: Viewport;
  private selectionGfx!: Graphics;
  private netDimGfx!: Graphics;
  /** Container for part-name labels drawn above the net-dim overlay */
  private netLabelLayer!: Container;
  private butterflySelectionGfx!: Graphics;
  private netLinesGfx!: Graphics;
  private debugVertexLabels: Text[] = [];
  private debugVertexPositions: Array<{x: number; y: number}> = [];
  private board: BoardData | null = null;
  private unsubscribeBoard: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private unsubscribeViewCommands: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private containerEl: HTMLDivElement;
  private initialized = false;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
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

  // On-demand rendering: only render when something changed
  private needsRender = true;

  // LoD zoom tracking — updated by ticker
  private lastLodScale = -1;

  // Hide-text-during-zoom: detect actual zooming via per-frame scale comparison
  private zoomSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private textHiddenForZoom = false;
  private prevTickScale = -1;

  // Selection blink state (triggered by focusPart / PDF reverse search)
  private selectionBlinkPhase = 0;
  private selectionBlinkTimer: ReturnType<typeof setTimeout> | null = null;

  // Net line pulse animation phase (0–1, driven by ticker)
  private netLinePulsePhase = 0;

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
  private sceneCache = new Map<BoardData, BoardScene>();
  private activeScene: BoardScene | null = null;

  // Cached label counts for perf overlay — updated by applyLabelVisibility, not by iterating every 500ms
  private labelCounts = { partVis: 0, partTotal: 0, pinVis: 0, pinTotal: 0 };

  // Trackpad rotation gesture state
  private gestureStartRotation = 0;
  private boundGestureStart: ((e: Event) => void) | null = null;
  private boundGestureChange: ((e: Event) => void) | null = null;

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

  /** Pause the renderer (stop ticker, zero CPU cost). Call when panel is hidden. */
  pause() {
    dbg(1, 'pause', 'tab=' + this.tabId);
    this.app.ticker.stop();
  }

  /** Resume the renderer (restart ticker). Call when panel becomes visible. */
  resume() {
    const w = this.containerEl.clientWidth;
    const h = this.containerEl.clientHeight;
    dbg(1, 'resume', 'tab=' + this.tabId, 'size=' + w + 'x' + h,
      'activeTabId=' + boardStore.activeTabId,
      'board=' + (this.board ? this.board.format : 'null'),
      'scene=' + (this.activeScene ? 'yes' : 'null'),
      'initialized=' + this.initialized);
    this.app.ticker.start();
    this.needsRender = true;
    // Re-sync with container size (may have been 0 while hidden)
    if (w > 0 && h > 0 && this.viewport) {
      this.viewport.resize(w, h);
      this.app.renderer.resize(w, h);
    }
    // Sync with current store state
    this.onBoardUpdate();
  }

  async init() {
    dbg(1, 'init', this.containerEl.clientWidth, 'x', this.containerEl.clientHeight);
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

    this.viewport
      .drag()
      .pinch()
      .wheel({ smooth: 5 })
      .decelerate({ friction: 0.95 })
      .clampZoom({ minScale: 0.001, maxScale: 10 });

    // Viewport pan/zoom/decelerate → mark dirty so we render
    this.viewport.on('moved', () => { this.needsRender = true; this.netLinesDirty = true; });

    this.app.stage.addChild(this.viewport);

    this.selectionGfx = new Graphics();
    this.netDimGfx = new Graphics();
    this.netLabelLayer = new Container();
    this.butterflySelectionGfx = new Graphics();
    this.netLinesGfx = new Graphics();

    // Elevated labels for selected part/pin — persistent objects, toggled in renderSelection()
    const labelStyle = { fontSize: 12, fill: 0xffffff, fontFamily: 'monospace' };
    this.elevatedPartBg = new Graphics();
    this.elevatedPartLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPartLabel.anchor.set(0.5, 0.5);
    this.elevatedPartLabel.visible = false;
    this.elevatedPartBg.visible = false;
    this.elevatedPinBg = new Graphics();
    this.elevatedPinLabel = new BitmapText({ text: '', style: labelStyle });
    this.elevatedPinLabel.anchor.set(0.5, 0.5);
    this.elevatedPinLabel.visible = false;
    this.elevatedPinBg.visible = false;
    this.viewport.addChild(this.netLinesGfx);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.viewport.on('clicked', (e: any) => {
      this.handleClick(e.world as Point);
    });

    this.boundContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      this.handleRightClick(e);
    };
    this.containerEl.addEventListener('contextmenu', this.boundContextMenu);

    // Mac trackpad rotation gesture — gesturestart/gesturechange are Safari/Chrome on macOS
    this.boundGestureStart = (e: Event) => {
      e.preventDefault();
      this.gestureStartRotation = boardStore.rotation;
    };
    this.boundGestureChange = (e: Event) => {
      e.preventDefault();
      const rotation = (e as unknown as { rotation: number }).rotation;
      boardStore.setRotationFree(this.gestureStartRotation - rotation);
    };
    this.containerEl.addEventListener('gesturestart', this.boundGestureStart, { passive: false });
    this.containerEl.addEventListener('gesturechange', this.boundGestureChange, { passive: false });

    this.unsubscribeBoard = boardStore.subscribe(() => this.onBoardUpdate());
    this.unsubscribeSettings = renderSettingsStore.subscribe(() => this.onSettingsUpdate());
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
    let hudThrottle = 0;
    this.app.ticker.add((ticker) => {
      const perf = this.perfVisible;
      const frameStart = perf ? performance.now() : 0;

      // Drive animated zoom
      if (this.zoomAnim) {
        const a = this.zoomAnim;
        a.elapsed += ticker.deltaMS;
        const t = Math.min(a.elapsed / a.duration, 1);
        const e = this.easeOutCubic(t);
        const sx = a.fromScaleX + (a.toScaleX - a.fromScaleX) * e;
        const sy = a.fromScaleY + (a.toScaleY - a.fromScaleY) * e;
        const px = a.fromX + (a.toX - a.fromX) * e;
        const py = a.fromY + (a.toY - a.fromY) * e;
        this.viewport.scale.set(sx, sy);
        this.viewport.position.set(px, py);
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

      // Smooth net-dim fade on every frame (updateLoD has a 10% threshold)
      if (boardStore.selection.highlightedNet) {
        this.updateNetDimAlpha(curScale);
      }

      // Net line pulse animation — only when there's an active selection with net lines
      if (boardStore.showNetLines && boardStore.selection.highlightedNet) {
        const s = renderSettingsStore.settings;
        if (s.netLineDashed || s.netLinePulse) {
          this.netLinePulsePhase = (this.netLinePulsePhase + ticker.deltaMS / 1000) % 1;
          t0 = perf ? performance.now() : 0;
          this.renderNetLines();
          if (perf) this.perfAccum.netLines += performance.now() - t0;
          this.needsRender = true;
        }
      }

      this.updateDebugVertexLabels();

      // On-demand GPU render — skip when nothing changed (e.g. idle at high zoom)
      if (this.needsRender) {
        this.needsRender = false;
        t0 = perf ? performance.now() : 0;
        this.app.render();
        if (perf) this.perfAccum.gpuRender += performance.now() - t0;
      }

      if (perf) {
        this.perfAccum.frame += performance.now() - frameStart;
        this.perfSamples++;
      }

      // HUD update (DOM only, no GPU cost) — throttle to ~4 updates/sec
      hudThrottle += ticker.deltaMS;
      if (hudThrottle >= 250) {
        hudThrottle = 0;
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
    });

    // Pick up any board data that loaded during async init
    this.onBoardUpdate();
    const tabLabel = this.tabId !== null ? ` (tab ${this.tabId})` : '';
    logStore.log('log', `[renderer] Initialized${tabLabel}: ${this.containerEl.clientWidth}×${this.containerEl.clientHeight}`);
    } catch (err) {
      logStore.log('error', '[renderer] init failed:', err);
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
        scene.topPinLabelsLayer.visible = false;
        scene.bottomPinLabelsLayer.visible = false;
      }
    }
    // Redraw net lines immediately on every zoom frame
    this.netLinesDirty = true;
    this.renderNetLines();
    // Reset settle timer on every zoom frame
    if (this.zoomSettleTimer) clearTimeout(this.zoomSettleTimer);
    // Restore labels after zoom settles (~2 frames idle)
    this.zoomSettleTimer = setTimeout(() => {
      this.zoomSettleTimer = null;
      if (this.textHiddenForZoom) {
        this.textHiddenForZoom = false;
        // Apply LoD (updates per-label visible) while container is still hidden — no flash
        this.applyLabelVisibility();
        const scene = this.activeScene;
        if (scene) {
          scene.topPinLabelsLayer.visible = true;
          scene.bottomPinLabelsLayer.visible = true;
        }
        this.needsRender = true;
      }
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

    // Fade net-dim overlay when zoomed in past 150% of fit level
    this.updateNetDimAlpha(scale);

    return true;
  }

  /** Compute relative zoom (1.0 = fit view) and fade the net-dim overlay. */
  private updateNetDimAlpha(absScale: number) {
    if (!this.board || !boardStore.showNetDim) return;
    const b = this.board.bounds;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;
    if (bw <= 0 || bh <= 0) return;
    const vw = this.viewport.screenWidth;
    const vh = this.viewport.screenHeight;
    const fitScale = Math.min(vw / bw, vh / bh);
    const relZoom = absScale / fitScale;
    // Fade: 100% → full dim, 150% → zero dim
    const dimAlpha = Math.max(0, Math.min(1, (1.5 - relZoom) / 0.5));
    if (this.netDimGfx.alpha !== dimAlpha) {
      this.netDimGfx.alpha = dimAlpha;
      this.netLabelLayer.alpha = dimAlpha;
      this.needsRender = true;
    }
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
    return getFormat(board.format)?.flipY ?? false;
  }

  // --- Flip management ---

  /** Apply orientation, view flips, user rotation and mirror to the scene root */
  private applyFlips(board: BoardData, scene: BoardScene) {
    dbg(2, 'applyFlips', { butterfly: boardStore.butterfly, mirrorX: boardStore.mirrorX, mirrorY: boardStore.mirrorY, rotation: boardStore.rotation });
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

      // The bottom half must be mirrored perpendicular to the separation direction
      // in VISUAL (screen) space so it appears as a physical fold of the board.
      //
      // separateX=true  → halves side-by-side → fold axis is vertical  → mirror visual-X
      // separateX=false → halves stacked      → fold axis is horizontal → mirror visual-Y
      //
      // When axes are swapped (rotation 90°/270°): visual-X ↔ board-Y, so:
      //   mirror visual-X needs board-Y flip  (i.e. botSy = -topSy)
      //   mirror visual-Y needs board-X flip  (i.e. botSx = -sx)
      //
      // When axes are NOT swapped (rotation 0°/180°):
      //   mirror visual-X needs board-X flip  (i.e. botSx = -sx)
      //   mirror visual-Y needs board-Y flip  (i.e. botSy = -topSy)
      //
      // So: mirror board-X when (separateX XOR axesSwapped), else mirror board-Y.
      const mirrorBoardX = separateX !== axesSwapped;
      const botScaleX = mirrorBoardX ? -sx    : sx;
      const botScaleY = mirrorBoardX ? topSy  : -topSy;

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
        for (const arr of [scene.topLabels, scene.topPinLabels]) {
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

      // When viewing bottom only, mirror X (like physically flipping the board
      // over a vertical axis). Also invert Y to match the physical flip — this
      // replicates OpenBoardView's FlipBoard(m_flipVertically=true) behaviour:
      // negate dx (X mirror in CoordToScreen) + Rotate(2) → net effect is Y mirror.
      const bottomOnly = boardStore.showBottom && !boardStore.showTop;
      const flipX = bottomOnly !== mirrorX;
      const flipY = (autoFlipY !== mirrorY) !== bottomOnly;

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
        for (const arr of [scene.labels, scene.topPinLabels, scene.bottomPinLabels]) {
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
      }
      return;
    }
    dbg(1, 'setupButterfly');

    // Create butterfly root with a copy of the outline
    const broot = new Container();
    const boutline = new Graphics();
    drawOutline(boutline, board, renderSettingsStore.settings);

    broot.addChild(boutline);

    // Move bottomLayer from root into butterfly root
    scene.root.removeChild(scene.bottomLayer);
    broot.addChild(scene.bottomLayer);

    scene.butterflyRoot = broot;
    scene.butterflyOutline = boutline;

    broot.addChild(this.butterflySelectionGfx);
    this.viewport.addChild(broot);

    // Keep net lines on top of butterfly content
    this.viewport.removeChild(this.netLinesGfx);
    this.viewport.addChild(this.netLinesGfx);
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
    scene.root.addChild(this.netLabelLayer);
    scene.root.addChild(this.selectionGfx);

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

  private buildScene(board: BoardData): BoardScene {
    const t0 = performance.now();
    try {
      const graph = buildBoardScene(board, renderSettingsStore.settings);
      const elapsed = (performance.now() - t0).toFixed(0);
      logStore.log('log', `[renderer] Scene built in ${elapsed}ms: ${board.parts.length} parts, ${graph.topLabels.length + graph.bottomLabels.length} labels`);

      // Debug vertex overlay for XZZ boards
      this.clearDebugVertexLabels();
      if (board.format === 'XZZ') {
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
      logStore.log('error', '[renderer] buildBoardScene failed:', err);
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
    let scene = this.sceneCache.get(board);
    if (!scene) {
      scene = this.buildScene(board);
      this.sceneCache.set(board, scene);
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
    }
  }

  private activateScene(board: BoardData) {
    dbg(1, 'activateScene', board.format, board.parts.length, 'parts');
    const scene = this.getOrBuildScene(board);

    if (this.activeScene === scene) {
      // Same scene — just update layer visibility + flips
      dbg(1, 'activateScene: same scene, updating flips');
      scene.topLayer.visible = this.isTopVisible;
      scene.bottomLayer.visible = this.isBottomVisible;
      this.applyFlips(board, scene);
      this.needsRender = true;
      return;
    }
    dbg(1, 'activateScene: switching to new scene, old=' + (this.activeScene ? 'yes' : 'null'));

    // Save current viewport state before switching
    this.saveViewportState();

    // Detach old scene (netDimGfx + selectionGfx + elevated labels live inside root)
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.netDimGfx);
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

    // Attach new scene + selection overlay (inside root so flips apply to selection too)
    this.viewport.addChild(scene.root);
    scene.root.addChild(this.netDimGfx);
    scene.root.addChild(this.netLabelLayer);
    scene.root.addChild(this.selectionGfx);
    // Elevated labels render on top of selection highlight
    scene.root.addChild(this.elevatedPinBg!);
    scene.root.addChild(this.elevatedPinLabel!);
    scene.root.addChild(this.elevatedPartBg!);
    scene.root.addChild(this.elevatedPartLabel!);
    this.activeScene = scene;
    this.lastFlipParams = null; // force full label transform on first applyFlips for this scene
    // Ensure label layers are visible (may have been hidden by zoom on a different tab)
    scene.topPinLabelsLayer.visible = !this.textHiddenForZoom;
    scene.bottomPinLabelsLayer.visible = !this.textHiddenForZoom;
    this.rebuildLabelCounts(scene);

    // Keep net lines on top of all scene content
    this.viewport.removeChild(this.netLinesGfx);
    this.viewport.addChild(this.netLinesGfx);

    scene.topLayer.visible = this.isTopVisible;
    scene.bottomLayer.visible = this.isBottomVisible;
    this.applyFlips(board, scene);

    // Restore viewport position or fit
    this.restoreViewportState(board);

    // Force LoD re-evaluation for the new scene
    this.lastLodScale = -1;
    this.updateLoD();

    this.needsRender = true;
  }

  private deactivateScene() {
    this.saveViewportState();
    if (this.activeScene) {
      this.teardownButterfly(this.activeScene);
      this.activeScene.root.removeChild(this.netDimGfx);
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
    this.netLabelLayer.removeChildren();
    this.selectionGfx.clear();
  }

  private invalidateAllScenes() {
    // Detach all overlay objects from active scene before destroying — these
    // objects are persistent (reused across rebuilds) and must not be destroyed
    // when scene.root.destroy({ children: true }) is called below.
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.netDimGfx);
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
    this.activeScene = null;
  }

  // --- Event handlers ---

  private onBoardUpdate() {
    if (!this.viewport) {
      dbg(1, 'onBoardUpdate SKIP: no viewport', 'tab=' + this.tabId);
      return;
    }
    // Only react when this renderer's tab is active (skip notifications for other tabs)
    if (this.tabId !== null && boardStore.activeTabId !== this.tabId) {
      dbg(2, 'onBoardUpdate SKIP: tab mismatch', 'mine=' + this.tabId, 'active=' + boardStore.activeTabId);
      return;
    }
    dbg(1, 'onBoardUpdate', 'tab=' + this.tabId,
      'board=' + (boardStore.board ? boardStore.board.format + '/' + boardStore.board.parts.length : 'null'),
      'prev=' + (this.board ? this.board.format + '/' + this.board.parts.length : 'null'),
      'same=' + (boardStore.board === this.board),
      'scene=' + (this.activeScene ? 'yes' : 'null'),
      'tickerStarted=' + this.app.ticker.started);
    try {
      const board = boardStore.board;
      if (board !== this.board) {
        dbg(1, 'onBoardUpdate: board changed', board ? 'activating' : 'deactivating');
        if (board) {
          this.activateScene(board);
        } else {
          this.deactivateScene();
        }
        this.board = board;
      } else if (board && this.activeScene) {
        // Same board — update layer visibility + flips
        this.activeScene.topLayer.visible = this.isTopVisible;
        this.activeScene.bottomLayer.visible = this.isBottomVisible;
        this.applyFlips(board, this.activeScene);
      }

      this.renderSelection();

      // Handle focus requests (animated zoom to part + blink selection)
      const focus = boardStore.consumeFocusRequest();
      if (focus) {
        const focusPart = this.board?.parts[focus.partIndex];
        const focusRoot = focusPart ? this.rootForPart(focusPart) : undefined;
        this.zoomToBounds(focus.bounds, focusRoot, 0.25);
        this.startSelectionBlink();
      }
    } catch (err) {
      logStore.log('error', '[renderer] onBoardUpdate crashed:', err);
    }
  }

  private zoomToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container, viewFraction = 0.25) {
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    if (sw === 0 || sh === 0) return;

    // Target scale magnitude — part should fill ~viewFraction of the smaller screen dimension
    const maxDim = Math.max(bw, bh, 1);
    const targetMag = (Math.min(sw, sh) * viewFraction) / maxDim;

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

  private onSettingsUpdate() {
    if (!this.board) return;
    dbg(2, 'onSettingsUpdate');
    try {
      // Cancel any pending zoom-settle timers (scene is about to be rebuilt)
      if (this.zoomSettleTimer) { clearTimeout(this.zoomSettleTimer); this.zoomSettleTimer = null; }

      this.textHiddenForZoom = false;
      // Save viewport, invalidate all scenes, rebuild current
      this.saveViewportState();
      this.invalidateAllScenes();
      this.activateScene(this.board);
      this.renderSelection();
      // Force LoD re-evaluation on next tick (new scene, thresholds may have changed)
      this.lastLodScale = -1;
    } catch (err) {
      logStore.log('error', '[renderer] onSettingsUpdate crashed:', err);
    }
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
      if (!this.app.ticker.started) this.app.render();
    };

    this.selectionBlinkTimer = setTimeout(() => tick(2), blinkInterval);
  }

  // --- Selection rendering (always rebuilt, lightweight) ---

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
    this.netLabelLayer.removeChildren();
    this.selectionGfx.clear();
    this.butterflySelectionGfx.clear();
    if (!this.board) return;

    const s = renderSettingsStore.settings;
    const sel = boardStore.selection;
    const butterfly = boardStore.butterfly && !!this.activeScene?.butterflyRoot;

    // Pick the right Graphics target for a part (butterfly bottom → butterflySelectionGfx)
    const gfxFor = (part: { side: string }) =>
      butterfly && part.side === 'bottom' ? this.butterflySelectionGfx : this.selectionGfx;

    // ── Highlight all search results ──
    const searchIndices = boardStore.searchResultIndices;
    if (searchIndices.size > 0) {
      const topSearchOutlines: (() => void)[] = [];
      const botSearchOutlines: (() => void)[] = [];
      for (const idx of searchIndices) {
        if (idx === sel.partIndex) continue; // selected part drawn separately
        const part = this.board.parts[idx];
        if (!part) continue;
        if (part.side === 'top' && !this.isTopVisible) continue;
        if (part.side === 'bottom' && !this.isBottomVisible) continue;
        const gfx = gfxFor(part);
        const outlines = gfx === this.butterflySelectionGfx ? botSearchOutlines : topSearchOutlines;
        if (part.pins.length === 1) {
          const pin = part.pins[0];
          const r = computePinRadius(s, pin.radius) + s.selectionPadding;
          outlines.push(() => gfx.circle(pin.position.x, pin.position.y, r));
        } else {
          const eb = computeEffectiveBounds(part.bounds, part.pins, s);
          const sp = s.selectionPadding;
          outlines.push(() => gfx.rect(eb.px - sp, eb.py - sp, eb.pw + sp * 2, eb.ph + sp * 2));
        }
      }
      for (const fn of topSearchOutlines) fn();
      if (topSearchOutlines.length > 0) {
        this.selectionGfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha * 0.5 });
        this.selectionGfx.stroke({ width: s.selectionWidth * 0.7, color: 0x44aaff, alpha: 0.5 });
      }
      for (const fn of botSearchOutlines) fn();
      if (botSearchOutlines.length > 0) {
        this.butterflySelectionGfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha * 0.5 });
        this.butterflySelectionGfx.stroke({ width: s.selectionWidth * 0.7, color: 0x44aaff, alpha: 0.5 });
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
          const eb = computeEffectiveBounds(part.bounds, part.pins, s);
          const sp = s.selectionPadding;
          gfx.rect(eb.px - sp, eb.py - sp, eb.pw + sp * 2, eb.ph + sp * 2);
        }
        gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha });
        // Blink red on odd phases, orange on even (0 = no blink = normal orange)
        const blinkRed = this.selectionBlinkPhase > 0 && this.selectionBlinkPhase % 2 === 1;
        const selColor = blinkRed ? 0xcc2222 : COLORS.partSelected;
        gfx.stroke({ width: s.selectionWidth, color: selColor, alpha: 0.9 });
      }
    }

    if (sel.highlightedNet) {
      const net = this.board.nets.get(sel.highlightedNet);
      if (net) {
        // ── Dim the entire board (if enabled) ────────────────────────────────
        if (boardStore.showNetDim) {
          const b = this.board.bounds;
          const bw = b.maxX - b.minX;
          const bh = b.maxY - b.minY;
          // Use a massive rect (10× board size) to cover butterfly mode, zoom, and pan
          const pad = Math.max(bw, bh) * 5;
          const cx = (b.minX + b.maxX) / 2;
          const cy = (b.minY + b.maxY) / 2;
          this.netDimGfx.rect(cx - pad, cy - pad, pad * 2, pad * 2);
          this.netDimGfx.fill({ color: 0x000000, alpha: 0.5 });
        }

        const showDim = boardStore.showNetDim;

        // ── Highlight parts containing net pins (selection-style outlines) ──
        const seenParts = new Set<number>();
        const topPartOutlines: (() => void)[] = [];
        const botPartOutlines: (() => void)[] = [];

        for (const ref of net.pinIndices) {
          if (seenParts.has(ref.partIndex)) continue;
          seenParts.add(ref.partIndex);
          const part = this.board.parts[ref.partIndex];
          if (!part) continue;
          if (part.side === 'top' && !this.isTopVisible) continue;
          if (part.side === 'bottom' && !this.isBottomVisible) continue;

          const gfx = gfxFor(part);
          const outlines = gfx === this.butterflySelectionGfx ? botPartOutlines : topPartOutlines;

          if (part.pins.length === 1) {
            const pin = part.pins[0];
            const r = computePinRadius(s, pin.radius) + s.selectionPadding;
            outlines.push(() => gfx.circle(pin.position.x, pin.position.y, r));
          } else {
            const eb = computeEffectiveBounds(part.bounds, part.pins, s);
            const sp = s.selectionPadding;
            outlines.push(() => gfx.rect(eb.px - sp, eb.py - sp, eb.pw + sp * 2, eb.ph + sp * 2));
          }
        }

        for (const fn of topPartOutlines) fn();
        if (topPartOutlines.length > 0) {
          this.selectionGfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha });
          this.selectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
        }
        for (const fn of botPartOutlines) fn();
        if (botPartOutlines.length > 0) {
          this.butterflySelectionGfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha });
          this.butterflySelectionGfx.stroke({ width: s.selectionWidth, color: COLORS.netHighlight, alpha: 0.7 });
        }

        // ── Re-draw affected part name labels above the dim overlay ─────────
        if (showDim && this.activeScene) {
          const affectedPartNames = new Set<string>();
          for (const pi of seenParts) {
            const p = this.board.parts[pi];
            if (p) affectedPartNames.add(p.name);
          }
          for (const srcLabel of this.activeScene.labels) {
            if (!srcLabel.visible || !affectedPartNames.has(srcLabel.text)) continue;
            const clone = new BitmapText({
              text: srcLabel.text,
              style: { fontSize: srcLabel.style.fontSize as number, fill: 0xffffff, fontFamily: 'monospace' },
            });
            clone.anchor.set(0.5, 0.5);
            clone.x = srcLabel.x;
            clone.y = srcLabel.y;
            clone.rotation = srcLabel.rotation;
            clone.scale.copyFrom(srcLabel.scale);
            this.netLabelLayer.addChild(clone);
          }
        }

        // ── Re-draw highlighted pins on top of dim with full brightness ────
        // Group per gfx target and per color for batched fills
        const topByColor = new Map<number, (() => void)[]>();
        const botByColor = new Map<number, (() => void)[]>();

        // Also collect yellow highlight shapes (existing behavior)
        const topHighlights: (() => void)[] = [];
        const botHighlights: (() => void)[] = [];

        for (const ref of net.pinIndices) {
          const part = this.board.parts[ref.partIndex];
          const pin = part?.pins[ref.pinIndex];
          if (!pin || !part) continue;

          if (part.side === 'top' && !this.isTopVisible) continue;
          if (part.side === 'bottom' && !this.isBottomVisible) continue;

          const gfx = gfxFor(part);
          const isBotGfx = gfx === this.butterflySelectionGfx;
          const highlights = isBotGfx ? botHighlights : topHighlights;

          // Resolve the pin's actual color
          const isPin1 = ref.pinIndex === 0 && part.pins.length > 2;
          const pinColor = isPin1 ? COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);

          if (part.pins.length === 2) {
            const grow = s.netHighlightGrow;
            const eb = computeEffectiveBounds(part.bounds, part.pins, s);
            const other = part.pins[ref.pinIndex === 0 ? 1 : 0];

            let rx: number, ry: number, rw: number, rh: number;
            if (eb.horiz) {
              const depth = Math.min(eb.ph, eb.pw * 0.4);
              const left = pin.position.x < other.position.x;
              rx = left ? eb.px : eb.px + eb.pw - depth;
              ry = eb.py;
              rw = depth;
              rh = eb.ph;
            } else {
              const depth = Math.min(eb.pw, eb.ph * 0.4);
              const top = pin.position.y < other.position.y;
              rx = eb.px;
              ry = top ? eb.py : eb.py + eb.ph - depth;
              rw = eb.pw;
              rh = depth;
            }
            // Bright re-draw of the pin pad (only needed when dimming)
            if (showDim) {
              const colorMap = isBotGfx ? botByColor : topByColor;
              let arr = colorMap.get(pinColor);
              if (!arr) { arr = []; colorMap.set(pinColor, arr); }
              arr.push(() => gfx.rect(rx, ry, rw, rh));
            }
            // Yellow highlight (slightly larger)
            highlights.push(() => gfx.rect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2));
          } else {
            const r = computePinRadius(s, pin.radius);
            // Bright re-draw of the pin circle (only needed when dimming)
            if (showDim) {
              const colorMap = isBotGfx ? botByColor : topByColor;
              let arr = colorMap.get(pinColor);
              if (!arr) { arr = []; colorMap.set(pinColor, arr); }
              arr.push(() => gfx.circle(pin.position.x, pin.position.y, r));
            }
            // Yellow highlight (slightly larger)
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
      }
    }

    // ── Elevated labels for selected part/pin ───────────────────────────────
    this.updateElevatedLabels(sel, s);

    // ── Selection overlay (big centered text) ─────────────────────────────
    this.updateSelectionOverlay(sel, s);

    if (perf) this.perfAccum.selection += performance.now() - selStart;

    const nlStart = perf ? performance.now() : 0;
    this.renderNetLines();
    if (perf) this.perfAccum.netLines += performance.now() - nlStart;
  }

  /** Draw background-elevated labels for the selected component and/or pin */
  private updateElevatedLabels(
    sel: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null },
    s: import('../store/render-settings').RenderSettings,
  ) {
    const partBg = this.elevatedPartBg!;
    const partLbl = this.elevatedPartLabel!;
    const pinBg = this.elevatedPinBg!;
    const pinLbl = this.elevatedPinLabel!;

    partBg.visible = false;
    partLbl.visible = false;
    pinBg.visible = false;
    pinLbl.visible = false;

    if (!this.board || sel.partIndex === null || !this.activeScene) return;
    const part = this.board.parts[sel.partIndex];
    if (!part) return;

    const vpScale = Math.abs(this.viewport.scale.x);
    const screenFontPx = 18;
    const fontSize = screenFontPx / vpScale;
    const pad = 4 / vpScale;
    const cornerR = 3 / vpScale;

    // Counter-flip: the scene root may be flipped/rotated; labels need to stay readable.
    const root = this.activeScene.root;
    const lsx = Math.sign(root.scale.x) || 1;
    const lsy = Math.sign(root.scale.y) || 1;
    const labelRot = -root.rotation * lsx * lsy;

    const applyCounterFlip = (lbl: BitmapText) => {
      lbl.scale.set(lsx, lsy);
      lbl.rotation = labelRot;
    };

    const applyCounterFlipGfx = (gfx: Graphics, cx: number, cy: number) => {
      gfx.position.set(cx, cy);
      gfx.scale.set(lsx, lsy);
      gfx.rotation = labelRot;
    };

    // ── Part label ──
    if (s.showElevatedPartLabel) {
      const eb = computeEffectiveBounds(part.bounds, part.pins, s);
      const cx = eb.px + eb.pw / 2;
      const cy = eb.py + eb.ph / 2;
      partLbl.style.fontSize = fontSize;
      partLbl.text = part.name;
      partLbl.x = cx;
      partLbl.y = cy;
      applyCounterFlip(partLbl);
      partLbl.visible = true;

      const pBounds = partLbl.getBounds();
      const pw = pBounds.width / vpScale + pad * 2;
      const ph = pBounds.height / vpScale + pad * 2;
      partBg.clear();
      partBg.roundRect(-pw / 2, -ph / 2, pw, ph, cornerR);
      partBg.fill({ color: 0x000000, alpha: 0.75 });
      applyCounterFlipGfx(partBg, cx, cy);
      partBg.visible = true;
    }

    // ── Pin label ──
    if (s.showElevatedPinLabel && sel.pinIndex !== null && sel.pinIndex >= 0) {
      const pin = part.pins[sel.pinIndex];
      if (pin) {
        const pinId = pinDisplayId(pin, sel.pinIndex);
        const pinText = pin.net && pin.net !== '(null)' && pin.net !== ''
          ? `${pinId}: ${pin.net}`
          : pinId;
        pinLbl.style.fontSize = fontSize;
        pinLbl.text = pinText;
        const cx = pin.position.x;
        const r = computePinRadius(s, pin.radius);
        const yOffset = (r + fontSize * 0.8) * lsy;
        const cy = pin.position.y - yOffset;
        pinLbl.x = cx;
        pinLbl.y = cy;
        applyCounterFlip(pinLbl);
        pinLbl.visible = true;

        const pnBounds = pinLbl.getBounds();
        const pnw = pnBounds.width / vpScale + pad * 2;
        const pnh = pnBounds.height / vpScale + pad * 2;
        pinBg.clear();
        pinBg.roundRect(-pnw / 2, -pnh / 2, pnw, pnh, cornerR);
        pinBg.fill({ color: 0x1a1a2e, alpha: 0.85 });
        applyCounterFlipGfx(pinBg, cx, cy);
        pinBg.visible = true;
      }
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

    if (!this.board || !boardStore.showNetLines) return;

    const sel = boardStore.selection;
    if (sel.partIndex === null || !sel.highlightedNet) return;

    const net = this.board.nets.get(sel.highlightedNet);
    if (!net) return;

    const s = renderSettingsStore.settings;

    // Skip GND/NC nets — GND connects too many components, NC is not a real net.
    const netUpper = sel.highlightedNet.toUpperCase();
    if (netUpper.includes('GND') || netUpper === 'NC' || netUpper === 'N/C' || netUpper === 'NO CONNECT') return;
    const selectedPart = this.board.parts[sel.partIndex];
    if (!selectedPart) return;

    const selectedRoot = this.rootForPart(selectedPart);
    const selEB = computeEffectiveBounds(selectedPart.bounds, selectedPart.pins, s);

    // If a specific pin is selected, use its position as the line origin (no clipping)
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

    // Collect visible target parts — anchor line to closest net pin
    let targetCount = 0;
    for (const [partIndex, pinIndices] of partNetPins) {
      const part = this.board.parts[partIndex];
      if (!part) continue;
      if (part.side === 'top' && !this.isTopVisible) continue;
      if (part.side === 'bottom' && !this.isBottomVisible) continue;

      const root = this.rootForPart(part);

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

    // Fade distance for lines (used when many converge)
    const vpScale = Math.abs(this.viewport.scale.x);
    this.netLineFadeDist = targetCount > 8 ? 60 / vpScale : 0;
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

    for (const { start, end } of this.netLineSegments) {
      if (useFade) {
        this.drawNetLineWithFade(start, end, fadeDist, lineW, color, s.netLineAlpha, s.netLineDashed, dashLen, dashOffset);
      } else if (s.netLineDashed) {
        this.drawDashedLine(start, end, dashLen, dashOffset, lineW, color, s.netLineAlpha);
      } else {
        this.netLinesGfx.moveTo(start.x, start.y);
        this.netLinesGfx.lineTo(end.x, end.y);
        this.netLinesGfx.stroke({ width: lineW, color, alpha: s.netLineAlpha });
      }
    }
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

  /** Draw a net line with alpha fade-in near the start to reduce clutter with many lines */
  private drawNetLineWithFade(from: Point, to: Point, fadeDist: number, width: number, color: number, alpha: number, dashed: boolean, dashLen: number, dashOffset: number) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const totalLen = Math.sqrt(dx * dx + dy * dy);
    if (totalLen < 0.001) return;

    const ux = dx / totalLen;
    const uy = dy / totalLen;
    const fadeEnd = Math.min(fadeDist, totalLen * 0.4);

    // Draw fade region in 4 steps with increasing alpha
    const fadeSteps = 4;
    for (let i = 0; i < fadeSteps; i++) {
      const t0 = (i / fadeSteps) * fadeEnd;
      const t1 = ((i + 1) / fadeSteps) * fadeEnd;
      const stepAlpha = alpha * ((i + 1) / fadeSteps) * 0.7; // ramp from ~0.18x to ~0.7x alpha
      const segFrom: Point = { x: from.x + ux * t0, y: from.y + uy * t0 };
      const segTo: Point = { x: from.x + ux * t1, y: from.y + uy * t1 };
      if (dashed) {
        this.drawDashedLine(segFrom, segTo, dashLen, dashOffset + t0, width, color, stepAlpha);
      } else {
        this.netLinesGfx.moveTo(segFrom.x, segFrom.y);
        this.netLinesGfx.lineTo(segTo.x, segTo.y);
        this.netLinesGfx.stroke({ width, color, alpha: stepAlpha });
      }
    }

    // Draw remaining line at full alpha
    if (fadeEnd < totalLen) {
      const remainFrom: Point = { x: from.x + ux * fadeEnd, y: from.y + uy * fadeEnd };
      if (dashed) {
        this.drawDashedLine(remainFrom, to, dashLen, dashOffset + fadeEnd, width, color, alpha);
      } else {
        this.netLinesGfx.moveTo(remainFrom.x, remainFrom.y);
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
    dbg(2, 'hitTest', world);
    if (!this.board) return null;

    const s = renderSettingsStore.settings;
    const butterfly = boardStore.butterfly && this.activeScene?.butterflyRoot;

    // In butterfly mode, we need to convert world coords per-part using the correct root.
    // Pre-compute local coords for top and bottom roots.
    const localTop = this.worldToScene(world, this.activeScene?.root);
    const localBot = butterfly
      ? this.worldToScene(world, this.activeScene!.butterflyRoot!)
      : localTop;

    // First pass: try to hit a specific pin
    let bestDist = Infinity;
    let bestPartIdx = -1;
    let bestPinIdx = -1;

    for (let pi = 0; pi < this.board.parts.length; pi++) {
      const part = this.board.parts[pi];
      if (part.side === 'top' && !this.isTopVisible) continue;
      if (part.side === 'bottom' && !this.isBottomVisible) continue;

      const local = part.side === 'bottom' ? localBot : localTop;
      const isTwoPin = part.pins.length === 2;

      if (isTwoPin) {
        const eb = computeEffectiveBounds(part.bounds, part.pins, s);
        for (let pni = 0; pni < 2; pni++) {
          const pin = part.pins[pni];
          const other = part.pins[1 - pni];
          let rx: number, ry: number, rw: number, rh: number;
          if (eb.horiz) {
            const depth = Math.min(eb.ph, eb.pw * 0.4);
            const left = pin.position.x < other.position.x;
            rx = left ? eb.px : eb.px + eb.pw - depth;
            ry = eb.py;
            rw = depth;
            rh = eb.ph;
          } else {
            const depth = Math.min(eb.pw, eb.ph * 0.4);
            const top = pin.position.y < other.position.y;
            rx = eb.px;
            ry = top ? eb.py : eb.py + eb.ph - depth;
            rw = eb.pw;
            rh = depth;
          }
          if (local.x >= rx && local.x <= rx + rw &&
              local.y >= ry && local.y <= ry + rh) {
            const cx = rx + rw / 2, cy = ry + rh / 2;
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

    // Second pass: check part bounds
    for (let pi = 0; pi < this.board.parts.length; pi++) {
      const part = this.board.parts[pi];
      if (part.side === 'top' && !this.isTopVisible) continue;
      if (part.side === 'bottom' && !this.isBottomVisible) continue;

      const local = part.side === 'bottom' ? localBot : localTop;
      const eb = computeEffectiveBounds(part.bounds, part.pins, s);
      if (local.x >= eb.px && local.x <= eb.px + eb.pw &&
          local.y >= eb.py && local.y <= eb.py + eb.ph) {
        return { partIndex: pi, pinIndex: -1 };
      }
    }

    return null;
  }

  // --- Click handling ---

  private handleClick(world: Point) {
    const hit = this.hitTest(world);
    if (hit) {
      if (hit.pinIndex >= 0) {
        boardStore.selectPin(hit.partIndex, hit.pinIndex);
      } else {
        boardStore.selectPart(hit.partIndex);
      }
    } else {
      boardStore.selectPart(null);
    }
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
        contextMenuStore.show(e.clientX, e.clientY, part.name, pinId, netName);
      }
    }
  }

  fitToBoard(board?: BoardData) {
    const b = board?.bounds ?? this.board?.bounds;
    if (!b) return;
    const pad = renderSettingsStore.settings.fitPadding;
    const bw = b.maxX - b.minX;
    const bh = b.maxY - b.minY;

    if (boardStore.butterfly) {
      // Butterfly shows two boards stacked vertically with 5% gap
      const gap = bh * 0.05;
      this.viewport.fit(true, bw + pad * 2, bh * 2 + gap + pad * 2);
      this.viewport.moveCenter((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    } else {
      this.viewport.fit(true, bw + pad * 2, bh + pad * 2);
      this.viewport.moveCenter((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    }
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
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    if (this.zoomSettleTimer) { clearTimeout(this.zoomSettleTimer); this.zoomSettleTimer = null; }
    if (this.netLineSettleTimer) { clearTimeout(this.netLineSettleTimer); this.netLineSettleTimer = null; }
    this.unsubscribeBoard?.();
    this.unsubscribeSettings?.();
    this.unsubscribeViewCommands?.();
    this.resizeObserver?.disconnect();
    if (this.boundContextMenu) {
      this.containerEl.removeEventListener('contextmenu', this.boundContextMenu);
    }
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
      this.invalidateAllScenes();
      this.netDimGfx?.clear();
      this.netLabelLayer?.removeChildren();
      this.selectionGfx?.clear();
      this.netLinesGfx?.clear();
      // NOTE: do NOT call cleanupShadowFonts() here — installedShadowFonts and the
      // PixiJS BitmapFont registry are module-level globals shared across all renderer
      // instances. Destroying one tab's renderer must not evict fonts still in use by
      // other tabs. Fonts are freed automatically on page unload.
      this.app.destroy(true, { children: true });
    }
  }
}
