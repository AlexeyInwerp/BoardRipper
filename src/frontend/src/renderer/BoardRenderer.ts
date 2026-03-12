import { Application, Graphics, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { BoardData, Point, Pin, BBox } from '../parsers';
import { boardStore } from '../store/board-store';
import { renderSettingsStore, computePinRadius, computeEffectiveBounds } from '../store/render-settings';
import { contextMenuStore } from '../store/context-menu-store';
import { buildBoardScene, drawOutline, BOARD_COLORS } from './board-scene';

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
  labels: import('pixi.js').Text[];
  topLabels: import('pixi.js').Text[];
  bottomLabels: import('pixi.js').Text[];
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
  private get isTopVisible() { return this.isTopVisible; }
  /** Whether bottom layer should be visible (accounts for butterfly mode) */
  private get isBottomVisible() { return this.isBottomVisible; }

  private app: Application;
  private viewport!: Viewport;
  private selectionGfx!: Graphics;
  private butterflySelectionGfx!: Graphics;
  private board: BoardData | null = null;
  private unsubscribeBoard: (() => void) | null = null;
  private unsubscribeSettings: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private containerEl: HTMLDivElement;
  private initialized = false;
  private boundContextMenu: ((e: MouseEvent) => void) | null = null;

  // Scene cache: avoid rebuilding PixiJS objects on tab switch
  private sceneCache = new Map<BoardData, BoardScene>();
  private activeScene: BoardScene | null = null;

  // Viewport state per board: restore pan/zoom on tab switch
  private viewportStates = new Map<BoardData, ViewportState>();

  // Orientation detection cache: true = need Y flip
  private orientationCache = new Map<BoardData, boolean>();

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
    });
    this.containerEl.appendChild(this.app.canvas as HTMLCanvasElement);
    this.initialized = true;

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
      .clampZoom({ minScale: 0.001, maxScale: 200 });

    this.app.stage.addChild(this.viewport);

    this.selectionGfx = new Graphics();
    this.butterflySelectionGfx = new Graphics();

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
    });
    this.resizeObserver.observe(this.containerEl);
  }

  // --- Orientation detection ---

  /**
   * Detect if the board data needs a Y-axis flip so IC pins ascend counter-clockwise.
   *
   * Fallback chain:
   * 1. Board format info (not available in BVR — reserved for future formats)
   * 2. Pin-order heuristic on a suitable IC (DIP/QFP/SOP — not BGA)
   */
  private needsYFlip(board: BoardData): boolean {
    const cached = this.orientationCache.get(board);
    if (cached !== undefined) return cached;

    const result = this.detectOrientation(board);
    this.orientationCache.set(board, result);
    return result;
  }

  private detectOrientation(board: BoardData): boolean {
    // Collect candidate ICs, scored by suitability
    const candidates: { pins: Point[]; score: number }[] = [];

    for (const part of board.parts) {
      const n = part.pins.length;
      if (n < 4) continue;

      // Sort pins by numeric pin number for correct sequential order
      const sorted = this.sortPinsByNumber(part.pins);
      if (!sorted) continue; // Non-numeric pin numbers (likely BGA: A1, B2, etc.)

      const positions = sorted.map(p => p.position);
      const bb = part.bounds;
      const bbW = bb.maxX - bb.minX;
      const bbH = bb.maxY - bb.minY;
      if (bbW < 0.001 || bbH < 0.001) continue;

      // Filter out BGAs: check if pins fill the interior (grid pattern)
      // For perimeter ICs (DIP/QFP), pins are only along edges
      const edgeFrac = this.perimeterFraction(positions, bb);
      if (edgeFrac < 0.6) continue; // More than 40% interior pins → likely BGA

      // Check that pin polygon area is meaningful relative to bounding box
      // (shoelace on a grid/zigzag path gives near-zero area)
      const area = this.shoelaceArea(positions);
      const bbArea = bbW * bbH;
      const areaRatio = Math.abs(area) / bbArea;
      if (areaRatio < 0.1) continue; // Path doesn't enclose a real polygon

      // Score: prefer parts with more pins (more reliable), higher area ratio
      const score = n * areaRatio;
      candidates.push({ pins: positions, score });
    }

    if (candidates.length === 0) return false;

    // Pick the best candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    const area = this.shoelaceArea(best.pins);

    // In standard math (Y-up): CCW polygon has positive shoelace area
    // On screen (Y-down): that same polygon appears CW
    // We want pins to appear CCW on screen → need Y-flip when area > 0
    return area > 0;
  }

  /** Sort pins by numeric pin number. Returns null if any pin number is non-numeric. */
  private sortPinsByNumber(pins: Pin[]): Pin[] | null {
    const withNum: { pin: Pin; num: number }[] = [];
    for (const pin of pins) {
      const num = parseInt(pin.number, 10);
      if (isNaN(num)) return null; // Non-numeric → likely BGA (A1, B2, etc.)
      withNum.push({ pin, num });
    }
    withNum.sort((a, b) => a.num - b.num);
    return withNum.map(w => w.pin);
  }

  /**
   * What fraction of pins lie on the perimeter of the bounding box?
   * Perimeter ICs (DIP/QFP/SOP) have ~100%; BGAs have much less.
   */
  private perimeterFraction(positions: Point[], bb: BBox): number {
    const bbW = bb.maxX - bb.minX;
    const bbH = bb.maxY - bb.minY;
    // A pin is "on the edge" if it's within 15% of the bounding box dimension from an edge
    const threshX = bbW * 0.15;
    const threshY = bbH * 0.15;
    let edgeCount = 0;
    for (const p of positions) {
      const nearLeft = p.x - bb.minX < threshX;
      const nearRight = bb.maxX - p.x < threshX;
      const nearTop = p.y - bb.minY < threshY;
      const nearBottom = bb.maxY - p.y < threshY;
      if (nearLeft || nearRight || nearTop || nearBottom) edgeCount++;
    }
    return edgeCount / positions.length;
  }

  /** Signed area via shoelace formula */
  private shoelaceArea(positions: Point[]): number {
    let area = 0;
    for (let i = 0; i < positions.length; i++) {
      const j = (i + 1) % positions.length;
      area += positions[i].x * positions[j].y;
      area -= positions[j].x * positions[i].y;
    }
    return area;
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

      const bh = board.bounds.maxY - board.bounds.minY;
      const vgap = bh * 0.05; // 5% gap between the two halves

      const flipY = autoFlipY !== boardStore.mirrorY;
      const sx = boardStore.mirrorX ? -1 : 1;
      const topSy = flipY ? -1 : 1;
      // Bottom: Y inverted relative to top (flipped around bottom edge)
      const botSy = -topSy;

      // Top half: shifted up
      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx, cy - bh / 2 - vgap / 2);
      scene.root.rotation = rotation;
      scene.root.scale.set(sx, topSy);

      // Bottom half: shifted down, Y-flipped (hinged on bottom edge)
      const broot = scene.butterflyRoot!;
      broot.pivot.set(cx, cy);
      broot.position.set(cx, cy + bh / 2 + vgap / 2);
      broot.rotation = rotation;
      broot.scale.set(sx, botSy);

      // Counter-flip labels for readability
      for (const label of scene.topLabels) {
        label.rotation = -rotation;
        label.scale.set(sx, topSy);
      }
      for (const label of scene.bottomLabels) {
        label.rotation = -rotation;
        label.scale.set(sx, botSy);
      }
    } else {
      // Normal mode
      this.teardownButterfly(scene);

      const bottomFlipX = boardStore.showBottom && !boardStore.showTop;
      const flipX = bottomFlipX !== boardStore.mirrorX;
      const flipY = autoFlipY !== boardStore.mirrorY;

      scene.root.pivot.set(cx, cy);
      scene.root.position.set(cx, cy);
      scene.root.rotation = rotation;
      scene.root.scale.set(flipX ? -1 : 1, flipY ? -1 : 1);

      // Counter-flip labels so text stays readable
      const lsx = flipX ? -1 : 1;
      const lsy = flipY ? -1 : 1;
      for (const label of scene.labels) {
        label.rotation = -rotation;
        label.scale.set(lsx, lsy);
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

    scene.topLayer.visible = this.isTopVisible;
    scene.bottomLayer.visible = this.isBottomVisible;
    this.applyFlips(board, scene);

    // Restore viewport position or fit
    this.restoreViewportState(board);
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

      // Handle focus requests (zoom to part)
      const focus = boardStore.consumeFocusRequest();
      if (focus) {
        const focusPart = this.board?.parts[focus.partIndex];
        const focusRoot = focusPart ? this.rootForPart(focusPart) : undefined;
        this.zoomToBounds(focus.bounds, focusRoot);
      }
    } catch (err) {
      console.error('[BoardRenderer] onBoardUpdate crashed:', err);
    }
  }

  private zoomToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }, root?: Container) {
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    const sw = this.containerEl.clientWidth;
    const sh = this.containerEl.clientHeight;
    // Component should take ~5% of the visible view
    const maxDim = Math.max(bw, bh, 1);
    const scale = (Math.min(sw, sh) * 0.05) / maxDim;
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
      // Save viewport, invalidate all scenes, rebuild current
      this.saveViewportState();
      this.invalidateAllScenes();
      this.activateScene(this.board);
      this.renderSelection();
    } catch (err) {
      console.error('[BoardRenderer] onSettingsUpdate crashed:', err);
    }
  }

  // --- Selection rendering (always rebuilt, lightweight) ---

  private renderSelection() {
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
        gfx.stroke({ width: s.selectionWidth, color: COLORS.partSelected, alpha: 0.9 });
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
    this.unsubscribeBoard?.();
    this.unsubscribeSettings?.();
    this.resizeObserver?.disconnect();
    if (this.boundContextMenu) {
      this.containerEl.removeEventListener('contextmenu', this.boundContextMenu);
    }
    if (this.initialized) {
      this.invalidateAllScenes();
      this.selectionGfx?.clear();
      this.app.destroy(true, { children: true });
    }
  }
}
