/** Canvas2D board-text overlay — draws only on-screen, LoD-passing labels
 *  each redraw instead of keeping ~100k BitmapText nodes in the Pixi scene.
 *  Architecture: docs/research/renderer-research-2026-07-19.md §1.5.
 *  Pure selection logic is exported for unit tests; the class owns the
 *  canvas. Text draws upright in screen space (counter-flip machinery not
 *  needed); positions transform through the per-side label-layer world
 *  matrices so rotate/mirror/butterfly work unchanged. */
import type { LabelModel, LabelRecord } from './label-model';
import { log } from '../store/log-store';

export interface OverlayViewState {
  topMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  bottomMatrix: { a: number; b: number; c: number; d: number; tx: number; ty: number };
  scale: number;
  width: number; height: number;
  showTop: boolean; showBottom: boolean;
  selectedPartIndex: number | null;
  dimActive: boolean;
  litParts: ReadonlySet<number> | null;
}
export interface OverlayThresholds {
  labelMinScreenPx: number;
  circleLabelMinScreenPx: number;
  twoPinLabelMinScreenPx: number;
  labelZoomHide: number;
}

const OFFSCREEN_MARGIN = 40;      // px — keep labels whose center is just off-edge
const DIM_ALPHA = 0.22;           // parity-tuned vs netDimGfx look in Task 9
/** Selected-part labels get a modest PROPORTIONAL boost (1.5× natural size,
 *  capped at SELECTED_BOOST_CAP_PX) instead of a hard floor — a constant-px
 *  floor made them visually GROW relative to the shrinking part during
 *  unzoom (user feedback 2026-07-19). They now shrink with zoom like
 *  everything else, just slightly larger. */
const SELECTED_BOOST = 1.5;
const SELECTED_BOOST_CAP_PX = 11;
/** Selected-part pin/net labels get a RELAXED LoD (0.75× the normal min-px)
 *  rather than a full bypass: slightly sticky through unzoom, but they
 *  disappear close to the normal cutoff (user feedback 2026-07-19 — net
 *  names must not survive unzooming, and 0.5 kept them too long). The part
 *  NAME label alone keeps the full bypass as the selection identity marker
 *  (parity with the Pixi elevated badge). */
const SELECTED_LOD_RELAX = 0.75;

function minPxFor(kind: LabelRecord['kind'], th: OverlayThresholds): number {
  switch (kind) {
    case 'circleNum': case 'circleNet': return th.circleLabelMinScreenPx;
    case 'twoPinNet': return th.twoPinLabelMinScreenPx;
    default: return th.labelMinScreenPx;
  }
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
      const min = minPxFor(r.kind, th) * (selected ? SELECTED_LOD_RELAX : 1);
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
          const isLit = !view.dimActive || isSel || (view.litParts?.has(r.partIndex) ?? false);
          const want = pass === 'selected' ? isSel : pass === 'lit' ? (isLit && !isSel) : !isLit;
          if (!want) continue;
          visible += 1;
          let px = r.fontSize * view.scale;
          if (isSel) px = Math.max(px, Math.min(px * SELECTED_BOOST, SELECTED_BOOST_CAP_PX));
          const fontPx = Math.round(px * 4) / 4;          // quantize to limit ctx.font churn
          if (fontPx !== lastFontPx) { ctx.font = `${fontPx}px monospace`; lastFontPx = fontPx; }
          const sx0 = m.a * r.x + m.c * r.y + m.tx;
          const sy0 = m.b * r.x + m.d * r.y + m.ty;
          // Anchor compensation: ctx draws centered (textAlign/baseline middle),
          // records carry BitmapText anchors — shift so the anchored point of
          // the text box lands on (sx0, sy0). Width via measureText; height ≈ fontPx.
          const aw = (0.5 - r.anchorX) * ctx.measureText(r.text).width;
          const ah = (0.5 - r.anchorY) * fontPx;
          const sx = sx0 + aw;
          const sy = sy0 + ah;
          ctx.globalAlpha = pass === 'dim' ? DIM_ALPHA : 1;
          if (r.bg) {                                     // backing rect (replaces the Graphics wrappers — two-pin AND circle-net)
            const tw = ctx.measureText(r.text).width + fontPx * 0.6;
            ctx.fillStyle = 'rgba(0,0,0,0.55)';
            ctx.fillRect(sx - tw / 2, sy - fontPx * 0.65, tw, fontPx * 1.3);
          }
          ctx.fillStyle = this.css(r.color);
          ctx.fillText(r.text, sx, sy);
        }
      }
    }
    ctx.globalAlpha = 1;
    this.lastCounts = { visible, total: model.top.length + model.bottom.length };
    const ms = performance.now() - t0;
    this.lastDrawMs = this.lastDrawMs === 0 ? ms : this.lastDrawMs * 0.8 + ms * 0.2;
    if (ms > 12) log.perf.log(`label overlay draw ${ms.toFixed(1)}ms visible=${visible}`);
  }

  destroy(): void { this.canvas.remove(); }
}
