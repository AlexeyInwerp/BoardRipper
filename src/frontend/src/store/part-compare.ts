/**
 * Cross-board part comparison — the pure kernel.
 *
 * Answers "is pin N of U1700 on board A wired the same way it is on board B".
 * No React, no stores, no DOM: everything the UI needs is derived here so the
 * same code can later back an MCP tool without a browser.
 *
 * Two properties of our data decide the whole shape of this module.
 *
 * 1. **`pin.number` is not a package pin.** `brd-parser`, `bdv-parser` and
 *    `xzz-parser` all assign `String(i + 1)` — a running index in *file order*.
 *    Two deliveries of one board can enumerate the same package differently,
 *    and then "pin 12 vs pin 12" silently compares unrelated pads. Only the
 *    iPhone-era XZZ JSON tail carries real designators (BGA pads like `M7`).
 *    So alignment is a search over several strategies, scored, with a
 *    geometric fallback — never a `zip()`.
 *
 * 2. **Net names are not stable identities.** One delivery of a board carries
 *    `PPBUS_G3H`, the next carries `N$21004` for the same copper. A name-only
 *    diff paints nearly every row red and tells the user nothing, so a pair
 *    whose names differ is re-checked against the *topology* — the set of
 *    components each net touches — to separate a rename from a real wiring
 *    change.
 *
 * Design: docs/specs/2026-09-11-part-pin-comparison-design.md
 */

import type { BoardData, DiodeReading, Part, Pin, Point } from '../parsers/types';

// ── Public types ──────────────────────────────────────────────────────────

export type AlignMode = 'auto' | 'name' | 'number' | 'order' | 'geometry';
export type ResolvedAlignMode = Exclude<AlignMode, 'auto'>;

export interface AlignPair {
  /** Pin index in part A, or null when this row exists only in B. */
  a: number | null;
  /** Pin index in part B, or null when this row exists only in A. */
  b: number | null;
}

export interface Alignment {
  mode: ResolvedAlignMode;
  pairs: AlignPair[];
  /** Pairs where both sides are non-null. */
  matched: number;
  /** `matched / max(|A|, |B|)`; 1 when both parts are empty. */
  score: number;
  /** Geometry only — the winning transform, for the diagnostics line. */
  transform?: string;
  /** Geometry only — two or more transforms explained the pads equally well
   *  and no net agreement broke the tie. The pairing is a guess; say so. */
  ambiguous?: boolean;
}

export interface AlignCandidate {
  mode: ResolvedAlignMode;
  matched: number;
  /** matched / max(|A|, |B|) — coverage, not quality. */
  score: number;
  /** Share of matched pairs whose nets agree. */
  netAgree: number;
  /** Share of matched pairs that sit in the same place under one transform. */
  geomAgree: number;
}

export type PinDiffStatus =
  /** Net names equal after normalisation. */
  | 'same'
  /** Names differ, but both nets touch exactly the same components. */
  | 'renamed'
  /** Names differ, neighbour sets overlap at or above SIMILAR_JACCARD. */
  | 'similar'
  /** Names are not equal but share a substantial run of text, and the
   *  topology did not already settle it. Two deliveries very often spell one
   *  rail slightly differently — `PPBUS_G3H` against `PPBUS_G3H_R` — and that
   *  is a naming difference, not a wiring one. */
  | 'partial'
  /** Both sides are ground/power-class rails of comparable size. */
  | 'bulk'
  /** Names and topology both differ — a real wiring difference. */
  | 'differs'
  /** The pin exists only in A / only in B. */
  | 'only-a'
  | 'only-b'
  /** Both sides unconnected. Not counted as a difference. */
  | 'nc';

/** Statuses the user is meant to read as "these boards disagree here". */
export const DIFFERENCE_STATUSES: readonly PinDiffStatus[] =
  ['differs', 'only-a', 'only-b'] as const;

export interface PinDiffSide {
  pinIndex: number;
  /** `pin.name` when the format carries a real designator, else `pin.number`. */
  label: string;
  /** Normalised net name; `''` means unconnected. */
  net: string;
  /** Net name exactly as stored, for display. */
  rawNet: string;
  diode?: DiodeReading;
}

/** A shared run of text between two net names, in each side's own offsets. */
export interface NameMatch {
  aStart: number;
  bStart: number;
  length: number;
  /** `length / max(|a|, |b|)` — 1 when one name contains the other entirely
   *  and they are the same length. */
  ratio: number;
}

export interface PinDiffRow {
  /** Stable within one result — safe as a React key. */
  key: string;
  a: PinDiffSide | null;
  b: PinDiffSide | null;
  status: PinDiffStatus;
  /** Jaccard overlap of the two neighbour sets; set for 'similar' and 'differs'. */
  similarity?: number;
  /** The longest run of text the two net names share, as offsets into each
   *  side's `rawNet`. Present on every row whose names differ and overlap at
   *  all — the UI marks it in both cells, which is what turns "these two
   *  strings are nearly the same" into something the eye can check in one
   *  pass. Absent when the names share nothing. */
  nameMatch?: NameMatch;
  /** Both sides carry a real reading and they diverge past the threshold. */
  diodeDiffers: boolean;
}

export interface CompareResult {
  alignment: Alignment;
  rows: PinDiffRow[];
  counts: Record<PinDiffStatus, number>;
  /** Total rows the user would call a difference. */
  differences: number;
  /** Pin-bounding-box diagonals differ by more than SIZE_TOLERANCE — the two
   *  parts are probably not the same package, so any alignment is suspect. */
  sizeMismatch: boolean;
  /** At least one compared pin carries a diode reading, so the column is worth
   *  rendering. */
  hasDiode: boolean;
  /** Every alignment strategy that was eligible, best first. Lets the UI show
   *  what `auto` chose over and why. */
  candidates: AlignCandidate[];
}

export interface CompareOptions {
  mode?: AlignMode;
  /**
   * Ground/power classifier. Injected rather than imported so the kernel stays
   * free of the settings store; callers pass
   * `(n) => isGroundNet(renderSettings, n)`.
   */
  isBulkNet?: (netName: string) => boolean;
}

// ── Tuning constants ──────────────────────────────────────────────────────

/** A net touching more pins than this is treated as a rail without ever
 *  building its neighbour set. `pinIndices.length` is the cheap pre-check —
 *  fingerprinting a 3000-pin GND is expensive *and* uninformative. */
const BULK_PIN_LIMIT = 120;
/** Two rails compare as equivalent when their pin counts are this close. */
const BULK_SIZE_TOLERANCE = 0.2;
/** Neighbour-set overlap at or above this reads as "similar", below as "differs". */
const SIMILAR_JACCARD = 0.6;
/** Floors for reading two names as one net spelled differently. Both matter:
 *  without the run length `PP3V3_S5` and `PP1V8_S0` would pair on a shared
 *  `PP`, and without the ratio `GND` would pair with `PP_GND_SENSE`. */
const PARTIAL_NAME_MIN_RUN = 3;
const PARTIAL_NAME_RATIO = 0.5;
/** Diode readings diverging by more than max(this, DIODE_REL × larger) are
 *  flagged. The floor governs ordinary junction readings (0.3–0.7 V, where
 *  board-to-board spread is a few tens of mV); the relative term only takes
 *  over above ~0.5 V so a big reading is not flagged on proportional noise. */
const DIODE_ABS_MV = 50;
const DIODE_REL = 0.10;
/** Pin-bbox diagonal ratio outside [1-x, 1+x] means "different package". */
const SIZE_TOLERANCE = 0.2;
/** A key strategy needs at least this share of pins to carry a usable key. */
const KEY_COVERAGE = 0.5;
/** Geometry match tolerance as a share of the median pin pitch, and its clamps. */
const GEOM_TOL_FACTOR = 0.4;
const GEOM_TOL_MIN = 2;
const GEOM_TOL_MAX = 20;
/** Pitch estimation samples this many pins rather than going fully quadratic. */
const PITCH_SAMPLES = 200;

// ── Small helpers ─────────────────────────────────────────────────────────

/** Uppercase, trimmed, with the three spellings of "unconnected" folded to ''. */
export function normalizeNet(name: string | undefined | null): string {
  const s = (name ?? '').trim().toUpperCase();
  if (s === '' || s === 'NC' || s === 'UNCONNECTED') return '';
  return s;
}

/** What to show in the `#` column: a real designator when the format has one. */
export function pinLabel(pin: Pin): string {
  return pin.name.trim() || pin.number.trim();
}

function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function centroidOf(pins: Pin[]): Point {
  if (pins.length === 0) return { x: 0, y: 0 };
  let x = 0, y = 0;
  for (const p of pins) { x += p.position.x; y += p.position.y; }
  return { x: x / pins.length, y: y / pins.length };
}

function bboxDiagonal(pins: Pin[]): number {
  if (pins.length === 0) return 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pins) {
    if (p.position.x < minX) minX = p.position.x;
    if (p.position.x > maxX) maxX = p.position.x;
    if (p.position.y < minY) minY = p.position.y;
    if (p.position.y > maxY) maxY = p.position.y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Median nearest-neighbour distance — our stand-in for "pin pitch".
 *
 * Sampled rather than exhaustive: the median of 200 sampled nearest-neighbour
 * distances is indistinguishable from the median of all of them for the shape
 * of data we have (a grid or a ring of pads), and it keeps a 1500-pin BGA off
 * the quadratic path.
 */
function medianPitch(pins: Pin[]): number {
  const n = pins.length;
  if (n < 2) return 0;
  const step = Math.max(1, Math.floor(n / PITCH_SAMPLES));
  const dists: number[] = [];
  for (let i = 0; i < n; i += step) {
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = dist2(pins[i].position, pins[j].position);
      if (d < best) best = d;
    }
    if (best < Infinity) dists.push(Math.sqrt(best));
  }
  if (dists.length === 0) return 0;
  dists.sort((a, b) => a - b);
  return dists[Math.floor(dists.length / 2)];
}

// ── Spatial grid ──────────────────────────────────────────────────────────

/**
 * Uniform bucket grid for nearest-neighbour queries inside one tolerance.
 *
 * Cell size *is* the query radius, so a lookup only ever inspects the 3×3
 * neighbourhood. That is all the geometric aligner needs — it never asks for a
 * neighbour further away than the match tolerance.
 */
class PointGrid {
  private readonly cell: number;
  private readonly pts: Point[];
  private readonly buckets = new Map<string, number[]>();

  constructor(pts: Point[], cell: number) {
    this.pts = pts;
    this.cell = cell > 0 ? cell : 1;
    for (let i = 0; i < pts.length; i++) {
      const k = this.key(pts[i]);
      const b = this.buckets.get(k);
      if (b) b.push(i); else this.buckets.set(k, [i]);
    }
  }

  private key(p: Point): string {
    return `${Math.floor(p.x / this.cell)},${Math.floor(p.y / this.cell)}`;
  }

  /** Nearest stored point within `maxDist`, or null. */
  nearest(p: Point, maxDist: number): { index: number; dist: number } | null {
    const cx = Math.floor(p.x / this.cell);
    const cy = Math.floor(p.y / this.cell);
    const maxD2 = maxDist * maxDist;
    let bestIdx = -1;
    let bestD2 = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const b = this.buckets.get(`${cx + dx},${cy + dy}`);
        if (!b) continue;
        for (const i of b) {
          const d2 = dist2(p, this.pts[i]);
          if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
        }
      }
    }
    if (bestIdx < 0 || bestD2 > maxD2) return null;
    return { index: bestIdx, dist: Math.sqrt(bestD2) };
  }
}

// ── Alignment strategies ──────────────────────────────────────────────────
//
// Every strategy produces a candidate pairing; none of them is trusted on its
// own. They are ranked afterwards by *evidence* — see `buildAlignment` — because
// a strategy's own success rate is not a quality measure: `number` alignment
// "succeeds" on 100 % of pins whenever the two parts have the same pin count,
// whether or not the pairing means anything.

/** Rows in A order (matched or A-only), then the B-only leftovers in B order. */
function pairsFromMatch(
  nA: number,
  nB: number,
  aToB: Array<number | null>,
): AlignPair[] {
  const usedB = new Set<number>();
  const pairs: AlignPair[] = [];
  for (let i = 0; i < nA; i++) {
    const j = aToB[i];
    if (j != null) usedB.add(j);
    pairs.push({ a: i, b: j ?? null });
  }
  for (let j = 0; j < nB; j++) if (!usedB.has(j)) pairs.push({ a: null, b: j });
  return pairs;
}

function finishAlignment(
  mode: ResolvedAlignMode,
  nA: number,
  nB: number,
  aToB: Array<number | null>,
  transform?: string,
): Alignment {
  const pairs = pairsFromMatch(nA, nB, aToB);
  const matched = pairs.filter(p => p.a != null && p.b != null).length;
  const denom = Math.max(nA, nB);
  return { mode, pairs, matched, score: denom === 0 ? 1 : matched / denom, transform };
}

/**
 * Key-based alignment. Ineligible — returns null — when the key is too sparse
 * or not unique, because then it is not a key and pretending otherwise would
 * pair pins arbitrarily.
 */
function alignByKey(
  mode: 'name' | 'number',
  a: Pin[],
  b: Pin[],
  keyOf: (p: Pin) => string,
): Alignment | null {
  const keysA = a.map(keyOf);
  const keysB = b.map(keyOf);
  const filled = (ks: string[]) => ks.filter(k => k !== '').length;
  if (a.length === 0 || b.length === 0) return null;
  if (filled(keysA) < a.length * KEY_COVERAGE) return null;
  if (filled(keysB) < b.length * KEY_COVERAGE) return null;

  const indexB = new Map<string, number>();
  for (let j = 0; j < keysB.length; j++) {
    const k = keysB[j];
    if (k === '') continue;
    if (indexB.has(k)) return null;   // duplicate ⇒ not a key
    indexB.set(k, j);
  }
  const seenA = new Set<string>();
  for (const k of keysA) {
    if (k === '') continue;
    if (seenA.has(k)) return null;
    seenA.add(k);
  }

  const aToB: Array<number | null> = keysA.map(k => (k === '' ? null : indexB.get(k) ?? null));
  return finishAlignment(mode, a.length, b.length, aToB);
}

/** Index *i* ↔ index *i*. The floor: always available, never clever. */
function alignByOrder(a: Pin[], b: Pin[]): Alignment {
  const n = Math.min(a.length, b.length);
  const aToB: Array<number | null> = a.map((_, i) => (i < n ? i : null));
  return finishAlignment('order', a.length, b.length, aToB);
}

// ── Geometry ──────────────────────────────────────────────────────────────

interface Transform { label: string; cos: number; sin: number; mirror: boolean }

function applyT(p: Point, t: Transform): Point {
  const x = t.mirror ? -p.x : p.x;
  return { x: x * t.cos - p.y * t.sin, y: x * t.sin + p.y * t.cos };
}

/** Pin positions relative to the part's own pin centroid. */
function localPoints(part: Part): Point[] {
  const c = centroidOf(part.pins);
  return part.pins.map(p => ({ x: p.position.x - c.x, y: p.position.y - c.y }));
}

/**
 * Candidate frames for mapping B's pins onto A's.
 *
 * `part.angleDeg` is absent on most Apple formats and the two boards may place
 * the chip on opposite sides, so a single transform cannot be trusted. We try
 * the four cardinal rotations in both mirror parities, plus — when both parts
 * *do* carry an angle — the exact delta, and let the evidence decide.
 * Non-cardinal placement differences are out of scope; the score makes that
 * visible instead of silently mis-pairing.
 */
function candidateTransforms(partA: Part, partB: Part): Transform[] {
  const out: Transform[] = [];
  const push = (deg: number, mirror: boolean, label: string) => {
    const r = (deg * Math.PI) / 180;
    out.push({ label, cos: Math.cos(r), sin: Math.sin(r), mirror });
  };
  for (const deg of [0, 90, 180, 270]) {
    push(deg, false, `${deg}°`);
    push(deg, true, `${deg}°+mirror`);
  }
  if (partA.angleDeg != null && partB.angleDeg != null) {
    const delta = partA.angleDeg - partB.angleDeg;
    if (Math.abs(((delta % 90) + 90) % 90) > 0.5) {
      push(delta, false, `Δ${delta.toFixed(1)}°`);
      push(delta, true, `Δ${delta.toFixed(1)}°+mirror`);
    }
  }
  return out;
}

/** Match tolerance in mils, derived from the denser part's pin pitch. */
function toleranceFor(partA: Part, partB: Part): number {
  const pitch = medianPitch(partA.pins) || medianPitch(partB.pins);
  if (pitch <= 0) return 0;
  return Math.min(GEOM_TOL_MAX, Math.max(GEOM_TOL_MIN, pitch * GEOM_TOL_FACTOR));
}

/** Share of matched pairs whose nets agree — `0` when nothing is comparable. */
function netAgreement(partA: Part, partB: Part, pairs: AlignPair[]): number {
  let n = 0, agree = 0;
  for (const p of pairs) {
    if (p.a == null || p.b == null) continue;
    const na = normalizeNet(partA.pins[p.a].net);
    const nb = normalizeNet(partB.pins[p.b].net);
    if (na === '' && nb === '') continue;    // carries no information either way
    n++;
    if (na !== '' && na === nb) agree++;
  }
  return n === 0 ? 0 : agree / n;
}

/**
 * Share of matched pairs that sit in the same place, under the single rigid
 * transform that explains the most of them.
 *
 * This is what lets a key-based pairing be *checked* rather than trusted: a
 * `number` alignment over two files that enumerate the package differently
 * scores near zero here, and loses to geometry.
 */
function geometricAgreement(
  partA: Part, partB: Part, pairs: AlignPair[], tol: number,
): number {
  if (tol <= 0) return 0;
  const matched = pairs.filter(p => p.a != null && p.b != null);
  if (matched.length === 0) return 0;
  const ptsA = localPoints(partA);
  const ptsB = localPoints(partB);
  const tol2 = tol * tol;
  let best = 0;
  for (const t of candidateTransforms(partA, partB)) {
    let hits = 0;
    for (const p of matched) {
      if (dist2(ptsA[p.a!], applyT(ptsB[p.b!], t)) <= tol2) hits++;
    }
    if (hits > best) best = hits;
    if (best === matched.length) break;
  }
  return best / matched.length;
}

/**
 * Geometric alignment — the strategy that makes cross-delivery comparison work
 * when two files enumerate one package in different orders.
 *
 * Anchored on the **pin centroid**, not `part.origin`: origin means different
 * things in different parsers, while the centroid is defined identically
 * everywhere and is therefore directly comparable. Nothing is rescaled — a
 * pitch mismatch means these are not the same package, and surfacing that is
 * the point.
 *
 * Pairing is mutual-nearest-neighbour: a pin pairs only when each side is the
 * other's nearest within tolerance. One-directional greedy matching collapses
 * two pins onto one on a dense BGA; mutual-best does not.
 *
 * **Most packages are geometrically symmetric** — a two-row SOIC pad field maps
 * onto itself under 180° and under a mirror, a square BGA under all four
 * rotations. Match count alone therefore cannot orient the package, and picking
 * the first transform that ties would pair pin 1 with pin 40 without saying so.
 * So transforms are ranked by (pins matched, then net agreement), and when the
 * top two tie on both the result is flagged `ambiguous` — there is genuinely no
 * evidence left, and the user has to pick the mode.
 */
function alignByGeometry(partA: Part, partB: Part): Alignment | null {
  const a = partA.pins, b = partB.pins;
  if (a.length === 0 || b.length === 0) return null;

  const tol = toleranceFor(partA, partB);
  if (tol <= 0) return null;

  const ptsA = localPoints(partA);
  const baseB = localPoints(partB);
  const gridA = new PointGrid(ptsA, tol);

  let best: Alignment | null = null;
  let bestRank: [number, number] = [-1, -1];
  let tied = false;

  for (const t of candidateTransforms(partA, partB)) {
    const ptsB = baseB.map(p => applyT(p, t));
    const gridB = new PointGrid(ptsB, tol);

    // Mutual best: A→B and B→A must agree.
    const aToBNear = ptsA.map(p => gridB.nearest(p, tol));
    const bToANear = ptsB.map(p => gridA.nearest(p, tol));
    const aToB: Array<number | null> = ptsA.map((_, i) => {
      const j = aToBNear[i]?.index;
      if (j == null) return null;
      return bToANear[j]?.index === i ? j : null;
    });

    const cand = finishAlignment('geometry', a.length, b.length, aToB, t.label);
    const rank: [number, number] = [cand.matched, netAgreement(partA, partB, cand.pairs)];
    if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
      best = cand; bestRank = rank; tied = false;
    } else if (best && rank[0] === bestRank[0] && rank[1] === bestRank[1]) {
      tied = true;
    }
  }
  if (best && tied) best.ambiguous = true;
  return best;
}

// ── Ranking ───────────────────────────────────────────────────────────────

/** Preference order when two strategies tie on all evidence: cheapest first. */
const TIE_BREAK: ResolvedAlignMode[] = ['name', 'number', 'geometry', 'order'];
/** Coverage within this of the best counts as tied — one unmatched pad must
 *  not cost geometry a comparison it otherwise explains completely. */
const COVERAGE_BAND = 0.05;

/**
 * Pick the alignment, and say why.
 *
 * The ranking deliberately does **not** use each strategy's own hit rate.
 * `number` alignment matches 100 % of pins whenever the pin counts are equal —
 * that is a statement about the two files having the same number of pads, not
 * about the pairing being right. So every candidate, however it was produced,
 * is scored by the same two independent kinds of evidence:
 *
 *   * **net agreement** — do paired pins carry the same net name?
 *   * **geometric agreement** — do paired pins sit in the same place under one
 *     rigid transform?
 *
 * Net agreement leads because it is the stronger claim; geometric agreement
 * decides the case the whole feature exists for, a delivery where every net has
 * been renamed and only the copper is comparable.
 */
export function buildAlignment(partA: Part, partB: Part, mode: AlignMode): {
  alignment: Alignment;
  candidates: AlignCandidate[];
} {
  const byName = alignByKey('name', partA.pins, partB.pins, p => p.name.trim().toUpperCase());
  const byNumber = alignByKey('number', partA.pins, partB.pins, p => p.number.trim().toUpperCase());
  const byGeometry = alignByGeometry(partA, partB);
  const byOrder = alignByOrder(partA.pins, partB.pins);

  const all: Alignment[] = [byName, byNumber, byGeometry, byOrder]
    .filter((x): x is Alignment => x !== null);

  const tol = toleranceFor(partA, partB);
  const scored: AlignCandidate[] = all.map(x => ({
    mode: x.mode,
    matched: x.matched,
    score: x.score,
    netAgree: netAgreement(partA, partB, x.pairs),
    geomAgree: geometricAgreement(partA, partB, x.pairs, tol),
  }));
  const rankOf = (c: AlignCandidate) =>
    [c.netAgree, c.geomAgree, -TIE_BREAK.indexOf(c.mode)] as const;
  const better = (p: AlignCandidate, q: AlignCandidate) => {
    // Coverage first, but only outside the band — then evidence.
    if (Math.abs(p.score - q.score) > COVERAGE_BAND) return p.score > q.score;
    const rp = rankOf(p), rq = rankOf(q);
    for (let i = 0; i < rp.length; i++) if (rp[i] !== rq[i]) return rp[i] > rq[i];
    return false;
  };

  const ordered = [...scored].sort((p, q) => (better(p, q) ? -1 : better(q, p) ? 1 : 0));

  if (mode !== 'auto') {
    const picked = all.find(x => x.mode === mode);
    // Requested mode ineligible for this pair — fall through to auto rather
    // than render nothing.
    if (picked) return { alignment: picked, candidates: ordered };
  }

  const winner = all.find(x => x.mode === ordered[0].mode)!;
  return { alignment: winner, candidates: ordered };
}

// ── Topology fingerprints ─────────────────────────────────────────────────

type Fingerprint =
  | { bulk: true; pins: number }
  | { bulk: false; pins: number; refs: Set<string> };

/**
 * The set of components a net touches, minus the part being compared.
 *
 * This is what separates "someone renamed the nets between these two
 * deliveries" from "this pin is wired somewhere else" — and on Apple boards
 * that is the difference between a useful diff and a wall of red.
 *
 * Rails never get a set built. `pinIndices.length` is the cheap pre-check
 * before any allocation: a net with more than BULK_PIN_LIMIT pins, or one the
 * caller's classifier calls ground, is compared by size alone.
 */
function fingerprint(
  board: BoardData,
  netName: string,
  excludeRefdes: string,
  isBulkNet: (n: string) => boolean,
  cache: Map<string, Fingerprint>,
): Fingerprint {
  const hit = cache.get(netName);
  if (hit) return hit;

  const net = board.nets.get(netName);
  const pins = net?.pinIndices.length ?? 0;
  let fp: Fingerprint;
  if (!net) {
    fp = { bulk: false, pins: 0, refs: new Set() };
  } else if (pins > BULK_PIN_LIMIT || isBulkNet(netName)) {
    fp = { bulk: true, pins };
  } else {
    const refs = new Set<string>();
    for (const { partIndex } of net.pinIndices) {
      const p = board.parts[partIndex];
      if (!p) continue;
      const ref = p.name.trim().toUpperCase();
      if (ref === excludeRefdes) continue;
      refs.add(ref);
    }
    fp = { bulk: false, pins, refs };
  }
  cache.set(netName, fp);
  return fp;
}

function jaccard(x: Set<string>, y: Set<string>): number {
  if (x.size === 0 && y.size === 0) return 0;
  let inter = 0;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  for (const v of small) if (large.has(v)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Net names longer than this are truncated before the O(n·m) scan. Nothing
 *  real comes close; the cap only stops a pathological file costing seconds. */
const NAME_SCAN_CAP = 128;

/**
 * Longest run of text two net names share, case-insensitively.
 *
 * Offsets come back in the **original** strings, so the caller can mark the
 * run without re-deriving anything. That is why the comparison lowercases per
 * character instead of uppercasing both strings first: `'ß'.toUpperCase()` is
 * two characters, which would slide every offset after it.
 *
 * Contiguous, not a subsequence. A subsequence LCS would call `PP3V3_S5` and
 * `PP1V8_S0` a 6-character match by picking letters out of the middle; a
 * contiguous run says 2, which is the honest answer.
 */
export function longestCommonRun(a: string, b: string): NameMatch | null {
  const x = a.slice(0, NAME_SCAN_CAP);
  const y = b.slice(0, NAME_SCAN_CAP);
  if (x.length === 0 || y.length === 0) return null;

  // Rolling two-row DP: prev[j] = run length ending at x[i-1], y[j-1].
  let prev = new Array<number>(y.length + 1).fill(0);
  let cur = new Array<number>(y.length + 1).fill(0);
  let best = 0, bestAEnd = 0, bestBEnd = 0;

  for (let i = 1; i <= x.length; i++) {
    const xc = x[i - 1].toLowerCase();
    for (let j = 1; j <= y.length; j++) {
      if (xc === y[j - 1].toLowerCase()) {
        const run = prev[j - 1] + 1;
        cur[j] = run;
        if (run > best) { best = run; bestAEnd = i; bestBEnd = j; }
      } else {
        cur[j] = 0;
      }
    }
    const swap = prev; prev = cur; cur = swap;
    cur.fill(0);
  }

  if (best === 0) return null;
  return {
    aStart: bestAEnd - best,
    bStart: bestBEnd - best,
    length: best,
    ratio: best / Math.max(a.length, b.length),
  };
}

/** Letters and digits only — `PPBUS_G3H` and `PPBUS-G3H` collapse to one. */
function alnumOnly(s: string): string {
  return s.replace(/[^0-9a-z]/gi, '').toLowerCase();
}

/**
 * True when two net names read as one net spelled differently.
 *
 * The rule is **containment**, not a similarity score, and that distinction is
 * the whole point. A score cannot tell `PPBUS_G3H` / `PPBUS_G3H_R` — one name
 * decorated — from `STUB_A` / `STUB_B` or `SMC_RST_L` / `SMC_RST_R`, where a
 * single character is *substituted* and the two are sibling nets that must
 * never be folded together. Both score about the same; only one has the
 * shorter name inside the longer one.
 *
 * The second door is separator-only variation (`PPBUS_G3H` vs `PPBUS-G3H`),
 * which containment misses because the difference sits mid-string.
 */
function isPartialName(m: NameMatch | null, a: string, b: string): m is NameMatch {
  if (alnumOnly(a) === alnumOnly(b) && alnumOnly(a).length >= PARTIAL_NAME_MIN_RUN) {
    return m !== null;
  }
  if (m === null) return false;
  if (m.length < PARTIAL_NAME_MIN_RUN || m.ratio < PARTIAL_NAME_RATIO) return false;
  // The shared run has to be one of the names in full.
  return m.length === Math.min(a.length, b.length);
}

/** Both sides carry a real reading and they diverge past the threshold. */
export function diodeDiverges(a: DiodeReading | undefined, b: DiodeReading | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind === 'open' || b.kind === 'open') return a.kind !== b.kind;
  if (a.kind !== 'value' || b.kind !== 'value') return false;
  if (a.mv == null || b.mv == null) return false;
  const span = Math.max(Math.abs(a.mv), Math.abs(b.mv));
  return Math.abs(a.mv - b.mv) > Math.max(DIODE_ABS_MV, span * DIODE_REL);
}

// ── The comparison ────────────────────────────────────────────────────────

export interface CompareSubject {
  board: BoardData;
  part: Part;
}

const EMPTY_COUNTS = (): Record<PinDiffStatus, number> => ({
  same: 0, renamed: 0, similar: 0, partial: 0, bulk: 0, differs: 0,
  'only-a': 0, 'only-b': 0, nc: 0,
});

function sideOf(pin: Pin, index: number): PinDiffSide {
  return {
    pinIndex: index,
    label: pinLabel(pin),
    net: normalizeNet(pin.net),
    rawNet: (pin.net ?? '').trim(),
    diode: pin.diode,
  };
}

export function comparePart(
  A: CompareSubject,
  B: CompareSubject,
  opts: CompareOptions = {},
): CompareResult {
  const isBulkNet = opts.isBulkNet ?? (() => false);
  const { alignment, candidates } = buildAlignment(A.part, B.part, opts.mode ?? 'auto');

  const refA = A.part.name.trim().toUpperCase();
  const refB = B.part.name.trim().toUpperCase();
  const fpCacheA = new Map<string, Fingerprint>();
  const fpCacheB = new Map<string, Fingerprint>();

  const counts = EMPTY_COUNTS();
  let hasDiode = false;

  const rows: PinDiffRow[] = alignment.pairs.map((pair, i) => {
    const pa = pair.a != null ? A.part.pins[pair.a] : undefined;
    const pb = pair.b != null ? B.part.pins[pair.b] : undefined;
    const a = pa && pair.a != null ? sideOf(pa, pair.a) : null;
    const b = pb && pair.b != null ? sideOf(pb, pair.b) : null;
    if (a?.diode && a.diode.kind !== 'none') hasDiode = true;
    if (b?.diode && b.diode.kind !== 'none') hasDiode = true;

    let status: PinDiffStatus;
    let similarity: number | undefined;
    let nameMatch: NameMatch | null = null;

    if (!a) {
      status = 'only-b';
    } else if (!b) {
      status = 'only-a';
    } else if (a.net === '' && b.net === '') {
      status = 'nc';
    } else if (a.net === b.net) {
      status = 'same';
    } else if (a.net === '' || b.net === '') {
      // One side connected, the other not — always a real difference.
      status = 'differs';
    } else {
      // Two independent kinds of evidence that these are one net: what the net
      // touches, and what it is called. Topology is the stronger claim and is
      // consulted first; the shared name run is computed either way, because
      // the UI marks it on every row whose names differ.
      nameMatch = longestCommonRun(a.rawNet, b.rawNet);
      const fa = fingerprint(A.board, a.rawNet, refA, isBulkNet, fpCacheA);
      const fb = fingerprint(B.board, b.rawNet, refB, isBulkNet, fpCacheB);

      if (fa.bulk || fb.bulk) {
        const span = Math.max(fa.pins, fb.pins) || 1;
        status = (fa.bulk && fb.bulk && Math.abs(fa.pins - fb.pins) / span <= BULK_SIZE_TOLERANCE)
          ? 'bulk'
          : 'differs';
      } else if (fa.refs.size === 0 && fb.refs.size === 0) {
        // Two stubs that touch nothing but the subject part. Equal empty sets
        // are not evidence of sameness, so topology abstains here and the name
        // is all there is to go on.
        similarity = 0;
        status = isPartialName(nameMatch, a.rawNet, b.rawNet) ? 'partial' : 'differs';
      } else {
        similarity = jaccard(fa.refs, fb.refs);
        if (similarity === 1) status = 'renamed';
        else if (similarity >= SIMILAR_JACCARD) status = 'similar';
        else if (isPartialName(nameMatch, a.rawNet, b.rawNet)) status = 'partial';
        else status = 'differs';
      }
    }

    counts[status]++;
    return {
      key: `${pair.a ?? 'x'}:${pair.b ?? 'x'}:${i}`,
      a, b, status, similarity,
      ...(nameMatch ? { nameMatch } : {}),
      diodeDiffers: diodeDiverges(a?.diode, b?.diode),
    };
  });

  const diagA = bboxDiagonal(A.part.pins);
  const diagB = bboxDiagonal(B.part.pins);
  const sizeMismatch =
    diagA > 0 && diagB > 0 &&
    Math.abs(diagA - diagB) / Math.max(diagA, diagB) > SIZE_TOLERANCE;

  return {
    alignment,
    rows,
    counts,
    differences: DIFFERENCE_STATUSES.reduce((n, s) => n + counts[s], 0),
    sizeMismatch,
    hasDiode,
    candidates,
  };
}

// ── Serialisation ─────────────────────────────────────────────────────────

const STATUS_SYMBOL: Record<PinDiffStatus, string> = {
  same: '=', renamed: '~', similar: '~', partial: '≈', bulk: '≡',
  differs: '≠', 'only-a': '◁', 'only-b': '▷', nc: '·',
};

export function statusSymbol(s: PinDiffStatus): string { return STATUS_SYMBOL[s]; }

/** Tab-separated dump of the given rows, header included. */
export function compareToText(
  rows: PinDiffRow[],
  labelA: string,
  labelB: string,
  withDiode: boolean,
): string {
  const head = withDiode
    ? ['pin A', `net · ${labelA}`, 'Δ', `net · ${labelB}`, 'pin B', 'diode A', 'diode B']
    : ['pin A', `net · ${labelA}`, 'Δ', `net · ${labelB}`, 'pin B'];
  const lines = [head.join('\t')];
  for (const r of rows) {
    const cells = [
      r.a?.label ?? '',
      r.a?.rawNet ?? '',
      STATUS_SYMBOL[r.status],
      r.b?.rawNet ?? '',
      r.b?.label ?? '',
    ];
    if (withDiode) {
      cells.push(r.a?.diode?.raw ?? '', r.b?.diode?.raw ?? '');
    }
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}
