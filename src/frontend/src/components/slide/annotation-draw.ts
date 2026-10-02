/** Drawing and hit-testing of slide annotations, in SCREEN space. One
 *  implementation serves the live layer and the PNG export, so what is saved
 *  is exactly what was on screen. */
import type { Annotation, Pt } from '../../store/slide-store';
import type { BoardRenderer } from '../../renderer/BoardRenderer';

export type ToScreen = (p: Pt) => Pt | null;

export const TEXT_FONT = '600 {size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const font = (size: number) => TEXT_FONT.replace('{size}', String(size));

/** Screen polygon of a board-space rectangle (a board-axis box: on a board
 *  turned by a free angle it turns with the board). */
export function rectCorners(ann: Annotation, toScreen: ToScreen): Pt[] | null {
  const pts = [
    { x: ann.a.x, y: ann.a.y }, { x: ann.b.x, y: ann.a.y },
    { x: ann.b.x, y: ann.b.y }, { x: ann.a.x, y: ann.b.y },
  ].map(toScreen);
  return pts.every(Boolean) ? (pts as Pt[]) : null;
}

const measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;

/** Screen box of a text annotation (multi-line, top-left anchored). */
export function textBox(ann: Annotation, toScreen: ToScreen): { x: number; y: number; w: number; h: number } | null {
  const p = toScreen(ann.a);
  if (!p) return null;
  const lines = (ann.text ?? '').split('\n');
  let w = 0;
  if (measureCtx) {
    measureCtx.font = font(ann.size);
    for (const l of lines) w = Math.max(w, measureCtx.measureText(l).width);
  } else {
    w = Math.max(...lines.map(l => l.length)) * ann.size * 0.6;
  }
  const pad = ann.size * 0.3;
  return { x: p.x - pad, y: p.y - pad, w: w + 2 * pad, h: lines.length * ann.size * 1.25 + 2 * pad };
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Pt, b: Pt, color: string, w: number) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const head = Math.max(10, w * 4);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  // Shaft stops at the head's base so a thick line does not poke through the tip.
  const shaft = Math.max(0, len - head * 0.8);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(a.x + Math.cos(ang) * shaft, a.y + Math.sin(ang) * shaft);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - head * Math.cos(ang - 0.42), b.y - head * Math.sin(ang - 0.42));
  ctx.lineTo(b.x - head * Math.cos(ang + 0.42), b.y - head * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fill();
}

/** Contrast halo so a red arrow still reads over a red-dominated board. */
function withHalo(ctx: CanvasRenderingContext2D, fn: () => void) {
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 3;
  fn();
  ctx.restore();
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation, toScreen: ToScreen) {
  if (ann.kind === 'arrow') {
    const a = toScreen(ann.a), b = toScreen(ann.b);
    if (!a || !b) return;
    withHalo(ctx, () => drawArrow(ctx, a, b, ann.color, ann.size));
  } else if (ann.kind === 'rect') {
    const c = rectCorners(ann, toScreen);
    if (!c) return;
    withHalo(ctx, () => {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.size;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(c[0].x, c[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
      ctx.closePath();
      ctx.stroke();
    });
  } else {
    const p = toScreen(ann.a);
    if (!p || !ann.text) return;
    ctx.save();
    ctx.font = font(ann.size);
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = Math.max(3, ann.size * 0.22);
    ctx.fillStyle = ann.color;
    ann.text.split('\n').forEach((line, i) => {
      const y = p.y + i * ann.size * 1.25;
      ctx.strokeText(line, p.x, y);
      ctx.fillText(line, p.x, y);
    });
    ctx.restore();
  }
}

/** Selection chrome: dashed box / handles. Live layer only, never exported. */
export function drawSelection(ctx: CanvasRenderingContext2D, ann: Annotation, toScreen: ToScreen) {
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#0a84ff';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  const handle = (p: Pt) => {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.rect(p.x - 4, p.y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };
  for (const h of handlesOf(ann, toScreen)) handle(h.p);
  if (ann.kind === 'text') {
    const b = textBox(ann, toScreen);
    if (b) ctx.strokeRect(b.x, b.y, b.w, b.h);
  } else if (ann.kind === 'rect') {
    const c = rectCorners(ann, toScreen);
    if (c) { ctx.beginPath(); c.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke(); }
  }
  ctx.restore();
}

/** A draggable handle: which board-space coordinates it moves. */
export interface Handle { p: Pt; moves: { ax?: boolean; ay?: boolean; bx?: boolean; by?: boolean } }

export function handlesOf(ann: Annotation, toScreen: ToScreen): Handle[] {
  if (ann.kind === 'arrow') {
    const a = toScreen(ann.a), b = toScreen(ann.b);
    return a && b ? [{ p: a, moves: { ax: true, ay: true } }, { p: b, moves: { bx: true, by: true } }] : [];
  }
  if (ann.kind === 'rect') {
    const c = rectCorners(ann, toScreen);
    if (!c) return [];
    return [
      { p: c[0], moves: { ax: true, ay: true } },
      { p: c[1], moves: { bx: true, ay: true } },
      { p: c[2], moves: { bx: true, by: true } },
      { p: c[3], moves: { ax: true, by: true } },
    ];
  }
  return [];
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Topmost annotation under a screen point (the last drawn wins). A rectangle
 *  is hit on its border only, so a click inside it still reaches the board. */
export function hitAnnotation(list: readonly Annotation[], p: Pt, toScreen: ToScreen, tol = 7): Annotation | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const ann = list[i];
    if (ann.kind === 'arrow') {
      const a = toScreen(ann.a), b = toScreen(ann.b);
      if (a && b && distToSegment(p, a, b) <= tol + ann.size / 2) return ann;
    } else if (ann.kind === 'rect') {
      const c = rectCorners(ann, toScreen);
      if (c && c.some((q, k) => distToSegment(p, q, c[(k + 1) % 4]) <= tol + ann.size / 2)) return ann;
    } else {
      const b = textBox(ann, toScreen);
      if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return ann;
    }
  }
  return null;
}

export function hitHandle(ann: Annotation, p: Pt, toScreen: ToScreen, tol = 8): Handle | null {
  for (const h of handlesOf(ann, toScreen)) {
    if (Math.abs(p.x - h.p.x) <= tol && Math.abs(p.y - h.p.y) <= tol) return h;
  }
  return null;
}

/** Draw the given annotations onto a context in renderer px. */
export function paintAnnotations(ctx: CanvasRenderingContext2D, list: readonly Annotation[], renderer: Pick<BoardRenderer, 'boardToScreen'>, selectedId: number | null) {
  const toScreen: ToScreen = p => renderer.boardToScreen(p.x, p.y);
  for (const ann of list) drawAnnotation(ctx, ann, toScreen);
  const sel = selectedId !== null ? list.find(a => a.id === selectedId) : undefined;
  if (sel) drawSelection(ctx, sel, toScreen);
}

/** The selected part's name as a caption: large, on a dark pill, beside the
 *  part — above, below, left or right, whichever fits in the view first
 *  without covering `avoid` (the minimap); failing all, a view corner. Drawn
 *  live in slide mode and into the PNG, so a slide always says what it shows. */
export function drawPartCaption(
  ctx: CanvasRenderingContext2D,
  sel: { name: string; x: number; y: number; w: number; h: number },
  view: { width: number; height: number },
  accent: string,
  avoid: { x: number; y: number; w: number; h: number } | null = null,
) {
  // Off screen entirely: nothing to point at.
  if (sel.x > view.width || sel.y > view.height || sel.x + sel.w < 0 || sel.y + sel.h < 0) return;
  const size = 30;
  ctx.save();
  ctx.font = font(size);
  const tw = ctx.measureText(sel.name).width;
  const padX = 12, h = size + 14, w = tw + 2 * padX, gap = 10, m = 6;
  const cx = sel.x + sel.w / 2 - w / 2, cy = sel.y + sel.h / 2 - h / 2;
  const candidates = [
    { x: cx, y: sel.y - gap - h },
    { x: cx, y: sel.y + sel.h + gap },
    { x: sel.x - gap - w, y: cy },
    { x: sel.x + sel.w + gap, y: cy },
    { x: m, y: view.height - h - m },
    { x: view.width - w - m, y: view.height - h - m },
    { x: m, y: m },
  ];
  const fits = (c: { x: number; y: number }) =>
    c.x >= m && c.y >= m && c.x + w <= view.width - m && c.y + h <= view.height - m &&
    !(avoid && c.x < avoid.x + avoid.w && c.x + w > avoid.x && c.y < avoid.y + avoid.h && c.y + h > avoid.y);
  // Beside the part, sliding along its edge into the view when it is close
  // to a border; then the corners as they are.
  const slid = candidates.slice(0, 4).map(c => ({
    x: Math.max(m, Math.min(view.width - w - m, c.x)),
    y: Math.max(m, Math.min(view.height - h - m, c.y)),
  }));
  const overlapsPart = (c: { x: number; y: number }) =>
    c.x < sel.x + sel.w && c.x + w > sel.x && c.y < sel.y + sel.h && c.y + h > sel.y;
  const pos = slid.find(c => fits(c) && !overlapsPart(c))
    ?? candidates.slice(4).find(fits)
    ?? slid[0];
  const { x, y } = pos;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(16,18,22,0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(sel.name, x + padX, y + h / 2 + 1);
  ctx.restore();
}
