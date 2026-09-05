/**
 * Derive the presented BoardData from a raw parser output, given the tab's
 * `foldMode`, `selectedBoardIndex` and per-board side swaps.
 *
 * The derived board is what every downstream consumer operates on — scene
 * builder, hit-grid, net highlight, selection, side-flip UI. That way a
 * single transformation point keeps all of these in sync.
 *
 * The parser already does the heavy lifting for XZZ packs: it splits the
 * file into `board.boards`, folds every board (bottom half mirrored onto the
 * top half — pins, pads, silk, traces, vias, test pads, outline) and slides
 * the boards next to each other. What is left for the store is presentation:
 *
 *   select      keep one board, hide the rest (parts keep their array index
 *               with `hidden: true` so `selection.partIndex` stays stable;
 *               everything else is filtered by the board's bounds);
 *   swap        the user says a board's sides are the wrong way round —
 *               mirror that board across its own centre line and relabel
 *               top ↔ bottom, on every geometry kind;
 *   all-sides   show the file's raw layout: parts are moved back to their
 *               pre-fold positions over `rawOutline`, sides neutralised.
 *               Pads, silk, traces, vias and test pads carry no record of
 *               whether they were folded, so this view shows parts and
 *               outline only on packs.
 *
 * Files without `board.boards` (other formats, and XZZ files whose single
 * outline was cut by the legacy gap detector) keep the older behaviour:
 * "Show all sides" reverses `board.foldInfo` on parts and traces.
 */

import type { BoardData, Part, Pin, Net, Point, BBox } from '../parsers';
import { computeBBox } from '../parsers/types';

export type FoldMode = 'suggested' | 'all-sides';

type Board = NonNullable<BoardData['boards']>[number];

const EMPTY_SWAPS: ReadonlySet<number> = new Set<number>();

const inBox = (b: BBox, x: number, y: number, pad = 0.5): boolean =>
  x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;

const flipSide = <S extends 'top' | 'bottom' | 'both'>(s: S): S =>
  (s === 'top' ? 'bottom' : s === 'bottom' ? 'top' : s) as S;

export function deriveBoardView(
  board: BoardData,
  foldMode: FoldMode,
  selectedBoardIndex: number | null,
  swappedBoards: ReadonlySet<number> = EMPTY_SWAPS,
): BoardData {
  if (board.boards && board.boards.length > 0) {
    return derivePack(board, board.boards, foldMode, selectedBoardIndex, swappedBoards);
  }
  return deriveLegacy(board, foldMode, selectedBoardIndex);
}

/** Split a NaN-separated outline into sub-paths, keep those whose first
 *  point satisfies `keep`, and join them back. */
function filterOutline(outline: Point[], keep: (p: Point) => boolean): Point[] {
  const out: Point[] = [];
  let sub: Point[] = [];
  let keepSub = false;
  const flush = () => {
    if (sub.length > 0 && keepSub) {
      if (out.length > 0) out.push({ x: NaN, y: NaN });
      for (const p of sub) out.push(p);
    }
    sub = [];
    keepSub = false;
  };
  for (const p of outline) {
    if (Number.isNaN(p.x) || Number.isNaN(p.y)) { flush(); continue; }
    if (sub.length === 0) keepSub = keep(p);
    sub.push(p);
  }
  flush();
  return out;
}

/** Rebuild nets from the visible parts so no `pinIndices` entry points at a
 *  hidden part. Hit-grid and net-highlight read nets through this map, so
 *  hidden parts vanish from highlight/search automatically. */
function rebuildNets(parts: Part[]): Map<string, Net> {
  const nets = new Map<string, Net>();
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (part.hidden) continue;
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net || pin.net === '(null)' || pin.net === '') continue;
      let net = nets.get(pin.net);
      if (!net) { net = { name: pin.net, pinIndices: [] }; nets.set(pin.net, net); }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }
  return nets;
}

function viewBounds(outline: Point[], parts: Part[]): BBox {
  const pts = outline.filter(p => !Number.isNaN(p.x) && !Number.isNaN(p.y));
  return pts.length > 0
    ? computeBBox(pts)
    : computeBBox(parts.flatMap(p => p.hidden ? [] : p.pins.map(pin => pin.position)));
}

// ─────────────────────────────────────────────────────────────────────────
// Packs (parser-folded boards)
// ─────────────────────────────────────────────────────────────────────────

function derivePack(
  board: BoardData,
  boards: Board[],
  foldMode: FoldMode,
  selectedBoardIndex: number | null,
  swappedBoards: ReadonlySet<number>,
): BoardData {
  const sel = selectedBoardIndex != null && boards[selectedBoardIndex] ? selectedBoardIndex : null;
  const swaps = [...swappedBoards].filter(i => boards[i]?.fold);
  if (foldMode === 'suggested' && sel === null && swaps.length === 0) return board;

  if (foldMode === 'all-sides') return derivePackAllSides(board, boards, sel);

  // Which board a non-part item belongs to: by folded bounds, smallest first
  // so a sub-board inside a bigger board's envelope wins.
  const order = boards.map((b, i) => ({ i, a: (b.bounds.maxX - b.bounds.minX) * (b.bounds.maxY - b.bounds.minY) }))
    .sort((p, q) => p.a - q.a).map(o => o.i);
  const boardAt = (x: number, y: number): number => {
    for (const i of order) if (inBox(boards[i].bounds, x, y)) return i;
    return -1;
  };
  const keepIdx = (i: number) => sel === null || i === sel;
  const swapSet = new Set(swaps);

  // Mirror a point across board i's centre line along its fold dimension.
  const centre = (i: number): { dim: 'x' | 'y'; c: number } => {
    const b = boards[i];
    const dim = b.fold!.dim;
    return { dim, c: dim === 'x' ? (b.bounds.minX + b.bounds.maxX) / 2 : (b.bounds.minY + b.bounds.maxY) / 2 };
  };
  const mirrorPt = (p: Point, i: number): Point => {
    const { dim, c } = centre(i);
    return dim === 'x' ? { x: 2 * c - p.x, y: p.y } : { x: p.x, y: 2 * c - p.y };
  };
  const mirrorBox = (bb: BBox, i: number): BBox => {
    const { dim, c } = centre(i);
    return dim === 'x'
      ? { minX: 2 * c - bb.maxX, maxX: 2 * c - bb.minX, minY: bb.minY, maxY: bb.maxY }
      : { minX: bb.minX, maxX: bb.maxX, minY: 2 * c - bb.maxY, maxY: 2 * c - bb.minY };
  };

  const parts: Part[] = board.parts.map(part => {
    const bi = part.boardIndex ?? boardAt(part.origin.x, part.origin.y);
    if (!keepIdx(bi)) return { ...part, hidden: true };
    if (!swapSet.has(bi)) return part;
    const pins: Pin[] = part.pins.map(pin => ({
      ...pin,
      side: flipSide(pin.side),
      position: mirrorPt(pin.position, bi),
      ...(pin.padBounds ? { padBounds: mirrorBox(pin.padBounds, bi) } : {}),
    }));
    return { ...part, side: flipSide(part.side), origin: mirrorPt(part.origin, bi), bounds: mirrorBox(part.bounds, bi), pins };
  });

  const traces = board.traces?.flatMap(t => {
    const bi = boardAt((t.start.x + t.end.x) / 2, (t.start.y + t.end.y) / 2);
    if (!keepIdx(bi)) return [];
    if (!swapSet.has(bi)) return [t];
    return [{ ...t, start: mirrorPt(t.start, bi), end: mirrorPt(t.end, bi) }];
  });
  const pads = board.pads?.flatMap(p => {
    const bi = boardAt((p.bounds.minX + p.bounds.maxX) / 2, (p.bounds.minY + p.bounds.maxY) / 2);
    if (!keepIdx(bi)) return [];
    if (!swapSet.has(bi)) return [p];
    return [{
      ...p, side: flipSide(p.side), bounds: mirrorBox(p.bounds, bi),
      ...(p.polygon ? { polygon: p.polygon.map(q => mirrorPt(q, bi)) } : {}),
    }];
  });
  const silkscreen = board.silkscreen?.flatMap(s => {
    const p0 = s.points[0];
    if (!p0) return [];
    const bi = boardAt(p0.x, p0.y);
    if (!keepIdx(bi)) return [];
    if (!swapSet.has(bi)) return [s];
    return [{ ...s, side: flipSide(s.side), points: s.points.map(q => mirrorPt(q, bi)) }];
  });
  const vias = board.vias?.flatMap(v => {
    const bi = boardAt(v.position.x, v.position.y);
    if (!keepIdx(bi)) return [];
    if (!swapSet.has(bi)) return [v];
    return [{ ...v, position: mirrorPt(v.position, bi) }];
  });
  const nails = board.nails.flatMap(n => {
    const bi = boardAt(n.position.x, n.position.y);
    if (!keepIdx(bi)) return [];
    if (!swapSet.has(bi)) return [n];
    return [{ ...n, side: flipSide(n.side), position: mirrorPt(n.position, bi) }];
  });
  // Outline sub-paths: keep the selected board's; a swapped board's outline
  // is mirrored too so cutouts stay where the parts went.
  const outline = (() => {
    const kept = filterOutline(board.outline, p => keepIdx(boardAt(p.x, p.y)));
    if (swapSet.size === 0) return kept;
    let bi = -1;
    return kept.map(p => {
      if (Number.isNaN(p.x)) { bi = -1; return p; }
      if (bi === -1) bi = boardAt(p.x, p.y);
      return swapSet.has(bi) ? mirrorPt(p, bi) : p;
    });
  })();

  const nets = rebuildNets(parts);
  const bounds = viewBounds(outline, parts);
  return { ...board, outline, parts, traces, pads, silkscreen, vias, nails, nets, bounds };
}

/** Raw layout: undo the parser's slide and fold per board. Parts and outline
 *  only — see the header comment. */
function derivePackAllSides(board: BoardData, boards: Board[], sel: number | null): BoardData {
  const comps = board.foldComponents ?? [];
  const keepIdx = (i: number) => sel === null || i === sel;
  const unfoldPt = (p: Point, b: Board, mirror: boolean): Point => {
    let x = p.x - b.shift.dx, y = p.y - b.shift.dy;
    if (mirror && b.fold) {
      if (b.fold.dim === 'x') x = 2 * b.fold.axis - x; else y = 2 * b.fold.axis - y;
    }
    return { x, y };
  };
  const unfoldBox = (bb: BBox, b: Board, mirror: boolean): BBox => {
    const a = unfoldPt({ x: bb.minX, y: bb.minY }, b, mirror);
    const c = unfoldPt({ x: bb.maxX, y: bb.maxY }, b, mirror);
    return { minX: Math.min(a.x, c.x), maxX: Math.max(a.x, c.x), minY: Math.min(a.y, c.y), maxY: Math.max(a.y, c.y) };
  };
  const parts: Part[] = board.parts.map(part => {
    const bi = part.boardIndex ?? -1;
    if (!keepIdx(bi)) return { ...part, hidden: true };
    const b = bi >= 0 ? boards[bi] : null;
    if (!b) return part.side === 'top' ? part : { ...part, side: 'top', pins: part.pins.map(p => ({ ...p, side: 'top' as const })) };
    const mirror = part.side === 'bottom';
    const pins: Pin[] = part.pins.map(pin => ({
      ...pin, side: 'top' as const, position: unfoldPt(pin.position, b, mirror),
      ...(pin.padBounds ? { padBounds: unfoldBox(pin.padBounds, b, mirror) } : {}),
    }));
    return { ...part, side: 'top', origin: unfoldPt(part.origin, b, mirror), bounds: unfoldBox(part.bounds, b, mirror), pins };
  });
  // Raw outline: every loop, or the selected board's loops (its components'
  // pre-fold bboxes).
  const source = board.rawOutline ?? board.outline;
  const outline = sel === null
    ? source
    : filterOutline(source, p => boards[sel].components.some(ci => comps[ci] && inBox(comps[ci], p.x, p.y)));
  const nets = rebuildNets(parts);
  const bounds = viewBounds(outline, parts);
  return {
    ...board, outline, parts, nets, bounds,
    traces: undefined, pads: undefined, silkscreen: undefined, vias: undefined, nails: [],
    butterflyFoldAxis: undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Legacy (no parser boards)
// ─────────────────────────────────────────────────────────────────────────

function deriveLegacy(board: BoardData, foldMode: FoldMode, selectedBoardIndex: number | null): BoardData {
  const groups = board.boardGroups;
  const selectedGroup = selectedBoardIndex != null && groups != null ? groups[selectedBoardIndex] ?? null : null;
  const hasSelection = selectedGroup !== null;
  const reverse = foldMode === 'all-sides' && board.foldInfo != null;
  if (!hasSelection && !reverse && foldMode !== 'all-sides') return board;

  const comps = board.foldComponents ?? [];
  const kept: BBox[] = hasSelection
    ? (selectedGroup!.components.map(i => comps[i]).filter(b => b != null) as BBox[])
    : [];
  const belongs = (x: number, y: number): boolean => !hasSelection || kept.some(b => inBox(b, x, y));

  const f = reverse ? board.foldInfo! : null;
  const mirrorPt = (p: Point): Point => !f ? p
    : f.dim === 'x' ? { x: 2 * f.axis - p.x, y: p.y } : { x: p.x, y: 2 * f.axis - p.y };

  const parts: Part[] = board.parts.map(part => {
    if (!belongs(part.origin.x, part.origin.y)) return { ...part, hidden: true };
    const mirror = f !== null && part.side === 'bottom';
    if (!mirror && part.side === 'top') return part;
    const bounds = mirror && f
      ? f.dim === 'x'
        ? { minX: 2 * f.axis - part.bounds.maxX, maxX: 2 * f.axis - part.bounds.minX, minY: part.bounds.minY, maxY: part.bounds.maxY }
        : { minX: part.bounds.minX, maxX: part.bounds.maxX, minY: 2 * f.axis - part.bounds.maxY, maxY: 2 * f.axis - part.bounds.minY }
      : part.bounds;
    const pins: Pin[] = part.pins.map(pin => ({ ...pin, side: 'top' as const, position: mirror ? mirrorPt(pin.position) : pin.position }));
    return { ...part, side: 'top', origin: mirror ? mirrorPt(part.origin) : part.origin, bounds, pins };
  });

  let traces = board.traces;
  if (board.traces && (hasSelection || f)) {
    traces = board.traces.flatMap(t => {
      const mx = (t.start.x + t.end.x) / 2, my = (t.start.y + t.end.y) / 2;
      if (!belongs(mx, my)) return [];
      if (!f) return [t];
      const c = f.dim === 'x' ? mx : my;
      const isBottom = f.lowerIsBottom ? c < f.axis : c > f.axis;
      return [isBottom ? { ...t, start: mirrorPt(t.start), end: mirrorPt(t.end) } : t];
    });
  }

  const source = board.rawOutline ?? board.outline;
  const outline = filterOutline(source, p => belongs(p.x, p.y));
  const nets = rebuildNets(parts);
  const bounds = viewBounds(outline, parts);
  const butterflyFoldAxis = foldMode === 'all-sides' || hasSelection ? undefined : board.butterflyFoldAxis;
  return { ...board, outline, parts, traces, bounds, nets, butterflyFoldAxis };
}
