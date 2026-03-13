/**
 * Shared scene-building logic for both the main BoardRenderer and SettingsMockup.
 * Any visual change made here is automatically reflected in both places.
 *
 * All text uses BitmapText with shared glyph atlases for dramatically lower
 * GPU memory and draw calls compared to per-label canvas Text objects.
 *
 * Pin drawing uses board-wide color batching: all pins of the same color share
 * a single Graphics object, reducing GPU draw-call submissions from O(parts × colors)
 * to O(unique colors) — typically ~10 instead of ~15,000 on a real board.
 */
import { Graphics, Container, BitmapText, BitmapFont } from 'pixi.js';
import type { BoardData } from '../parsers';
import {
  getLabelFontSize,
  computePinRadius,
  computeEffectiveBounds,
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

/** Info needed to dynamically redraw a part border at different widths */
export interface BorderEntry {
  gfx: Graphics;
  x: number; y: number; w: number; h: number;
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
  /** Part border Graphics entries for dynamic min-width updates */
  borderEntries: BorderEntry[];
  /** Labels grouped by font-size bucket for efficient LoD visibility */
  fontSizeGroups: FontSizeGroup[];
  /** Global pin Graphics keyed by color — one per unique color per layer.
   *  Exposed for future incremental updates (e.g. re-coloring a net without full rebuild). */
  topPinGfx:    Map<number, Graphics>;
  bottomPinGfx: Map<number, Graphics>;
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

/** Draw the board outline path into a Graphics object */
export function drawOutline(gfx: Graphics, board: BoardData, s: RenderSettings): void {
  if (board.outline.length <= 1) return;
  gfx.moveTo(board.outline[0].x, board.outline[0].y);
  for (let i = 1; i < board.outline.length; i++) {
    gfx.lineTo(board.outline[i].x, board.outline[i].y);
  }
  gfx.closePath();
  if (s.boardFillAlpha > 0) {
    gfx.fill({ color: 0xffffff, alpha: s.boardFillAlpha });
  }
  gfx.stroke({ width: s.outlineWidth, color: BOARD_COLORS.outline, alpha: s.outlineAlpha });
}

/** Redraw all border entries with an effective minimum width */
export function updateBorderWidths(entries: BorderEntry[], configuredWidth: number, viewportScale: number): void {
  const minScreenPx = 1;
  const effectiveWidth = Math.max(configuredWidth, minScreenPx / viewportScale);

  // All borders share the same effective width — check the first entry to skip redundant redraws.
  // Use a relative tolerance so minor floating-point drift doesn't trigger full redraws.
  if (entries.length > 0 && Math.abs(effectiveWidth - entries[0].lastWidth) / Math.max(effectiveWidth, 0.001) < 0.02) {
    return;
  }

  for (const e of entries) {
    e.lastWidth = effectiveWidth;
    e.gfx.clear();
    e.gfx.rect(e.x, e.y, e.w, e.h);
    e.gfx.stroke({ width: effectiveWidth, color: e.color, alpha: e.alpha });
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
  const borderEntries: BorderEntry[] = [];

  // Skip event system traversal for all board objects — events are handled
  // manually via viewport hit-testing, so PixiJS doesn't need to walk the tree.
  root.interactiveChildren = false;

  root.addChild(outlineGfx);
  root.addChild(bottomLayer);
  root.addChild(topLayer);

  drawOutline(outlineGfx, board, s);

  // ── Global pin batching ──────────────────────────────────────────────────────
  // One Graphics per (layer, color) for the entire board.
  // All pin shapes are accumulated first; fill() is called once per Graphics after
  // the loop — O(unique colors) draw calls instead of O(parts × colors).
  const topPinGfx    = new Map<number, Graphics>();
  const bottomPinGfx = new Map<number, Graphics>();
  const getGlobalPinGfx = (isBottom: boolean, color: number): Graphics => {
    const map = isBottom ? bottomPinGfx : topPinGfx;
    let gfx = map.get(color);
    if (!gfx) { gfx = new Graphics(); map.set(color, gfx); }
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

    // ── Pins ─────────────────────────────────────────────────────────────────
    // Shapes are drawn directly into the board-wide global pin Graphics (by color).
    // Collect text labels to add to partContainer after all graphics for z-order.
    const deferredTexts: BitmapText[] = [];
    // Track pad rectangles for 2-pin net labels (indexed by pin index)
    const padRects: { rx: number; ry: number; rw: number; rh: number }[] = [];

    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin    = part.pins[pni];
      const isPin1 = pni === 0 && isMultiPin;
      const color  = isPin1 ? BOARD_COLORS.pin1 : resolvePinColor(s, pin.net, pin.side);
      const pinGfx = getGlobalPinGfx(isBottom, color);

      if (isTwoPinPart) {
        const other = part.pins[1 - pni];
        let padRx: number, padRy: number, padRw: number, padRh: number;
        if (eb.horiz) {
          const depth = Math.min(eb.ph, eb.pw * 0.4);
          const left  = pin.position.x < other.position.x;
          padRx = left ? eb.px : eb.px + eb.pw - depth;
          padRy = eb.py; padRw = depth; padRh = eb.ph;
        } else {
          const depth = Math.min(eb.pw, eb.ph * 0.4);
          const top   = pin.position.y < other.position.y;
          padRx = eb.px; padRy = top ? eb.py : eb.py + eb.ph - depth;
          padRw = eb.pw; padRh = depth;
        }
        pinGfx.rect(padRx, padRy, padRw, padRh);
        padRects[pni] = { rx: padRx, ry: padRy, rw: padRw, rh: padRh };
      } else {
        const r = computePinRadius(s, pin.radius);
        pinGfx.circle(pin.position.x, pin.position.y, r);
      }

      // ── Pin number label (multi-pin only, not 1-pin or 2-pin) ─────────
      if (isMultiPin && s.showPinNumbers) {
        const r = computePinRadius(s, pin.radius);
        const numStr = pin.number || String(pni + 1);
        const diameter = r * 2;
        let pinFontSize = (diameter * 0.7) / (Math.max(numStr.length, 3) * 0.6);
        pinFontSize = Math.min(pinFontSize, diameter * 0.8);
        pinFontSize = quantizeFontSize(pinFontSize);
        if (pinFontSize >= 2) {
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
        if (netFontSize >= 2) {
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
    if (isMultiPin && part.pins.length > 0) {
      const pin = part.pins[0];
      const r = computePinRadius(s, pin.radius);
      const triSize = r * 0.7;
      const triGfx = new Graphics();
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
      triGfx.fill({ color: BOARD_COLORS.pin1, alpha: 0.9 });
      partContainer.addChild(triGfx);
    }

    // ── Part border (after pins, before label) ──────────────────────────────
    if (part.pins.length > 1) {
      const boundsGfx = new Graphics();
      const borderColor = part.side === 'bottom' ? BOARD_COLORS.partBoundsBottom : BOARD_COLORS.partBoundsTop;
      boundsGfx.rect(eb.px, eb.py, eb.pw, eb.ph);
      boundsGfx.stroke({
        width: s.partBorderWidth,
        color: borderColor,
        alpha: s.partBorderAlpha,
      });
      partContainer.addChild(boundsGfx);
      borderEntries.push({ gfx: boundsGfx, x: eb.px, y: eb.py, w: eb.pw, h: eb.ph, color: borderColor, alpha: s.partBorderAlpha, lastWidth: s.partBorderWidth });
    }

    // ── Label (last = always on top within the part) ────────────────────────
    if (s.showPartLabels) {
      let fontSize: number;
      if (isTwoPinPart) {
        fontSize = getLabelFontSize(s);
      } else {
        const bh      = eb.maxY - eb.minY;
        const targetW = eb.pw * 0.7;
        fontSize = targetW / (part.name.length * 0.6);
        fontSize = Math.max(2, Math.min(fontSize, bh * 0.8));
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
        (part.side === 'bottom' ? bottomLabels : topLabels).push(label);
      }
    }

    // ── Deferred text (pin numbers + net names) — added last for z-order ──
    for (const txt of deferredTexts) {
      partContainer.addChild(txt);
    }

    partQueue.push({ container: partContainer, isBottom });
  }

  // ── Flush global pin Graphics ─────────────────────────────────────────────
  // Each Graphics has accumulated all shapes of one color; a single fill() call
  // submits them as one GPU draw — then add to the layer BEFORE partContainers
  // so borders, triangles, and labels render on top.
  for (const [color, gfx] of topPinGfx)    { gfx.fill({ color, alpha: s.pinAlpha }); topLayer.addChild(gfx); }
  for (const [color, gfx] of bottomPinGfx) { gfx.fill({ color, alpha: s.pinAlpha }); bottomLayer.addChild(gfx); }

  // Add part containers (borders + triangle markers + labels) above pins
  for (const { container, isBottom } of partQueue) {
    (isBottom ? bottomLayer : topLayer).addChild(container);
  }

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

  return { root, outlineGfx, topLayer, bottomLayer, labels, topLabels, bottomLabels, topPinLabels, bottomPinLabels, borderEntries, fontSizeGroups, topPinGfx, bottomPinGfx };
}
