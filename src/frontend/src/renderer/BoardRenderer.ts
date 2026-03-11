import { Application, Graphics, Container, Text, TextStyle } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { BoardData, Point } from '../parsers';
import { boardStore } from '../store/board-store';
import { renderSettingsStore, getLabelFontSize, computePinRadius, computeEffectiveBounds } from '../store/render-settings';
import { contextMenuStore } from '../store/context-menu-store';

const COLORS = {
  background: 0x1a1a2e,
  outline: 0x4a9eff,
  partBoundsTop: 0x336633,
  partBoundsBottom: 0x663333,
  partSelected: 0xffaa00,
  netHighlight: 0xffff44,
};

/** Pre-built scene graph for a single board */
interface BoardScene {
  root: Container;
  outlineGfx: Graphics;
  topLayer: Container;
  bottomLayer: Container;
  labels: Text[];
}

/** Saved viewport transform for restoring on tab switch */
interface ViewportState {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export class BoardRenderer {
  private app: Application;
  private viewport!: Viewport;
  private selectionGfx!: Graphics;
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

  /** Detect if the board data needs a Y-axis flip to make IC pins go counter-clockwise */
  private needsYFlip(board: BoardData): boolean {
    const cached = this.orientationCache.get(board);
    if (cached !== undefined) return cached;

    // Find best candidate: part with 4–100 pins (avoids BGAs)
    let best: { pins: { position: Point }[] } | null = null;
    for (const part of board.parts) {
      if (part.pins.length < 4 || part.pins.length > 100) continue;
      if (!best || part.pins.length > best.pins.length) {
        best = part;
      }
    }

    let result = false;
    if (best) {
      // Compute signed area using shoelace formula
      let area = 0;
      const pins = best.pins;
      for (let i = 0; i < pins.length; i++) {
        const j = (i + 1) % pins.length;
        area += pins[i].position.x * pins[j].position.y;
        area -= pins[j].position.x * pins[i].position.y;
      }
      // In screen coords (Y-down): positive area = clockwise = wrong
      // We want counter-clockwise (negative area)
      if (Math.abs(area) > 0.001) {
        result = area > 0;
      }
    }

    this.orientationCache.set(board, result);
    return result;
  }

  // --- Flip management ---

  /** Apply orientation, view flips, user rotation and mirror to the scene root */
  private applyFlips(board: BoardData, scene: BoardScene) {
    const bottomFlipX = boardStore.showBottom && !boardStore.showTop;
    const autoFlipY = this.needsYFlip(board);

    // Combine auto flips with user transforms (XOR)
    const flipX = bottomFlipX !== boardStore.mirrorX;
    const flipY = autoFlipY !== boardStore.mirrorY;
    const rotation = boardStore.rotation * Math.PI / 180;

    const cx = (board.bounds.minX + board.bounds.maxX) / 2;
    const cy = (board.bounds.minY + board.bounds.maxY) / 2;

    scene.root.pivot.set(cx, cy);
    scene.root.position.set(cx, cy);
    scene.root.rotation = rotation;
    scene.root.scale.set(flipX ? -1 : 1, flipY ? -1 : 1);

    // Counter-flip labels so text stays readable (rotation passes through)
    const lsx = flipX ? -1 : 1;
    const lsy = flipY ? -1 : 1;
    for (const label of scene.labels) {
      label.rotation = -rotation;
      label.scale.set(lsx, lsy);
    }
  }

  /** Convert world coords (viewport space) to scene-local coords */
  private worldToScene(world: Point): Point {
    const root = this.activeScene?.root;
    if (!root) return world;

    const sx = root.scale.x;
    const sy = root.scale.y;
    const theta = root.rotation;
    const cx = root.pivot.x;
    const cy = root.pivot.y;

    if (theta === 0 && sx === 1 && sy === 1) return world;

    // Inverse: un-translate, un-rotate, un-scale
    const dx = world.x - cx;
    const dy = world.y - cy;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    // Inverse rotation
    const rx = dx * cosT + dy * sinT;
    const ry = -dx * sinT + dy * cosT;
    // Inverse scale
    return { x: cx + rx / sx, y: cy + ry / sy };
  }

  /** Convert scene-local coords to world coords (viewport space) */
  private sceneToWorld(point: Point): Point {
    const root = this.activeScene?.root;
    if (!root) return point;

    const sx = root.scale.x;
    const sy = root.scale.y;
    const theta = root.rotation;
    const cx = root.pivot.x;
    const cy = root.pivot.y;

    if (theta === 0 && sx === 1 && sy === 1) return point;

    // Forward: scale, then rotate, then translate
    const dx = (point.x - cx) * sx;
    const dy = (point.y - cy) * sy;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: cx + dx * cosT - dy * sinT,
      y: cy + dx * sinT + dy * cosT,
    };
  }

  // --- Scene cache management ---

  private buildScene(board: BoardData): BoardScene {
    const s = renderSettingsStore.settings;

    const root = new Container();
    const outlineGfx = new Graphics();
    const bottomLayer = new Container();
    const topLayer = new Container();
    const labels: Text[] = [];

    bottomLayer.cullable = true;
    topLayer.cullable = true;

    root.addChild(outlineGfx);
    root.addChild(bottomLayer);
    root.addChild(topLayer);

    // Outline
    if (board.outline.length > 1) {
      outlineGfx.moveTo(board.outline[0].x, board.outline[0].y);
      for (let i = 1; i < board.outline.length; i++) {
        outlineGfx.lineTo(board.outline[i].x, board.outline[i].y);
      }
      outlineGfx.closePath();
      outlineGfx.stroke({ width: s.outlineWidth, color: COLORS.outline, alpha: s.outlineAlpha });
    }

    // Parts
    for (let pi = 0; pi < board.parts.length; pi++) {
      const part = board.parts[pi];
      const layer = part.side === 'bottom' ? bottomLayer : topLayer;
      const partContainer = new Container();
      partContainer.cullable = true;
      partContainer.label = part.name;

      const isTwoPinPart = part.pins.length === 2;
      const eb = computeEffectiveBounds(part.bounds, part.pins, s);

      // Pins
      for (let pni = 0; pni < part.pins.length; pni++) {
        const pin = part.pins[pni];
        const pinGfx = new Graphics();
        const color = renderSettingsStore.resolvePinColor(pin.net, pin.side);

        if (isTwoPinPart) {
          const other = part.pins[1 - pni];
          if (eb.horiz) {
            const depth = Math.min(eb.ph, eb.pw * 0.4);
            const left = pin.position.x < other.position.x;
            if (left) {
              pinGfx.rect(eb.px, eb.py, depth, eb.ph);
            } else {
              pinGfx.rect(eb.px + eb.pw - depth, eb.py, depth, eb.ph);
            }
          } else {
            const depth = Math.min(eb.pw, eb.ph * 0.4);
            const top = pin.position.y < other.position.y;
            if (top) {
              pinGfx.rect(eb.px, eb.py, eb.pw, depth);
            } else {
              pinGfx.rect(eb.px, eb.py + eb.ph - depth, eb.pw, depth);
            }
          }
        } else {
          const r = computePinRadius(s, pin.radius);
          pinGfx.circle(pin.position.x, pin.position.y, r);
        }
        pinGfx.fill({ color, alpha: s.pinAlpha });
        pinGfx.cullable = true;
        partContainer.addChild(pinGfx);
      }

      // Part outline (skip for single-pin testpoints)
      if (part.pins.length > 1) {
        const boundsGfx = new Graphics();
        boundsGfx.rect(eb.px, eb.py, eb.pw, eb.ph);
        boundsGfx.stroke({
          width: s.partBorderWidth,
          color: part.side === 'bottom' ? COLORS.partBoundsBottom : COLORS.partBoundsTop,
          alpha: s.partBorderAlpha,
        });
        partContainer.addChild(boundsGfx);
      }

      // Part label (centered via anchor, hidden when too small)
      if (s.showPartLabels) {
        let fontSize: number;
        if (isTwoPinPart) {
          fontSize = getLabelFontSize(s);
        } else {
          const bh = eb.maxY - eb.minY;
          const targetW = eb.pw * 0.7;
          fontSize = targetW / (part.name.length * 0.6);
          fontSize = Math.max(2, Math.min(fontSize, bh * 0.8));
        }
        if (fontSize >= s.labelHideThreshold) {
          const label = new Text({
            text: part.name,
            style: new TextStyle({ fontSize, fill: 0xcccccc, fontFamily: 'monospace' }),
            resolution: 4,
          });
          label.anchor.set(0.5, 0.5);
          label.x = eb.px + eb.pw / 2;
          label.y = eb.py + eb.ph / 2;
          label.cullable = true;
          partContainer.addChild(label);
          labels.push(label);
        }
      }

      layer.addChild(partContainer);
    }

    return { root, outlineGfx, topLayer, bottomLayer, labels };
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
    const scene = this.getOrBuildScene(board);

    if (this.activeScene === scene) {
      // Same scene — just update layer visibility + flips
      scene.topLayer.visible = boardStore.showTop;
      scene.bottomLayer.visible = boardStore.showBottom;
      this.applyFlips(board, scene);
      return;
    }

    // Save current viewport state before switching
    this.saveViewportState();

    // Detach old scene (selectionGfx lives inside root)
    if (this.activeScene) {
      this.activeScene.root.removeChild(this.selectionGfx);
      this.viewport.removeChild(this.activeScene.root);
    }

    // Attach new scene + selection overlay (inside root so flips apply to selection too)
    this.viewport.addChild(scene.root);
    scene.root.addChild(this.selectionGfx);
    this.activeScene = scene;

    scene.topLayer.visible = boardStore.showTop;
    scene.bottomLayer.visible = boardStore.showBottom;
    this.applyFlips(board, scene);

    // Restore viewport position or fit
    this.restoreViewportState(board);
  }

  private deactivateScene() {
    this.saveViewportState();
    if (this.activeScene) {
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
    }

    for (const [, scene] of this.sceneCache) {
      scene.root.destroy({ children: true });
    }
    this.sceneCache.clear();
    this.activeScene = null;
  }

  // --- Event handlers ---

  private onBoardUpdate() {
    if (!this.viewport) return;

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
      this.activeScene.topLayer.visible = boardStore.showTop;
      this.activeScene.bottomLayer.visible = boardStore.showBottom;
      this.applyFlips(board, this.activeScene);
    }

    this.renderSelection();

    // Handle focus requests (zoom to part)
    const focus = boardStore.consumeFocusRequest();
    if (focus) {
      this.zoomToBounds(focus.bounds);
    }
  }

  private zoomToBounds(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
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
    });
    this.viewport.moveCenter(center.x, center.y);
  }

  private onSettingsUpdate() {
    if (!this.board) return;
    // Save viewport, invalidate all scenes, rebuild current
    this.saveViewportState();
    this.invalidateAllScenes();
    this.activateScene(this.board);
    this.renderSelection();
  }

  // --- Selection rendering (always rebuilt, lightweight) ---

  private renderSelection() {
    this.selectionGfx.clear();
    if (!this.board) return;

    const s = renderSettingsStore.settings;
    const sel = boardStore.selection;

    if (sel.partIndex !== null) {
      const part = this.board.parts[sel.partIndex];
      if (part) {
        if (part.pins.length === 1) {
          // 1-pin testpoint: circle selection around the pin
          const pin = part.pins[0];
          const r = computePinRadius(s, pin.radius) + s.selectionPadding;
          this.selectionGfx.circle(pin.position.x, pin.position.y, r);
        } else {
          const eb = computeEffectiveBounds(part.bounds, part.pins, s);
          const sp = s.selectionPadding;
          this.selectionGfx.rect(
            eb.px - sp, eb.py - sp,
            eb.pw + sp * 2, eb.ph + sp * 2
          );
        }
        this.selectionGfx.stroke({ width: s.selectionWidth, color: COLORS.partSelected, alpha: 0.9 });
      }
    }

    if (sel.highlightedNet) {
      const net = this.board.nets.get(sel.highlightedNet);
      if (net) {
        for (const ref of net.pinIndices) {
          const part = this.board.parts[ref.partIndex];
          const pin = part?.pins[ref.pinIndex];
          if (!pin || !part) continue;

          // Skip pins on hidden layers
          if (part.side === 'top' && !boardStore.showTop) continue;
          if (part.side === 'bottom' && !boardStore.showBottom) continue;

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
            this.selectionGfx.rect(rx - grow, ry - grow, rw + grow * 2, rh + grow * 2);
          } else {
            const r = computePinRadius(s, pin.radius) + s.netHighlightGrow;
            this.selectionGfx.circle(pin.position.x, pin.position.y, r);
          }
        }
        this.selectionGfx.fill({ color: COLORS.netHighlight, alpha: s.netHighlightAlpha });
      }
    }
  }

  // --- Hit testing ---

  /** Find the part (and optionally pin) under a world-space point */
  private hitTest(world: Point): { partIndex: number; pinIndex: number } | null {
    if (!this.board) return null;

    // Convert world coords to scene-local coords (accounts for flips)
    const local = this.worldToScene(world);

    const s = renderSettingsStore.settings;

    // First pass: try to hit a specific pin
    let bestDist = Infinity;
    let bestPartIdx = -1;
    let bestPinIdx = -1;

    for (let pi = 0; pi < this.board.parts.length; pi++) {
      const part = this.board.parts[pi];
      if (part.side === 'top' && !boardStore.showTop) continue;
      if (part.side === 'bottom' && !boardStore.showBottom) continue;

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
      if (part.side === 'top' && !boardStore.showTop) continue;
      if (part.side === 'bottom' && !boardStore.showBottom) continue;

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
    this.viewport.fit(
      true,
      b.maxX - b.minX + pad * 2,
      b.maxY - b.minY + pad * 2,
    );
    // Board center maps to itself regardless of flip (pivot = position = center)
    this.viewport.moveCenter(
      (b.minX + b.maxX) / 2,
      (b.minY + b.maxY) / 2,
    );
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
