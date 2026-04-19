/**
 * Derive the presented BoardData from a raw parser output, given the current
 * `foldMode` and `selectedBoardIndex` tab state.
 *
 * The derived board is what every downstream consumer operates on — scene
 * builder, hit-grid, net highlight, selection, side-flip UI. That way a
 * single transformation point keeps all of these in sync.
 *
 * Three transform modes emerge from the state:
 *   forward-fold   selectedGroup + suggested + group.fold present
 *                  Multi-board files. Classify parts by position relative to
 *                  the group's fold axis; mirror bottom-half parts onto the
 *                  top half and tag `side: 'bottom'` so existing
 *                  top/bottom/butterfly UI works normally. Outline keeps
 *                  only the "top" component's sub-paths (bottom component's
 *                  outline mirrors onto it).
 *   reverse-fold   no selection + all-sides + board.foldInfo present
 *                  Butterfly files the parser already folded. Mirror back
 *                  and neutralise sides.
 *   filter-only    any selection + all-sides view
 *                  Keep the selected group's components at raw positions;
 *                  neutralise sides to 'top'. No mirroring.
 *   passthrough    everything else — return raw board unchanged.
 *
 * Parts that fall outside the kept component bboxes keep their array index
 * (so `selection.partIndex` stays stable across filter changes) but get
 * `hidden: true` flagged. `nets` is rebuilt to exclude their pins.
 */

import type { BoardData, Part, Pin, Net } from '../parsers';
import { computeBBox } from '../parsers/types';

/** Subset of a component bbox used for containment checks — `foldComponents`
 *  entries also carry `segCount` which we don't need here. */
type BBoxLike = { minX: number; minY: number; maxX: number; maxY: number };

export type FoldMode = 'suggested' | 'all-sides';

type Mode = 'forward' | 'reverse' | 'filter-only' | 'passthrough';
type FoldSpec = { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean };

const IDENTITY = <T extends { x: number; y: number }>(p: T): T => p;

export function deriveBoardView(
  board: BoardData,
  foldMode: FoldMode,
  selectedBoardIndex: number | null,
): BoardData {
  const groups = board.boardGroups;
  const selectedGroup =
    selectedBoardIndex != null && groups != null ? groups[selectedBoardIndex] ?? null : null;
  const hasSelection = selectedGroup !== null;

  let mode: Mode;
  let foldToUse: FoldSpec | null;
  if (selectedGroup && foldMode === 'suggested' && selectedGroup.fold) {
    mode = 'forward';
    foldToUse = selectedGroup.fold;
  } else if (!hasSelection && foldMode === 'all-sides' && board.foldInfo) {
    mode = 'reverse';
    foldToUse = board.foldInfo;
  } else if (hasSelection || foldMode === 'all-sides') {
    mode = 'filter-only';
    foldToUse = null;
  } else {
    mode = 'passthrough';
    foldToUse = null;
  }
  if (mode === 'passthrough') return board;

  // Selection-only data: kept bboxes for filtering. When nothing is selected,
  // every part/trace/outline-point is kept — skip the array setup entirely.
  const componentBBoxes = board.foldComponents ?? [];
  const keptBBoxes: BBoxLike[] = hasSelection
    ? selectedGroup!.components
        .map(i => componentBBoxes[i])
        .filter(b => b != null) as BBoxLike[]
    : [];

  const bboxContainsPt = (bb: BBoxLike, x: number, y: number, pad = 0.5): boolean =>
    x >= bb.minX - pad && x <= bb.maxX + pad && y >= bb.minY - pad && y <= bb.maxY + pad;
  const belongsToKept = (x: number, y: number): boolean => {
    if (!hasSelection) return true;
    for (const bb of keptBBoxes) if (bboxContainsPt(bb, x, y)) return true;
    return false;
  };

  // Forward-fold: outline is drawn from only the "top" component of the
  // selected group — the bottom one mirrors onto it and would superimpose.
  const topComponentBBox: BBoxLike | null = (() => {
    if (mode !== 'forward' || !selectedGroup || !foldToUse) return null;
    for (const ci of selectedGroup.components) {
      const bb = componentBBoxes[ci];
      if (!bb) continue;
      const c = foldToUse.dim === 'x' ? (bb.minX + bb.maxX) / 2 : (bb.minY + bb.maxY) / 2;
      const isBottom = foldToUse.lowerIsBottom ? c < foldToUse.axis : c > foldToUse.axis;
      if (!isBottom) return bb;
    }
    return null;
  })();
  const belongsToTopOnly = (x: number, y: number): boolean =>
    !topComponentBBox || bboxContainsPt(topComponentBBox, x, y);

  // When `foldToUse` is null we still want a callable function — the callers
  // that guarded `mirrorPt && ...` can just call it unconditionally now.
  const mirrorPt = foldToUse
    ? (p: { x: number; y: number }) => foldToUse!.dim === 'x'
      ? { x: 2 * foldToUse!.axis - p.x, y: p.y }
      : { x: p.x, y: 2 * foldToUse!.axis - p.y }
    : IDENTITY;

  const isPartOnBottom = (x: number, y: number): boolean => {
    if (!foldToUse) return false;
    const c = foldToUse.dim === 'x' ? x : y;
    return foldToUse.lowerIsBottom ? c < foldToUse.axis : c > foldToUse.axis;
  };

  // OUTLINE — rawOutline has both halves; filter to whichever bboxes apply.
  const sourceOutline = board.rawOutline ?? board.outline;
  const outline: typeof board.outline = [];
  {
    let subPath: typeof board.outline = [];
    let subPathKeep = false;
    const flush = () => {
      if (subPath.length > 0 && subPathKeep) {
        if (outline.length > 0) outline.push({ x: NaN, y: NaN });
        for (const p of subPath) outline.push(p);
      }
      subPath = [];
      subPathKeep = false;
    };
    for (const p of sourceOutline) {
      if (Number.isNaN(p.x) || Number.isNaN(p.y)) { flush(); continue; }
      if (!subPathKeep) {
        subPathKeep = mode === 'forward' ? belongsToTopOnly(p.x, p.y) : belongsToKept(p.x, p.y);
      }
      subPath.push(p);
    }
    flush();
  }

  // PARTS — preserve array length (so selection.partIndex stays valid). Parts
  // outside kept bboxes get `hidden: true`; visible parts may be transformed.
  // When nothing changes (same side, no mirror) return `part` verbatim so
  // downstream reference-equality checks short-circuit.
  const parts: Part[] = board.parts.map(part => {
    const kept = belongsToKept(part.origin.x, part.origin.y);
    if (!kept) return { ...part, hidden: true };

    let shouldMirror = false;
    let newSide: 'top' | 'bottom';
    if (mode === 'forward') {
      if (isPartOnBottom(part.origin.x, part.origin.y)) {
        shouldMirror = true;
        newSide = 'bottom';
      } else {
        newSide = 'top';
      }
    } else if (mode === 'reverse') {
      if (part.side === 'bottom') shouldMirror = true;
      newSide = 'top';
    } else {
      newSide = 'top';
    }

    if (!shouldMirror && part.side === newSide) return part;

    const origin = shouldMirror ? mirrorPt(part.origin) : part.origin;
    const bounds = shouldMirror && foldToUse
      ? foldToUse.dim === 'x'
        ? { minX: 2 * foldToUse.axis - part.bounds.maxX, maxX: 2 * foldToUse.axis - part.bounds.minX, minY: part.bounds.minY, maxY: part.bounds.maxY }
        : { minX: part.bounds.minX, maxX: part.bounds.maxX, minY: 2 * foldToUse.axis - part.bounds.maxY, maxY: 2 * foldToUse.axis - part.bounds.minY }
      : part.bounds;
    const pins: Pin[] = shouldMirror
      ? part.pins.map(pin => ({ ...pin, side: newSide, position: mirrorPt(pin.position) }))
      : part.pins.map(pin => (pin.side === newSide ? pin : { ...pin, side: newSide }));
    return { ...part, side: newSide, origin, bounds, pins };
  });

  // TRACES — filter + mirror in a single pass; skip intermediate filtered array.
  let traces: BoardData['traces'];
  if (board.traces) {
    const out: NonNullable<BoardData['traces']> = [];
    for (const t of board.traces) {
      const mx = (t.start.x + t.end.x) / 2;
      const my = (t.start.y + t.end.y) / 2;
      if (hasSelection && !belongsToKept(mx, my)) continue;
      if (foldToUse) {
        const c = foldToUse.dim === 'x' ? mx : my;
        const isBottom = foldToUse.lowerIsBottom ? c < foldToUse.axis : c > foldToUse.axis;
        out.push(isBottom ? { ...t, start: mirrorPt(t.start), end: mirrorPt(t.end) } : t);
      } else {
        out.push(t);
      }
    }
    traces = out;
  } else {
    traces = board.traces;
  }

  // NETS — rebuild from visible parts only so net.pinIndices never points to
  // a hidden part. Hit-grid and net-highlight code read nets via this rebuilt
  // map, so hidden parts vanish from highlight/search automatically.
  const nets = new Map<string, Net>();
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    if (part.hidden) continue;
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net || pin.net === '(null)' || pin.net === '') continue;
      let net = nets.get(pin.net);
      if (!net) {
        net = { name: pin.net, pinIndices: [] };
        nets.set(pin.net, net);
      }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }

  // Recompute board-level bounds so the viewport auto-frames the view.
  // Outline alone is authoritative when it exists (covers the board area);
  // fall back to pin positions only when the outline is empty / all-NaN.
  const outlinePts = outline.filter(p => !Number.isNaN(p.x) && !Number.isNaN(p.y));
  const bounds = outlinePts.length > 0
    ? computeBBox(outlinePts)
    : computeBBox(parts.flatMap(p => p.hidden ? [] : p.pins.map(pin => pin.position)));

  // Set `butterflyFoldAxis` only in forward-fold mode so the existing flip UI
  // treats the selected multi-board view as a normal butterfly board. Clear
  // it in reverse/filter-only modes (everything is neutralised to 'top').
  const butterflyFoldAxis =
    mode === 'forward' && foldToUse ? foldToUse.dim
    : mode === 'reverse' || mode === 'filter-only' ? undefined
    : board.butterflyFoldAxis;

  return { ...board, outline, parts, traces, bounds, nets, butterflyFoldAxis };
}
