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
import { Application, Graphics, Container, BitmapText } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { BoardData, Point } from '../parsers';
import { boardStore } from '../store/board-store';
import { renderSettingsStore, computePinRadius, computeEffectiveBounds } from '../store/render-settings';
import { contextMenuStore } from '../store/context-menu-store';
import { buildBoardScene, drawOutline, updateBorderWidths, cleanupShadowFonts, BOARD_COLORS } from './board-scene';
import type { BorderEntry } from './board-scene';

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
  borderEntries: BorderEntry[];
  fontSizeGroups: import('./board-scene').FontSizeGroup[];
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
  private butterflySelectionGfx!: Graphics;
  private netLinesGfx!: Graphics;
  private board: BoardData | null = null;
  private unsubscribeBoard: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private containerEl: HTMLDivElement;
  private initialized = false;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;
  private hudEl: HTMLDivElement | null = null;

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

  // Scene cache: avoid rebuilding PixiJS objects on tab switch
  private sceneCache = new Map<BoardData, BoardScene>();
  private activeScene: BoardScene | null = null;

  // Viewport state per board: restore pan/zoom on tab switch
  private viewportStates = new Map<BoardData, ViewportState>();

  constructor(container: HTMLDivElement) {
    this.containerEl = container;
    this.app = new Application();
  }

  async init() {
    dbg(1, 'init', this.containerEl.clientWidth, 'x', this.containerEl.clientHeight);
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
    this.viewport.on('moved', () => { this.needsRender = true; });

    this.app.stage.addChild(this.viewport);

    this.selectionGfx = new Graphics();
    this.butterflySelectionGfx = new Graphics();
    this.netLinesGfx = new Graphics();
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

    this.unsubscribeBoard = boardStore.subscribe(() => this.onBoardUpdate());
    this.unsubscribeSettings = renderSettingsStore.subscribe(() => this.onSettingsUpdate());

    this.resizeObserver = new ResizeObserver(() => {
      this.viewport.resize(this.containerEl.clientWidth, this.containerEl.clientHeight);
      this.app.renderer.resize(this.containerEl.clientWidth, this.containerEl.clientHeight);
      this.needsRender = true;
    });
    this.resizeObserver.observe(this.containerEl);

    // HUD overlay (zoom + FPS)
    this.hudEl = document.createElement('div');
    this.hudEl.className = 'board-hud';
    this.containerEl.style.position = 'relative';
    this.containerEl.appendChild(this.hudEl);

    // Combined ticker: LoD updates + net line animation + HUD + on-demand render
    let hudThrottle = 0;
    this.app.ticker.add((ticker) => {
      // Detect active zooming by comparing scale between frames
      const curScale = Math.abs(this.viewport.scale.x);
      if (this.prevTickScale >= 0 && curScale !== this.prevTickScale) {
        this.onZoomFrame();
      }
      this.prevTickScale = curScale;

      if (this.updateLoD()) this.needsRender = true;

      // Net line pulse animation — only when there's an active selection with net lines
      if (boardStore.showNetLines && boardStore.selection.highlightedNet) {
        const s = renderSettingsStore.settings;
        if (s.netLineDashed || s.netLinePulse) {
          this.netLinePulsePhase = (this.netLinePulsePhase + ticker.deltaMS / 1000) % 1;
          this.renderNetLines();
          this.needsRender = true;
        }
      }

      // On-demand GPU render — skip when nothing changed (e.g. idle at high zoom)
      if (this.needsRender) {
        this.needsRender = false;
        this.app.render();
      }

      // HUD update (DOM only, no GPU cost) — throttle to ~4 updates/sec
      hudThrottle += ticker.deltaMS;
      if (hudThrottle >= 250) {
        hudThrottle = 0;
        this.updateHud(ticker.FPS);
      }
    });
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

  /** Called per frame when viewport scale is actively changing (user is zooming) */
  private onZoomFrame() {
    const s = renderSettingsStore.settings;
    if (s.hideTextDuringZoom && !this.textHiddenForZoom) {
      this.textHiddenForZoom = true;
      const scene = this.activeScene;
      if (scene) {
        for (const group of scene.fontSizeGroups) {
          if (group.visible) {
            group.visible = false;
            for (const lbl of group.labels) lbl.visible = false;
          }
        }
      }
    }
    // Reset settle timer on every zoom frame
    if (this.zoomSettleTimer) clearTimeout(this.zoomSettleTimer);
    this.zoomSettleTimer = setTimeout(() => {
      this.zoomSettleTimer = null;
      if (this.textHiddenForZoom) {
        this.textHiddenForZoom = false;
        this.applyLabelVisibility();
        this.needsRender = true;
      }
    }, 200);
  }

  /** Update level-of-detail based on current viewport zoom. Returns true if scale changed. */
  private updateLoD(): boolean {
    const scale = Math.abs(this.viewport.scale.x);
    if (scale === this.lastLodScale) return false;
    // Skip if scale change is negligible (< 5%) to avoid per-frame work during smooth zoom.
    if (this.lastLodScale > 0 && Math.abs(scale - this.lastLodScale) / this.lastLodScale < 0.05) return false;
    this.lastLodScale = scale;

    const scene = this.activeScene;
    if (!scene) return true;
    const s = renderSettingsStore.settings;

    // Update label visibility via font-size groups (skip if text is hidden for zoom)
    if (!this.textHiddenForZoom) {
      this.applyLabelVisibility();
    }

    // Min border width: ensure borders are at least 1 screen pixel
    updateBorderWidths(scene.borderEntries, s.partBorderWidth, scale);

    return true;
  }

  /** Apply label visibility using font-size groups — O(groups) when nothing changes */
  private applyLabelVisibility() {
    const scene = this.activeScene;
    if (!scene) return;
    const s = renderSettingsStore.settings;
    const scale = Math.abs(this.viewport.scale.x);
    const minPx = s.labelMinScreenPx;
    const zoomOk = s.labelZoomHide <= 0 || scale >= s.labelZoomHide;

    for (const group of scene.fontSizeGroups) {
      const shouldBeVisible = zoomOk && group.minSize * scale >= minPx;
      if (shouldBeVisible !== group.visible) {
        group.visible = shouldBeVisible;
        for (const lbl of group.labels) lbl.visible = shouldBeVisible;
      }
    }
  }

  // --- Orientation ---

  /**
   * BVR files use Y-up math convention. Screen uses Y-down.
   * Always flip Y to convert, matching OpenBoardView's CoordToScreen (ty = -1 * ...).
   * User can toggle Mirror Y for manual override.
   */
  private needsYFlip(_board: BoardData): boolean {
    return true;
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

      // Separate along the shorter visual axis (side-by-side when vertical)
      const separateX = visualH > visualW;
      const sepDim = separateX ? visualW : visualH;
      const gap = sepDim * 0.05;
      const halfSep = sepDim / 2 + gap / 2;

      const flipY = autoFlipY !== boardStore.mirrorY;
      const sx = boardStore.mirrorX ? -1 : 1;
      const topSy = flipY ? -1 : 1;
      // Bottom: Y inverted relative to top (flipped around bottom edge)
      const botSy = -topSy;

      const dx = separateX ? halfSep : 0;
      const dy = separateX ? 0 : halfSep;

      // Top half: shifted left/up
      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx - dx, cy - dy);
      scene.root.rotation = rotation;
      scene.root.scale.set(sx, topSy);

      // Bottom half: shifted right/down, Y-flipped
      const broot = scene.butterflyRoot!;
      broot.pivot.set(cx, cy);
      broot.position.set(cx + dx, cy + dy);
      broot.rotation = rotation;
      broot.scale.set(sx, botSy);

      // Counter-flip labels + pin numbers for readability
      for (const arr of [scene.topLabels, scene.topPinLabels]) {
        for (const label of arr) { label.rotation = -rotation; label.scale.set(sx, topSy); }
      }
      for (const arr of [scene.bottomLabels, scene.bottomPinLabels]) {
        for (const label of arr) { label.rotation = -rotation; label.scale.set(sx, botSy); }
      }
    } else {
      // Normal mode
      this.teardownButterfly(scene);

      // When viewing bottom only, flip Y (like flipping a physical board top-to-bottom)
      const bottomFlipY = boardStore.showBottom && !boardStore.showTop;
      const flipX = boardStore.mirrorX;
      const flipY = autoFlipY !== bottomFlipY !== boardStore.mirrorY;

      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx, cy);
      scene.root.rotation = rotation;
      scene.root.scale.set(flipX ? -1 : 1, flipY ? -1 : 1);

      // Counter-flip labels + pin numbers so text stays readable
      const lsx = flipX ? -1 : 1;
      const lsy = flipY ? -1 : 1;
      for (const arr of [scene.labels, scene.topPinLabels, scene.bottomPinLabels]) {
        for (const label of arr) { label.rotation = -rotation; label.scale.set(lsx, lsy); }
      }
    }
  }

  /** Set up butterfly mode: move bottom layer into its own root */
  private setupButterfly(board: BoardData, scene: BoardScene) {
    if (scene.butterflyRoot) { dbg(2, 'setupButterfly: already set up'); return; }
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

    // Move bottom layer back to main root
    scene.butterflyRoot.removeChild(scene.bottomLayer);
    scene.root.addChild(scene.bottomLayer);

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
    const graph = buildBoardScene(board, renderSettingsStore.settings);
    return { ...graph, butterflyRoot: null, butterflyOutline: null };
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
      scene.topLayer.visible = this.isTopVisible;
      scene.bottomLayer.visible = this.isBottomVisible;
      this.applyFlips(board, scene);
      this.needsRender = true;
      return;
    }

    // Save current viewport state before switching
    this.saveViewportState();

    // Detach old scene (selectionGfx lives inside root)
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.selectionGfx);
      this.viewport.removeChild(this.activeScene.root);
      if (this.activeScene.butterflyRoot) {
        this.viewport.removeChild(this.activeScene.butterflyRoot);
      }
    }

    // Attach new scene + selection overlay (inside root so flips apply to selection too)
    this.viewport.addChild(scene.root);
    scene.root.addChild(this.selectionGfx);
    this.activeScene = scene;

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
      this.activeScene.root.removeChild(this.selectionGfx);
      this.viewport.removeChild(this.activeScene.root);
      this.activeScene = null;
    }
    this.selectionGfx.clear();
  }

  /** Remove a board's cached scene (called when tab is closed or settings change) */
  private invalidateScene(board: BoardData) {
    const scene = this.sceneCache.get(board);
    if (scene) {
      scene.root.destroy({ children: true });
      this.sceneCache.delete(board);
    }
  }

  private invalidateAllScenes() {
    // Detach selectionGfx from active scene before destroying
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.selectionGfx);
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
    if (!this.viewport) return;
    dbg(2, 'onBoardUpdate');
    try {
      const board = boardStore.board;
      if (board !== this.board) {
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

      // Handle focus requests (zoom to part + blink selection)
      const focus = boardStore.consumeFocusRequest();
      if (focus) {
        const focusPart = this.board?.parts[focus.partIndex];
        const focusRoot = focusPart ? this.rootForPart(focusPart) : undefined;
        const pinCount = focusPart?.pins.length ?? 0;
        this.zoomToBounds(focus.bounds, focusRoot, pinCount > 2 ? 0.6 : 0.05);
        this.startSelectionBlink();
      }
    } catch (err) {
      console.error('[BoardRenderer] onBoardUpdate crashed:', err);
    }
  }

  private zoomToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container, viewFraction = 0.05) {
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    const maxDim = Math.max(bw, bh, 1);
    const scale = (Math.min(sw, sh) * viewFraction) / maxDim;
    this.viewport.scale.set(scale, scale);

    // Convert scene-local center to world coords for viewport
    const center = this.sceneToWorld({
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    }, root);
    this.viewport.moveCenter(center.x, center.y);
  }

  private onSettingsUpdate() {
    if (!this.board) return;
    dbg(2, 'onSettingsUpdate');
    try {
      // Cancel any pending zoom-settle timer (scene is about to be rebuilt)
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
      console.error('[BoardRenderer] onSettingsUpdate crashed:', err);
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
    };

    this.selectionBlinkTimer = setTimeout(() => tick(2), blinkInterval);
  }

  // --- Selection rendering (always rebuilt, lightweight) ---

  private renderSelection() {
    this.needsRender = true;
    // Cancel any in-progress blink from a previous selection
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    this.selectionBlinkPhase = 0;
    this.selectionGfx.clear();
    this.butterflySelectionGfx.clear();
    if (!this.board) return;

    const s = renderSettingsStore.settings;
    const sel = boardStore.selection;
    const butterfly = boardStore.butterfly && !!this.activeScene?.butterflyRoot;

    // Pick the right Graphics target for a part (butterfly bottom → butterflySelectionGfx)
    const gfxFor = (part: { side: string }) =>
      butterfly && part.side === 'bottom' ? this.butterflySelectionGfx : this.selectionGfx;

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
        // Collect net highlights per gfx target so we can batch fill
        const topHits: (() => void)[] = [];
        const botHits: (() => void)[] = [];

        for (const ref of net.pinIndices) {
          const part = this.board.parts[ref.partIndex];
          const pin = part?.pins[ref.pinIndex];
          if (!pin || !part) continue;

          if (part.side === 'top' && !this.isTopVisible) continue;
          if (part.side === 'bottom' && !this.isBottomVisible) continue;

          const gfx = gfxFor(part);
          const hits = gfx === this.butterflySelectionGfx ? botHits : topHits;

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
            hits.push(() => gfx.rect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2));
          } else {
            const r = computePinRadius(s, pin.radius) + s.netHighlightGrow;
            hits.push(() => gfx.circle(pin.position.x, pin.position.y, r));
          }
        }

        for (const fn of topHits) fn();
        if (topHits.length > 0) {
          this.selectionGfx.fill({ color: COLORS.netHighlight, alpha: s.netHighlightAlpha });
        }
        for (const fn of botHits) fn();
        if (botHits.length > 0) {
          this.butterflySelectionGfx.fill({ color: COLORS.netHighlight, alpha: s.netHighlightAlpha });
        }
      }
    }

    this.renderNetLines();
  }

  // --- Net lines rendering ---

  private renderNetLines() {
    this.needsRender = true;
    this.netLinesGfx.clear();
    if (!this.board || !boardStore.showNetLines) return;

    const sel = boardStore.selection;
    if (sel.partIndex === null || !sel.highlightedNet) return;

    const net = this.board.nets.get(sel.highlightedNet);
    if (!net) return;

    const s = renderSettingsStore.settings;

    // Skip GND nets — they connect to too many components to be useful.
    const netUpper = sel.highlightedNet.toUpperCase();
    if (netUpper.includes('GND')) return;
    const selectedPart = this.board.parts[sel.partIndex];
    if (!selectedPart) return;

    const selectedRoot = this.rootForPart(selectedPart);
    const selEB = computeEffectiveBounds(selectedPart.bounds, selectedPart.pins, s);

    // If a specific pin is selected, use its position as the line origin (no clipping)
    const selectedPin = sel.pinIndex !== null ? selectedPart.pins[sel.pinIndex] : null;
    const selCenterW = selectedPin
      ? this.sceneToWorld(selectedPin.position, selectedRoot)
      : this.sceneToWorld({ x: selEB.px + selEB.pw / 2, y: selEB.py + selEB.ph / 2 }, selectedRoot);

    // Collect visible target parts
    const targets: { part: typeof selectedPart; root: Container | undefined }[] = [];
    const seenParts = new Set<number>();
    for (const ref of net.pinIndices) {
      if (ref.partIndex === sel.partIndex) continue;
      if (seenParts.has(ref.partIndex)) continue;
      seenParts.add(ref.partIndex);
      const part = this.board.parts[ref.partIndex];
      if (!part) continue;
      if (part.side === 'top' && !this.isTopVisible) continue;
      if (part.side === 'bottom' && !this.isBottomVisible) continue;
      targets.push({ part, root: this.rootForPart(part) });
    }

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

    // When many lines converge, fade-in near the origin to reduce clutter
    const lineCount = targets.length;
    const useFade = lineCount > 8;
    // Fade distance: ~60 screen px converted to world
    const fadeDist = useFade ? 60 / vpScale : 0;

    for (const { part, root } of targets) {
      const eb = computeEffectiveBounds(part.bounds, part.pins, s);
      const tgtCenter: Point = { x: eb.px + eb.pw / 2, y: eb.py + eb.ph / 2 };
      const tgtCenterW = this.sceneToWorld(tgtCenter, root);

      // Always clip start to selected part edge (lines never cross the selected part)
      const start = this.clipToRectEdge(selCenterW, tgtCenterW, selEB, selectedRoot);
      const end = this.clipToRectEdge(tgtCenterW, selCenterW, eb, root);

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
        contextMenuStore.show(e.clientX, e.clientY, part.name);
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

  destroy() {
    if (this.selectionBlinkTimer) {
      clearTimeout(this.selectionBlinkTimer);
      this.selectionBlinkTimer = null;
    }
    if (this.zoomSettleTimer) { clearTimeout(this.zoomSettleTimer); this.zoomSettleTimer = null; }
    this.unsubscribeBoard?.();
    this.unsubscribeSettings?.();
    this.resizeObserver?.disconnect();
    if (this.boundContextMenu) {
      this.containerEl.removeEventListener('contextmenu', this.boundContextMenu);
    }
    if (this.hudEl) {
      this.hudEl.remove();
      this.hudEl = null;
    }
    if (this.initialized) {
      this.invalidateAllScenes();
      this.selectionGfx?.clear();
      this.netLinesGfx?.clear();
      cleanupShadowFonts();
      this.app.destroy(true, { children: true });
    }
  }
}
