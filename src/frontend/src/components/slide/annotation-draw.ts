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

/** Screen points of a freehand stroke. */
export function inkPoints(ann: Annotation, toScreen: ToScreen): Pt[] {
  const out: Pt[] = [];
  for (const p of ann.points ?? []) { const q = toScreen(p); if (q) out.push(q); }
  return out;
}

/** Smooth a stroke through its sample midpoints (quadratic segments). */
function strokeInk(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (pts.length < 3) {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    if (pts.length === 1) ctx.lineTo(pts[0].x + 0.01, pts[0].y);   // a dot
  } else {
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }
  ctx.stroke();
}

function bboxOf(pts: Pt[]): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, ann: Annotation, toScreen: ToScreen) {
  if (ann.kind === 'ink') {
    const pts = inkPoints(ann, toScreen);
    if (!pts.length) return;
    withHalo(ctx, () => {
      ctx.strokeStyle = ann.color;
      ctx.lineWidth = ann.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      strokeInk(ctx, pts);
    });
    return;
  }
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
  if (ann.kind === 'ink') {
    const b = bboxOf(inkPoints(ann, toScreen));
    const pad = ann.size / 2 + 4;
    if (Number.isFinite(b.x)) ctx.strokeRect(b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
  } else if (ann.kind === 'text') {
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
    if (ann.kind === 'ink') {
      const pts = inkPoints(ann, toScreen);
      const t = tol + ann.size / 2;
      if (pts.length === 1 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= t) return ann;
      for (let k = 1; k < pts.length; k++) if (distToSegment(p, pts[k - 1], pts[k]) <= t) return ann;
    } else if (ann.kind === 'arrow') {
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

export interface Rect { x: number; y: number; w: number; h: number }

/** One selected part's caption: its refdes and any drafted readings. */
export interface CaptionItem {
  key: string;
  name: string;
  /** The part's drawn body on screen. */
  box: Rect;
  /** Second line (readings), empty when there are none. */
  detail: string;
  primary: boolean;
}

/** Where a caption went: the pill, plus the block that includes the room
 *  reserved under it. */
export interface CaptionPlaced { key: string; pill: Rect; block: Rect }

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function captionMetrics(ctx: CanvasRenderingContext2D, it: CaptionItem) {
  const size = it.primary ? 30 : 22;
  const dsize = Math.round(size * 0.62);
  ctx.font = font(size);
  let tw = ctx.measureText(it.name).width;
  if (it.detail) { ctx.font = font(dsize); tw = Math.max(tw, ctx.measureText(it.detail).width); }
  const padX = Math.round(size * 0.4);
  const h = Math.round(size + 14 + (it.detail ? dsize * 1.3 : 0));
  return { size, dsize, padX, w: tw + 2 * padX, h };
}

/** Place every caption beside its part — above, below, left or right, sliding
 *  along the edge into the view, else a free corner — never over its own
 *  part, over `avoid` (the minimap) or over a caption already placed.
 *  `reserveBelow` keeps room under a pill for the live reading inputs and
 *  `minWidth` makes that block at least so wide — both per caption key. */
export function layoutCaptions(
  ctx: CanvasRenderingContext2D,
  items: readonly CaptionItem[],
  view: { width: number; height: number },
  avoid: readonly Rect[],
  reserveBelow: (key: string) => number = () => 0,
  minWidth: (key: string) => number = () => 0,
): CaptionPlaced[] {
  const placed: CaptionPlaced[] = [];
  const taken: Rect[] = [...avoid];
  const m = 6, gap = 10;
  let stacked = 0;
  ctx.save();
  for (const it of items) {
    const b = it.box;
    if (b.x > view.width || b.y > view.height || b.x + b.w < 0 || b.y + b.h < 0) continue;
    const met = captionMetrics(ctx, it);
    const w = Math.max(met.w, minWidth(it.key)), h = met.h + reserveBelow(it.key);
    const cx = b.x + b.w / 2 - w / 2, cy = b.y + b.h / 2 - h / 2;
    const clamp = (c: { x: number; y: number }) => ({
      x: Math.max(m, Math.min(view.width - w - m, c.x)),
      y: Math.max(m, Math.min(view.height - h - m, c.y)),
    });
    const beside = [
      { x: cx, y: b.y - gap - h }, { x: cx, y: b.y + b.h + gap },
      { x: b.x - gap - w, y: cy }, { x: b.x + b.w + gap, y: cy },
    ].map(clamp);
    const corners = [
      { x: m, y: view.height - h - m }, { x: view.width - w - m, y: view.height - h - m },
      { x: m, y: m }, { x: view.width - w - m, y: m },
    ];
    const free = (c: { x: number; y: number }) => {
      const r = { x: c.x, y: c.y, w, h };
      return r.x >= m - 0.5 && r.y >= m - 0.5 && r.x + w <= view.width - m + 0.5 && r.y + h <= view.height - m + 0.5 &&
        !taken.some(t => overlaps(r, t));
    };
    let pos = beside.find(c => free(c) && !overlaps({ x: c.x, y: c.y, w, h }, b)) ?? corners.find(free);
    if (!pos) {
      // Nothing is free: stack up from the bottom-left corner.
      pos = { x: m, y: Math.max(m, view.height - m - h - stacked * (h + 4)) };
      stacked++;
    }
    const block = { x: pos.x, y: pos.y, w, h };
    taken.push(block);
    placed.push({ key: it.key, pill: { x: pos.x, y: pos.y, w: met.w, h: met.h }, block });
  }
  ctx.restore();
  return placed;
}

/** One caption pill: refdes large, readings on a second line. Primary in the
 *  accent colour, the rest of the multi-selection in the board's cyan. */
export function drawCaption(ctx: CanvasRenderingContext2D, it: CaptionItem, pl: CaptionPlaced, accent: string) {
  const met = captionMetrics(ctx, it);
  const { x, y, w, h } = pl.pill;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = 'rgba(16,18,22,0.9)';
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 7);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = it.primary ? accent : '#00e5ff';
  ctx.lineWidth = it.primary ? 2.5 : 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.font = font(met.size);
  ctx.fillText(it.name, x + met.padX, y + 7 + met.size / 2 + 1);
  if (it.detail) {
    ctx.font = font(met.dsize);
    ctx.fillStyle = '#ffd60a';
    ctx.fillText(it.detail, x + met.padX, y + 7 + met.size + met.dsize * 0.7);
  }
  ctx.restore();
}

/** The readings line under a refdes: "4.7 kΩ · ▷| 0.452". */
export function readingsLine(r: { ohm: string; diode: string } | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  const ohm = r.ohm.trim(), diode = r.diode.trim();
  if (ohm) parts.push(/[Ωω]|ohm/i.test(ohm) ? ohm : `${ohm} Ω`);
  if (diode) parts.push(`▷| ${diode}`);
  return parts.join('  ·  ');
}
