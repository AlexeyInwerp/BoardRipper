/**
 * Shared scene-building logic for both the main BoardRenderer and SettingsMockup.
 * Any visual change made here is automatically reflected in both places.
 */
import { Graphics, Container, Text, TextStyle } from 'pixi.js';
import type { BoardData } from '../parsers';
import {
  getLabelFontSize,
  computePinRadius,
  computeEffectiveBounds,
  resolvePinColor,
} from '../store/render-settings';
import type { RenderSettings } from '../store/render-settings';

export const BOARD_COLORS = {
  background:        0x1a1a2e,
  outline:           0x4a9eff,
  partBoundsTop:     0x336633,
  partBoundsBottom:  0x663333,
  partSelected:      0xffaa00,
  netHighlight:      0xffff44,
} as const;

export interface BoardSceneGraph {
  root:        Container;
  outlineGfx:  Graphics;
  topLayer:    Container;
  bottomLayer: Container;
  labels:      Text[];
  topLabels:   Text[];
  bottomLabels: Text[];
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

/**
 * Build a PixiJS scene graph for a board.
 * Pure function — no side effects on any store.
 */
export function buildBoardScene(board: BoardData, s: RenderSettings): BoardSceneGraph {
  const root        = new Container();
  const outlineGfx  = new Graphics();
  const bottomLayer = new Container();
  const topLayer    = new Container();
  const labels: Text[] = [];
  const topLabels: Text[] = [];
  const bottomLabels: Text[] = [];

  bottomLayer.cullable = true;
  topLayer.cullable    = true;

  root.addChild(outlineGfx);
  root.addChild(bottomLayer);
  root.addChild(topLayer);

  drawOutline(outlineGfx, board, s);

  // Parts
  for (let pi = 0; pi < board.parts.length; pi++) {
    const part = board.parts[pi];
    const layer = part.side === 'bottom' ? bottomLayer : topLayer;

    const partContainer = new Container();
    partContainer.cullable = true;
    partContainer.label   = part.name;

    const isTwoPinPart = part.pins.length === 2;
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);

    // ── Pins (drawn first) ──────────────────────────────────────────────────
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin    = part.pins[pni];
      const pinGfx = new Graphics();
      const color  = resolvePinColor(s, pin.net, pin.side);

      if (isTwoPinPart) {
        const other = part.pins[1 - pni];
        if (eb.horiz) {
          const depth = Math.min(eb.ph, eb.pw * 0.4);
          const left  = pin.position.x < other.position.x;
          if (left) pinGfx.rect(eb.px, eb.py, depth, eb.ph);
          else      pinGfx.rect(eb.px + eb.pw - depth, eb.py, depth, eb.ph);
        } else {
          const depth = Math.min(eb.pw, eb.ph * 0.4);
          const top   = pin.position.y < other.position.y;
          if (top) pinGfx.rect(eb.px, eb.py, eb.pw, depth);
          else     pinGfx.rect(eb.px, eb.py + eb.ph - depth, eb.pw, depth);
        }
      } else {
        const r = computePinRadius(s, pin.radius);
        pinGfx.circle(pin.position.x, pin.position.y, r);
      }

      pinGfx.fill({ color, alpha: s.pinAlpha });
      pinGfx.cullable = true;
      partContainer.addChild(pinGfx);
    }

    // ── Part border (after pins, before label) ──────────────────────────────
    if (part.pins.length > 1) {
      const boundsGfx = new Graphics();
      boundsGfx.rect(eb.px, eb.py, eb.pw, eb.ph);
      boundsGfx.stroke({
        width: s.partBorderWidth,
        color: part.side === 'bottom' ? BOARD_COLORS.partBoundsBottom : BOARD_COLORS.partBoundsTop,
        alpha: s.partBorderAlpha,
      });
      partContainer.addChild(boundsGfx);
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
      if (fontSize >= s.labelHideThreshold) {
        const label = new Text({
          text:  part.name,
          style: new TextStyle({ fontSize, fill: 0xcccccc, fontFamily: 'monospace' }),
          resolution: 4,
        });
        label.anchor.set(0.5, 0.5);
        label.x = eb.px + eb.pw / 2;
        label.y = eb.py + eb.ph / 2;
        label.cullable = true;
        partContainer.addChild(label);
        labels.push(label);
        (part.side === 'bottom' ? bottomLabels : topLabels).push(label);
      }
    }

    layer.addChild(partContainer);
  }

  return { root, outlineGfx, topLayer, bottomLayer, labels, topLabels, bottomLabels };
}
