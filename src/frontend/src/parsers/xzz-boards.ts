/**
 * XZZ board packs — splitting one `.pcb` into its physical boards and deciding
 * which half of each board is the top.
 *
 * An XZZ file draws every board twice, side by side: the top as seen from
 * above and the bottom as seen from below, each as its own closed loop on
 * layer 28. iPhone "AP+BB" packs put two such boards next to each other, so a
 * file holds four large loops plus whatever cutouts, fiducials and frames the
 * exporter drew. Everything here is pure geometry on the outline-component
 * bboxes so it can be unit-tested without a fixture.
 *
 * What the corpus taught (2026-09-05, 346 files, see
 * docs/specs/2026-09-05-xzz-multi-board-unfold-review.md):
 *
 * - Halves are mirror images, but the exact `(w, h, segCount)` key the old
 *   grouper used breaks on a one-segment difference (iPhone 5) and on a
 *   bottom half with an extra notch (XS Max boardview). Pairing is a score.
 * - Cutouts are separate loops nested inside a board loop; the iPhone 6/6s/8
 *   files carry up to 26 of them. They belong to the board, they are not
 *   boards.
 * - The part header has no side field. Side comes from copper when the file
 *   has traces (every pin of a half sits on the first copper layer or on the
 *   last, never mixed), and otherwise from the exporter's layout invariant:
 *   the design's top half is at the lower coordinate of the pair, unless the
 *   whole file is stored mirrored, in which case it is at the higher one.
 */

import type { Point } from './types';

export interface OutlineComponent {
  minX: number; minY: number; maxX: number; maxY: number;
  segCount: number;
  /** Indices into the parser's segment list. */
  segIdxs: number[];
}

export type ComponentClass = 'major' | 'cutout' | 'fragment' | 'frame';

export interface ComponentClassification {
  cls: ComponentClass[];
  /** For a cutout, the index of the major component it sits inside. */
  parentOf: Array<number | undefined>;
  majors: number[];
}

const bboxArea = (c: OutlineComponent): number => Math.max(0, c.maxX - c.minX) * Math.max(0, c.maxY - c.minY);

function contains(outer: OutlineComponent, inner: OutlineComponent, tol = 1): boolean {
  return inner.minX >= outer.minX - tol && inner.maxX <= outer.maxX + tol &&
         inner.minY >= outer.minY - tol && inner.maxY <= outer.maxY + tol;
}

/** Sort outline components into boards ("major"), holes drawn inside a board
 *  ("cutout"), decorative leftovers ("fragment": tiny and empty), and the
 *  occasional plain rectangle drawn around everything ("frame").
 *
 *  `partCount[i]` is how many parts have their centroid inside component i's
 *  bbox — a loop with parts in it is never a fragment, however small. */
export function classifyComponents(comps: OutlineComponent[], partCount: number[]): ComponentClassification {
  const n = comps.length;
  const cls: ComponentClass[] = new Array(n).fill('major');
  const parentOf: Array<number | undefined> = new Array(n).fill(undefined);
  if (n === 0) return { cls, parentOf, majors: [] };
  const area = comps.map(bboxArea);
  const maxArea = Math.max(...area);

  // Frames first: a 4-segment rectangle that encloses two or more sizeable
  // loops and has no parts of its own that aren't also inside those loops.
  // Without this the frame would be the largest component and demote every
  // real board to a cutout.
  for (let i = 0; i < n; i++) {
    if (comps[i].segCount > 4) continue;
    let enclosed = 0;
    for (let j = 0; j < n; j++) {
      if (j === i || area[j] < area[i] * 0.05) continue;
      if (contains(comps[i], comps[j])) enclosed++;
    }
    if (enclosed >= 2) cls[i] = 'frame';
  }

  // Cutouts: nested inside a larger non-frame component. The parent is the
  // smallest such container, resolved through nesting so a hole inside a
  // hole still lands on the board.
  for (let i = 0; i < n; i++) {
    if (cls[i] === 'frame') continue;
    let best = -1;
    for (let j = 0; j < n; j++) {
      if (j === i || cls[j] === 'frame' || area[j] <= area[i]) continue;
      if (!contains(comps[j], comps[i])) continue;
      if (best < 0 || area[j] < area[best]) best = j;
    }
    if (best >= 0) { cls[i] = 'cutout'; parentOf[i] = best; }
  }
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'cutout') continue;
    let p = parentOf[i]!;
    let guard = 0;
    while (cls[p] === 'cutout' && guard++ < n) p = parentOf[p]!;
    parentOf[i] = p;
  }

  // Fragments: tiny and empty. 1 % of the largest board is far below any
  // sub-board seen (the iPhone 17 Air SUB is 13 %, the XS Max PA regions 11 %).
  for (let i = 0; i < n; i++) {
    if (cls[i] !== 'major') continue;
    if (area[i] < maxArea * 0.01 && (partCount[i] ?? 0) === 0) cls[i] = 'fragment';
    // An empty plain rectangle beside the boards is a drawing aid (a sheet
    // border, a placement guide), not a board — XS "plug charging" file.
    else if (comps[i].segCount <= 4 && (partCount[i] ?? 0) === 0) cls[i] = 'fragment';
  }

  const majors: number[] = [];
  for (let i = 0; i < n; i++) if (cls[i] === 'major') majors.push(i);
  return { cls, parentOf, majors };
}

export interface ComponentPair {
  /** The two major components, in ascending coordinate order along `dim`. */
  lower: number;
  upper: number;
  dim: 'x' | 'y';
  /** Fold axis midway across the gap, in the components' coordinate frame. */
  axis: number;
  gap: number;
  score: number;
}

/** Pair major components that are mirror images placed side by side.
 *
 *  Two halves match when their bbox dimensions agree within `tol`, they do
 *  not overlap on the separation axis, they overlap almost fully on the
 *  other axis, and the gap between them is small compared to their size
 *  (20 mil on every modern file, up to ~280 mil on iPhone 4/5 era exports).
 *  Candidates are ranked by dimension mismatch first, then gap, then segment
 *  count difference, and taken greedily — so two identical boards next to
 *  each other still pair with their own neighbour. */
export function pairMajors(comps: OutlineComponent[], majors: number[]): { pairs: ComponentPair[]; singles: number[] } {
  const cands: ComponentPair[] = [];
  for (let ia = 0; ia < majors.length; ia++) {
    for (let ib = ia + 1; ib < majors.length; ib++) {
      const a = comps[majors[ia]], b = comps[majors[ib]];
      const wa = a.maxX - a.minX, ha = a.maxY - a.minY;
      const wb = b.maxX - b.minX, hb = b.maxY - b.minY;
      const tol = Math.max(3, 0.002 * Math.max(wa, ha, wb, hb));
      const dw = Math.abs(wa - wb), dh = Math.abs(ha - hb);
      if (dw > tol || dh > tol) continue;
      const xSep = a.maxX <= b.minX || b.maxX <= a.minX;
      const ySep = a.maxY <= b.minY || b.maxY <= a.minY;
      if (xSep === ySep) continue; // overlapping, or diagonal neighbours
      const dim: 'x' | 'y' = xSep ? 'x' : 'y';
      const [lo, hi] = dim === 'x'
        ? (a.minX <= b.minX ? [a, b] : [b, a])
        : (a.minY <= b.minY ? [a, b] : [b, a]);
      const gap = dim === 'x' ? hi.minX - lo.maxX : hi.minY - lo.maxY;
      const across = dim === 'x' ? Math.min(ha, hb) : Math.min(wa, wb);
      const overlap = dim === 'x'
        ? Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY)
        : Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      if (overlap < across * 0.8) continue;
      const maxGap = Math.max(300, 0.3 * Math.min(wa, ha));
      if (gap > maxGap) continue;
      const axis = dim === 'x' ? (lo.maxX + hi.minX) / 2 : (lo.maxY + hi.minY) / 2;
      const score = dw + dh + gap * 0.05 + Math.abs(a.segCount - b.segCount) * 0.001;
      cands.push({
        lower: lo === a ? majors[ia] : majors[ib],
        upper: lo === a ? majors[ib] : majors[ia],
        dim, axis, gap, score,
      });
    }
  }
  cands.sort((p, q) => p.score - q.score);
  const used = new Set<number>();
  const pairs: ComponentPair[] = [];
  for (const c of cands) {
    if (used.has(c.lower) || used.has(c.upper)) continue;
    used.add(c.lower); used.add(c.upper);
    pairs.push(c);
  }
  const singles = majors.filter(m => !used.has(m));
  return { pairs, singles };
}

/** Per-component copper evidence: how many of its pins have a trace endpoint
 *  on the file's first copper layer versus its last. */
export interface CopperVotes { first: number; last: number }

export interface SideDecision {
  top: number;
  bottom: number;
  source: 'copper' | 'layout';
  /** Set when a CPU-rule prior was supplied and it points at the other
   *  half — logged so the corpus keeps telling us how often the two differ. */
  cpuDisagrees?: boolean;
}

/** Decide which half of a pair is the top.
 *
 *  Copper wins when it is decisive (at least 20 routed pins and a 4:1
 *  margin). Otherwise the exporter's layout rule applies: for halves side
 *  by side the left one (lower x) is the top; for halves stacked vertically
 *  the upper one (higher y — XZZ's raw frame is y-up) is the top. Verified
 *  against copper on 78 of 78 trace-carrying files, MacBook and iPhone alike,
 *  including every file whose pin winding says it is stored mirrored — so
 *  mirroring does not move the halves. `cpuTop` (the most-pinned part's
 *  half) is only compared against the decision, never used to make it: it
 *  is right on MacBooks and a coin flip on iPhone sandwich boards. */
export function decideSide(
  pair: ComponentPair,
  votes: CopperVotes[] | null,
  cpuTop: number | null,
): SideDecision {
  const withCpu = (d: SideDecision): SideDecision =>
    cpuTop !== null && (cpuTop === pair.lower || cpuTop === pair.upper) && cpuTop !== d.top
      ? { ...d, cpuDisagrees: true }
      : d;
  if (votes) {
    const lo = votes[pair.lower], hi = votes[pair.upper];
    if (lo && hi) {
      const loTop = lo.first + hi.last;   // lower half is L1, upper is last
      const hiTop = hi.first + lo.last;
      const win = Math.max(loTop, hiTop), lose = Math.min(loTop, hiTop);
      if (win >= 20 && win >= lose * 4) {
        return withCpu(loTop >= hiTop
          ? { top: pair.lower, bottom: pair.upper, source: 'copper' }
          : { top: pair.upper, bottom: pair.lower, source: 'copper' });
      }
    }
  }
  const lowerIsTop = pair.dim === 'x';
  return withCpu(lowerIsTop
    ? { top: pair.lower, bottom: pair.upper, source: 'layout' }
    : { top: pair.upper, bottom: pair.lower, source: 'layout' });
}

/** Bbox union helper for a board region (major + its cutouts). */
export function unionBBox(comps: OutlineComponent[], idxs: number[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const i of idxs) {
    const c = comps[i];
    if (c.minX < minX) minX = c.minX; if (c.minY < minY) minY = c.minY;
    if (c.maxX > maxX) maxX = c.maxX; if (c.maxY > maxY) maxY = c.maxY;
  }
  return { minX, minY, maxX, maxY };
}

/** Build a point → board-index lookup from board regions. Regions are the
 *  union bboxes of a board's components; when regions overlap the smaller
 *  one wins (a sub-board inside the envelope of a bigger one). */
export function makeRegionLookup(
  regions: Array<{ minX: number; minY: number; maxX: number; maxY: number }>,
  pad = 0.5,
): (x: number, y: number) => number {
  const order = regions.map((r, i) => ({ i, area: (r.maxX - r.minX) * (r.maxY - r.minY) }))
    .sort((a, b) => a.area - b.area).map(o => o.i);
  return (x, y) => {
    for (const i of order) {
      const r = regions[i];
      if (x >= r.minX - pad && x <= r.maxX + pad && y >= r.minY - pad && y <= r.maxY + pad) return i;
    }
    return -1;
  };
}

/** Mirror a point across `axis` along `dim`. */
export function mirrorPoint(p: Point, dim: 'x' | 'y', axis: number): void {
  if (dim === 'x') p.x = 2 * axis - p.x; else p.y = 2 * axis - p.y;
}
