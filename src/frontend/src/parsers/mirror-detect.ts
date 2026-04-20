/**
 * Parser-independent X-mirror detection based on chip pin-numbering direction.
 *
 * IPC-7351 convention: pin 1 is marked on the top side of a chip, and pins are
 * numbered counter-clockwise (CCW) as viewed from the chip's top side (away
 * from the PCB). For a TOP-mounted chip in world coordinates looking down at
 * the PCB, this CCW walk is directly visible — pins should traverse CCW in
 * numeric order (positive shoelace signed area). A board stored with mirrored
 * X coordinates reverses the sign, so top-mounted chips instead walk CW.
 *
 * We intentionally ignore BOTTOM-mounted chips. Different file formats store
 * them differently:
 *   - Some (Mentor CAMCAD) keep the shape in chip-local top-view frame and
 *     rely on a render-time flip. Storage shows BOTTOM chips as CCW too.
 *   - Others (world-coord shape files like the SERG GenCAD converter) pre-flip
 *     bottom-chip pin coords at export, so BOTTOM shows as CW in storage.
 * Either convention is valid — but they disagree on what "BOTTOM CCW" means,
 * so mixing them into one signal yields false positives on legit files. The
 * TOP-side signal is universal: pin 1 is CCW viewed from chip top, and chip
 * top is directly above the PCB for top-mounted parts in any file.
 *
 *                     Top chips
 *   Not mirrored      CCW (positive signed area)
 *   X-mirrored        CW  (negative signed area)
 *
 * Robustness filters (reject anything that isn't an IC with clean numbering):
 *
 *   1. Pin count ≥ minPins (rejects passives, 2-/4-pin packages).
 *   2. Pin numbers are contiguous 1..N integers (rejects fragmentary parts).
 *   3. Pins span both X and Y (rejects single-row connectors).
 *   4. Numeric-order polygon area / convex-hull area ≥ minPerimeterMatch
 *      — requires the numbering to trace the chip's actual perimeter.
 *      BGA grids and zig-zag DIP numbering yield low ratios and are skipped.
 *
 * Shoelace-area sign is invariant to the starting vertex — pin 1 may sit at
 * any corner of the package without affecting the verdict.
 */

import type { Part, Point, Nail, Trace, Via } from './types';

export interface MirrorVerdict {
  /** True when topCW ratio and sample size both cross thresholds. */
  mirrored: boolean;
  /** Top-side parts that passed all filters and contributed a CCW/CW vote.
   *  (Bottom-side parts are counted for diagnostics only.) */
  totalAnalyzed: number;
  /** Top-side parts whose pin-order walks clockwise — indicates X-mirror. */
  topCW: number;
  /** Top-side parts whose pin-order walks counter-clockwise — normal orientation. */
  topCCW: number;
  /** topCW / totalAnalyzed (NaN when total === 0). */
  wrongRatio: number;
  /** Bottom-side counts for diagnostics. Not used in the verdict. */
  bottomCCW: number;
  bottomCW: number;
}

export interface DetectorOptions {
  /** Minimum top-side analyzable parts before declaring a verdict. Default 10. */
  minSamples?: number;
  /** Minimum topCW / totalAnalyzed ratio to flag as mirrored. Default 0.7. */
  ratioThreshold?: number;
  /** Minimum ratio of (numeric-order polygon area) to (convex-hull area) before
   *  a part is considered a clean perimeter walk. Default 0.6. */
  minPerimeterMatch?: number;
  /** Minimum pin count per part considered. Default 8. */
  minPins?: number;
}

export function detectXMirrorByPinDirection(
  parts: Part[],
  opts: DetectorOptions = {},
): MirrorVerdict {
  const minPins     = opts.minPins            ?? 8;
  const minPerim    = opts.minPerimeterMatch  ?? 0.6;
  const minSamples  = opts.minSamples         ?? 10;
  const threshold   = opts.ratioThreshold     ?? 0.7;

  let topCCW = 0, topCW = 0, bottomCCW = 0, bottomCW = 0;

  for (const part of parts) {
    if (part.pins.length < minPins) continue;

    const byNum = new Map<number, Point>();
    for (const pin of part.pins) {
      const num = parseInt(pin.number || pin.name || '', 10);
      if (!isNaN(num) && !byNum.has(num)) byNum.set(num, pin.position);
    }
    if (byNum.size < minPins) continue;

    const nums = [...byNum.keys()].sort((a, b) => a - b);
    if (!nums.every((n, i) => n === i + 1)) continue;

    const pts = nums.map(n => byNum.get(n)!);
    if (!hasBothAxes(pts)) continue;

    const hullArea = convexHullArea(pts);
    if (hullArea === 0) continue;
    const signed = signedPolygonArea(pts);
    if (Math.abs(signed) / hullArea < minPerim) continue;
    if (signed === 0) continue;

    const ccw = signed > 0;
    if (part.side === 'bottom') {
      if (ccw) bottomCCW++; else bottomCW++;
    } else {
      if (ccw) topCCW++; else topCW++;
    }
  }

  const totalAnalyzed = topCCW + topCW;
  const wrongRatio = totalAnalyzed > 0 ? topCW / totalAnalyzed : NaN;
  const mirrored = totalAnalyzed >= minSamples && wrongRatio >= threshold;

  return { mirrored, totalAnalyzed, topCW, topCCW, wrongRatio, bottomCCW, bottomCW };
}

/**
 * Apply an in-place X-negation to every world coordinate reachable from the
 * passed arrays. Recomputes each part's bounds (minX/maxX swap under negation).
 * The part origin and pin positions are shared references, so trace/via/nail
 * arrays that borrow those Point objects are covered implicitly; callers still
 * pass their own trace/via lists explicitly because those live on BoardData
 * separately.
 */
export function applyXMirrorInPlace(
  parts: Part[],
  nails: Nail[] = [],
  traces: Trace[] = [],
  vias: Via[] = [],
  outline: Point[] = [],
): void {
  for (const part of parts) {
    for (const pin of part.pins) pin.position.x = -pin.position.x;
    part.origin.x = -part.origin.x;
    const oldMax = part.bounds.maxX;
    part.bounds.maxX = -part.bounds.minX;
    part.bounds.minX = -oldMax;
  }
  for (const n of nails)  n.position.x = -n.position.x;
  for (const t of traces) { t.start.x = -t.start.x; t.end.x = -t.end.x; }
  for (const v of vias)   v.position.x = -v.position.x;
  for (const p of outline) p.x = -p.x;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function hasBothAxes(pts: Point[]): boolean {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return maxX > minX && maxY > minY;
}

function signedPolygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Andrew's monotone chain. Returns the hull polygon's absolute area. */
function convexHullArea(pts: Point[]): number {
  if (pts.length < 3) return 0;
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (O: Point, A: Point, B: Point) =>
    (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);
  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  return Math.abs(signedPolygonArea(hull));
}
