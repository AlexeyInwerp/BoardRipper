/**
 * Position-overlap revision detector.
 *
 * ─── What this is ───────────────────────────────────────────────────────────
 * Some TVW files (and likely some other formats too — see "Generalising"
 * below) accumulate every BOM/revision variant of the same physical board
 * location into one component list. The classic signal is N parts with
 * different refdes occupying the same (side, position) and connected to the
 * same nets — e.g. `L32`, `L33`, `L35` all sitting at one inductor footprint
 * because three production passes used three different inductors there.
 *
 * The CAD parser already detects revisions, but using a different signal:
 * **refdes-name repetition** in sequence. That heuristic finds nothing here
 * because TVW exporters renumber the duplicates, so each refdes is unique.
 *
 * ─── What we do ─────────────────────────────────────────────────────────────
 * After parsing finishes, we run two passes over `BoardData.parts`:
 *
 * 1. **Bucket** parts by `(side, quantised_position)` where position is the
 *    centroid of the part's pin set, quantised to the nearest 5 mils. The
 *    quantisation tolerates small placement tweaks between revisions while
 *    still distinguishing parts that belong to genuinely different
 *    footprints.
 *
 * 2. **Filter** buckets to those that look like revision variants, requiring
 *    ALL of the following to keep false positives off legitimate clusters
 *    (e.g. a 4-resistor termination network, a row of bypass caps that
 *    happen to be near each other):
 *
 *      a. ≥ 2 distinct refdes in the bucket — one part is not a revision.
 *      b. The pin counts match across all parts in the bucket — variants of
 *         one footprint always share pad geometry.
 *      c. The pins land on the SAME net set (order-insensitive). If two
 *         "overlapping" parts connect to different nets, they're separate
 *         components that just happen to be close, not a revision pair.
 *
 *    A bucket that survives all three checks is a "revision group". We
 *    additionally require the file to contain ≥ 5 such groups before
 *    treating it as a multi-revision board — a single suspect bucket is
 *    probably a layout coincidence; five-plus is a pattern.
 *
 * 3. **Emit revisions** by partitioning parts: every group's *first* part
 *    (lowest index in `parts[]`) goes to revision 1, the *second* to
 *    revision 2, and so on — matching the convention TVW writers use, where
 *    the original components are emitted first and each subsequent BOM
 *    revision is appended. Non-grouped parts are shared across all
 *    revisions (they don't change between BOM passes).
 *
 *    The number of revisions is the LARGEST group size detected.
 *
 *    The "current" / active revision is the LAST one — that matches the
 *    existing CAD convention (newest pass = current rendered state).
 *
 * ─── What this DELIBERATELY does NOT do ─────────────────────────────────────
 *
 * - Does not run on boards that already have `revisions` set (CAD does).
 * - Does not modify or reorder `parts`. The detector only adds a parallel
 *   `revisions[]` view; parts in `BoardData.parts` stay untouched.
 * - Does not assign traces/vias to revisions. The CAD parser does this with
 *   connected-component analysis but TVW lacks per-revision trace metadata,
 *   so per-revision `traces` / `vias` are left undefined and the renderer
 *   shows the union (the same wires are usually shared anyway — only the
 *   discrete components differ between BOM passes).
 * - Does not detect ghost components (subset-net dominance). That's a
 *   separate signal that lives on `BoardData.ghosts`.
 *
 * ─── Generalising later ─────────────────────────────────────────────────────
 *
 * This file is consciously a **TVW-only** post-processor for now (called
 * from `parseTVW()`). The implementation operates on `BoardData` only —
 * there is nothing format-specific in it — so when we want to lift it to
 * a universal detector the move is:
 *
 *   1. Move call sites from each parser into a single point in board-store
 *      (`loadFile` for example).
 *   2. Skip when `board.revisions` is already populated (lets CAD's better
 *      pass-detection win).
 *   3. Watch the threshold tuning: BVR3 has tightly-packed component grids
 *      that may need a stricter quantisation step. Bench against a sample
 *      from each format before flipping.
 *
 * Until that work is justified by user demand from a second format, the
 * code stays here so its scope is obvious.
 */

import type { BoardData, BoardRevision, Part } from '../types';
import { computeBBox, computePartGeometry, buildNets, detectGhostComponents } from '../types';
import { log } from '../../store/log-store';

/** Quantisation step (mils) for position bucketing. 20 mils ~ 0.5 mm — picks
 *  up variants whose positions were lightly nudged between BOM passes (a
 *  Landrex writer rounds inconsistently) while still keeping legitimate
 *  neighbouring components in separate buckets. Empirically: stepping
 *  from 5 mil → 20 mil added 6 BOM-variant groups on the GV-N5080 fixture
 *  with no new false positives across the regression set. */
const POSITION_QUANTUM_MILS = 20;

/** Minimum number of "revision-shape" buckets in a file before we believe
 *  it's a multi-revision board. Calibrated against the NM-E221 Lenovo file,
 *  which shows 7 isolated PCIe AC-coupling cap pairs with matching nets —
 *  technically valid revision-shaped buckets, but a normal layout artifact
 *  rather than a real BOM split. 10+ buckets is the empirical "this is a
 *  pattern, not a coincidence" threshold; below that we stay quiet. */
const MIN_REVISION_BUCKETS = 10;

/** Variant-part fraction floor: at least this share of total parts must
 *  participate in revision buckets before we treat the file as multi-rev.
 *  A genuine BOM-revision board usually swaps 1%+ of components between
 *  variants (GV-N5080: ~6%); single-digit incidental overlaps are below
 *  this bar (NM-E221: 0.3%). Combined with MIN_REVISION_BUCKETS as an
 *  AND-gate: both must pass. */
const MIN_VARIANT_PART_FRACTION = 0.01;

/** Minimum distinct refdes inside a single bucket. 2 = one possible variant
 *  swap; the file-level gates above filter noise from incidental pairs. */
const MIN_PARTS_PER_BUCKET = 2;

interface Bucket {
  /** Key for diagnostic logs: "side|qx,qy". */
  key: string;
  /** Indices into BoardData.parts, in original parse order. */
  partIndices: number[];
}

/**
 * Run the detector on a freshly-parsed board. Mutates `board` in place by
 * setting `board.revisions` + `board.activeRevision` if a multi-revision
 * pattern is detected. No-op when the board already has revisions or when
 * the heuristic doesn't fire.
 *
 * Returns the number of revisions detected (1 means "didn't fire").
 */
export function detectPositionOverlapRevisions(board: BoardData): number {
  if (board.revisions && board.revisions.length > 1) {
    return board.revisions.length;
  }

  const buckets = bucketPartsByPosition(board.parts);
  const revisionGroups = filterToRevisionGroups(buckets, board.parts);

  // Variant parts = sum of bucket sizes (each part can sit in only one
  // bucket because we partition by quantised position).
  const variantPartCount = revisionGroups.reduce((sum, b) => sum + b.partIndices.length, 0);
  const variantFraction = board.parts.length > 0 ? variantPartCount / board.parts.length : 0;
  if (revisionGroups.length < MIN_REVISION_BUCKETS || variantFraction < MIN_VARIANT_PART_FRACTION) {
    if (revisionGroups.length > 0) {
      log.parser.log(
        `revision detector: ${revisionGroups.length} overlap buckets / ${variantPartCount} variant parts (${(variantFraction * 100).toFixed(2)}%) — below thresholds (${MIN_REVISION_BUCKETS} / ${(MIN_VARIANT_PART_FRACTION * 100).toFixed(0)}%), treating as single-revision`,
      );
    }
    // No BOM variants detected — still run ghost detection on the whole
    // board so the user gets the same "stale refdes / DNI overlap" hint
    // CAD files get for clean single-revision boards.
    const ghosts = detectGhostComponents(board.parts);
    if (ghosts.length > 0) {
      board.ghosts = ghosts;
      log.parser.log(`revision detector: ${ghosts.length} ghost-overlap pairs flagged on single-revision board`);
    }
    return 1;
  }

  const revisionCount = Math.max(...revisionGroups.map(b => b.partIndices.length));
  log.parser.log(
    `revision detector: ${revisionGroups.length} overlap buckets / ${variantPartCount} variant parts (${(variantFraction * 100).toFixed(1)}%) → ${revisionCount} revisions`,
  );

  // Indices that need to be partitioned across revisions.
  const variantIdx = new Set<number>();
  for (const b of revisionGroups) for (const i of b.partIndices) variantIdx.add(i);

  // Build per-revision part index lists.
  // Convention: bucket.partIndices[0] (the EARLIEST in parse order) → rev 1,
  // [1] → rev 2, etc. Buckets shorter than `revisionCount` repeat their last
  // entry across the missing tail revisions — that mirrors the writer's
  // intent: a part that was added in rev N stays in revs N+1, N+2, …
  const perRev: number[][] = Array.from({ length: revisionCount }, () => []);
  for (let i = 0; i < board.parts.length; i++) {
    if (!variantIdx.has(i)) {
      // Shared part — present in every revision.
      for (let r = 0; r < revisionCount; r++) perRev[r].push(i);
    }
  }
  for (const bucket of revisionGroups) {
    for (let r = 0; r < revisionCount; r++) {
      const i = r < bucket.partIndices.length
        ? bucket.partIndices[r]
        : bucket.partIndices[bucket.partIndices.length - 1];
      perRev[r].push(i);
    }
  }

  // Materialise revisions. Nets are rebuilt per-revision via buildNets()
  // — the resulting pinIndices are keyed against the revision's local
  // parts array, which is what the renderer expects when it switches
  // active revision.
  const revisions: BoardRevision[] = perRev.map((indices, idx) => {
    const parts = indices.map(i => board.parts[i]);
    const allPoints = parts.flatMap(p => p.pins.map(pin => pin.position));
    const bounds = computeBBox(allPoints.length > 0 ? allPoints : board.outline);
    // Labelled as "BOM variant N" rather than "rev N" because what TVW
    // writers stack into one component list is genuinely BOM-variant data
    // (alternate stuffing options for the same revision). The Revisions
    // tab UI text is generic enough to fit either; using accurate
    // terminology in the label avoids implying a board version change
    // when there might not be one.
    // Run ghost detection on the per-revision parts so the existing
    // Revisions-tab swap-button UX (hide one half of each overlap pair)
    // works the same way it does on CAD multi-pass files. detectGhost-
    // Components looks for parts whose pin nets are a strict SUBSET of
    // an overlapping dominator — a different signal from BOM-variant
    // detection (which requires net-set EQUALITY) and so finds residual
    // stale-refdes overlaps that survived the bucket partition above
    // (e.g. a 2-pin DNI footprint subset of a 3-pin dominator).
    const ghosts = detectGhostComponents(parts);
    return {
      index: idx + 1,
      label: idx === revisionCount - 1 ? `BOM variant ${idx + 1} (current)` : `BOM variant ${idx + 1}`,
      componentCount: parts.length,
      parts,
      bounds,
      outline: board.outline,
      nets: buildNets(parts),
      ghosts,
    };
  });

  board.revisions = revisions;
  board.activeRevision = revisionCount; // newest = current
  return revisionCount;
}

/** Group parts by quantised centroid position + side. */
function bucketPartsByPosition(parts: Part[]): Bucket[] {
  const map = new Map<string, number[]>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const c = partCentroid(part);
    const qx = Math.round(c.x / POSITION_QUANTUM_MILS) * POSITION_QUANTUM_MILS;
    const qy = Math.round(c.y / POSITION_QUANTUM_MILS) * POSITION_QUANTUM_MILS;
    const key = `${part.side}|${qx},${qy}`;
    const arr = map.get(key);
    if (arr) arr.push(i);
    else map.set(key, [i]);
  }
  const out: Bucket[] = [];
  for (const [key, partIndices] of map) {
    if (partIndices.length >= MIN_PARTS_PER_BUCKET) out.push({ key, partIndices });
  }
  return out;
}

/** Drop buckets that don't look like genuine BOM/revision groups. */
function filterToRevisionGroups(buckets: Bucket[], parts: Part[]): Bucket[] {
  const out: Bucket[] = [];
  for (const b of buckets) {
    const seen = b.partIndices.map(i => parts[i]);

    // (a) ≥ 2 distinct refdes — protects against pin extension dual-side
    // (same refdes twice on opposite sides) being misread as a revision.
    const distinctNames = new Set(seen.map(p => p.name));
    if (distinctNames.size < MIN_PARTS_PER_BUCKET) continue;

    // (b) all share the same pin count — BOM variants reuse the same
    // footprint, so pin count must agree.
    const pinCount = seen[0].pins.length;
    if (!seen.every(p => p.pins.length === pinCount)) continue;

    // (c) all touch the same nets (set equality). User-confirmed signal:
    // L32, L33, L35 share connections.
    const refNets = netSetForPart(seen[0]);
    let allMatch = true;
    for (let i = 1; i < seen.length; i++) {
      const ns = netSetForPart(seen[i]);
      if (ns.size !== refNets.size) { allMatch = false; break; }
      for (const n of ns) if (!refNets.has(n)) { allMatch = false; break; }
      if (!allMatch) break;
    }
    if (!allMatch) continue;

    out.push(b);
  }
  return out;
}

/** Centroid of a part's pin positions. Uses bounds origin if pins are absent. */
function partCentroid(part: Part): { x: number; y: number } {
  if (part.pins.length === 0) {
    const g = computePartGeometry(part.pins);
    return g.origin;
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
