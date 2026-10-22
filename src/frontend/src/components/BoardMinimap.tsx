/** Board minimap: the whole board in miniature with a box for what the screen
 *  shows. Two ways it appears:
 *    - `always` (slide mode): steady while composing a view;
 *    - `onPan` (ribbon toggle `minimap`): fades in at the top centre when the
 *      user, zoomed in to 2× the fit view or more, has panned 12 % of the
 *      screen (`PanActivity`), and out once panning stops.
 *  Drawn from BoardData (outline + part boxes) through the board roots'
 *  transforms, so rotation, mirror and Butterfly come for free. The board is
 *  cached in an offscreen canvas and only the view box is redrawn per frame.
 *  Click or drag on it to move the view there. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardRenderer } from '../renderer/BoardRenderer';
import { PanActivity } from '../store/pan-activity';
import { boardStore } from '../store/board-store';
import { themeStore } from '../store/themes';

const MAX_W = 220;
const MAX_H = 150;

type Model = NonNullable<ReturnType<BoardRenderer['getViewModel']>>;
type Mat = Model['roots'][number]['m'];

function apply(m: Mat, x: number, y: number) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/** World-space AABB of the board under every root transform. */
function contentBounds(model: Model) {
  const b = model.board.bounds;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of model.roots) {
    for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]]) {
      const p = apply(r.m, x, y);
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, minY, w: Math.max(1e-6, maxX - minX), h: Math.max(1e-6, maxY - minY) };
}

function css(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** The minimap's colours. A palette scheme (Dark, Landrex, Light, Atari) draws
 *  it in its own colours, so a light scheme does not get a dark map of white
 *  lines; Default keeps the translucent-white map it always had. */
interface MapColors { bg: string | null; sheet: string; edge: string; parts: string; selected: string; view: string; viewFill: string }
function mapColors(): MapColors {
  const t = themeStore.activeTheme();
  if (!t.palette) {
    const accent = css('--accent', '#5aa0ff');
    return { bg: null, sheet: 'rgba(255,255,255,0.06)', edge: 'rgba(255,255,255,0.55)', parts: 'rgba(255,255,255,0.32)',
      selected: accent, view: accent, viewFill: 'rgba(90,160,255,0.12)' };
  }
  const b = t.board;
  return { bg: b.canvasBackground, sheet: b.boardFill, edge: b.outline, parts: b.partOutlineTop ?? b.labelPart,
    selected: b.selectedPart ?? b.selection, view: b.selection, viewFill: hexA(b.selection, 0.14) };
}
/** The cached board picture's colour key: the colours paintBoard reads, not
 *  just the scheme id — editing the custom scheme keeps the id 'custom'. */
function mapSig(): string {
  const c = mapColors();
  return `${c.sheet}|${c.edge}|${c.parts}|${c.selected}|${c.bg ?? ''}`;
}
function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Paint the board itself (outline + part boxes) into `ctx`, world→minimap via `k, ox, oy`. */
function paintBoard(ctx: CanvasRenderingContext2D, model: Model, k: number, ox: number, oy: number) {
  const mc = mapColors();
  const accent = mc.selected;
  const { board } = model;
  const top = boardStore.showTop, bottom = boardStore.showBottom;
  const primaryBottom = board.primarySide === 'bottom';
  for (const r of model.roots) {
    const [a, b, c, d, tx, ty] = r.m;
    ctx.setTransform(a * k, b * k, c * k, d * k, tx * k + ox, ty * k + oy);
    const px = 1 / (Math.hypot(a, b) * k);   // one minimap px in board units
    // Outline (NaN = pen-up between contours).
    if (board.outline.length > 1) {
      ctx.beginPath();
      let pen = false;
      for (const p of board.outline) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { pen = false; continue; }
        if (pen) ctx.lineTo(p.x, p.y); else { ctx.moveTo(p.x, p.y); pen = true; }
      }
      ctx.fillStyle = mc.sheet;
      ctx.fill();
      ctx.strokeStyle = mc.edge;
      ctx.lineWidth = px * 1.2;
      ctx.stroke();
    }
    // Parts: the side(s) this root shows. 'all' follows the side switch.
    ctx.fillStyle = mc.parts;
    if (mc.bg) ctx.globalAlpha = 0.55;   // scheme colours are opaque; Default's are pre-faded
    for (const part of board.parts) {
      if (part.hidden) continue;
      const isTop = part.side === 'both' || (part.side === 'top') !== primaryBottom;
      const isBottom = part.side === 'both' || !isTop;
      if (r.side === 'top' && !isTop) continue;
      if (r.side === 'bottom' && !isBottom) continue;
      if (r.side === 'all' && !((top && isTop) || (bottom && isBottom))) continue;
      const pb = part.bounds;
      ctx.fillRect(pb.minX, pb.minY, Math.max(px, pb.maxX - pb.minX), Math.max(px, pb.maxY - pb.minY));
    }
    ctx.globalAlpha = 1;
    // The selected part stands out, so the map also says where the work is.
    const sel = boardStore.selection.partIndex;
    if (sel !== null && board.parts[sel]) {
      const pb = board.parts[sel].bounds;
      const pad = px * 2;
      const rx = pb.minX - pad, ry = pb.minY - pad, rw = pb.maxX - pb.minX + 2 * pad, rh = pb.maxY - pb.minY + 2 * pad;
      // Translucent fill + outline: a big part must not bury the view box.
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = accent;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = accent;
      ctx.lineWidth = px * 1.5;
      ctx.strokeRect(rx, ry, rw, rh);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function BoardMinimap({ renderer, mode }: { renderer: BoardRenderer | null; mode: 'always' | 'onPan' | 'off' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<{ sig: string; canvas: HTMLCanvasElement; k: number; ox: number; oy: number; w: number; h: number } | null>(null);
  const activity = useRef(new PanActivity());
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);
  const [size, setSize] = useState({ w: MAX_W, h: MAX_H });

  const visible = mode === 'always' || (mode === 'onPan' && shown);

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const model = renderer?.getViewModel();
    if (!cv || !model) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cb = contentBounds(model);
    const sel = boardStore.selection.partIndex;
    const sig = `${model.roots.map(r => r.m.join(',')).join('|')}|${model.board.parts.length}|${boardStore.showTop}${boardStore.showBottom}|${sel}|${mapSig()}`;
    let base = baseRef.current;
    if (!base || base.sig !== sig) {
      // Fit the board into MAX_W × MAX_H, keeping its aspect.
      const k = Math.min((MAX_W - 8) / cb.w, (MAX_H - 8) / cb.h);
      const w = Math.round(cb.w * k + 8), h = Math.round(cb.h * k + 8);
      const off = base?.canvas ?? document.createElement('canvas');
      off.width = Math.round(w * dpr); off.height = Math.round(h * dpr);
      const octx = off.getContext('2d')!;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.clearRect(0, 0, off.width, off.height);
      const ox = (4 - cb.minX * k) * dpr, oy = (4 - cb.minY * k) * dpr;
      paintBoard(octx, model, k * dpr, ox, oy);
      base = { sig, canvas: off, k, ox: ox / dpr, oy: oy / dpr, w, h };
      baseRef.current = base;
      if (size.w !== w || size.h !== h) setSize({ w, h });
    }
    if (cv.width !== base.canvas.width || cv.height !== base.canvas.height) {
      cv.width = base.canvas.width; cv.height = base.canvas.height;
    }
    // Scheme background on the frame (palette schemes); '' falls back to the CSS chip.
    if (cv.parentElement) cv.parentElement.style.background = mapColors().bg ?? '';
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(base.canvas, 0, 0);
    // The view box, clipped to the map so a zoomed-out view still draws sanely.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const v = model.view;
    const x0 = Math.max(1, v.x * base.k + base.ox), y0 = Math.max(1, v.y * base.k + base.oy);
    const x1 = Math.min(base.w - 1, (v.x + v.w) * base.k + base.ox), y1 = Math.min(base.h - 1, (v.y + v.h) * base.k + base.oy);
    if (x1 > x0 && y1 > y0) {
      const mc = mapColors();
      ctx.fillStyle = mc.viewFill;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = mc.view;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
  }, [renderer, size.w, size.h]);

  // Follow the view; in onPan mode, feed the gesture counter.
  useEffect(() => {
    if (!renderer || mode === 'off') return;
    return renderer.onViewChange(({ userPan, dx, dy }) => {
      if (mode === 'onPan' && userPan) {
        const now = performance.now();
        const model = renderer.getViewModel();
        const sz = renderer.viewSize();
        // Zoom relative to the fit view: 1 when the whole board fits on screen.
        let zoom = 0;
        if (model) {
          const cb = contentBounds(model);
          zoom = Math.max(cb.w / model.view.w, cb.h / model.view.h);
        }
        if (activity.current.move(now, { dx, dy, width: sz.width, height: sz.height, zoom })) {
          setShown(true);
          if (hideTimer.current) clearTimeout(hideTimer.current);
          const arm = () => {
            hideTimer.current = setTimeout(() => {
              const t = performance.now();
              if (hovering.current) { activity.current.touch(t); arm(); return; }
              if (!activity.current.visible(t)) setShown(false); else arm();
            }, Math.max(50, (activity.current.hideAt() ?? now) - performance.now() + 10));
          };
          arm();
        }
      }
      if (canvasRef.current && (mode === 'always' || activity.current.hideAt() !== null)) paint();
    });
  }, [renderer, mode, paint]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);
  // Selection / side changes repaint the board picture.
  useEffect(() => boardStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  // A scheme switch repaints it in the new colours.
  useEffect(() => themeStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  useEffect(() => { if (visible) paint(); }, [visible, paint]);

  const dragging = useRef(false);
  const goTo = useCallback((e: React.PointerEvent) => {
    const base = baseRef.current, cv = canvasRef.current;
    if (!base || !cv || !renderer) return;
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (base.w / r.width), my = (e.clientY - r.top) * (base.h / r.height);
    renderer.centerOnWorld((mx - base.ox) / base.k, (my - base.oy) / base.k);
  }, [renderer]);

  if (mode === 'off' || !renderer) return null;

  return (
    <div
      className={`board-minimap${visible ? ' visible' : ''}`}
      data-testid="board-minimap"
      data-visible={visible ? 'true' : 'false'}
      style={{ width: size.w, height: size.h }}
      onPointerEnter={() => { hovering.current = true; }}
      onPointerLeave={() => { hovering.current = false; }}
      onPointerDown={e => {
        if (!visible || e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        goTo(e);
      }}
      // Only a press that began on the map drags the view. A board drag that
      // merely crosses the map — which fades in under the very pan that is
      // being made — must not recentre on the map point (2026-10-22, "jumps
      // as if the map were being used").
      onPointerMove={e => { if (dragging.current && e.buttons & 1 && visible) goTo(e); }}
      onPointerUp={() => { dragging.current = false; }}
      onPointerCancel={() => { dragging.current = false; }}
      onLostPointerCapture={() => { dragging.current = false; }}
    >
      <canvas ref={canvasRef} style={{ width: size.w, height: size.h }} />
    </div>
  );
}
