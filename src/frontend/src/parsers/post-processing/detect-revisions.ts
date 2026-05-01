/**
 * BOM-variant detector.
 *
 * ─── What this is ───────────────────────────────────────────────────────────
 * Some TVW files (and likely some other formats too — see "Generalising"
 * below) accumulate every BOM/stuffing variant of the same physical board
 * location into one component list. The classic signal is N parts with
 * different refdes occupying the same footprint and connected to the same
 * nets — e.g. `L32`, `L33`, `L35` all sitting at one inductor pad set
 * because three production builds used three different inductors there.
 *
 * The CAD parser already detects revisions, but using a different signal:
 * **refdes-name repetition** in sequence. That heuristic finds nothing here
 * because TVW exporters renumber the duplicates, so each refdes is unique.
 *
 * ─── How we detect it ───────────────────────────────────────────────────────
 * After parsing finishes, we run **bbox-overlap clustering** over
 * `BoardData.parts`:
 *
 * 1. **Spatial prefilter.** For each part compute its centroid; bin parts
 *    into a coarse grid (200 mils per cell) keyed by `(side, gridX, gridY)`.
 *    Only parts in the same cell or its 8 neighbours can possibly share a
 *    footprint. This converts a naive O(n²) all-pairs comparison into
 *    O(n × neighbourhood-density), which on real boards is small.
 *
 * 2. **Pairwise equivalence.** Two parts A, B are "same footprint" iff
 *    they pass ALL of:
 *      a. same `side` (or one of them is "both");
 *      b. their bounding boxes overlap;
 *      c. same pin count — variants of one footprint reuse pad geometry;
 *      d. identical net set (order-insensitive). Different nets means
 *         they're separate components that just happen to be close, not a
 *         BOM-variant pair (the user's "share same lines" criterion).
 *
 *    Note we check bbox overlap, NOT just centroid proximity. Caps stacked
 *    on a power rail can be 40+ mils apart yet share the same footprint —
 *    centroid distance alone misses that. The earlier 20-mil position-
 *    quantisation version of this detector missed ~25 cap pairs on
 *    GV-N5080 for that reason.
 *
 * 3. **Union-find.** Equivalent pairs feed a disjoint-set forest; the
 *    resulting components are the BOM-variant groups.
 *
 * 4. **Threshold gate.** A genuine BOM-variant board has many such groups
 *    AND a meaningful share of its parts in them. We require ≥ 10 groups
 *    AND ≥ 1% of parts in groups before declaring multi-variant. Below
 *    that we treat single-bucket overlaps as legitimate layout duplicates
 *    (e.g. two AC-coupling caps on a PCIe lane in NM-E221, which is a
 *    real same-foot two-cap layout, not a BOM swap).
 *
 * 5. **Emission.** Each group's *first* part (lowest index in `parts[]`)
 *    goes to BOM variant 1, the *second* to variant 2, and so on. Groups
 *    shorter than the maximum tail-fill their last entry across the
 *    missing variants. Non-grouped parts are shared across every variant
 *    (they're the same in every build).
 *
 *    The number of variants is the LARGEST group size detected. The
 *    "current" variant is the LAST one — same convention CAD uses for
 *    multi-pass files (newest = current rendered state).
 *
 * 6. **Ghost detection** runs on a per-variant basis when variants are
 *    detected, AND on the whole board as a fallback otherwise. This is
 *    `detectGhostComponents` (subset-net dominance) — a different signal
 *    from BOM equivalence (subset, not equality) — that surfaces stale
 *    DNI footprints / leftover refdes overlaps.
 *
 * ─── What this DELIBERATELY does NOT do ─────────────────────────────────────
 *
 * - Does not run on boards that already have `revisions` set (CAD does).
 * - Does not modify or reorder `parts`. The detector only adds a parallel
 *   `revisions[]` view; parts in `BoardData.parts` stay untouched.
 * - Does not assign traces/vias to variants. The CAD parser does this with
 *   connected-component analysis on the routing graph, but TVW lacks that
 *   per-variant trace metadata. The renderer shows the union of traces;
 *   the same wires are usually shared anyway — only the discrete
 *   components differ between BOM passes.
 * - Does not group parts with DIFFERENT pin counts even if they overlap
 *   (e.g. a 2-pin cap subsumed by a 3-pin TVS at the same footprint).
 *   That's the ghost detector's job and produces a different UI affordance
 *   (single hide/show toggle, not multi-variant switch).
 *
 * ─── Generalising later ─────────────────────────────────────────────────────
 *
 * This file is consciously a **TVW-only** post-processor for now (called
 * from `parseTVW()`). The implementation operates on `BoardData` only —
 * there is nothing format-specific in it — so when we want to lift it to
 * a universal detector the move is:
 *
 *   1. Move the call site from `parseTVW()` into a single point in
 *      board-store (e.g. `loadFile`).
 *   2. Skip when `board.revisions` is already populated (lets CAD's better
 *      pass-detection win).
 *   3. Re-bench thresholds on a sample from each format. BVR3 has tightly
 *      packed component grids that may need a stricter same-net check.
 *   4. Consider promoting "BOM variant" to a first-class concept distinct
 *      from "revision" in the type system — currently both ride the same
 *      `BoardRevision[]` carrier with different labelling.
 *
 * Until that work is justified by user demand from a second format, the
 * code stays here so its scope is obvious.
 */

import type { BoardData, BoardRevision, Part, BBox } from '../types';
import { computeBBox, buildNets, detectGhostComponents } from '../types';
import { log } from '../../store/log-store';

/** Coarse spatial-index cell size (mils). Picks how widely we cast our
 *  net for candidate overlap pairs. 200 mils ~ 5 mm; one cell easily
 *  contains a 0805 / 1206 cap and its near neighbours, but is small
 *  enough that the candidate sets per cell stay short. */
const SPATIAL_GRID_MILS = 200;

/** Minimum number of variant groups before we believe the file is a
 *  multi-BOM board. Calibrated against NM-E221 (7 isolated PCIe AC-
 *  coupling cap pairs, real same-footprint layout but not a BOM swap)
 *  vs GV-N5080 (hundreds of groups, clearly a multi-build file). */
const MIN_VARIANT_GROUPS = 10;

/** Variant-part fraction floor: at least this share of total parts must
 *  participate in variant groups before we declare multi-BOM.
 *  Combined with MIN_VARIANT_GROUPS as an AND-gate. */
const MIN_VARIANT_PART_FRACTION = 0.01;

/**
 * Run the detector on a freshly-parsed board. Mutates `board` in place by
 * setting `board.revisions` + `board.activeRevision` if a multi-variant
 * pattern is detected, otherwise sets `board.ghosts`. No-op when the
 * board already has revisions.
 *
 * Returns the number of variants detected (1 means "didn't fire").
 */
export function detectPositionOverlapRevisions(board: BoardData): number {
  if (board.revisions && board.revisions.length > 1) {
    return board.revisions.length;
  }

  const groups = clusterEquivalentParts(board.parts);
  const variantPartCount = groups.reduce((sum, g) => sum + g.length, 0);
  const variantFraction = board.parts.length > 0 ? variantPartCount / board.parts.length : 0;

  if (groups.length < MIN_VARIANT_GROUPS || variantFraction < MIN_VARIANT_PART_FRACTION) {
    if (groups.length > 0) {
      log.parser.log(
        `bom-variant detector: ${groups.length} groups / ${variantPartCount} variant parts (${(variantFraction * 100).toFixed(2)}%) — below thresholds (${MIN_VARIANT_GROUPS} / ${(MIN_VARIANT_PART_FRACTION * 100).toFixed(0)}%), treating as single-variant`,
      );
    }
    // No BOM variants — still surface ghost overlaps so the user gets the
    // hide/swap UX for stale-refdes pairs even on clean files.
    const ghosts = detectGhostComponents(board.parts);
    if (ghosts.length > 0) {
      board.ghosts = ghosts;
      log.parser.log(`bom-variant detector: ${ghosts.length} ghost-overlap pairs flagged on single-variant board`);
    }
    return 1;
  }

  const variantCount = Math.max(...groups.map(g => g.length));
  log.parser.log(
    `bom-variant detector: ${groups.length} groups / ${variantPartCount} variant parts (${(variantFraction * 100).toFixed(1)}%) → ${variantCount} BOM variants`,
  );

  // Indices that need to be partitioned across variants.
  const variantIdx = new Set<number>();
  for (const g of groups) for (const i of g) variantIdx.add(i);

  // Build per-variant part index lists.
  // Convention: group[0] (the EARLIEST in parse order) → variant 1,
  // [1] → variant 2, etc. Groups shorter than `variantCount` repeat their
  // last entry across the missing tail variants.
  const perVar: number[][] = Array.from({ length: variantCount }, () => []);
  for (let i = 0; i < board.parts.length; i++) {
    if (!variantIdx.has(i)) {
      // Shared part — present in every variant.
      for (let r = 0; r < variantCount; r++) perVar[r].push(i);
    }
  }
  for (const group of groups) {
    for (let r = 0; r < variantCount; r++) {
      const i = r < group.length ? group[r] : group[group.length - 1];
      perVar[r].push(i);
    }
  }

  // Materialise variants. Nets are rebuilt per-variant via buildNets() —
  // the resulting pinIndices are keyed against the variant's local parts
  // array, which is what the renderer expects when it switches.
  const variants: BoardRevision[] = perVar.map((indices, idx) => {
    const parts = indices.map(i => board.parts[i]);
    const allPoints = parts.flatMap(p => p.pins.map(pin => pin.position));
    const bounds = computeBBox(allPoints.length > 0 ? allPoints : board.outline);
    // Per-variant ghost detection covers stale-refdes overlaps that
    // survived the BOM clustering (different pin counts / subset nets).
    const ghosts = detectGhostComponents(parts);
    return {
      index: idx + 1,
      label: idx === variantCount - 1 ? `BOM variant ${idx + 1} (current)` : `BOM variant ${idx + 1}`,
      componentCount: parts.length,
      parts,
      bounds,
      outline: board.outline,
      nets: buildNets(parts),
      ghosts,
    };
  });

  board.revisions = variants;
  board.activeRevision = variantCount; // newest = current
  return variantCount;
}

// ─── Equivalence clustering ──────────────────────────────────────────────────

/**
 * Cluster parts by "same footprint" equivalence. Returns groups of part
 * indices, each group containing ≥ 2 parts with distinct refdes.
 *
 * The equivalence relation is:
 *   - same side
 *   - bbox overlap
 *   - identical pin count
 *   - identical net set
 *
 * Implementation: spatial-grid prefilter + union-find.
 */
function clusterEquivalentParts(parts: Part[]): number[][] {
  const partInfos = parts.map((p, idx) => ({
    idx,
    side: p.side,
    pinCount: p.pins.length,
    bounds: p.bounds,
    centroid: partCentroid(p),
    nets: netSetForPart(p),
  }));

  // Spatial bucketing on centroid. Parts straddle exactly one cell.
  const grid = new Map<string, number[]>();
  const cellKey = (side: string, x: number, y: number) =>
    `${side}|${Math.floor(x / SPATIAL_GRID_MILS)},${Math.floor(y / SPATIAL_GRID_MILS)}`;
  for (const pi of partInfos) {
    const sides = pi.side === 'both' ? ['top', 'bottom'] : [pi.side];
    for (const s of sides) {
      const key = cellKey(s, pi.centroid.x, pi.centroid.y);
      const arr = grid.get(key);
      if (arr) arr.push(pi.idx);
      else grid.set(key, [pi.idx]);
    }
  }

  // Union-find.
  const parent = new Int32Array(parts.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const next = parent[a]; parent[a] = r; a = next; }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // For each part, scan its cell + the 8 neighbour cells for candidates.
  for (const pi of partInfos) {
    const sides = pi.side === 'both' ? ['top', 'bottom'] : [pi.side];
    for (const s of sides) {
      const cx = Math.floor(pi.centroid.x / SPATIAL_GRID_MILS);
      const cy = Math.floor(pi.centroid.y / SPATIAL_GRID_MILS);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const candidates = grid.get(`${s}|${cx + dx},${cy + dy}`);
          if (!candidates) continue;
          for (const cand of candidates) {
            if (cand <= pi.idx) continue; // each pair tested once
            const cj = partInfos[cand];
            if (!sidesCompatible(pi.side, cj.side)) continue;
            if (pi.pinCount !== cj.pinCount) continue;
            if (!bboxOverlap(pi.bounds, cj.bounds)) continue;
            if (!netSetEqual(pi.nets, cj.nets)) continue;
            // Same-name pairs (the dual-side extension parts we emit for
            // edge connectors) are already correct as they stand — no
            // need to cluster them as variants.
            if (parts[pi.idx].name === parts[cand].name) continue;
            union(pi.idx, cand);
          }
        }
      }
    }
  }

  // Collect components, dropping singletons.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < parent.length; i++) {
    const r = find(i);
    const arr = byRoot.get(r);
    if (arr) arr.push(i);
    else byRoot.set(r, [i]);
  }
  const groups: number[][] = [];
  for (const indices of byRoot.values()) {
    if (indices.length < 2) continue;
    // Confirm the cluster genuinely has ≥ 2 distinct refdes.
    const distinctNames = new Set(indices.map(i => parts[i].name));
    if (distinctNames.size < 2) continue;
    indices.sort((a, b) => a - b);
    groups.push(indices);
  }
  return groups;
}

function sidesCompatible(a: 'top' | 'bottom' | 'both', b: 'top' | 'bottom' | 'both'): boolean {
  if (a === b) return true;
  return a === 'both' || b === 'both';
}

/** BBox-overlap proximity test, inclusive + with a small tolerance.
 *
 *  Two reasons we can't use strict `<` against the raw bboxes:
 *    1. Two-pin parts often produce a degenerate (zero-width) bbox when
 *       both pins share an X coord — e.g. GV-N5080's L32/L33 power-stage
 *       inductors at x=4300.4, bbox width 0. Strict `<` rejects these.
 *    2. TVW writers round positions inconsistently — within one footprint
 *       L32/L33 land at x=4300.4 but L35 lands at x=4300.0 (0.4 mil
 *       offset). Without slack, L35 falls outside the cluster.
 *
 *  Tolerance is small (10 mils ~ 0.25 mm) — large enough to absorb
 *  writer-rounding noise, small enough that legitimate adjacent
 *  components (the closest 0402 cap pitch is ~30 mils) stay in their
 *  own clusters. The same-net-set + same-pin-count gates downstream
 *  are the primary defence against false positives anyway. */
const BBOX_TOLERANCE_MILS = 10;
function bboxOverlap(a: BBox, b: BBox): boolean {
  const t = BBOX_TOLERANCE_MILS;
  return (
    a.minX - t <= b.maxX &&
    a.maxX + t >= b.minX &&
    a.minY - t <= b.maxY &&
    a.maxY + t >= b.minY
  );
}

function netSetEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

function partCentroid(part: Part): { x: number; y: number } {
  if (part.pins.length === 0) {
    return { x: (part.bounds.minX + part.bounds.maxX) / 2, y: (part.bounds.minY + part.bounds.maxY) / 2 };
  }
  let sx = 0;
  let sy = 0;
  for (const pin of part.pins) {
    sx += pin.position.x;
    sy += pin.position.y;
  }
  return { x: sx / part.pins.length, y: sy / part.pins.length };
}

function netSetForPart(part: Part): Set<string> {
  const out = new Set<string>();
  for (const pin of part.pins) {
    if (pin.net) out.add(pin.net);
  }
  return out;
}
