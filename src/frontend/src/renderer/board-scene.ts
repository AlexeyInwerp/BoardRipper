/**
 * Shared scene-building logic for both the main BoardRenderer and SettingsMockup.
 * Any visual change made here is automatically reflected in both places.
 *
 * All text uses BitmapText with shared glyph atlases for dramatically lower
 * GPU memory and draw calls compared to per-label canvas Text objects.
 *
 * Pin drawing uses spatial grid culling with color batching: the board is divided
 * into NxN cells (auto-sized by pin count), each containing color-batched Graphics
 * in a cullable Container. PixiJS skips off-screen cells entirely, and within each
 * cell pins share one Graphics per color — O(cells × colors) draw calls, with most
 * cells culled when zoomed in. Pin-1 triangles are batched per-cell likewise.
 *
 * Pin labels (numbers + net names) use the same spatial grid: each cell accumulates
 * labels during the part loop, then flushes them into cullable Containers within
 * the label layers. This gives O(visible cells) label rendering instead of O(all labels).
 */
import { Graphics, Container, BitmapText, BitmapFont, Rectangle } from 'pixi.js';
import type { BoardData } from '../parsers';
import { log } from '../store/log-store';
import { pinDisplayId } from '../parsers/types';
import {
  getLabelFontSize,
  computePinRadius,
  computeMultiPinPadding,
  computeEffectiveBounds,
  computeDiagonalOBB,
  computeTwoPinOBB,
  computeDiag2PinPads,
  resolvePinColor,
  quantizeFontSize,
  resolvePartTypeOverride,
  applyBodyShapeOverride,
  isNcNet,
} from '../store/render-settings';
import type { RenderSettings } from '../store/render-settings';
import { DEFAULT_LAYER_PALETTE } from '../store/layer-store';

export const BOARD_COLORS = {
  background:        0x1a1a2e,
  outline:           0x4a9eff,
  partBoundsTop:     0x336633,
  partBoundsBottom:  0x663333,
  partSelected:      0xffaa00,
  netHighlight:      0xffff44,
  pin1:              0xcc2222,
  labelPart:         0xcccccc,
  labelPin:          0xffffff,
  labelNet:          0x88ccff,
} as const;

const LABEL_FONT_FAMILY = 'monospace';

/** Clamp trace stroke width to prevent power pours from visually dominating signal traces */
const MAX_TRACE_WIDTH = 30;

/** Choose grid resolution based on total pin count — returns 1 (no grid) for small boards */
function computeGridSize(pinCount: number): number {
  if (pinCount < 1000) return 1;
  if (pinCount < 5000) return 4;
  return 8;
}

/** Border rectangle data for batched redraw */
export interface BorderRect {
  x: number; y: number; w: number; h: number;
  /** If set, draw this polygon instead of the axis-aligned rect (for diagonal parts) */
  poly?: [number, number][];
}

/** Batched border Graphics per layer — rebuilt on zoom, 2 draw calls instead of 3K */
export interface BorderBatch {
  gfx: Graphics;
  rects: BorderRect[];
  color: number;
  alpha: number;
  /** Last drawn effective width — skip redraw when unchanged */
  lastWidth: number;
}

/** Labels bucketed by font size for O(groups) visibility updates instead of O(labels) */
export interface FontSizeGroup {
  /** Lower bound of the bucket (2^bucket) — used for threshold check */
  minSize: number;
  labels: BitmapText[];
  /** Cached visibility state — skip iteration when unchanged */
  visible: boolean;
}

/** Pin/net labels bucketed by font size — same idea as FontSizeGroup but items can be Container wrappers */
export interface PinFontSizeGroup {
  minSize: number;
  items: Container[];
  visible: boolean;
}

export interface BoardSceneGraph {
  root:        Container;
  outlineGfx:  Graphics;
  topLayer:    Container;
  bottomLayer: Container;
  /** Sub-layer containers for granular visibility control */
  topFillLayer: Container;
  bottomFillLayer: Container;
  topPinLayer: Container;
  bottomPinLayer: Container;
  topOutlineLayer: Container;
  bottomOutlineLayer: Container;
  topLabelLayer: Container;
  bottomLabelLayer: Container;
  labels:      BitmapText[];
  topLabels:   BitmapText[];
  bottomLabels: BitmapText[];
  /** Pin number labels (and net-name wrappers), tracked for zoom-based LoD */
  topPinLabels:    Container[];
  bottomPinLabels: Container[];
  /** Part-index → its pin labels (numbers + net names). Used by the renderer
   *  to un-dim a selected part's pin labels above the ambient dim overlay. */
  pinLabelsByPartIndex: Map<number, Container[]>;
  /** Batched border Graphics per layer — rebuilt on zoom with minimum-width enforcement */
  borderBatches: BorderBatch[];
  /** Labels grouped by font-size bucket for efficient LoD visibility */
  fontSizeGroups: FontSizeGroup[];
  /** Global pin Graphics keyed by color — one per unique color per layer.
   *  Exposed for future incremental updates (e.g. re-coloring a net without full rebuild). */
  topPinGfx:    Map<number, Graphics>;
  bottomPinGfx: Map<number, Graphics>;
  /** Group A: pin numbers + net names on circle/1-pin parts */
  topCircleLabelLayer:    Container;
  bottomCircleLabelLayer: Container;
  /** Group B: net names inside 2-pin part pads */
  topTwoPinNetLayer:    Container;
  bottomTwoPinNetLayer: Container;
  /** Font-size groups for Group A (circle/1-pin pin labels) — progressive zoom visibility */
  circleFontSizeGroups: PinFontSizeGroup[];
  /** Font-size groups for Group B (2-pin net labels) — progressive zoom visibility */
  twoPinFontSizeGroups: PinFontSizeGroup[];
  /** Part index → part name BitmapText label. For selection highlighting (tint/brightness). */
  partLabelByIndex: Map<number, BitmapText>;
  /** Per-part max pin radius to prevent overlap (BGA etc). partIndex → maxRadius. Only set when < Infinity. */
  pinRadiusClamp: Map<number, number>;
  /** Per 2-pin part: per-pin pad polygons (4 corners each). Used for exact selection highlights. */
  twoPinPadPolys: Map<number, [number, number][][]>;
  /** PCB trace lines container — toggled by showTraces */
  traceLayer: Container | null;
  /** Per-layer trace containers for multi-layer boards (indexed by layer). Empty for single-layer. */
  traceLayerContainers: Container[];
  /** Silkscreen / assembly outline overlay — toggled by showSilkscreen.
   *  Two child containers (top, bottom); each side container is shown only
   *  when its corresponding board side is visible. */
  silkscreenLayer: Container | null;
  silkscreenTop: Container | null;
  silkscreenBottom: Container | null;
  /** Copper pad overlay — toggled by showPads. Same side-split pattern.
   *  Only includes pads where `attached === true` (pin-bound pads). */
  padsLayer: Container | null;
  padsTop: Container | null;
  padsBottom: Container | null;
  /** Standalone copper-drop pads (GND stitching, power-rail tie pads,
   *  mounting-hole pads) — pads where `attached === false`. Toggled by
   *  showCopperDrops, default OFF. Same side-split pattern. */
  copperDropsLayer: Container | null;
  copperDropsTop: Container | null;
  copperDropsBottom: Container | null;
  /** Via/drill hole overlay container — toggled by showVias */
  viaLayer: Container | null;
  /** Via labels — tracked for counter-rotation on board flip */
  viaLabels: BitmapText[];
  /** Per-via connected layer indices (parallel to board.vias). Empty for single-layer boards. */
  viaConnectedLayers: number[][];
}

/** PCB character set — covers part names, pin numbers, net names, and common accented chars */
const PCB_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./+#()[]{}:;,<>!@$%^&*=~|\\?\'"ÄÖÜäöüß';

/** Resolution for pre-installed BitmapFonts (higher = sharper at deep zoom, larger atlas).
 *  Small font sizes use lower resolution since the extra pixels aren't visible. */
function bitmapFontResolution(fontSize: number): number {
  return fontSize < 8 ? 4 : 8;
}

// BitmapFont atlases are globally registered in PixiJS and shared across every
// open tab/Application. They must NOT be uninstalled on per-tab scene teardown
// — tearing down tab A's fonts destroys the TextureStyle that BitmapText in
// tabs B/C/D still references, causing a later "addressModeU of null" crash in
// GlTextureSystem.updateStyle. Atlases are keyed by content (board-shadow-N-v3,
// board-pin-N), idempotently cached, and cheap to leak for the app lifetime.
const installedShadowFonts = new Set<string>();
const installedPinFonts = new Set<string>();

/** Install (once) a plain BitmapFont atlas for pin number labels at a specific quantized size */
function ensurePinFont(fontSize: number): string {
  const name = `board-pin-${fontSize}`;
  if (!installedPinFonts.has(name)) {
    try {
      BitmapFont.install({
        name,
        style: { fontFamily: LABEL_FONT_FAMILY, fontSize, fill: 0xffffff },
        chars: PCB_CHARS,
        resolution: bitmapFontResolution(fontSize),
      });
      installedPinFonts.add(name);
    } catch {
      return LABEL_FONT_FAMILY;
    }
  }
  return name;
}


/**
 * Accumulate a background block behind a label into a batched Graphics object.
 * Flush the batch with `bgGfx.fill({ color, alpha })` after all labels are processed.
 * Uses estimated monospace character dimensions (0.55 × fontSize wide, 1.1 × fontSize tall).
 * @param bgGfx  Accumulated Graphics object (shared per layer)
 * @param cx/cy  Label anchor position in world space
 * @param anchorX/Y  BitmapText anchor (0–1 normalised)
 * @param fontSize  Quantized font size in mils
 * @param charCount  Number of characters in the text
 * @param pad  Extra padding around the text rectangle
 */
export function accumulateLabelBg(
  bgGfx: Graphics,
  cx: number, cy: number,
  anchorX: number, anchorY: number,
  fontSize: number,
  charCount: number,
  pad: number,
): void {
  const estW = fontSize * charCount * 0.55;
  const estH = fontSize * 1.1;
  bgGfx.rect(
    cx - anchorX * estW - pad,
    cy - anchorY * estH - pad,
    estW + pad * 2,
    estH + pad * 2,
  );
}

/** Install a BitmapFont for part labels with baked drop shadow at a specific quantized size */
function ensureShadowFont(fontSize: number): string {
  const name = `board-shadow-${fontSize}-v3`;
  if (!installedShadowFonts.has(name)) {
    try {
      BitmapFont.install({
        name,
        style: {
          fontFamily: LABEL_FONT_FAMILY,
          fontSize,
          fill: 0xffffff,
          // distance:0 keeps shadow centered (no offset). blur ~0.35× gives a tight
          // dark halo without overflowing the atlas glyph tile.
          dropShadow: { color: 0x000000, alpha: 0.85, blur: fontSize * 0.35, distance: 0 },
        },
        chars: PCB_CHARS,
        resolution: bitmapFontResolution(fontSize),
      });
      installedShadowFonts.add(name);
    } catch (err) {
      log.render.warn('BitmapFont shadow install failed:', err);
      return LABEL_FONT_FAMILY;
    }
  }
  return name;
}

/** Draw the board outline path into a Graphics object.
 *  Points with NaN coords act as sub-path separators. Sub-paths whose start
 *  and end points coincide (within `CLOSE_EPS` mils) are closed with
 *  `closePath()`; open sub-paths are left open so they don't render a spurious
 *  diagonal closing line (previously turned every L-bracket feature on a
 *  `.pcb` file into a filled triangle).
 *  Duplicate consecutive points are skipped to keep the polygon clean.
 */
const CLOSE_EPS = 2.0;
export function drawOutline(gfx: Graphics, board: BoardData, s: RenderSettings): void {
  const pts = board.outline;
  if (pts.length <= 1) return;

  let penDown = false;
  let prevX = NaN, prevY = NaN;
  let firstX = NaN, firstY = NaN;
  const closeIfMatchingStart = () => {
    if (!penDown) return;
    // Only close the sub-path if it is geometrically a closed loop. For open
    // chains, closing here would draw an unwanted stroke from the chain's end
    // back to its start — visible as a long diagonal across the board.
    if (Math.hypot(prevX - firstX, prevY - firstY) < CLOSE_EPS) {
      gfx.closePath();
    }
  };
  for (const pt of pts) {
    if (isNaN(pt.x) || isNaN(pt.y)) {
      closeIfMatchingStart();
      penDown = false;
      prevX = prevY = firstX = firstY = NaN;
      continue;
    }
    // Skip duplicate consecutive points
    if (pt.x === prevX && pt.y === prevY) continue;
    if (!penDown) {
      gfx.moveTo(pt.x, pt.y);
      penDown = true;
      firstX = pt.x; firstY = pt.y;
    } else {
      gfx.lineTo(pt.x, pt.y);
    }
    prevX = pt.x; prevY = pt.y;
  }
  closeIfMatchingStart();

  if (s.boardFillAlpha > 0) {
    gfx.fill({ color: 0xffffff, alpha: s.boardFillAlpha });
  }
  gfx.stroke({ width: s.outlineWidth, color: BOARD_COLORS.outline, alpha: s.outlineAlpha });
}

/** Debug dots at each outline vertex (world space). Returns world positions for screen-space labels. */
export function drawOutlineDebug(container: Container, board: BoardData): Array<{x: number; y: number}> {
  const gfx = new Graphics();
  container.addChild(gfx);
  const positions: Array<{x: number; y: number}> = [];
  for (const pt of board.outline) {
    if (isNaN(pt.x)) { positions.push({x: NaN, y: NaN}); continue; }
    gfx.circle(pt.x, pt.y, 20);
    positions.push({x: pt.x, y: pt.y});
  }
  gfx.fill({ color: 0xff4444 });
  return positions;
}

/** Redraw batched border Graphics with an effective minimum width — 2 draw calls total */
export function updateBorderWidths(batches: BorderBatch[], configuredWidth: number, viewportScale: number): void {
  const minScreenPx = 1;
  const effectiveWidth = Math.max(configuredWidth, minScreenPx / viewportScale);

  // Check first batch to skip redundant redraws (2% relative tolerance).
  if (batches.length > 0 && Math.abs(effectiveWidth - batches[0].lastWidth) / Math.max(effectiveWidth, 0.001) < 0.02) {
    return;
  }

  for (const batch of batches) {
    batch.lastWidth = effectiveWidth;
    batch.gfx.clear();
    for (const r of batch.rects) {
      if (r.poly) {
        batch.gfx.moveTo(r.poly[0][0], r.poly[0][1]);
        for (let i = 1; i < r.poly.length; i++) batch.gfx.lineTo(r.poly[i][0], r.poly[i][1]);
        batch.gfx.closePath();
      } else {
        batch.gfx.rect(r.x, r.y, r.w, r.h);
      }
    }
    batch.gfx.stroke({ width: effectiveWidth, color: batch.color, alpha: batch.alpha });
  }
}


/**
 * Build a PixiJS scene graph for a board.
 * Pure function — no side effects on any store.
 */
export function buildBoardScene(board: BoardData, s: RenderSettings): BoardSceneGraph {
  // `board` arrives pre-derived via `boardStore.board` (see
  // `store/derive-board-view.ts`): filtered, folded, sides tagged. Hidden
  // parts stay at their raw array index with `hidden: true` so
  // `selection.partIndex` stays stable — skip them below.
  const root        = new Container();
  const outlineGfx  = new Graphics();
  const bottomLayer = new Container();
  const topLayer    = new Container();

  // Sub-layer containers for granular visibility control.
  // Each wraps a rendering phase so visibility can be toggled independently.
  const topFillLayer     = new Container();
  const bottomFillLayer  = new Container();
  const topPinLayer      = new Container();
  const bottomPinLayer   = new Container();
  const topOutlineLayer  = new Container();
  const bottomOutlineLayer = new Container();
  const topLabelLayer    = new Container();
  const bottomLabelLayer = new Container();

  // Add sub-layers to parent layers in z-order: fills → pins → outlines → labels
  topLayer.addChild(topFillLayer, topPinLayer, topOutlineLayer, topLabelLayer);
  bottomLayer.addChild(bottomFillLayer, bottomPinLayer, bottomOutlineLayer, bottomLabelLayer);

  const labels: BitmapText[] = [];
  const topLabels: BitmapText[] = [];
  const bottomLabels: BitmapText[] = [];
  const topPinLabels: Container[] = [];
  const bottomPinLabels: Container[] = [];
  const pinLabelsByPartIndex: Map<number, Container[]> = new Map();
  // Group A: pin numbers + net names on circle/1-pin parts (smallest text, highest zoom threshold).
  const topCircleLabelLayer    = new Container();
  const bottomCircleLabelLayer = new Container();
  // Group B: net names inside 2-pin part pads (medium zoom threshold).
  const topTwoPinNetLayer    = new Container();
  const bottomTwoPinNetLayer = new Container();
  // Background plates for pin labels are attached as children of each BitmapText
  // (not a shared Graphics) so they inherit the per-label counter-rotation from applyFlips.
  // Component-type fill Graphics — one Graphics per color, same batching pattern as pins.
  // A single Graphics with multiple fill() calls of different colors doesn't work reliably
  // in PixiJS v8 (all paths may get the last color). Use Map<color, Graphics> instead.
  const topFillMap    = new Map<number, Graphics>();
  const bottomFillMap = new Map<number, Graphics>();
  // NC (no-connect) pins are drawn as outline-only circles — no fill, single Graphics per side.
  const topNcPinGfx    = new Graphics();
  const bottomNcPinGfx = new Graphics();
  // Background plates for pin net-name labels — one batched Graphics per layer,
  // added at index 0 of topPinLabelsLayer so it renders behind all BitmapTexts.
  // Batched border Graphics — one per (layer, color), rebuilt on zoom
  const topBorderBatch: BorderBatch    = { gfx: new Graphics(), rects: [], color: BOARD_COLORS.partBoundsTop,    alpha: s.partBorderAlpha, lastWidth: s.partBorderWidth };
  const bottomBorderBatch: BorderBatch = { gfx: new Graphics(), rects: [], color: BOARD_COLORS.partBoundsBottom, alpha: s.partBorderAlpha, lastWidth: s.partBorderWidth };

  // Skip event system traversal for all board objects — events are handled
  // manually via viewport hit-testing, so PixiJS doesn't need to walk the tree.
  root.interactiveChildren = false;

  // Enable zIndex-based sorting so overlay objects (selection, elevated labels)
  // can use zIndex to guarantee render order regardless of addChild sequence.
  root.sortableChildren = true;

  root.addChild(outlineGfx);

  // PCB traces — drawn behind components, after outline.
  // Multi-layer: per-layer trace containers (each gets its own color from layerStates).
  // Single-layer: single traceLayer container with default red color.
  let traceLayer: Container | null = null;
  const traceLayerContainers: Container[] = [];
  const isMultiLayer = !!board.layerNames && board.layerNames.length > 0;

  if (board.traces && board.traces.length > 0) {
    if (isMultiLayer) {
      // Group traces by layer index → per-layer containers
      const byLayer = new Map<number, typeof board.traces>();
      for (const t of board.traces) {
        const li = t.layer ?? 0;
        let arr = byLayer.get(li);
        if (!arr) { arr = []; byLayer.set(li, arr); }
        arr.push(t);
      }
      traceLayer = new Container();
      for (const [layerIdx, layerTraces] of byLayer) {
        const layerContainer = new Container();
        layerContainer.label = `trace-layer-${layerIdx}`;
        const gfx = new Graphics();
        // Group by width for batched strokes
        const byWidth = new Map<number, typeof layerTraces>();
        for (const t of layerTraces) {
          let arr = byWidth.get(t.width);
          if (!arr) { arr = []; byWidth.set(t.width, arr); }
          arr.push(t);
        }
        // Use palette color for this layer
        const layerColor = board.layerNames && layerIdx < board.layerNames.length
          ? DEFAULT_LAYER_PALETTE[layerIdx % DEFAULT_LAYER_PALETTE.length]
          : 0xcc3333;
        for (const [width, traces] of byWidth) {
          for (const t of traces) {
            gfx.moveTo(t.start.x, t.start.y);
            gfx.lineTo(t.end.x, t.end.y);
          }
          gfx.stroke({ width: Math.min(width, MAX_TRACE_WIDTH), color: layerColor, alpha: 0.85, join: 'round', cap: 'round' });
        }
        layerContainer.addChild(gfx);
        traceLayer.addChild(layerContainer);
        // Ensure array is big enough
        while (traceLayerContainers.length <= layerIdx) traceLayerContainers.push(null!);
        traceLayerContainers[layerIdx] = layerContainer;
      }
      root.addChild(traceLayer);
    } else {
      // Single-layer: one container with default red
      traceLayer = new Container();
      const traceGfx = new Graphics();
      const byWidth = new Map<number, typeof board.traces>();
      for (const t of board.traces) {
        let arr = byWidth.get(t.width);
        if (!arr) { arr = []; byWidth.set(t.width, arr); }
        arr.push(t);
      }
      for (const [width, traces] of byWidth) {
        for (const t of traces) {
          traceGfx.moveTo(t.start.x, t.start.y);
          traceGfx.lineTo(t.end.x, t.end.y);
        }
        traceGfx.stroke({ width: Math.min(width, MAX_TRACE_WIDTH), color: 0xcc3333, alpha: 0.85, join: 'round', cap: 'round' });
      }
      traceLayer.addChild(traceGfx);
      root.addChild(traceLayer);
    }
  }

  // ── Silkscreen / assembly outlines ────────────────────────────────────────
  // Per-component polylines from the parser, already in board coordinates.
  // Two side containers so the renderer can independently toggle visibility
  // alongside the existing top/bottom side toggles.
  let silkscreenLayer: Container | null = null;
  let silkscreenTop: Container | null = null;
  let silkscreenBottom: Container | null = null;
  if (board.silkscreen && board.silkscreen.length > 0) {
    silkscreenLayer = new Container();
    silkscreenLayer.label = 'silkscreen';
    silkscreenTop = new Container();
    silkscreenTop.label = 'silkscreen-top';
    silkscreenBottom = new Container();
    silkscreenBottom.label = 'silkscreen-bottom';

    const SILK_TOP_COLOR    = 0xc8c8c8;
    const SILK_BOTTOM_COLOR = 0x9aa8c0;
    const SILK_WIDTH        = 1.5;
    const SILK_ALPHA        = 0.85;

    const topGfx = new Graphics();
    const botGfx = new Graphics();
    for (const path of board.silkscreen) {
      const pts = path.points;
      if (pts.length < 2) continue;
      const g = path.side === 'top' ? topGfx : botGfx;
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    }
    topGfx.stroke({ width: SILK_WIDTH, color: SILK_TOP_COLOR,    alpha: SILK_ALPHA, join: 'round', cap: 'round' });
    botGfx.stroke({ width: SILK_WIDTH, color: SILK_BOTTOM_COLOR, alpha: SILK_ALPHA, join: 'round', cap: 'round' });
    silkscreenTop.addChild(topGfx);
    silkscreenBottom.addChild(botGfx);
    silkscreenLayer.addChild(silkscreenBottom);
    silkscreenLayer.addChild(silkscreenTop);
    root.addChild(silkscreenLayer);
  }

  // ── Copper pads ─────────────────────────────────────────────────────────────
  // Filled rectangles in board coordinates (already pre-rotated/translated).
  // Through-hole pads (side='both') render on both side containers so they
  // remain visible regardless of which side is selected.
  //
  // Two parallel layer trees so the user can toggle them independently:
  //   - padsLayer      = pads where pad.attached === true  (real component pins)
  //   - copperDropsLayer = the rest (GND stitching, power drops, mounting pads)
  // Parsers that don't tag attachment (Allegro/BVR/etc.) leave `attached`
  // undefined; we treat undefined as "attached" so existing formats render
  // exactly as before.
  let padsLayer: Container | null = null;
  let padsTop: Container | null = null;
  let padsBottom: Container | null = null;
  let copperDropsLayer: Container | null = null;
  let copperDropsTop: Container | null = null;
  let copperDropsBottom: Container | null = null;
  if (board.pads && board.pads.length > 0) {
    padsLayer = new Container();
    padsLayer.label = 'pads';
    padsTop = new Container();
    padsTop.label = 'pads-top';
    padsBottom = new Container();
    padsBottom.label = 'pads-bottom';
    copperDropsLayer = new Container();
    copperDropsLayer.label = 'copper-drops';
    copperDropsTop = new Container();
    copperDropsTop.label = 'copper-drops-top';
    copperDropsBottom = new Container();
    copperDropsBottom.label = 'copper-drops-bottom';

    const PAD_TOP_COLOR    = 0xd4a64a;  // warm copper
    const PAD_BOTTOM_COLOR = 0x8da6c0;  // cool copper-grey
    const PAD_ALPHA        = 0.9;
    const DROP_ALPHA       = 0.55;      // dimmer than real pads — they're noise
    const DRILL_COLOR      = 0x111111;
    const DRILL_ALPHA      = 0.95;

    const topPadGfx  = new Graphics();
    const botPadGfx  = new Graphics();
    const topDropGfx = new Graphics();
    const botDropGfx = new Graphics();
    const drillGfx   = new Graphics();
    let anyDrill = false;
    for (const p of board.pads) {
      const w = p.bounds.maxX - p.bounds.minX;
      const h = p.bounds.maxY - p.bounds.minY;
      if (w <= 0 || h <= 0) continue;
      const isAttached = p.attached !== false; // undefined → treat as attached
      const topGfx = isAttached ? topPadGfx : topDropGfx;
      const botGfx = isAttached ? botPadGfx : botDropGfx;
      if (p.side === 'top' || p.side === 'both') {
        topGfx.rect(p.bounds.minX, p.bounds.minY, w, h);
      }
      if (p.side === 'bottom' || p.side === 'both') {
        botGfx.rect(p.bounds.minX, p.bounds.minY, w, h);
      }
      // Punch a drill hole through TH pads so the user can see the hole
      // through the (otherwise solid) ground/power pad rectangle.
      if (p.drill && p.drill > 0) {
        const cx = (p.bounds.minX + p.bounds.maxX) / 2;
        const cy = (p.bounds.minY + p.bounds.maxY) / 2;
        drillGfx.circle(cx, cy, p.drill / 2);
        anyDrill = true;
      }
    }
    topPadGfx.fill({ color: PAD_TOP_COLOR,    alpha: PAD_ALPHA });
    botPadGfx.fill({ color: PAD_BOTTOM_COLOR, alpha: PAD_ALPHA });
    topDropGfx.fill({ color: PAD_TOP_COLOR,    alpha: DROP_ALPHA });
    botDropGfx.fill({ color: PAD_BOTTOM_COLOR, alpha: DROP_ALPHA });
    if (anyDrill) drillGfx.fill({ color: DRILL_COLOR, alpha: DRILL_ALPHA });
    padsTop.addChild(topPadGfx);
    padsBottom.addChild(botPadGfx);
    copperDropsTop.addChild(topDropGfx);
    copperDropsBottom.addChild(botDropGfx);
    // Drops render BELOW pads so a drop pad sitting under a pin doesn't
    // visually overpower the real pad.
    copperDropsLayer.addChild(copperDropsBottom);
    copperDropsLayer.addChild(copperDropsTop);
    padsLayer.addChild(padsBottom);
    padsLayer.addChild(padsTop);
    root.addChild(copperDropsLayer);
    root.addChild(padsLayer);
    // Drill holes render above both side fills so the hole visually punches
    // through whichever side is currently visible.
    if (anyDrill) {
      padsLayer.addChild(drillGfx);
    }
  }

  root.addChild(bottomLayer);
  root.addChild(topLayer);

  drawOutline(outlineGfx, board, s);

  // ── Spatial grid for pin/triangle culling ────────────────────────────────────
  // Divide the board into NxN cells. Each cell has its own color-batched pin
  // Graphics + triangle Graphics inside a cullable Container with explicit
  // cullArea. PixiJS skips off-screen cells entirely during rendering.
  // For small boards (gridSize=1) this degrades to the previous flat batching.
  const totalPins = board.parts.reduce((n, p) => n + p.pins.length, 0);
  const gridSize  = computeGridSize(totalPins);
  const bMinX = board.bounds.minX, bMinY = board.bounds.minY;
  const bW = board.bounds.maxX - bMinX || 1;
  const bH = board.bounds.maxY - bMinY || 1;
  const cellW = bW / gridSize, cellH = bH / gridSize;

  interface GridCell {
    pinGfx: Map<number, Graphics>;
    triGfx: Graphics | null;
    container: Container;
    // Label accumulation arrays — flushed into cullable containers after all parts
    circleNums: BitmapText[];       // pin number labels (Group A, lower z)
    circleNets: Container[];        // net name labels (Group A, higher z)
    twoPinItems: Container[];       // 2-pin net labels (Group B)
  }

  const makeGrid = (): GridCell[][] => {
    const cells: GridCell[][] = [];
    for (let cy = 0; cy < gridSize; cy++) {
      cells[cy] = [];
      for (let cx = 0; cx < gridSize; cx++) {
        const container = new Container();
        container.cullable = true;
        container.cullArea = new Rectangle(
          bMinX + cx * cellW,
          bMinY + cy * cellH,
          cellW,
          cellH,
        );
        cells[cy][cx] = { pinGfx: new Map(), triGfx: null, container, circleNums: [], circleNets: [], twoPinItems: [] };
      }
    }
    return cells;
  };

  const topGrid    = makeGrid();
  const bottomGrid = makeGrid();

  const posToCell = (x: number, y: number): [number, number] => [
    Math.min(gridSize - 1, Math.max(0, Math.floor((x - bMinX) / cellW))),
    Math.min(gridSize - 1, Math.max(0, Math.floor((y - bMinY) / cellH))),
  ];

  const getGridPinGfx = (isBottom: boolean, color: number, x: number, y: number): Graphics => {
    const [cx, cy] = posToCell(x, y);
    const cell = (isBottom ? bottomGrid : topGrid)[cy][cx];
    let gfx = cell.pinGfx.get(color);
    if (!gfx) { gfx = new Graphics(); cell.pinGfx.set(color, gfx); }
    return gfx;
  };

  // Part containers are queued and added AFTER global pin Graphics so borders/labels render on top
  const partQueue: { container: Container; isBottom: boolean }[] = [];
  const pinRadiusClamp = new Map<number, number>();
  const twoPinPadPolys = new Map<number, [number, number][][]>();
  const partLabelByIndex = new Map<number, BitmapText>();

  // Parts
  for (let pi = 0; pi < board.parts.length; pi++) {
    const part = board.parts[pi];
    if (part.hidden) continue; // filtered out by the board-selection UI

    // Resolve per-type override — prefix match, longest key wins (e.g. 'FB' beats 'F' for FB1)
    const override = resolvePartTypeOverride(part.name, s);
    if (override?.hidden) continue;

    // Push helper: adds a pin label to both the flat side-array and the
    // per-part index (used by the renderer to un-dim selected parts).
    const pushPinLabel = (isBot: boolean, c: Container) => {
      (isBot ? bottomPinLabels : topPinLabels).push(c);
      let arr = pinLabelsByPartIndex.get(pi);
      if (!arr) { arr = []; pinLabelsByPartIndex.set(pi, arr); }
      arr.push(c);
    };

    const partContainer = new Container();
    partContainer.cullable = true;
    partContainer.label   = part.name;

    const isSmallPart  = part.pins.length <= 4;
    const isMultiPin   = part.pins.length > 2;
    const isBottom     = part.side === 'bottom';
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);

    // Detect diagonal 2-pin parts: if min(dx,dy)/max(dx,dy) > 0.4, it's diagonal
    // enough that axis-aligned rendering produces oversized outlines.
    const isDiag2Pin = part.pins.length === 2 && (() => {
      const dx = Math.abs(part.pins[1].position.x - part.pins[0].position.x);
      const dy = Math.abs(part.pins[1].position.y - part.pins[0].position.y);
      const ratio = Math.min(dx, dy) / (Math.max(dx, dy) || 1);
      return ratio > 0.4;
    })();
    const isTwoPinPart = part.pins.length === 2 && !isDiag2Pin;

    applyBodyShapeOverride(eb, override, isSmallPart);

    // Explicit cullArea avoids PixiJS calling getBounds() on every child each frame.
    // Pad generously (2× pinMaxRadius) so net-name labels that extend beyond part
    // bounds are never accidentally clipped.
    const cullPad = s.pinMaxRadius * 2;
    partContainer.cullArea = new Rectangle(
      eb.px - cullPad, eb.py - cullPad,
      eb.pw + cullPad * 2, eb.ph + cullPad * 2,
    );

    // ── Pins ─────────────────────────────────────────────────────────────────
    // Shapes are drawn directly into the board-wide global pin Graphics (by color).
    // Group A labels (circle/single-pin) and Group B labels (2-pin net names) go to separate layers.
    const deferredCircleNumTexts: BitmapText[] = [];  // Group A — pin numbers (flushed first → below)
    const deferredCircleNetTexts: Container[] = [];   // Group A — net names  (flushed last  → on top)
    const deferredTwoPinTexts: Container[] = [];      // Group B
    // Track pad rectangles for 2-pin net labels (indexed by pin index)
    const padRects: { rx: number; ry: number; rw: number; rh: number }[] = [];

    // Pre-compute pad depth for 2-pin parts (used in pin loop and border drawing)
    const padDepth = isTwoPinPart
      ? (eb.horiz ? Math.min(eb.ph, eb.pw * 0.4) : Math.min(eb.pw, eb.ph * 0.4))
      : 0;

    // Pre-compute rotated pads for diagonal 2-pin parts
    const diag2Pads = isDiag2Pin ? computeDiag2PinPads(part.pins, s) : null;

    // Auto-clamp pin radius for dense parts (e.g. BGA) so pins don't overlap.
    // Uses sorted-axis approach: O(N log N) instead of O(N²) for finding
    // minimum pin-to-pin distance. Sort by X, then only check neighbors
    // whose X-gap is smaller than the current best distance.
    let maxNonOverlapRadius = Infinity;
    let minPinSpacing = Infinity; // sqrt of minDist2, used for row grouping below
    if (isMultiPin) {
      const sorted = part.pins.slice().sort((a, b) => a.position.x - b.position.x);
      let minDist2 = Infinity;
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const dx = sorted[j].position.x - sorted[i].position.x;
          if (dx * dx >= minDist2) break; // sorted by X — all further j are worse
          const dy = sorted[j].position.y - sorted[i].position.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 0 && d2 < minDist2) minDist2 = d2;
        }
      }
      if (minDist2 < Infinity) {
        minPinSpacing = Math.sqrt(minDist2);
        maxNonOverlapRadius = minPinSpacing * 0.45;
        pinRadiusClamp.set(pi, maxNonOverlapRadius);
        // Shrink eb bounds if overlap clamp reduces effective pin radius.
        // Original padding used unclamped maxR; re-pad with clamped maxR so
        // border outline matches drawn pin extents.
        let maxDrawnR = s.pinMinRadius;
        for (const pin of part.pins) {
          const r = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
          if (r > maxDrawnR) maxDrawnR = r;
        }
        const clampedPad = s.partPadding + maxDrawnR;
        const origPad = computeMultiPinPadding(s, part.pins.map(p => p.radius ?? 0));
        const shrink = origPad - clampedPad;
        if (shrink > 0) {
          eb.px += shrink; eb.py += shrink;
          eb.pw -= shrink * 2; eb.ph -= shrink * 2;
        }
      }
    }

    // Pre-compute per-pin column index for BGA alternating label layout.
    // Groups pins into horizontal rows by Y proximity (within 50% of min pin spacing),
    // then assigns a 0-based column index by sorting each row by X.
    // This gives the correct "left-to-right position within the row" regardless of
    // sequential pin numbering order.
    const pinColIndex: number[] = new Array(part.pins.length).fill(0);
    if (isMultiPin && s.showPinNumbers && minPinSpacing < Infinity) {
      // Map rowKey → list of pin indices in that row
      const rowMap = new Map<number, number[]>();
      for (let i = 0; i < part.pins.length; i++) {
        const rowKey = Math.round(part.pins[i].position.y / minPinSpacing);
        const row = rowMap.get(rowKey);
        if (row) row.push(i); else rowMap.set(rowKey, [i]);
      }
      // Within each row, sort by X and assign column index
      for (const indices of rowMap.values()) {
        indices.sort((a, b) => part.pins[a].position.x - part.pins[b].position.x);
        for (let col = 0; col < indices.length; col++) {
          pinColIndex[indices[col]] = col;
        }
      }
    }

    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin    = part.pins[pni];
      const isPin1 = pni === 0 && isMultiPin;
      // Compute netUpper early — needed for both NC drawing routing and label suppression.
      const netUpper = pin.net?.toUpperCase() ?? '';
      const isNcPin  = isNcNet(netUpper, s.ncNetPatterns);
      const color = (isPin1 && s.showPin1Marker) ? BOARD_COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);
      const ncGfx = isBottom ? bottomNcPinGfx : topNcPinGfx;

      if (isTwoPinPart) {
        let padRx: number, padRy: number, padRw: number, padRh: number;
        if (eb.horiz) {
          padRx = pin.position.x - padDepth / 2;
          padRy = eb.py; padRw = padDepth; padRh = eb.ph;
        } else {
          padRx = eb.px; padRy = pin.position.y - padDepth / 2;
          padRw = eb.pw; padRh = padDepth;
        }
        const padShape = override?.padShape ?? 'natural';
        if (isNcPin) {
          if (padShape === 'round') {
            const pr = Math.min(padRw, padRh) / 2;
            ncGfx.circle(padRx + padRw / 2, padRy + padRh / 2, pr);
            padRects[pni] = { rx: padRx + padRw / 2 - pr, ry: padRy + padRh / 2 - pr, rw: pr * 2, rh: pr * 2 };
          } else {
            ncGfx.rect(padRx, padRy, padRw, padRh);
            padRects[pni] = { rx: padRx, ry: padRy, rw: padRw, rh: padRh };
          }
        } else {
          const pinGfx = getGridPinGfx(isBottom, color, padRx + padRw / 2, padRy + padRh / 2);
          if (padShape === 'round') {
            const pr = Math.min(padRw, padRh) / 2;
            pinGfx.circle(padRx + padRw / 2, padRy + padRh / 2, pr);
            padRects[pni] = { rx: padRx + padRw / 2 - pr, ry: padRy + padRh / 2 - pr, rw: pr * 2, rh: pr * 2 };
          } else if (padShape === 'square') {
            const side = Math.min(padRw, padRh);
            const sx = padRx + padRw / 2 - side / 2;
            const sy = padRy + padRh / 2 - side / 2;
            pinGfx.rect(sx, sy, side, side);
            padRects[pni] = { rx: sx, ry: sy, rw: side, rh: side };
          } else {
            pinGfx.rect(padRx, padRy, padRw, padRh);
            padRects[pni] = { rx: padRx, ry: padRy, rw: padRw, rh: padRh };
          }
        }
      } else if (diag2Pads) {
        // Diagonal 2-pin: draw rotated rectangular pads along the pin axis
        const poly = diag2Pads.pads[pni];
        const targetGfx = isNcPin ? ncGfx : getGridPinGfx(isBottom, color, pin.position.x, pin.position.y);
        targetGfx.moveTo(poly[0][0], poly[0][1]);
        for (let vi = 1; vi < poly.length; vi++) targetGfx.lineTo(poly[vi][0], poly[vi][1]);
        targetGfx.closePath();
        // Store axis-aligned bounding rect for label sizing
        const xs = poly.map(p => p[0]), ys = poly.map(p => p[1]);
        padRects[pni] = {
          rx: Math.min(...xs), ry: Math.min(...ys),
          rw: Math.max(...xs) - Math.min(...xs),
          rh: Math.max(...ys) - Math.min(...ys),
        };
      } else {
        const r = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
        const padShape = override?.padShape ?? 'natural';
        if (isNcPin) {
          // Inset by half stroke width so outer edge aligns with filled pins of same radius
          const ncInset = Math.max(0.15, s.pinMinRadius * 0.06);
          const ri = r - ncInset;
          if (padShape === 'square') ncGfx.rect(pin.position.x - ri, pin.position.y - ri, ri * 2, ri * 2);
          else                       ncGfx.circle(pin.position.x, pin.position.y, ri);
        } else {
          const pinGfx = getGridPinGfx(isBottom, color, pin.position.x, pin.position.y);
          if (padShape === 'square') pinGfx.rect(pin.position.x - r, pin.position.y - r, r * 2, r * 2);
          else                       pinGfx.circle(pin.position.x, pin.position.y, r);
        }
      }

      // Whether this pin has a displayable net name (GND/NC suppressed — already color-coded)
      const hasNet = !!(pin.net && pin.net !== '(null)' && pin.net !== '' && !netUpper.includes('GND') && !isNcPin);
      // BGA alternating: when both pin number and net name are shown on a multi-pin part,
      // alternate their vertical positions by pin index so adjacent pins' labels interleave.
      const bgaAlternate = isMultiPin && s.showPinNumbers && hasNet;

      // Whether 2-pin parts show pin numbers (two-level layout like BGA)
      const twoPinShowNum = false;
      // Whether this 2-pin pad uses two-level layout (pin number + net name stacked)
      const twoPinTwoLevel = twoPinShowNum && hasNet;

      // ── Pin number label ──────────────────────────────────────────────
      // Multi-pin (BGA/IC): always shown when showPinNumbers is on.
      // 2-pin: shown when showTwoPinNumbers is on — sized to fit the pad rectangle.
      // NC pins skip labels entirely — no useful info, saves draw calls.
      if (((isMultiPin && s.showPinNumbers) || twoPinShowNum) && !isNcPin) {
        const numStr = pinDisplayId(pin, pni);
        let pinFontSize: number;
        let pinX: number, pinY: number;
        let numAnchorY = 0.5;

        if (isTwoPinPart) {
          // 2-pin: fit pin number inside the pad rectangle.
          // When two-level, use the top half; otherwise center in the full pad.
          const pad = padRects[pni];
          const fitW = pad.rw * 0.85;
          const fitH = twoPinTwoLevel ? (pad.rh * 0.45) : (pad.rh * 0.85);
          pinFontSize = Math.min(fitW / (Math.max(numStr.length, 2) * 0.6), fitH * 0.8);
          pinFontSize = Math.max(pinFontSize, getLabelFontSize(s));
          pinX = pad.rx + pad.rw / 2;
          pinY = twoPinTwoLevel
            ? pad.ry + pad.rh * 0.25   // top quarter of pad
            : pad.ry + pad.rh / 2;     // center of pad
        } else {
          // Multi-pin (BGA/IC): size to pin circle diameter
          const r = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
          const diameter = r * 2;
          pinFontSize = (diameter * 0.55) / (Math.max(numStr.length, 3) * 0.6);
          pinFontSize = Math.min(pinFontSize, diameter * 0.65);
          pinX = pin.position.x;
          pinY = pin.position.y;
          // BGA alternating: even column → number above pin center, odd → below.
          // Half the requested gap is applied here; the matching net label adds
          // the other half on the opposite side, so the visible gap between the
          // two labels equals `r * bgaLabelGapFactor` (matches the UI tooltip).
          const even = pinColIndex[pni] % 2 === 0;
          numAnchorY = bgaAlternate ? (even ? 1.0 : 0.0) : 0.8;
          const bgaHalfGap = (r * s.bgaLabelGapFactor) / 2;
          pinY += bgaAlternate ? (even ? -bgaHalfGap : bgaHalfGap) : 0;
        }

        pinFontSize = quantizeFontSize(pinFontSize);
        if (pinFontSize >= s.labelHideThreshold) {
          const pinLabel = new BitmapText({
            text: numStr,
            style: { fontSize: pinFontSize, fill: BOARD_COLORS.labelPin, fontFamily: ensurePinFont(pinFontSize) },
          });
          pinLabel.anchor.set(0.5, numAnchorY);
          pinLabel.x = pinX;
          pinLabel.y = pinY;
          if (isTwoPinPart) {
            deferredTwoPinTexts.push(pinLabel);
          } else {
            deferredCircleNumTexts.push(pinLabel);
          }
          pushPinLabel(isBottom, pinLabel);
        }
      }

      // ── Net name label on pin (skip GND — already color-coded) ─────
      if (hasNet) {
        let netFontSize: number;
        let nx: number, ny: number;
        const anchorX = 0.5;
        let anchorY = 0.5;

        if (isTwoPinPart) {
          // 2-pin: fit net name inside pad. When two-level, use the bottom half.
          const pad = padRects[pni];
          const fitW = pad.rw * 0.85;
          const fitH = twoPinTwoLevel ? (pad.rh * 0.45) : (pad.rh * 0.85);
          netFontSize = Math.min(fitW / (pin.net.length * 0.6), fitH * 0.8);
          nx = pad.rx + pad.rw / 2;
          if (twoPinTwoLevel) {
            ny = pad.ry + pad.rh * 0.75;   // bottom quarter of pad
          } else if (eb.horiz) {
            // Horizontal: alternate labels above/below part-name level
            // so they don't overlap each other or the component name.
            const gap = (eb.ph / 2) * s.twoPinLabelGapFactor;
            ny = pad.ry + pad.rh / 2;
            anchorY = pni === 0 ? 1.0 : 0.0; // pin 0 above, pin 1 below
            ny += pni === 0 ? -gap : gap;
          } else {
            ny = pad.ry + pad.rh / 2;       // vertical: center in pad
          }
        } else {
          const r = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
          const diameter = r * 2;
          // Use max(len, 3) so short names like "NC" don't get oversized — mirrors pin number formula.
          netFontSize = diameter * 0.85 / (Math.max(pin.net.length, 3) * 0.6);
          netFontSize = Math.min(netFontSize, diameter * 0.85);
          nx = pin.position.x;
          ny = pin.position.y;
          if (bgaAlternate) {
            // BGA alternating: mirror of pin number — even column → net below pin center, odd → above.
            // anchor 0.0 = text top at y; anchor 1.0 = text bottom at y.
            // Half-gap matches the pin-number side; combined visible separation = r * factor.
            const even = pinColIndex[pni] % 2 === 0;
            anchorY = even ? 0.0 : 1.0;
            const bgaHalfGap = (r * s.bgaLabelGapFactor) / 2;
            ny += even ? bgaHalfGap : -bgaHalfGap;
          } else if (isMultiPin && s.showPinNumbers) {
            anchorY = 0.05; // standard offset when pin number also shown
          }
        }

        // Floor: user's active label-size setting keeps net names legible even on tiny pins.
        // For BGA, also cap at pin diameter so text doesn't spill beyond the circle.
        const netFloor = isTwoPinPart
          ? getLabelFontSize(s)
          : Math.min(getLabelFontSize(s), maxNonOverlapRadius * 2 * 0.85);
        netFontSize = Math.max(netFontSize, netFloor);
        netFontSize = quantizeFontSize(netFontSize);
        if (netFontSize >= s.labelHideThreshold) {
          const netLabel = new BitmapText({
            text: pin.net,
            style: { fontSize: netFontSize, fill: BOARD_COLORS.labelNet, fontFamily: ensureShadowFont(netFontSize) },
          });
          netLabel.anchor.set(anchorX, anchorY);
          netLabel.x = nx;
          netLabel.y = ny;
          const bgPad = Math.max(1, netFontSize * 0.12);
          if (isTwoPinPart) {
            if (s.twoPinNetLabelBg) {
              // Container wrapper: bg (index 0) renders behind netLabel (index 1).
              const estW = netFontSize * pin.net.length * 0.55;
              const estH = netFontSize * 1.1;
              const bg = new Graphics();
              bg.rect(-anchorX * estW - bgPad, -anchorY * estH - bgPad, estW + bgPad * 2, estH + bgPad * 2);
              bg.fill({ color: 0x000000, alpha: 0.6 });
              netLabel.x = 0; netLabel.y = 0;
              const wrapper = new Container();
              wrapper.x = nx; wrapper.y = ny;
              wrapper.addChild(bg);
              wrapper.addChild(netLabel);
              deferredTwoPinTexts.push(wrapper);
              pushPinLabel(isBottom, wrapper);
            } else {
              deferredTwoPinTexts.push(netLabel);
              pushPinLabel(isBottom, netLabel);
            }
          } else {
            if (s.pinNetLabelBg) {
              // Cap background width to 3× pin diameter; Container wrapper keeps bg behind text.
              const pinR = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
              const estW = Math.min(netFontSize * pin.net.length * 0.55, pinR * 6);
              const estH = netFontSize * 1.1;
              const bg = new Graphics();
              bg.rect(-anchorX * estW - bgPad, -anchorY * estH - bgPad, estW + bgPad * 2, estH + bgPad * 2);
              bg.fill({ color: 0x000000, alpha: 0.6 });
              netLabel.x = 0; netLabel.y = 0;
              const wrapper = new Container();
              wrapper.x = nx; wrapper.y = ny;
              wrapper.addChild(bg);
              wrapper.addChild(netLabel);
              deferredCircleNetTexts.push(wrapper);
              pushPinLabel(isBottom, wrapper);
            } else {
              deferredCircleNetTexts.push(netLabel);
              pushPinLabel(isBottom, netLabel);
            }
          }
        }
      }
    }

    // ── Pin 1 triangle marker (multi-pin only) ──────────────────────────
    // Accumulated into the grid cell's triangle Graphics (by layer).
    if (s.showPin1Marker && isMultiPin && part.pins.length > 0) {
      const pin = part.pins[0];
      const r = Math.min(computePinRadius(s, pin.radius), maxNonOverlapRadius);
      const triSize = r * 0.7;
      const distLeft   = pin.position.x - eb.px;
      const distRight  = (eb.px + eb.pw) - pin.position.x;
      const distTop    = pin.position.y - eb.py;
      const distBottom = (eb.py + eb.ph) - pin.position.y;
      const minDist    = Math.min(distLeft, distRight, distTop, distBottom);
      let tx: number, ty: number, angle: number;
      if (minDist === distLeft) {
        tx = eb.px + triSize * 0.3; ty = pin.position.y; angle = Math.PI / 2;
      } else if (minDist === distRight) {
        tx = eb.px + eb.pw - triSize * 0.3; ty = pin.position.y; angle = -Math.PI / 2;
      } else if (minDist === distTop) {
        tx = pin.position.x; ty = eb.py + triSize * 0.3; angle = Math.PI;
      } else {
        tx = pin.position.x; ty = eb.py + eb.ph - triSize * 0.3; angle = 0;
      }
      const [cx, cy] = posToCell(tx, ty);
      const triCell = (isBottom ? bottomGrid : topGrid)[cy][cx];
      if (!triCell.triGfx) triCell.triGfx = new Graphics();
      const triGfx = triCell.triGfx;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const pts = [
        { x: 0, y: -triSize * 0.6 },
        { x: -triSize * 0.5, y: triSize * 0.4 },
        { x:  triSize * 0.5, y: triSize * 0.4 },
      ];
      triGfx.moveTo(tx + pts[0].x * cos - pts[0].y * sin, ty + pts[0].x * sin + pts[0].y * cos);
      triGfx.lineTo(tx + pts[1].x * cos - pts[1].y * sin, ty + pts[1].x * sin + pts[1].y * cos);
      triGfx.lineTo(tx + pts[2].x * cos - pts[2].y * sin, ty + pts[2].x * sin + pts[2].y * cos);
      triGfx.closePath();
    }

    // Store pad polygons for 2-pin parts so selection highlights can reuse exact geometry
    if (isTwoPinPart && padRects.length === 2) {
      twoPinPadPolys.set(pi, padRects.map(r => [
        [r.rx, r.ry], [r.rx + r.rw, r.ry],
        [r.rx + r.rw, r.ry + r.rh], [r.rx, r.ry + r.rh],
      ] as [number, number][]));
    } else if (diag2Pads) {
      twoPinPadPolys.set(pi, diag2Pads.pads);
    }

    // ── Part border + optional component-type fill ───────────────────────────
    if (part.pins.length > 1 || (part.pins.length === 0 && eb.pw > 0 && eb.ph > 0)) {
      let borderRect: BorderRect;
      let fillX: number, fillY: number, fillW: number, fillH: number;
      let fillPoly: [number, number][] | null = null;
      if (part.pins.length === 0) {
        // No pin data — draw simple bounds rectangle from parser-assigned defaults
        borderRect = { x: eb.px, y: eb.py, w: eb.pw, h: eb.ph };
        fillX = eb.px; fillY = eb.py; fillW = eb.pw; fillH = eb.ph;
      } else if (isTwoPinPart) {
        // Expand border to encompass pads centered on pin vertices.
        // Use pin positions directly (not eb bounds) so the outline matches
        // the pads exactly — eb bounds may be inflated by parser bboxes.
        const p0 = part.pins[0].position;
        const p1 = part.pins[part.pins.length - 1].position;
        let bx: number, by: number, bw: number, bh: number;
        if (eb.horiz) {
          const pinMinX = Math.min(p0.x, p1.x);
          const pinSpanX = Math.abs(p1.x - p0.x);
          bx = pinMinX - padDepth / 2;
          by = eb.py;
          bw = pinSpanX + padDepth;
          bh = eb.ph;
        } else {
          const pinMinY = Math.min(p0.y, p1.y);
          const pinSpanY = Math.abs(p1.y - p0.y);
          bx = eb.px;
          by = pinMinY - padDepth / 2;
          bw = eb.pw;
          bh = pinSpanY + padDepth;
        }
        borderRect = { x: bx, y: by, w: bw, h: bh };
        fillX = bx; fillY = by; fillW = bw; fillH = bh;
      } else {
        // For diagonal 2-pin parts, compute a simple OBB along the pin axis.
        // For multi-pin parts, use the existing diagonal detection.
        const obb = isDiag2Pin
          ? computeTwoPinOBB(part.pins, s)
          : computeDiagonalOBB(part.pins, s);
        borderRect = obb
          ? { x: eb.px, y: eb.py, w: eb.pw, h: eb.ph, poly: obb }
          : { x: eb.px, y: eb.py, w: eb.pw, h: eb.ph };
        fillX = eb.px; fillY = eb.py; fillW = eb.pw; fillH = eb.ph;
        fillPoly = obb ?? null;
      }
      (isBottom ? bottomBorderBatch : topBorderBatch).rects.push(borderRect);

      if (s.showComponentColors && override?.color) {
        const fillColor = parseInt(override.color.replace('#', ''), 16);
        const map = isBottom ? bottomFillMap : topFillMap;
        let gfx = map.get(fillColor);
        if (!gfx) { gfx = new Graphics(); map.set(fillColor, gfx); }
        if (fillPoly) {
          gfx.moveTo(fillPoly[0][0], fillPoly[0][1]);
          for (let i = 1; i < fillPoly.length; i++) gfx.lineTo(fillPoly[i][0], fillPoly[i][1]);
          gfx.closePath();
        } else {
          gfx.rect(fillX, fillY, fillW, fillH);
        }
      }
    }

    // ── Label (last = always on top within the part) ────────────────────────
    if (s.showPartLabels) {
      let fontSize: number;
      if (isTwoPinPart) {
        // Horizontal: text is always rendered horizontally so size to full part width.
        // Vertical:   text spans the narrow width, height limited to center-body gap.
        // Floor at settings font size so tiny parts always have a readable label.
        const fitW = eb.pw;
        const fitH = eb.horiz ? eb.ph : eb.ph - 2 * padDepth;
        const fromBounds = Math.min(fitW * 0.85 / (part.name.length * 0.6), fitH * 0.85);
        fontSize = Math.max(getLabelFontSize(s), fromBounds);
      } else {
        const targetW = eb.pw * 0.7;
        fontSize = targetW / (part.name.length * 0.6);
        fontSize = Math.max(getLabelFontSize(s), Math.min(fontSize, eb.ph * 0.8));
      }
      fontSize = quantizeFontSize(fontSize);
      if (fontSize >= s.labelHideThreshold) {
        let labelColor: number = BOARD_COLORS.labelPart;
        let fontFamily = LABEL_FONT_FAMILY;
        if (s.showLabelSizeDebug) {
          const qs = quantizeFontSize(s.labelSizeSmall);
          const qm = quantizeFontSize(s.labelSizeMedium);
          labelColor = fontSize <= qs ? 0x4499ff   // blue  = small tier
                     : fontSize <= qm ? 0xffcc00   // yellow = medium tier
                     :                  0x44ff88;  // green  = large tier
        } else if (s.partLabelShadow) {
          fontFamily = ensureShadowFont(fontSize);
        }
        const label = new BitmapText({
          text:  part.name,
          style: { fontSize, fill: labelColor, fontFamily },
        });
        label.anchor.set(0.5, 0.5);
        label.x = eb.px + eb.pw / 2;
        label.y = eb.py + eb.ph / 2;
        partContainer.addChild(label);
        labels.push(label);
        (isBottom ? bottomLabels : topLabels).push(label);
        partLabelByIndex.set(pi, label);
      }
    }

    // ── Deferred text — route to grid cells for spatial culling ────────────
    // Labels are accumulated in grid cells and flushed after all parts,
    // maintaining z-order (pin numbers below net names) within each cell.
    const targetGrid = isBottom ? bottomGrid : topGrid;
    for (const txt of deferredCircleNumTexts) {
      const [cx, cy] = posToCell(txt.x, txt.y);
      targetGrid[cy][cx].circleNums.push(txt);
    }
    for (const txt of deferredCircleNetTexts) {
      const [cx, cy] = posToCell(txt.x, txt.y);
      targetGrid[cy][cx].circleNets.push(txt);
    }
    for (const txt of deferredTwoPinTexts) {
      // Extract position from BitmapText or Container wrapper
      const px = txt instanceof BitmapText ? txt.x : txt.x;
      const [cx, cy] = posToCell(px, txt instanceof BitmapText ? txt.y : txt.y);
      targetGrid[cy][cx].twoPinItems.push(txt);
    }

    partQueue.push({ container: partContainer, isBottom });
  }

  // Flush component-type fills — one Graphics per color, added before grid cells (fills under pins)
  for (const [color, gfx] of topFillMap) {
    gfx.fill({ color, alpha: s.componentFillAlpha });
    topFillLayer.addChild(gfx);
  }
  for (const [color, gfx] of bottomFillMap) {
    gfx.fill({ color, alpha: s.componentFillAlpha });
    bottomFillLayer.addChild(gfx);
  }

  // ── Flush grid cells ─────────────────────────────────────────────────────
  // Each grid cell container holds color-batched pin Graphics + triangle Graphics.
  // fill() finalizes accumulated paths; empty cells are skipped entirely.
  // Cells are added BEFORE partContainers so borders/labels render on top.
  const topPinGfx    = new Map<number, Graphics>();
  const bottomPinGfx = new Map<number, Graphics>();

  for (const [grid, layer, flatMap] of [
    [topGrid, topPinLayer, topPinGfx],
    [bottomGrid, bottomPinLayer, bottomPinGfx],
  ] as [GridCell[][], Container, Map<number, Graphics>][]) {
    for (let cy = 0; cy < gridSize; cy++) {
      for (let cx = 0; cx < gridSize; cx++) {
        const cell = grid[cy][cx];
        if (cell.pinGfx.size === 0) continue; // skip empty cells
        for (const [color, gfx] of cell.pinGfx) {
          gfx.fill({ color, alpha: s.pinAlpha });
          cell.container.addChild(gfx);
          // Merge into flat map for backward compat (net re-coloring, SettingsMockup)
          flatMap.set(color, gfx);
        }
        if (cell.triGfx) {
          cell.triGfx.fill({ color: BOARD_COLORS.pin1, alpha: 0.9 });
          cell.container.addChild(cell.triGfx);
        }
        layer.addChild(cell.container);
      }
    }
  }

  // Flush NC (no-connect) pin outlines — stroke-only, no fill.
  // Thin stroke so NC pins don't visually dominate over filled pins.
  // Stroke extends outward by half its width, so the drawn NC circle
  // already appears slightly larger than same-radius filled pins.
  const ncStrokeWidth = Math.max(0.3, s.pinMinRadius * 0.12);
  for (const [ncGfx, layer] of [[topNcPinGfx, topPinLayer], [bottomNcPinGfx, bottomPinLayer]] as [Graphics, Container][]) {
    ncGfx.stroke({ width: ncStrokeWidth, color: 0x555555, alpha: s.pinAlpha });
    layer.addChild(ncGfx);
  }

  // Flush batched border Graphics — initial draw, will be rebuilt on zoom
  const borderBatches: BorderBatch[] = [];
  for (const [batch, layer] of [[topBorderBatch, topOutlineLayer], [bottomBorderBatch, bottomOutlineLayer]] as [BorderBatch, Container][]) {
    if (batch.rects.length === 0) continue;
    for (const r of batch.rects) {
      if (r.poly) {
        batch.gfx.moveTo(r.poly[0][0], r.poly[0][1]);
        for (let i = 1; i < r.poly.length; i++) batch.gfx.lineTo(r.poly[i][0], r.poly[i][1]);
        batch.gfx.closePath();
      } else {
        batch.gfx.rect(r.x, r.y, r.w, r.h);
      }
    }
    batch.gfx.stroke({ width: s.partBorderWidth, color: batch.color, alpha: batch.alpha });
    layer.addChild(batch.gfx);
    borderBatches.push(batch);
  }

  // Add part containers above pins, triangles, and borders
  for (const { container, isBottom } of partQueue) {
    (isBottom ? bottomLabelLayer : topLabelLayer).addChild(container);
  }


  // ── Flush grid cell labels into cullable containers ──────────────────────
  // Each non-empty grid cell gets a cullable Container within the label layers.
  // Pin numbers are added before net names for correct z-ordering within each cell.
  // Generous cullArea padding accounts for label text extending beyond pin center.
  const labelCullPad = Math.max(cellW, cellH) * 0.5;
  for (const [grid, circleLayer, twoPinLayer] of [
    [topGrid, topCircleLabelLayer, topTwoPinNetLayer],
    [bottomGrid, bottomCircleLabelLayer, bottomTwoPinNetLayer],
  ] as [GridCell[][], Container, Container][]) {
    for (let cy = 0; cy < gridSize; cy++) {
      for (let cx = 0; cx < gridSize; cx++) {
        const cell = grid[cy][cx];
        if (cell.circleNums.length > 0 || cell.circleNets.length > 0) {
          const c = new Container();
          c.cullable = true;
          c.cullArea = new Rectangle(
            bMinX + cx * cellW - labelCullPad,
            bMinY + cy * cellH - labelCullPad,
            cellW + labelCullPad * 2,
            cellH + labelCullPad * 2,
          );
          // Z-order: nums first (below), nets second (on top)
          for (const txt of cell.circleNums) c.addChild(txt);
          for (const txt of cell.circleNets) c.addChild(txt);
          circleLayer.addChild(c);
        }
        if (cell.twoPinItems.length > 0) {
          const c = new Container();
          c.cullable = true;
          c.cullArea = new Rectangle(
            bMinX + cx * cellW - labelCullPad,
            bMinY + cy * cellH - labelCullPad,
            cellW + labelCullPad * 2,
            cellH + labelCullPad * 2,
          );
          for (const txt of cell.twoPinItems) c.addChild(txt);
          twoPinLayer.addChild(c);
        }
      }
    }
  }

  // Group B (2-pin net names) added below Group A (circle labels) — Group A is smallest/densest.
  topLabelLayer.addChild(topTwoPinNetLayer);
  topLabelLayer.addChild(topCircleLabelLayer);
  bottomLabelLayer.addChild(bottomTwoPinNetLayer);
  bottomLabelLayer.addChild(bottomCircleLabelLayer);

  // Build font-size groups: bucket all labels by floor(log2(fontSize)).
  // This gives ~5-6 groups, enabling O(groups) visibility checks instead of O(labels).
  const bucketMap = new Map<number, BitmapText[]>();
  const allLabelArrays = [topLabels, bottomLabels]; // pin labels managed separately by pin-size threshold
  for (const arr of allLabelArrays) {
    for (const lbl of arr) {
      const fs = lbl.style.fontSize as number;
      const bucket = Math.floor(Math.log2(Math.max(fs, 1)));
      let list = bucketMap.get(bucket);
      if (!list) { list = []; bucketMap.set(bucket, list); }
      list.push(lbl);
    }
  }
  const fontSizeGroups: FontSizeGroup[] = [];
  for (const [bucket, lbls] of bucketMap) {
    fontSizeGroups.push({ minSize: 2 ** bucket, labels: lbls, visible: true });
  }
  // Sort ascending so we can early-exit: once a group is visible, all larger groups are too
  fontSizeGroups.sort((a, b) => a.minSize - b.minSize);

  // Build font-size groups for pin labels (Group A: circle, Group B: 2-pin).
  // Items are either BitmapText or Container wrappers — extract fontSize from the BitmapText child.
  // Labels are now nested inside grid-cell containers, so flatten through one level.
  const pinFontSize = (item: Container): number => {
    if (item instanceof BitmapText) return item.style.fontSize as number;
    // Container wrapper: bg at [0], BitmapText at [1]
    const child = item.children[1];
    return child instanceof BitmapText ? (child.style.fontSize as number) : 1;
  };
  const buildPinGroups = (items: Container[]): PinFontSizeGroup[] => {
    const map = new Map<number, Container[]>();
    for (const item of items) {
      const bucket = Math.floor(Math.log2(Math.max(pinFontSize(item), 1)));
      let list = map.get(bucket);
      if (!list) { list = []; map.set(bucket, list); }
      list.push(item);
    }
    const groups: PinFontSizeGroup[] = [];
    for (const [bucket, grp] of map) {
      groups.push({ minSize: 2 ** bucket, items: grp, visible: true });
    }
    groups.sort((a, b) => a.minSize - b.minSize);
    return groups;
  };
  // Circle labels = pin numbers + net names on multi-pin parts.
  // Flatten through grid-cell containers to get individual label items.
  const flattenLabelLayer = (layer: Container): Container[] => {
    const items: Container[] = [];
    for (const cellContainer of layer.children) {
      for (const label of (cellContainer as Container).children) {
        items.push(label as Container);
      }
    }
    return items;
  };
  const allCircleItems: Container[] = [...flattenLabelLayer(topCircleLabelLayer), ...flattenLabelLayer(bottomCircleLabelLayer)];
  const circleFontSizeGroups = buildPinGroups(allCircleItems);
  // 2-pin net labels — also flatten through grid-cell containers
  const allTwoPinItems: Container[] = [...flattenLabelLayer(topTwoPinNetLayer), ...flattenLabelLayer(bottomTwoPinNetLayer)];
  const twoPinFontSizeGroups = buildPinGroups(allTwoPinItems);

  // ── Debug: pad vertex crosshairs ─────────────────────────────────────────
  const padVertexGfx = new Graphics();
  if (s.showPadVertices) {
    const ARM = 6; // crosshair arm length in mils
    padVertexGfx.setStrokeStyle({ width: 1.5, color: 0xff00ff });
    for (const part of board.parts) {
      if (part.hidden) continue;
      for (const pin of part.pins) {
        const { x, y } = pin.position;
        padVertexGfx.moveTo(x - ARM, y).lineTo(x + ARM, y);
        padVertexGfx.moveTo(x, y - ARM).lineTo(x, y + ARM);
      }
    }
    padVertexGfx.stroke();
  }
  root.addChild(padVertexGfx);

  // ── Via / drill hole markers ───────────────────────────────────────────────
  // Rendered as a pad ring sized to the via's actual diameter, plus a
  // proportionally smaller filled drill hole. No crosshair — boards with
  // thousands of vias (LA-H271P: 10791) turn a fixed crosshair into visual
  // noise that hides the real geometry. A small minimum radius keeps the
  // smallest vias visible at far zoom; otherwise size tracks reality.
  let viaLayer: Container | null = null;
  const viaLabels: BitmapText[] = [];
  const viaConnectedLayers: number[][] = []; // parallel to board.vias — connected layer indices per via
  if (board.vias && board.vias.length > 0 && isMultiLayer) {
    viaLayer = new Container();
    viaLayer.label = 'vias';
    const viaGfx = new Graphics();
    const viaCenterGfx = new Graphics();
    const VIA_COLOR = 0xcccccc;
    const VIA_HOLE_COLOR = 0x111111;
    const VIA_MIN_OUTER_R = 3;       // mil — visibility floor at far zoom
    const VIA_DRILL_RATIO = 0.4;     // drill ≈ 40% of pad diameter (typical)

    // Short layer labels for overlay
    const layerShortNames = board.layerNames
      ? board.layerNames.map((n, _i) => {
          const upper = n.toUpperCase();
          if (upper.includes('TOP')) return 'T';
          if (upper.includes('BOTTOM') || upper.includes('BOT')) return 'B';
          // Inner layers: use the layer name, strip parenthesized type suffix
          const short = n.replace(/\s*\(.*\)$/, '');
          return short.length <= 4 ? short : String(_i + 1);
        })
      : [];

    // ── Resolve per-via layer connectivity from trace endpoints ──────────
    // Trace coloring works perfectly, so trace data is our source of truth.
    // For each via, find traces on the same net with an endpoint touching the via.
    const VIA_MATCH_R2 = 15 * 15; // 15 mils squared
    // Index: net → array of { layer, x, y } from trace endpoints
    const traceEndpointsByNet = new Map<string, { layer: number; x: number; y: number }[]>();
    if (board.traces) {
      for (const t of board.traces) {
        if (!t.net || t.layer == null) continue;
        let arr = traceEndpointsByNet.get(t.net);
        if (!arr) { arr = []; traceEndpointsByNet.set(t.net, arr); }
        arr.push({ layer: t.layer, x: t.start.x, y: t.start.y });
        arr.push({ layer: t.layer, x: t.end.x, y: t.end.y });
      }
    }

    const viaFontSize = quantizeFontSize(4);

    for (const via of board.vias) {
      const { x, y } = via.position;

      // Find which layers have trace endpoints near this via
      const connected = new Set<number>();
      const endpoints = via.net ? traceEndpointsByNet.get(via.net) : null;
      if (endpoints) {
        for (const ep of endpoints) {
          const dx = ep.x - x, dy = ep.y - y;
          if (dx * dx + dy * dy < VIA_MATCH_R2) {
            connected.add(ep.layer);
          }
        }
      }
      const sorted = [...connected].sort((a, b) => a - b);
      viaConnectedLayers.push(sorted);

      // Pad ring sized to the via's real diameter, with a small visibility floor.
      const outerR = Math.max(VIA_MIN_OUTER_R, via.diameter / 2);
      const innerR = Math.max(0.5, outerR * VIA_DRILL_RATIO);

      viaGfx.circle(x, y, outerR);
      viaCenterGfx.circle(x, y, innerR);

      // Layer connectivity label — only show for vias with 2+ resolved layers
      if (layerShortNames.length > 0 && sorted.length >= 2) {
        const from = layerShortNames[sorted[0]] ?? '?';
        const to = layerShortNames[sorted[sorted.length - 1]] ?? '?';
        const labelStr = `${from}-${to}`;

        const label = new BitmapText({
          text: labelStr,
          style: { fontSize: viaFontSize, fill: 0xffcc44, fontFamily: ensurePinFont(viaFontSize) },
        });
        label.anchor.set(0.5, 0);
        label.x = x;
        label.y = y + outerR + 1;
        viaLayer.addChild(label);
        viaLabels.push(label);
      }
    }

    viaGfx.stroke({ width: 1.5, color: VIA_COLOR, alpha: 0.7 });
    viaCenterGfx.fill({ color: VIA_HOLE_COLOR, alpha: 0.9 });
    viaLayer.addChild(viaGfx);
    viaLayer.addChild(viaCenterGfx);
    root.addChild(viaLayer);
  }

  return { root, outlineGfx, topLayer, bottomLayer, topFillLayer, bottomFillLayer, topPinLayer, bottomPinLayer, topOutlineLayer, bottomOutlineLayer, topLabelLayer, bottomLabelLayer, labels, topLabels, bottomLabels, topPinLabels, bottomPinLabels, pinLabelsByPartIndex, borderBatches, fontSizeGroups, topPinGfx, bottomPinGfx, topCircleLabelLayer, bottomCircleLabelLayer, topTwoPinNetLayer, bottomTwoPinNetLayer, circleFontSizeGroups, twoPinFontSizeGroups, partLabelByIndex, pinRadiusClamp, twoPinPadPolys, traceLayer, traceLayerContainers, silkscreenLayer, silkscreenTop, silkscreenBottom, padsLayer, padsTop, padsBottom, copperDropsLayer, copperDropsTop, copperDropsBottom, viaLayer, viaLabels, viaConnectedLayers };
}
