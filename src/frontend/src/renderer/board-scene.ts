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
 */
import { Graphics, Container, BitmapText, BitmapFont, Rectangle } from 'pixi.js';
import type { BoardData } from '../parsers';
import { pinDisplayId } from '../parsers/types';
import {
  getLabelFontSize,
  computePinRadius,
  computeEffectiveBounds,
  computeDiagonalOBB,
  resolvePinColor,
  quantizeFontSize,
} from '../store/render-settings';
import type { RenderSettings } from '../store/render-settings';

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

export interface BoardSceneGraph {
  root:        Container;
  outlineGfx:  Graphics;
  topLayer:    Container;
  bottomLayer: Container;
  labels:      BitmapText[];
  topLabels:   BitmapText[];
  bottomLabels: BitmapText[];
  /** Pin number labels, tracked for zoom-based LoD */
  topPinLabels:    BitmapText[];
  bottomPinLabels: BitmapText[];
  /** Batched border Graphics per layer — rebuilt on zoom with minimum-width enforcement */
  borderBatches: BorderBatch[];
  /** Labels grouped by font-size bucket for efficient LoD visibility */
  fontSizeGroups: FontSizeGroup[];
  /** Global pin Graphics keyed by color — one per unique color per layer.
   *  Exposed for future incremental updates (e.g. re-coloring a net without full rebuild). */
  topPinGfx:    Map<number, Graphics>;
  bottomPinGfx: Map<number, Graphics>;
  /** Flat containers holding only pin number + net name labels.
   *  Toggling .visible hides/shows them in O(1) during zoom. Part name labels stay in partContainers. */
  topPinLabelsLayer:    Container;
  bottomPinLabelsLayer: Container;
}

/** PCB character set — covers part names, pin numbers, net names, and common accented chars */
const PCB_CHARS = ' ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-./+#()[]{}:;,<>!@$%^&*=~|\\?\'"ÄÖÜäöüß';

/** Resolution for pre-installed shadow BitmapFonts (higher = sharper at deep zoom, larger atlas) */
const SHADOW_FONT_RESOLUTION = 4;

/** Track which shadow fonts have been installed to avoid re-installing */
const installedShadowFonts = new Set<string>();

/** Uninstall all shadow BitmapFonts and free their GPU atlas textures */
export function cleanupShadowFonts(): void {
  for (const name of installedShadowFonts) {
    try { BitmapFont.uninstall(name); } catch { /* already removed */ }
  }
  installedShadowFonts.clear();
}

/** Install a BitmapFont for part labels with baked drop shadow at a specific quantized size */
function ensureShadowFont(fontSize: number): string {
  const name = `board-shadow-${fontSize}`;
  if (!installedShadowFonts.has(name)) {
    try {
      BitmapFont.install({
        name,
        style: {
          fontFamily: LABEL_FONT_FAMILY,
          fontSize,
          fill: 0xffffff,
          dropShadow: { color: 0x000000, alpha: 0.7, blur: fontSize * 0.6, distance: 0 },
        },
        chars: PCB_CHARS,
        resolution: SHADOW_FONT_RESOLUTION,
      });
      installedShadowFonts.add(name);
    } catch {
      return LABEL_FONT_FAMILY;
    }
  }
  return name;
}

/** Draw the board outline path into a Graphics object.
 *  Points with NaN coords act as sub-path separators — closePath + moveTo.
 *  Duplicate consecutive points are skipped to keep the polygon clean.
 */
export function drawOutline(gfx: Graphics, board: BoardData, s: RenderSettings): void {
  // Filter to valid, deduplicated points; NaN → sub-path break
  const pts = board.outline;
  if (pts.length <= 1) return;

  let penDown = false;
  let prevX = NaN, prevY = NaN;
  for (const pt of pts) {
    if (isNaN(pt.x) || isNaN(pt.y)) {
      if (penDown) { gfx.closePath(); penDown = false; prevX = prevY = NaN; }
      continue;
    }
    // Skip duplicate consecutive points
    if (pt.x === prevX && pt.y === prevY) continue;
    if (!penDown) { gfx.moveTo(pt.x, pt.y); penDown = true; }
    else gfx.lineTo(pt.x, pt.y);
    prevX = pt.x; prevY = pt.y;
  }
  if (penDown) gfx.closePath();

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
  const root        = new Container();
  const outlineGfx  = new Graphics();
  const bottomLayer = new Container();
  const topLayer    = new Container();
  const labels: BitmapText[] = [];
  const topLabels: BitmapText[] = [];
  const bottomLabels: BitmapText[] = [];
  const topPinLabels: BitmapText[] = [];
  const bottomPinLabels: BitmapText[] = [];
  // Flat containers for pin number + net name labels only.
  // Toggling .visible hides them in O(1) during zoom; part name labels stay in partContainers.
  const topPinLabelsLayer    = new Container();
  const bottomPinLabelsLayer = new Container();
  // Batched border Graphics — one per (layer, color), rebuilt on zoom
  const topBorderBatch: BorderBatch    = { gfx: new Graphics(), rects: [], color: BOARD_COLORS.partBoundsTop,    alpha: s.partBorderAlpha, lastWidth: s.partBorderWidth };
  const bottomBorderBatch: BorderBatch = { gfx: new Graphics(), rects: [], color: BOARD_COLORS.partBoundsBottom, alpha: s.partBorderAlpha, lastWidth: s.partBorderWidth };

  // Skip event system traversal for all board objects — events are handled
  // manually via viewport hit-testing, so PixiJS doesn't need to walk the tree.
  root.interactiveChildren = false;

  root.addChild(outlineGfx);
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
        cells[cy][cx] = { pinGfx: new Map(), triGfx: null, container };
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

  // Parts
  for (let pi = 0; pi < board.parts.length; pi++) {
    const part = board.parts[pi];

    const partContainer = new Container();
    partContainer.cullable = true;
    partContainer.label   = part.name;

    const isTwoPinPart = part.pins.length === 2;
    const isMultiPin   = part.pins.length > 2;
    const isBottom     = part.side === 'bottom';
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);

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
    // Collect text labels to add to partContainer after all graphics for z-order.
    const deferredTexts: BitmapText[] = [];
    // Track pad rectangles for 2-pin net labels (indexed by pin index)
    const padRects: { rx: number; ry: number; rw: number; rh: number }[] = [];

    // Pre-compute pad depth for 2-pin parts (used in pin loop and border drawing)
    const padDepth = isTwoPinPart
      ? (eb.horiz ? Math.min(eb.ph, eb.pw * 0.4) : Math.min(eb.pw, eb.ph * 0.4))
      : 0;

    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin    = part.pins[pni];
      const isPin1 = pni === 0 && isMultiPin;
      const color = isPin1 ? BOARD_COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);

      if (isTwoPinPart) {
        let padRx: number, padRy: number, padRw: number, padRh: number;
        if (eb.horiz) {
          padRx = pin.position.x - padDepth / 2;
          padRy = eb.py; padRw = padDepth; padRh = eb.ph;
        } else {
          padRx = eb.px; padRy = pin.position.y - padDepth / 2;
          padRw = eb.pw; padRh = padDepth;
        }
        const pinGfx = getGridPinGfx(isBottom, color, padRx + padRw / 2, padRy + padRh / 2);
        pinGfx.rect(padRx, padRy, padRw, padRh);
        padRects[pni] = { rx: padRx, ry: padRy, rw: padRw, rh: padRh };
      } else {
        const r = computePinRadius(s, pin.radius);
        const pinGfx = getGridPinGfx(isBottom, color, pin.position.x, pin.position.y);
        pinGfx.circle(pin.position.x, pin.position.y, r);
      }

      // ── Pin number label (multi-pin only, not 1-pin or 2-pin) ─────────
      if (isMultiPin && s.showPinNumbers) {
        const r = computePinRadius(s, pin.radius);
        const numStr = pinDisplayId(pin, pni);
        const diameter = r * 2;
        let pinFontSize = (diameter * 0.7) / (Math.max(numStr.length, 3) * 0.6);
        pinFontSize = Math.min(pinFontSize, diameter * 0.8);
        pinFontSize = quantizeFontSize(pinFontSize);
        if (pinFontSize >= s.labelHideThreshold) {
          const pinLabel = new BitmapText({
            text: numStr,
            style: { fontSize: pinFontSize, fill: BOARD_COLORS.labelPin, fontFamily: LABEL_FONT_FAMILY },
          });
          pinLabel.anchor.set(0.5, 0.8);
          pinLabel.x = pin.position.x;
          pinLabel.y = pin.position.y;
          deferredTexts.push(pinLabel);
          (part.side === 'bottom' ? bottomPinLabels : topPinLabels).push(pinLabel);
        }
      }

      // ── Net name label on pin (skip GND — already color-coded) ─────
      if (pin.net && pin.net !== '(null)' && pin.net !== '' && !pin.net.toUpperCase().includes('GND')) {
        let netFontSize: number;
        let nx: number, ny: number;
        let anchorX = 0.5, anchorY = 0.5;

        if (isTwoPinPart) {
          const pad = padRects[pni];
          const fitW = pad.rw * 0.85;
          const fitH = pad.rh * 0.85;
          netFontSize = Math.min(fitW / (pin.net.length * 0.6), fitH * 0.8);
          nx = pad.rx + pad.rw / 2;
          ny = pad.ry + pad.rh / 2;
        } else {
          const r = computePinRadius(s, pin.radius);
          const diameter = r * 2;
          netFontSize = diameter * 0.85 / Math.max(pin.net.length * 0.6, 1);
          netFontSize = Math.min(netFontSize, diameter * 0.85);
          nx = pin.position.x;
          ny = pin.position.y;
          if (isMultiPin && s.showPinNumbers) {
            anchorY = 0.2;
          }
        }

        netFontSize = quantizeFontSize(netFontSize);
        if (netFontSize >= s.labelHideThreshold) {
          const netLabel = new BitmapText({
            text: pin.net,
            style: { fontSize: netFontSize, fill: BOARD_COLORS.labelNet, fontFamily: LABEL_FONT_FAMILY },
          });
          netLabel.anchor.set(anchorX, anchorY);
          netLabel.x = nx;
          netLabel.y = ny;
          deferredTexts.push(netLabel);
          (part.side === 'bottom' ? bottomPinLabels : topPinLabels).push(netLabel);
        }
      }
    }

    // ── Pin 1 triangle marker (multi-pin only) ──────────────────────────
    // Accumulated into the grid cell's triangle Graphics (by layer).
    if (isMultiPin && part.pins.length > 0) {
      const pin = part.pins[0];
      const r = computePinRadius(s, pin.radius);
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

    // ── Part border (accumulated into batched border Graphics) ──────────────
    if (part.pins.length > 1) {
      let borderRect: BorderRect;
      if (isTwoPinPart) {
        // Expand border to encompass pads centered on pin vertices
        const bx = eb.horiz ? eb.px - padDepth / 2 : eb.px;
        const by = eb.horiz ? eb.py : eb.py - padDepth / 2;
        const bw = eb.horiz ? eb.pw + padDepth : eb.pw;
        const bh = eb.horiz ? eb.ph : eb.ph + padDepth;
        borderRect = { x: bx, y: by, w: bw, h: bh };
      } else {
        const obb = computeDiagonalOBB(part.pins, s);
        borderRect = obb
          ? { x: eb.px, y: eb.py, w: eb.pw, h: eb.ph, poly: obb }
          : { x: eb.px, y: eb.py, w: eb.pw, h: eb.ph };
      }
      (isBottom ? bottomBorderBatch : topBorderBatch).rects.push(borderRect);
    }

    // ── Label (last = always on top within the part) ────────────────────────
    if (s.showPartLabels) {
      let fontSize: number;
      if (isTwoPinPart) {
        // Scale to center-body area (between the two pads) for large parts;
        // floor at settings font size so tiny parts always have a readable label.
        const centerW = eb.horiz ? eb.pw - 2 * padDepth : eb.pw;
        const centerH = eb.horiz ? eb.ph : eb.ph - 2 * padDepth;
        const fromCenter = Math.min(centerW * 0.85 / (part.name.length * 0.6), centerH * 0.85);
        fontSize = Math.max(getLabelFontSize(s), fromCenter);
      } else {
        const targetW = eb.pw * 0.7;
        fontSize = targetW / (part.name.length * 0.6);
        fontSize = Math.max(getLabelFontSize(s), Math.min(fontSize, eb.ph * 0.8));
      }
      fontSize = quantizeFontSize(fontSize);
      if (fontSize >= s.labelHideThreshold) {
        const useShadowFont = s.partLabelShadow;
        const fontFamily = useShadowFont ? ensureShadowFont(fontSize) : LABEL_FONT_FAMILY;
        const label = new BitmapText({
          text:  part.name,
          style: { fontSize, fill: BOARD_COLORS.labelPart, fontFamily },
        });
        label.anchor.set(0.5, 0.5);
        label.x = eb.px + eb.pw / 2;
        label.y = eb.py + eb.ph / 2;
        partContainer.addChild(label);
        labels.push(label);
        (isBottom ? bottomLabels : topLabels).push(label);
      }
    }

    // ── Deferred text (pin numbers + net names) — flat layer for O(1) zoom-hide ──
    const pinLayer = isBottom ? bottomPinLabelsLayer : topPinLabelsLayer;
    for (const txt of deferredTexts) {
      pinLayer.addChild(txt);
    }

    partQueue.push({ container: partContainer, isBottom });
  }

  // ── Flush grid cells ─────────────────────────────────────────────────────
  // Each grid cell container holds color-batched pin Graphics + triangle Graphics.
  // fill() finalizes accumulated paths; empty cells are skipped entirely.
  // Cells are added BEFORE partContainers so borders/labels render on top.
  const topPinGfx    = new Map<number, Graphics>();
  const bottomPinGfx = new Map<number, Graphics>();

  for (const [grid, layer, flatMap] of [
    [topGrid, topLayer, topPinGfx],
    [bottomGrid, bottomLayer, bottomPinGfx],
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

  // Flush batched border Graphics — initial draw, will be rebuilt on zoom
  const borderBatches: BorderBatch[] = [];
  for (const [batch, layer] of [[topBorderBatch, topLayer], [bottomBorderBatch, bottomLayer]] as [BorderBatch, Container][]) {
    if (batch.rects.length === 0) continue;
    for (const r of batch.rects) batch.gfx.rect(r.x, r.y, r.w, r.h);
    batch.gfx.stroke({ width: s.partBorderWidth, color: batch.color, alpha: batch.alpha });
    layer.addChild(batch.gfx);
    borderBatches.push(batch);
  }

  // Add part containers above pins, triangles, and borders
  for (const { container, isBottom } of partQueue) {
    (isBottom ? bottomLayer : topLayer).addChild(container);
  }

  // Pin label layers sit on top — toggling visible hides pin/net labels in O(1) during zoom
  topLayer.addChild(topPinLabelsLayer);
  bottomLayer.addChild(bottomPinLabelsLayer);

  // Build font-size groups: bucket all labels by floor(log2(fontSize)).
  // This gives ~5-6 groups, enabling O(groups) visibility checks instead of O(labels).
  const bucketMap = new Map<number, BitmapText[]>();
  const allLabelArrays = [topLabels, bottomLabels, topPinLabels, bottomPinLabels];
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

  // ── Debug: pad vertex crosshairs ─────────────────────────────────────────
  const padVertexGfx = new Graphics();
  if (s.showPadVertices) {
    const ARM = 6; // crosshair arm length in mils
    padVertexGfx.setStrokeStyle({ width: 1.5, color: 0xff00ff });
    for (const part of board.parts) {
      for (const pin of part.pins) {
        const { x, y } = pin.position;
        padVertexGfx.moveTo(x - ARM, y).lineTo(x + ARM, y);
        padVertexGfx.moveTo(x, y - ARM).lineTo(x, y + ARM);
      }
    }
    padVertexGfx.stroke();
  }
  root.addChild(padVertexGfx);

  return { root, outlineGfx, topLayer, bottomLayer, labels, topLabels, bottomLabels, topPinLabels, bottomPinLabels, borderBatches, fontSizeGroups, topPinGfx, bottomPinGfx, topPinLabelsLayer, bottomPinLabelsLayer };
}
