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

type FoldMode = 'suggested' | 'all-sides';
type Mode = 'forward' | 'reverse' | 'filter-only' | 'passthrough';

export function deriveBoardView(
  board: BoardData,
  foldMode: FoldMode,
  selectedBoardIndex: number | null,
): BoardData {
  const groups = board.boardGroups;
  const hasSelection = selectedBoardIndex != null && groups != null && groups[selectedBoardIndex] != null;
  const selectedGroup = hasSelection ? groups![selectedBoardIndex!] : null;

  type FoldSpec = { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean };
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

  const componentBBoxes = board.foldComponents ?? [];
  const keptComponents = hasSelection ? selectedGroup!.components : componentBBoxes.map((_, i) => i);
  const keptBBoxes = keptComponents.map(i => componentBBoxes[i]).filter(b => b != null);

  function bboxContainsPt(
    bb: { minX: number; minY: number; maxX: number; maxY: number },
    x: number,
    y: number,
    pad = 0.5,
  ): boolean {
    return x >= bb.minX - pad && x <= bb.maxX + pad && y >= bb.minY - pad && y <= bb.maxY + pad;
  }
  function belongsToKept(x: number, y: number): boolean {
    if (!hasSelection) return true;
    for (const bb of keptBBoxes) if (bboxContainsPt(bb, x, y)) return true;
    return false;
  }

  // Forward-fold: outline is drawn from only the "top" component of the
  // selected group — the bottom one mirrors onto it and would superimpose.
  const topComponentBBox = (() => {
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
  function belongsToTopOnly(x: number, y: number): boolean {
    if (!topComponentBBox) return true;
    return bboxContainsPt(topComponentBBox, x, y);
  }

  const mirrorPt = foldToUse
    ? (p: { x: number; y: number }) => foldToUse!.dim === 'x'
      ? { x: 2 * foldToUse!.axis - p.x, y: p.y }
      : { x: p.x, y: 2 * foldToUse!.axis - p.y }
    : null;

  function isPartOnBottom(x: number, y: number): boolean {
    if (!foldToUse) return false;
    const c = foldToUse.dim === 'x' ? x : y;
    return foldToUse.lowerIsBottom ? c < foldToUse.axis : c > foldToUse.axis;
  }

  // OUTLINE — source is rawOutline when we're doing anything non-passthrough.
  const sourceOutline = board.rawOutline ?? board.outline;
  let outline: typeof board.outline;
  {
    const out: typeof board.outline = [];
    let subPath: typeof board.outline = [];
    let subPathKeep = false;
    const flush = () => {
      if (subPath.length > 0 && subPathKeep) {
        if (out.length > 0) out.push({ x: NaN, y: NaN });
        for (const p of subPath) out.push(p);
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
    outline = out;
  }

  // PARTS — preserve array length (so selection.partIndex stays valid). Parts
  // outside kept bboxes get `hidden: true`; visible parts may be transformed.
  const parts: Part[] = board.parts.map(part => {
    const kept = hasSelection ? belongsToKept(part.origin.x, part.origin.y) : true;
    if (!kept) return { ...part, hidden: true };

    let shouldMirror = false;
    let newSide: 'top' | 'bottom' = 'top';
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

    const origin = shouldMirror && mirrorPt ? mirrorPt(part.origin) : part.origin;
    const bounds = shouldMirror && foldToUse
      ? (foldToUse.dim === 'x'
        ? { minX: 2 * foldToUse.axis - part.bounds.maxX, maxX: 2 * foldToUse.axis - part.bounds.minX, minY: part.bounds.minY, maxY: part.bounds.maxY }
        : { minX: part.bounds.minX, maxX: part.bounds.maxX, minY: 2 * foldToUse.axis - part.bounds.maxY, maxY: 2 * foldToUse.axis - part.bounds.minY })
      : part.bounds;
    const pins: Pin[] = shouldMirror && mirrorPt
      ? part.pins.map(pin => ({ ...pin, side: newSide, position: mirrorPt(pin.position) }))
      : part.pins.map(pin => ({ ...pin, side: newSide }));
    return { ...part, side: newSide, origin, bounds, pins };
  });

  // TRACES — filter by midpoint and mirror bottom-side when a fold is active.
  const traces = board.traces
    ? board.traces
        .filter(t => {
          if (!hasSelection) return true;
          const mx = (t.start.x + t.end.x) / 2;
          const my = (t.start.y + t.end.y) / 2;
          return belongsToKept(mx, my);
        })
        .map(t => {
          if (!mirrorPt || !foldToUse) return t;
          const mx = foldToUse.dim === 'x' ? (t.start.x + t.end.x) / 2 : (t.start.y + t.end.y) / 2;
          const isBottom = foldToUse.lowerIsBottom ? mx < foldToUse.axis : mx > foldToUse.axis;
          if (!isBottom) return t;
          return { ...t, start: mirrorPt(t.start), end: mirrorPt(t.end) };
        })
    : board.traces;

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
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of outline) {
    if (Number.isNaN(pt.x) || Number.isNaN(pt.y)) continue;
    if (pt.x < minX) minX = pt.x; if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x; if (pt.y > maxY) maxY = pt.y;
  }
  for (const part of parts) {
    if (part.hidden) continue;
    for (const pin of part.pins) {
      if (pin.position.x < minX) minX = pin.position.x;
      if (pin.position.y < minY) minY = pin.position.y;
      if (pin.position.x > maxX) maxX = pin.position.x;
      if (pin.position.y > maxY) maxY = pin.position.y;
    }
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const bounds = { minX, minY, maxX, maxY };

  // Set `butterflyFoldAxis` only in forward-fold mode so the existing flip UI
  // treats the selected multi-board view as a normal butterfly board. Clear
  // it in reverse/filter-only modes (everything is neutralised to 'top').
  const butterflyFoldAxis =
    mode === 'forward' && foldToUse ? foldToUse.dim
    : mode === 'reverse' || mode === 'filter-only' ? undefined
    : board.butterflyFoldAxis;

  return { ...board, outline, parts, traces, bounds, nets, butterflyFoldAxis };
}
