/** Canvas2D board-text overlay — draws only on-screen, LoD-passing labels
 *  each redraw instead of keeping ~100k BitmapText nodes in the Pixi scene.
 *  Pure selection logic is exported for unit tests; the class owns the
 *  canvas. Text draws upright in screen space (counter-flip machinery not
 *  needed); positions transform through the per-side label-layer world
 *  matrices so rotate/mirror/butterfly work unchanged. */
import type { LabelModel, LabelRecord } from './label-model';
import { log } from '../store/log-store';
import { resizeModeStore } from '../store/resize-mode-store';

export interface OverlayViewState {
  topMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  bottomMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  scale: number;
  width: number; height: number;
  showTop: boolean; showBottom: boolean;
  selectedPartIndex: number | null;
  /** Selected pin within the selected part (board-store selection.pinIndex). */
  selectedPinIndex?: number | null;
  /** Pin under the pointer, on any part — its labels get the full floor too. */
  hoverPartIndex?: number | null;
  hoverPinIndex?: number | null;
  dimActive: boolean;
  litParts: ReadonlySet<number> | null;
}
export interface OverlayThresholds {
  labelMinScreenPx: number;
  /** Net names on IC/BGA pins appear at this many screen px. */
  circleLabelMinScreenPx: number;
  /** Pin numbers appear at this many screen px — lower than the net names:
   *  a number sits inside its pin and cannot overlap, so it can stay through
   *  more of the unzoom. Falls back to circleLabelMinScreenPx when unset. */
  pinNumberMinScreenPx?: number;
  twoPinLabelMinScreenPx: number;
  labelZoomHide: number;
  /** Floor (screen px) for the selected part's labels — they stay readable
   *  while unzooming ("grow" relative to the shrinking part, which users
   *  liked). 0 = no floor, scale naturally. User-adjustable: Settings ▸
   *  Zoom Level of Detail ▸ Selected Part Labels. */
  selectedLabelMinPx: number;
  /** LoD relax multiplier for the selected part's labels (see render-settings
   *  `selectedLabelLodRelax`). Lower = selected labels appear at lower zoom. */
  selectedLabelLodRelax: number;
  /** Fraction of `selectedLabelMinPx` the selected part's OTHER pin labels get
   *  (default 0.8). Only the selected pin and the hovered pin — and the part
   *  name — get the full floor; every pin of a dense part at 11 px overlapped
   *  its neighbours. */
  selectedLabelOtherScale?: number;
  /** Cap every pin label of a multi-pin part at the size that fits between
   *  its pin centres (`labelFitToPitch`, default on). Labels that would have
   *  to shrink below their appear-floor to fit are hidden instead. */
  fitToPitch?: boolean;
}

const OFFSCREEN_MARGIN = 40;      // px — keep labels whose center is just off-edge
const DIM_ALPHA = 0.22;           // parity-tuned vs netDimGfx look in Task 9
/** Selected-part pin/net labels get a RELAXED LoD (default 0.75× the normal
 *  min-px, via `selectedLabelLodRelax`) rather than a full bypass: slightly
 *  sticky through unzoom, but they disappear close to the normal cutoff (user
 *  feedback 2026-07-19 — net names must not survive unzooming, and 0.5 kept
 *  them too long). The part NAME label alone keeps the full bypass as the
 *  selection identity marker (parity with the Pixi elevated badge). */
/** Component (part) names fade out as they grow oversized on screen — i.e. as
 *  you zoom into a big part — so the net names underneath (drawn earlier) and
 *  the pins below the overlay show through, instead of the huge designator
 *  blanketing a BGA. Purely a draw-time alpha; net names are unaffected. */
const PART_FADE_START = 80;    // px on-screen — name begins to recede (earlier)
const PART_FADE_END = 240;     // px — name reaches PART_FADE_MIN (a faint ghost)
const PART_FADE_MIN = 0.14;
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function partNameFade(onScreenPx: number): number {
  return 1 - smoothstep(PART_FADE_START, PART_FADE_END, onScreenPx) * (1 - PART_FADE_MIN);
}

function minPxFor(kind: LabelRecord['kind'], th: OverlayThresholds): number {
  switch (kind) {
    case 'circleNum': return th.pinNumberMinScreenPx ?? th.circleLabelMinScreenPx;
    case 'circleNet': return th.circleLabelMinScreenPx;
    case 'twoPinNet': return th.twoPinLabelMinScreenPx;
    default: return th.labelMinScreenPx;
  }
}

/** Screen-px floor for a label drawn in the selected pass. The part name and
 *  the focused pin (selected or hovered) get the full `selectedLabelMinPx`;
 *  every other label of the selected part gets `selectedLabelOtherScale` of
 *  it, so a dense part's pin names stop overlapping while the one you point
 *  at is still the big one. 0 when the floor is off. */
export function selectedFloorPx(kind: LabelRecord['kind'], isFocusPin: boolean, th: OverlayThresholds): number {
  if (th.selectedLabelMinPx <= 0) return 0;
  const full = isFocusPin || kind === 'part';
  return th.selectedLabelMinPx * (full ? 1 : (th.selectedLabelOtherScale ?? 0.8));
}

/** The largest screen-px font at which this label still fits between its
 *  part's pin centres: width `chars × 0.6 × px ≤ 0.9 × pitch`, height
 *  `px ≤ 0.9 × pitch` (0.45 × pitch when a number and a name are stacked on
 *  the pin — two labels share the pitch). Infinity when the record carries no pitch. This is the whole
 *  overlap test — per label, one multiply, no pairwise comparison: on a grid
 *  of pins, "fits between centres" is exactly "cannot overlap a neighbour". */
export function pitchCapPx(r: LabelRecord, scale: number): number {
  if (!r.pitch) return Infinity;
  const pitchPx = r.pitch * scale;
  const width = (pitchPx * 0.9) / (Math.max(r.text.length, 3) * 0.6);
  const height = pitchPx * (r.stacked ? 0.45 : 0.9);
  return Math.min(width, height);
}

/** Where a pin number sits at this zoom: centred in its pin while the pin's
 *  net name is below its appear-floor (nothing to make room for), shifted
 *  above/below once the name shows. Mirrors the net label's own visibility
 *  rule so the two never disagree. */
export function pinNumberPlacement(
  r: LabelRecord, view: OverlayViewState, th: OverlayThresholds, selected: boolean,
): { x: number; y: number; anchorY: number } {
  if (r.alt && r.pairFontSize) {
    const zoomHidden = th.labelZoomHide > 0 && view.scale < th.labelZoomHide;
    const min = th.circleLabelMinScreenPx * (selected ? th.selectedLabelLodRelax : 1);
    const netVisible = !zoomHidden && r.pairFontSize * view.scale >= min;
    if (!netVisible) return r.alt;
  }
  return { x: r.x, y: r.y, anchorY: r.anchorY };
}

export function selectVisibleLabels(
  records: readonly LabelRecord[],
  m: OverlayViewState['topMatrix'],
  view: OverlayViewState,
  th: OverlayThresholds,
): LabelRecord[] {
  const out: LabelRecord[] = [];
  const zoomHidden = th.labelZoomHide > 0 && view.scale < th.labelZoomHide;
  for (const r of records) {
    const selected = view.selectedPartIndex !== null && r.partIndex === view.selectedPartIndex;
    const keepAlways = selected && r.kind === 'part';   // selection identity marker
    if (!keepAlways) {
      if (zoomHidden) continue;
      const min = minPxFor(r.kind, th) * (selected ? th.selectedLabelLodRelax : 1);
      if (r.fontSize * view.scale < min) continue;
    }
    const sx = m.a * r.x + m.c * r.y + m.tx;
    const sy = m.b * r.x + m.d * r.y + m.ty;
    if (sx < -OFFSCREEN_MARGIN || sx > view.width + OFFSCREEN_MARGIN ||
        sy < -OFFSCREEN_MARGIN || sy > view.height + OFFSCREEN_MARGIN) continue;
    out.push(r);
  }
  return out;
}

export class LabelOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private container: HTMLElement;
  private colorCache = new Map<number, string>();
  lastDrawMs = 0;
  lastCounts = { visible: 0, total: 0 };
  private lastSlowDrawLogAt = 0;
  /** Screen-space bounding boxes of every label painted in the last draw,
   *  in CSS px (same space as the renderer canvas). Consumed by hitTest()
   *  for Resize Mode's "did the click land on text?" classification. */
  private lastBoxes: Array<{ x0: number; y0: number; x1: number; y1: number; kind: LabelRecord['kind']; partIndex: number }> = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.canvas = document.createElement('canvas');
    const s = this.canvas.style;
    s.position = 'absolute';
    s.inset = '0';
    s.pointerEvents = 'none';
    s.zIndex = '2';
    s.transformOrigin = '0 0';
    container.appendChild(this.canvas);
    // NOT alpha:false — persistent canvas, per the PDF-canvas rules in CLAUDE.md.
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const bw = Math.max(1, Math.floor(w * dpr)), bh = Math.max(1, Math.floor(h * dpr));
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw; this.canvas.height = bh;
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private css(color: number): string {
    let s = this.colorCache.get(color);
    if (!s) { s = '#' + color.toString(16).padStart(6, '0'); this.colorCache.set(color, s); }
    return s;
  }

  clear(): void {
    this.ctx.clearRect(0, 0, this.container.clientWidth, this.container.clientHeight);
    this.lastCounts = { visible: 0, total: 0 };
  }

  setCssTransform(t: string): void { this.canvas.style.transform = t; }

  draw(model: LabelModel, view: OverlayViewState, th: OverlayThresholds): void {
    const t0 = performance.now();
    this.setCssTransform('');
    const ctx = this.ctx;
    ctx.clearRect(0, 0, view.width, view.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Only record hit-test boxes while Resize Mode is on — otherwise this is a
    // per-visible-label allocation on the (normally allocation-free) draw hot
    // path that no one reads (boxes are consumed only on a Resize Mode click).
    const recordBoxes = resizeModeStore.enabled;
    this.lastBoxes.length = 0;

    // Cull ONCE per side, then iterate the three paint passes over the
    // pre-culled arrays (painter's order: dimmed → lit → selected-on-top).
    const sides: Array<[LabelRecord[], OverlayViewState['topMatrix']]> = [];
    if (view.showTop) sides.push([selectVisibleLabels(model.top, view.topMatrix, view, th), view.topMatrix]);
    if (view.showBottom) sides.push([selectVisibleLabels(model.bottom, view.bottomMatrix, view, th), view.bottomMatrix]);
    let visible = 0;
    for (const pass of ['dim', 'lit', 'selected'] as const) {
      for (const [vis, m] of sides) {
        let lastFontPx = -1;
        for (const r of vis) {
          const isSel = view.selectedPartIndex !== null && r.partIndex === view.selectedPartIndex;
          // The pin being pointed at: the selected pin, or the hovered pin on
          // any part. Its labels take the full floor and paint on top.
          const isFocusPin = r.pinIndex !== undefined && r.pinIndex >= 0 && (
            (isSel && r.pinIndex === view.selectedPinIndex) ||
            (r.partIndex === view.hoverPartIndex && r.pinIndex === view.hoverPinIndex));
          const onTop = isSel || isFocusPin;
          const isLit = !view.dimActive || onTop || (view.litParts?.has(r.partIndex) ?? false);
          const want = pass === 'selected' ? onTop : pass === 'lit' ? (isLit && !onTop) : !isLit;
          if (!want) continue;
          visible += 1;
          let px = r.fontSize * view.scale;
          if (onTop) px = Math.max(px, selectedFloorPx(r.kind, isFocusPin, th));
          // Fit to pitch — every pin label except the one being pointed at,
          // which is one label drawn on top and may cover its neighbours.
          if (th.fitToPitch !== false && !isFocusPin && r.pitch) {
            const cap = pitchCapPx(r, view.scale);
            if (px > cap) {
              px = cap;
              // Below the appear-floor it is noise, not a label: hide, don't shrink.
              if (px < minPxFor(r.kind, th) * (isSel ? th.selectedLabelLodRelax : 1)) continue;
            }
          }
          const fontPx = Math.round(px * 4) / 4;          // quantize to limit ctx.font churn
          if (fontPx !== lastFontPx) { ctx.font = `${fontPx}px monospace`; lastFontPx = fontPx; }
          const pl = r.kind === 'circleNum' ? pinNumberPlacement(r, view, th, isSel) : r;
          const sx0 = m.a * pl.x + m.c * pl.y + m.tx;
          const sy0 = m.b * pl.x + m.d * pl.y + m.ty;
          // Anchor compensation: ctx draws centered (textAlign/baseline middle),
          // records carry BitmapText anchors — shift so the anchored point of
          // the text box lands on (sx0, sy0). Width via measureText; height ≈ fontPx.
          const textW = ctx.measureText(r.text).width;   // measured once — reused for bg rect
          const aw = (0.5 - r.anchorX) * textW;
          const ah = (0.5 - pl.anchorY) * fontPx;
          const sx = sx0 + aw;
          const sy = sy0 + ah;
          // Diode readings are exempt from ambient dimming: a measurement
          // you are comparing against the meter must not be translucent.
          let alpha = pass === 'dim' && r.kind !== 'diode' ? DIM_ALPHA : 1;
          if (r.kind === 'part') alpha *= partNameFade(r.fontSize * view.scale);
          ctx.globalAlpha = alpha;
          if (r.bg) {                                     // backing rect (replaces the Graphics wrappers — two-pin AND circle-net)
            const tw = textW + fontPx * 0.6;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(sx - tw / 2, sy - fontPx * 0.65, tw, fontPx * 1.3);
          }
          ctx.fillStyle = this.css(r.color);
          ctx.fillText(r.text, sx, sy);
          // Record the painted box (centered draw) for Resize Mode hit-testing.
          // A few px of slop makes small labels easier to click.
          if (recordBoxes) {
            const hw = textW / 2 + 3;
            const hh = fontPx / 2 + 3;
            this.lastBoxes.push({ x0: sx - hw, y0: sy - hh, x1: sx + hw, y1: sy + hh, kind: r.kind, partIndex: r.partIndex });
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    this.lastCounts = { visible, total: model.top.length + model.bottom.length };
    const ms = performance.now() - t0;
    this.lastDrawMs = this.lastDrawMs === 0 ? ms : this.lastDrawMs * 0.8 + ms * 0.2;
    if (ms > 12 && t0 - this.lastSlowDrawLogAt > 1000) {   // ≤1 emit/s — content-dirty motion can hit this per frame
      this.lastSlowDrawLogAt = t0;
      log.perf.log(`label overlay draw ${ms.toFixed(1)}ms visible=${visible}`);
    }
  }

  /** Resize Mode: return the topmost label box containing the given
   *  canvas-space (CSS px) point, or null. Iterates last-painted-first so the
   *  visually-on-top label (selected pass drawn last) wins. */
  hitTest(sx: number, sy: number): { kind: LabelRecord['kind']; partIndex: number } | null {
    for (let i = this.lastBoxes.length - 1; i >= 0; i--) {
      const b = this.lastBoxes[i];
      if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) return { kind: b.kind, partIndex: b.partIndex };
    }
    return null;
  }

  destroy(): void { this.canvas.remove(); }
}
