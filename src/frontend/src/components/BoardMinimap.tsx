/** Board minimap: the whole board in miniature with a box for what the screen
 *  shows. Two ways it appears:
 *    - `always` (slide mode): steady while composing a view;
 *    - `onPan` (ribbon toggle `minimap`): fades in at the top centre when the
 *      user, zoomed in to 2× the fit view or more, has panned 12 % of the
 *      screen (`PanActivity`), and out once panning stops.
 *  Drawn from BoardData (outline + part boxes) through the board roots'
 *  transforms, so rotation, mirror and Butterfly come for free. The board is
 *  cached in an offscreen canvas and only the view box is redrawn per frame.
 *  Click or drag on it to move the view there.
 *
 *  Placement (right-click the map): top centre, top left, top right, or
 *  Float — the map then follows the pointer around the board panel and the
 *  next click puts it down there (Escape keeps it where it was). Settings
 *  `minimapPosition` / `minimapFloatX/Y`, global. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardRenderer } from '../renderer/BoardRenderer';
import { PanActivity } from '../store/pan-activity';
import { boardStore } from '../store/board-store';
import { themeStore } from '../store/themes';
import { renderSettingsStore, minimapMode, type MinimapMode, type MinimapPosition } from '../store/render-settings';
import { useRenderSettings } from '../hooks/useRenderSettings';
import { uiZoom } from '../store/ui-zoom';
import { QuickMenu } from './QuickMenu';
import { IconChevronLeft, IconChevronRight, IconHistory, IconChecklist, IconExternalLink } from '@tabler/icons-react';
import { worklistStore, MARK_COLOR_CSS, type Worklist } from '../store/worklist-store';
import { useWorklist } from '../hooks/useWorklist';
import { useBoardStore } from '../hooks/useBoardStore';
import { worklistStepKeys, currentWorklistKey, worklistStep } from '../store/minimap-worklist';
import { openBoardSidebarTab } from '../panels/board-viewer-bridge';
import { showSidebarTab } from './Sidebar.utils';
import { navHistoryStore } from '../store/nav-history-store';
import { historyBack, historyForward } from '../store/nav-history-actions';
import { useNavHistory } from '../hooks/useNavHistory';
import { minimapTrail, MINIMAP_TRAIL_LIMIT } from '../store/minimap-trail';
import type { BoardData } from '../parsers/types';

/** The map's box at Size 100 %; `minimapScale` multiplies it. */
const MAX_W = 220;
const MAX_H = 150;
const ACTIVE_HOLD_MS = 700;
/** The header strip above the map: history ‹ › and the History tab. */
const HEAD_H = 20;
/** Narrowest the map gets, so the header's buttons always fit; a tall
 *  board (or one turned 90°) is centred in the extra width. */
const MIN_W = 180;
/** The frame's 1px border on each side (box-sizing is border-box). */
const FRAME = 2;

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

/** The minimap element a canvas of it sits in (data attributes live there). */
function mapRoot(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>('[data-testid="board-minimap"]');
}

// ── History trail ───────────────────────────────────────────────────────

const partIndexCache = new WeakMap<BoardData, Map<string, number>>();
function partIndexByName(board: BoardData): Map<string, number> {
  let m = partIndexCache.get(board);
  if (!m) {
    m = new Map();
    board.parts.forEach((p, i) => { if (!m!.has(p.name.toUpperCase())) m!.set(p.name.toUpperCase(), i); });
    partIndexCache.set(board, m);
  }
  return m;
}

function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Newest visit in the selection colour, oldest in magenta. Not the accent:
 *  the map's edges and view box are drawn in it, and a trail fading into
 *  that blue disappeared into the map. The alpha floor stays high because
 *  the whole map is already faded by its opacity setting. */
const TRAIL_COLD: [number, number, number] = [255, 64, 170];
function trailColor(rank: number, n: number, alphaScale = 1): string {
  const hot = parseHex(css('--board-selection', '#ffff44')) ?? [255, 255, 68];
  const cold = TRAIL_COLD;
  const t = n <= 1 ? 0 : rank / (n - 1);
  const c = hot.map((v, i) => Math.round(v + (cold[i] - v) * t));
  const a = (1 - 0.35 * t) * alphaScale;
  return `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
}

/** Draw the trail in map css px: `k`/`ox`/`oy` map world to the map. */
function paintTrail(ctx: CanvasRenderingContext2D, model: Model, tabId: number | null,
  k: number, ox: number, oy: number, mapW: number, mapH: number, viewSize: { width: number; height: number }) {
  const steps = renderSettingsStore.settings.minimapHistorySteps ?? MINIMAP_TRAIL_LIMIT;
  const trail = minimapTrail(navHistoryStore.entries, navHistoryStore.cursor, tabId, { limit: steps });
  // For tests and the curious: how many visits the map marks.
  const host = mapRoot(ctx.canvas);
  if (host) host.dataset.trail = String(trail.length);
  if (trail.length === 0) return;
  const { board } = model;
  const idx = partIndexByName(board);
  const primaryBottom = board.primarySide === 'bottom';
  const top = boardStore.showTop, bottom = boardStore.showBottom;
  const n = trail.length;
  const cb = contentBounds(model);
  // Oldest first, so the newest is drawn on top.
  const ordered = [...trail].reverse();
  const centres: Array<{ x: number; y: number; rank: number }> = [];

  for (const it of ordered) {
    const col = trailColor(it.rank, n);
    if (it.camera && !it.part) {
      // A view left behind: its rectangle, dashed. Skip fit-the-board views.
      const c = it.camera;
      const w = viewSize.width / c.scaleX, h = viewSize.height / c.scaleY;
      if (w >= cb.w * 0.85 && h >= cb.h * 0.85) continue;
      const x = -c.x / c.scaleX, y = -c.y / c.scaleY;
      const rx = Math.max(1, x * k + ox), ry = Math.max(1, y * k + oy);
      const rx1 = Math.min(mapW - 1, (x + w) * k + ox), ry1 = Math.min(mapH - 1, (y + h) * k + oy);
      if (rx1 <= rx || ry1 <= ry) continue;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = col;
      ctx.lineWidth = it.current ? 1.6 : 1;
      ctx.strokeRect(rx, ry, rx1 - rx, ry1 - ry);
      ctx.setLineDash([]);
      continue;
    }
    if (!it.part) continue;
    const pi = idx.get(it.part.toUpperCase());
    if (pi === undefined) continue;
    const part = board.parts[pi];
    const isTop = part.side === 'both' || (part.side === 'top') !== primaryBottom;
    const isBottom = part.side === 'both' || !isTop;
    for (const r of model.roots) {
      if (r.side === 'top' && !isTop) continue;
      if (r.side === 'bottom' && !isBottom) continue;
      if (r.side === 'all' && !((top && isTop) || (bottom && isBottom))) continue;
      const dpr = window.devicePixelRatio || 1;
      const [a, b, c, d, tx, ty] = r.m;
      ctx.setTransform(a * k * dpr, b * k * dpr, c * k * dpr, d * k * dpr, (tx * k + ox) * dpr, (ty * k + oy) * dpr);
      const px = 1 / (Math.hypot(a, b) * k);
      const pb = part.bounds;
      // At least 6 map px, so a passive the size of a dot still reads.
      const minS = px * 6;
      const w = Math.max(minS, pb.maxX - pb.minX), h = Math.max(minS, pb.maxY - pb.minY);
      const cx = (pb.minX + pb.maxX) / 2, cy = (pb.minY + pb.maxY) / 2;
      // A dark rim first: it separates the mark from the board under it on
      // light and dark schemes alike.
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = px * 3;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      ctx.fillStyle = col;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col;
      ctx.lineWidth = px * (it.current ? 2 : 1.2);
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
      // Centre in map css px, for the connecting line.
      centres.push({ x: (a * cx + c * cy + tx) * k + ox, y: (b * cx + d * cy + ty) * k + oy, rank: it.rank });
      break;
    }
  }
  // A faint line through the parts, oldest to newest: the order of the work.
  // Kept well below the boxes — it is a hint of sequence, not a mark.
  if (centres.length > 1) {
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 0.75;
    for (let i = 1; i < centres.length; i++) {
      ctx.strokeStyle = trailColor(centres[i].rank, n, 0.32);
      ctx.beginPath();
      ctx.moveTo(centres[i - 1].x, centres[i - 1].y);
      ctx.lineTo(centres[i].x, centres[i].y);
      ctx.stroke();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The loaded worklist's parts in their mark colours; the current row ringed. */
function paintWorklist(ctx: CanvasRenderingContext2D, model: Model, wl: Worklist | null, k: number, ox: number, oy: number) {
  const host = mapRoot(ctx.canvas);
  const rows = (wl?.entries ?? []).filter(e => !e.unresolved && e.partIndex >= 0);
  if (host) host.dataset.wlMarks = String(rows.length);
  if (rows.length === 0) return;
  const { board } = model;
  const primaryBottom = board.primarySide === 'bottom';
  const top = boardStore.showTop, bottom = boardStore.showBottom;
  const sel = boardStore.selection.partIndex;
  const ring = css('--board-selection', '#ffff44');
  const dpr = window.devicePixelRatio || 1;
  for (const e of rows) {
    const part = board.parts[e.partIndex];
    if (!part) continue;
    const isTop = part.side === 'both' || (part.side === 'top') !== primaryBottom;
    const isBottom = part.side === 'both' || !isTop;
    for (const r of model.roots) {
      if (r.side === 'top' && !isTop) continue;
      if (r.side === 'bottom' && !isBottom) continue;
      if (r.side === 'all' && !((top && isTop) || (bottom && isBottom))) continue;
      const [a, b, c, d, tx, ty] = r.m;
      ctx.setTransform(a * k * dpr, b * k * dpr, c * k * dpr, d * k * dpr, (tx * k + ox) * dpr, (ty * k + oy) * dpr);
      const px = 1 / (Math.hypot(a, b) * k);
      const pb = part.bounds;
      const w = Math.max(px * 4, pb.maxX - pb.minX), h = Math.max(px * 4, pb.maxY - pb.minY);
      const cx = (pb.minX + pb.maxX) / 2, cy = (pb.minY + pb.maxY) / 2;
      const col = MARK_COLOR_CSS[e.mark] ?? MARK_COLOR_CSS.none;
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = col;
      ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
      ctx.globalAlpha = 1;
      const current = e.partIndex === sel;
      ctx.strokeStyle = current ? ring : col;
      ctx.lineWidth = px * (current ? 2.2 : 1);
      const pad = current ? px * 2 : 0;
      ctx.strokeRect(cx - w / 2 - pad, cy - h / 2 - pad, w + 2 * pad, h + 2 * pad);
      break;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

export function BoardMinimap({ renderer, tabId = null, mode }: { renderer: BoardRenderer | null; tabId?: number | null; mode: 'always' | 'onPan' | 'off' }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Marks layer over the board image: trail / worklist marks and the view
   *  box. The opacity setting fades the board image and the frame only, so
   *  the marks keep their contrast on a faded map. */
  const marksRef = useRef<HTMLCanvasElement>(null);
  const baseRef = useRef<{ sig: string; canvas: HTMLCanvasElement; k: number; ox: number; oy: number; w: number; h: number } | null>(null);
  const activity = useRef(new PanActivity());
  const [shown, setShown] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovering = useRef(false);
  const dragging = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  /** Full strength while the board is panned or the map is being used; the
   *  chosen opacity comes back ACTIVE_HOLD_MS after the last movement. Set
   *  on the element, not in React state: it changes on every pan frame. */
  const activeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markActive = useCallback((hold = true) => {
    const el = rootRef.current;
    if (!el) return;
    el.classList.add('active');
    if (activeTimer.current) clearTimeout(activeTimer.current);
    activeTimer.current = hold ? setTimeout(() => { if (!dragging.current) el.classList.remove('active'); }, ACTIVE_HOLD_MS) : null;
  }, []);
  const [size, setSize] = useState({ w: MAX_W, h: MAX_H });

  const settings = useRenderSettings();
  const position: MinimapPosition = settings.minimapPosition ?? 'center';
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Float placement in progress: where the map is under the pointer, px from
   *  the board panel's top-left. The map stays up the whole time. */
  const [placing, setPlacing] = useState<{ x: number; y: number } | null>(null);

  const visible = mode === 'always' || (mode === 'onPan' && shown) || placing !== null;

  const paint = useCallback(() => {
    const cv = canvasRef.current;
    const model = renderer?.getViewModel();
    if (!cv || !model) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const cb = contentBounds(model);
    const sel = boardStore.selection.partIndex;
    const sig = `${model.roots.map(r => r.m.join(',')).join('|')}|${model.board.parts.length}|${boardStore.showTop}${boardStore.showBottom}|${sel}|${mapSig()}|${renderSettingsStore.settings.minimapScale ?? 1}`;
    let base = baseRef.current;
    if (!base || base.sig !== sig) {
      // Fit the board into the (scaled) MAX_W × MAX_H box, keeping its aspect.
      const scale = renderSettingsStore.settings.minimapScale ?? 1;
      const k = Math.min((MAX_W * scale - 8) / cb.w, (MAX_H * scale - 8) / cb.h);
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
    const mk = marksRef.current;
    for (const c of [cv, mk]) {
      if (c && (c.width !== base.canvas.width || c.height !== base.canvas.height)) {
        c.width = base.canvas.width; c.height = base.canvas.height;
      }
    }
    const root = mapRoot(cv);
    // Scheme background on the frame (palette schemes), faded with the map;
    // '' falls back to the CSS chip.
    if (root) {
      const bg = mapColors().bg;
      root.style.setProperty('--mm-bg', bg ?? '');
      root.classList.toggle('scheme-bg', !!bg);
    }
    const bctx = cv.getContext('2d')!;
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.clearRect(0, 0, cv.width, cv.height);
    bctx.drawImage(base.canvas, 0, 0);
    if (!mk) return;
    const ctx = mk.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, mk.width, mk.height);
    const nav = renderSettingsStore.settings.minimapNav ?? 'history';
    if (nav === 'worklist') {
      if (root) root.dataset.trail = '0';
      paintWorklist(ctx, model, worklistStore.worklistForTab(tabId), base.k, base.ox, base.oy);
    } else {
      if (root) root.dataset.wlMarks = '0';
      if (renderSettingsStore.settings.minimapShowHistory !== false) {
        paintTrail(ctx, model, tabId, base.k, base.ox, base.oy, base.w, base.h, renderer!.viewSize());
      } else if (root) root.dataset.trail = '0';
    }
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
  }, [renderer, size.w, size.h, tabId]);

  // Follow the view; in onPan mode, feed the gesture counter.
  useEffect(() => {
    if (!renderer || mode === 'off') return;
    return renderer.onViewChange(({ userPan, dx, dy }) => {
      if (userPan) markActive();
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
  }, [renderer, mode, paint, markActive]);

  useEffect(() => () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (activeTimer.current) clearTimeout(activeTimer.current);
  }, []);
  // Selection / side changes repaint the board picture.
  useEffect(() => boardStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  // Hooks stay above the early return below.
  const history = useNavHistory();
  const nav = settings.minimapNav ?? 'history';
  const wl = nav === 'worklist' ? worklistStore.worklistForTab(tabId) : null;
  const wlKeys = worklistStepKeys(wl);
  const selPart = boardStore.selection.partIndex;
  const wlCur = currentWorklistKey(wlKeys,
    selPart !== null ? (renderer?.getViewModel()?.board.parts[selPart]?.name ?? null) : null,
    boardStore.selection.highlightedNet);
  const wlAt = wlCur ? wlKeys.indexOf(wlCur) : -1;
  const wlPrev = worklistStep(wlKeys, wlCur, -1);
  const wlNext = worklistStep(wlKeys, wlCur, 1);
  const goWl = (key: string | null) => {
    if (!key) return;
    const name = key.slice(2);
    if (key.startsWith('n:')) boardStore.focusNet(name); else boardStore.focusPart(name);
  };
  // Repaint when the trail switch flips (paint reads the store directly).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (visible) paint(); }, [settings.minimapShowHistory, settings.minimapHistorySteps, settings.minimapNav, settings.minimapScale]);
  // Worklist mode: re-render the header (position) and repaint on edits.
  useWorklist();
  useBoardStore();
  useEffect(() => worklistStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  // A new visit (or a step back/forward) moves the trail.
  useEffect(() => navHistoryStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  // A scheme switch repaints it in the new colours.
  useEffect(() => themeStore.subscribe(() => { if (visible) paint(); }), [visible, paint]);
  useEffect(() => { if (visible) paint(); }, [visible, paint]);

  const goTo = useCallback((e: React.PointerEvent) => {
    const base = baseRef.current, cv = canvasRef.current;
    if (!base || !cv || !renderer) return;
    const r = cv.getBoundingClientRect();
    const mx = (e.clientX - r.left) * (base.w / r.width), my = (e.clientY - r.top) * (base.h / r.height);
    renderer.centerOnWorld((mx - base.ox) / base.k, (my - base.oy) / base.k);
  }, [renderer]);

  // Float: follow the pointer inside the board panel until a click settles
  // it. Window capture listeners, so the settling press never reaches the
  // board (and its click is swallowed); Escape restores the old place.
  const startPlacing = useCallback(() => {
    const el = rootRef.current;
    const panel = el?.offsetParent as HTMLElement | null;
    if (!el || !panel) return;
    const z = uiZoom();
    const w = el.offsetWidth, h = el.offsetHeight;
    // Where left/top 0 is on screen: the panel's padding box. Taken from the
    // panel, never from the map's own rect — the map may be mid-transition
    // (its show/hide slide animates a transform), and that would offset
    // where it is put down by however far the animation had got.
    const pr = panel.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const originX = pr.left + panel.clientLeft * z, originY = pr.top + panel.clientTop * z;
    const clamp = (cx: number, cy: number) => ({
      x: Math.min(Math.max(0, cx), Math.max(0, panel.clientWidth - w)),
      y: Math.min(Math.max(0, cy), Math.max(0, panel.clientHeight - h)),
    });
    let at = clamp((er.left - originX) / z, (er.top - originY) / z);
    setPlacing(at);
    const move = (e: PointerEvent) => {
      at = clamp((e.clientX - originX) / z - w / 2, (e.clientY - originY) / z - h / 2);
      setPlacing(at);
    };
    const swallow = (e: Event) => { e.stopPropagation(); e.preventDefault(); };
    const end = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      setPlacing(null);
    };
    const down = (e: PointerEvent) => {
      swallow(e);
      if (e.button === 0) {
        move(e);
        renderSettingsStore.setMinimapPosition('floating', at);
        window.addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallow, true), 0);
      }
      end();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { swallow(e); end(); } };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
  }, []);

  if (mode === 'off' || !renderer) return null;

  const at = placing ?? (position === 'floating' ? { x: settings.minimapFloatX, y: settings.minimapFloatY } : null);
  const placeStyle: React.CSSProperties = at
    // Clamped in CSS as well: a panel made smaller later cannot carry it off.
    ? { left: `clamp(0px, ${at.x}px, calc(100% - ${Math.max(size.w, MIN_W) + FRAME}px))`, top: `clamp(0px, ${at.y}px, calc(100% - ${size.h + HEAD_H + FRAME}px))` }
    : {};
  const pick = (p: MinimapPosition) => () => {
    setMenu(null);
    if (p === 'floating') startPlacing(); else renderSettingsStore.setMinimapPosition(p);
  };
  const show = (m: MinimapMode) => () => { setMenu(null); renderSettingsStore.setMinimapMode(m); };
  const curMode = minimapMode(settings);

  return (
    <>
    <div
      ref={rootRef}
      className={`board-minimap pos-${at ? 'floating' : position}${visible ? ' visible' : ''}${placing ? ' placing' : ''}${settings.minimapOpaqueWhileActive === false ? ' keep-opacity' : ''}`}
      data-testid="board-minimap"
      data-visible={visible ? 'true' : 'false'}
      data-position={position}
      data-placing={placing ? 'true' : 'false'}
      style={{ width: Math.max(size.w, MIN_W) + FRAME, height: size.h + HEAD_H + FRAME, ...placeStyle, ['--mm-user' as string]: String(settings.minimapOpacity ?? 1) }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (!placing) setMenu({ x: e.clientX, y: e.clientY }); }}
      onPointerEnter={() => { hovering.current = true; }}
      onPointerLeave={() => { hovering.current = false; }}
      onPointerDown={e => {
        if (!visible || e.button !== 0 || placing) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        dragging.current = true;
        markActive(false);
        goTo(e);
      }}
      // Only a press that began on the map drags the view. A board drag that
      // merely crosses the map — which fades in under the very pan that is
      // being made — must not recentre on the map point (2026-10-22, "jumps
      // as if the map were being used").
      onPointerMove={e => { if (dragging.current && e.buttons & 1 && visible) goTo(e); }}
      onPointerUp={() => { dragging.current = false; markActive(); }}
      onPointerCancel={() => { dragging.current = false; markActive(); }}
      onLostPointerCapture={() => { dragging.current = false; markActive(); }}
    >
      <div className="minimap-head" data-testid="minimap-head" data-nav={nav}
        onPointerDown={e => e.stopPropagation()}>
        <button type="button" data-testid="minimap-history-back" aria-label={nav === 'worklist' ? 'Previous row' : 'Back'}
          title={nav === 'worklist' ? 'Previous worklist row' : 'Back'}
          disabled={nav === 'worklist' ? !wlPrev : !history.canBack}
          onClick={() => nav === 'worklist' ? goWl(wlPrev) : historyBack()}>
          <IconChevronLeft size={13} stroke={2.2} />
        </button>
        <button type="button" data-testid="minimap-history-forward" aria-label={nav === 'worklist' ? 'Next row' : 'Forward'}
          title={nav === 'worklist' ? (wlAt < 0 ? 'Start at the first worklist row' : 'Next worklist row') : 'Forward'}
          disabled={nav === 'worklist' ? !wlNext : !history.canForward}
          onClick={() => nav === 'worklist' ? goWl(wlNext) : historyForward()}>
          <IconChevronRight size={13} stroke={2.2} />
        </button>
        {nav === 'worklist' && (
          <span className="minimap-head-pos" data-testid="minimap-wl-pos" translate="no">
            {wlKeys.length === 0 ? (wl ? 'empty' : 'none') : wlAt < 0 ? String(wlKeys.length) : `${wlAt + 1}/${wlKeys.length}`}
          </span>
        )}
        <span className="minimap-head-fill" />
        <span className="minimap-head-seg" role="group" aria-label="Map shows">
          <button type="button" data-testid="minimap-nav-history" aria-pressed={nav === 'history'}
            className={nav === 'history' ? 'on' : ''} title="History: back / forward and recent visits"
            onClick={() => renderSettingsStore.setMinimapNav('history')}>
            <IconHistory size={13} stroke={2} />
          </button>
          <button type="button" data-testid="minimap-nav-worklist" aria-pressed={nav === 'worklist'}
            className={nav === 'worklist' ? 'on' : ''} title={wl ? `Worklist: step through “${wl.name}”` : 'Worklist: none loaded on this board'}
            onClick={() => renderSettingsStore.setMinimapNav('worklist')}>
            <IconChecklist size={13} stroke={2} />
          </button>
        </span>
        <button type="button" data-testid="minimap-open-tab" aria-label={nav === 'worklist' ? 'Open the Worklist tab' : 'Open the History tab'}
          title={nav === 'worklist' ? 'Open the Worklist tab' : 'Open the History tab'}
          onClick={() => nav === 'worklist' ? openBoardSidebarTab('worklist', tabId ?? undefined) : showSidebarTab('history')}>
          <IconExternalLink size={12} stroke={2} />
        </button>
      </div>
      <div className="minimap-body" style={{ width: size.w, height: size.h }}>
        <canvas ref={canvasRef} className="minimap-base" style={{ width: size.w, height: size.h }} />
        <canvas ref={marksRef} className="minimap-marks" style={{ width: size.w, height: size.h }} />
      </div>
    </div>
    {menu && (
      <QuickMenu
        x={menu.x}
        y={menu.y}
        onClose={() => setMenu(null)}
        ariaLabel="Minimap"
        testId="minimap-menu"
        items={[
          { kind: 'header', label: 'Position' },
          { kind: 'check', label: 'Left', checked: position === 'left', testId: 'minimap-pos-left', onSelect: pick('left') },
          { kind: 'check', label: 'Centre', checked: position === 'center', testId: 'minimap-pos-center', onSelect: pick('center') },
          { kind: 'check', label: 'Right', checked: position === 'right', testId: 'minimap-pos-right', onSelect: pick('right') },
          { kind: 'check', label: 'Float · click to put it down', checked: position === 'floating', testId: 'minimap-pos-floating', onSelect: pick('floating') },
          { kind: 'sep' },
          { kind: 'header', label: 'Show' },
          { kind: 'check', label: 'While panning', checked: curMode === 'onPan', testId: 'minimap-show-onPan', onSelect: show('onPan') },
          { kind: 'check', label: 'Always', checked: curMode === 'always', testId: 'minimap-show-always', onSelect: show('always') },
          { kind: 'check', label: 'Off', checked: curMode === 'off', testId: 'minimap-show-off', onSelect: show('off') },
          { kind: 'sep' },
          {
            kind: 'check', label: 'Show history', testId: 'minimap-show-history',
            hint: 'The parts and views you visited on this board in this session, newest strongest',
            checked: settings.minimapShowHistory !== false,
            onSelect: () => renderSettingsStore.setMinimapShowHistory(settings.minimapShowHistory === false),
          },
          {
            kind: 'range', label: 'Steps', testId: 'minimap-history-steps',
            value: settings.minimapHistorySteps ?? 8, min: 2, max: 20, step: 1,
            onChange: v => renderSettingsStore.setMinimapHistorySteps(v),
          },
          { kind: 'sep' },
          {
            kind: 'range', label: 'Size', testId: 'minimap-size',
            value: Math.round((settings.minimapScale ?? 1) * 100), min: 60, max: 200, step: 10,
            format: v => `${v} %`,
            onChange: v => renderSettingsStore.setMinimapScale(v / 100),
          },
          {
            kind: 'range', label: 'Opacity', testId: 'minimap-opacity',
            value: Math.round((settings.minimapOpacity ?? 1) * 100), min: 20, max: 100, step: 5,
            format: v => `${v} %`,
            onChange: v => renderSettingsStore.setMinimapOpacity(v / 100),
          },
          {
            kind: 'check', label: 'Full strength while in use', testId: 'minimap-opaque-active',
            hint: 'While the board is panned or the map is dragged',
            checked: settings.minimapOpaqueWhileActive !== false,
            onSelect: () => renderSettingsStore.setMinimapOpaqueWhileActive(settings.minimapOpaqueWhileActive === false),
          },
        ]}
      />
    )}
    </>
  );
}
