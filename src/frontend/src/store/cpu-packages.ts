/**
 * CPU / GPU / SoC package records — what sits on top of a large BGA, so the 3D
 * view can draw a Skylake-U as two bare dies beside each other, a GeForce as a
 * die in a stiffener ring, a Ryzen as a die in its frame, instead of a flat
 * box the size of the ball field.
 *
 * Lookup is by what a boardview reliably carries: the ball **pitch** and the
 * ball field's **span** (outer ball centres), with the ball count as a check.
 * The count alone cannot be the key: a boardview may omit unconnected balls
 * (the MacBook Pro A2251's Ice Lake-U lists 1,344 of its 1,526), and GA102 /
 * AD102 share one 3,328-ball footprint. Either orientation matches.
 *
 * Dimensions in mm. Die positions are in the package's own frame: x along the
 * body length L, y along the width W, origin at the package centre, A1 at
 * (−x, +y). Sources and confidence per record; "span" is measured on a sample
 * board when one exists (scripts/cpu-package-ballmaps.ts), else derived from
 * the body with the edge margin. Research: docs/specs/2026-11-15-cpu-packages.md.
 */

import { SIGNATURES } from './cpu-package-signatures';

export type DieKind = 'cpu' | 'gpu' | 'pch' | 'io' | 'mem' | 'base';
export interface PackageDie { kind: DieKind; label?: string; x: number; y: number; w: number; d: number; h?: number; onInterposer?: boolean }
export interface CapRow { x: number; y: number; n: number; dir: 'x' | 'y'; pitch?: number; size?: '0402' | '0201' }
export interface PackageSpec {
  id: string;
  vendor: 'intel' | 'amd' | 'nvidia' | 'apple' | 'memory';
  name: string;
  /** Nominal ball count. */
  balls: number;
  /** Nearest-neighbour pitch (minimum pitch on a multi-pitch field). */
  pitch: number;
  body: { L: number; W: number; H?: number; sub?: number };
  /** Outer ball-centre span [along L, along W]; measured where a sample exists. */
  span: [number, number];
  style: string;
  dies?: PackageDie[];
  lid?: { w: number; d: number; h: number; x?: number; y?: number };
  ring?: { w: number; d: number; t?: number; h?: number };
  /** A moulded FBGA (memory, NAND): the mould compound covers the whole body to this height above the substrate; `finish` 'silver' for the metallic-looking Apple NAND packages. */
  mold?: { h: number; finish?: 'black' | 'silver' };
  /** An LGA socket on the pad field: plastic frame (outer w × d, wall t, height h) around a lidded CPU drawn by `lid`. */
  socket?: { w: number; d: number; t: number; h: number };
  interposer?: { w: number; d: number; h: number; x?: number; y?: number };
  caps?: CapRow[];
  used?: string;
  sources?: string[];
  confidence?: string;
  notes?: string;
  /** Ball-map entry id in the mockup (docs/specs/2026-11-15-cpu-package-ballmaps.js). */
  mapId?: string;
  /** 12 × 12 ball-occupancy signature of the sample's field in the record frame (generated; orients a matched field). */
  sig?: number[];
}

export const SIG_N = 12;
/** Ball-occupancy signature: the fraction of balls in each cell of a SIG_N × SIG_N grid over the field's own bounding
 *  box, rows from +y (top) to −y, columns from −x to +x. Scale-free, so mils and mm compare. */
export function ballSignature(pts: readonly { x: number; y: number }[], n = SIG_N): number[] {
  const out = new Array<number>(n * n).fill(0); if (!pts.length) return out;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9);
  for (const p of pts) { const i = Math.min(n - 1, Math.floor((p.x - x0) / w * n)), j = Math.min(n - 1, Math.floor((y1 - p.y) / h * n)); out[j * n + i] += 1 / pts.length; }
  return out;
}
export type Turn = 0 | 90 | 180 | 270;
/** The turn (CCW, degrees) that brings a measured field onto a record's signature, by the smallest L1 distance over
 *  the four right angles. `mirrorY` = the field is seen through the board (a bottom-side part): the package is the
 *  field with y mirrored, which is what the 3D renderer does to a bottom part's model. A symmetric field ties; the
 *  smallest turn wins then. `allowed` restricts the turns — the span already says whether the field is turned 90°. */
export function orientToSignature(sig: readonly number[], locs: readonly { x: number; y: number }[], mirrorY: boolean, allowed: readonly Turn[] = [0, 90, 180, 270]): { turn: Turn; fit: number; worst: number } {
  let best: { turn: Turn; fit: number } | null = null, worst = 0;
  for (const turn of allowed) {
    const pts = locs.map(p => { // package = R(−turn) · field, then the side mirror
      const q = turn === 0 ? p : turn === 90 ? { x: p.y, y: -p.x } : turn === 180 ? { x: -p.x, y: -p.y } : { x: -p.y, y: p.x };
      return mirrorY ? { x: q.x, y: -q.y } : q;
    });
    const s = ballSignature(pts); let d = 0; for (let i = 0; i < s.length; i++) d += Math.abs(s[i] - sig[i]);
    if (!best || d < best.fit - 1e-9) best = { turn, fit: d }; if (d > worst) worst = d;
  }
  return { ...best!, worst };
}


export interface PackageMeasure { balls: number; pitch: number; spanX: number; spanY: number }
export interface PackageMatch { spec: PackageSpec; /** The field's X axis is the body's W (turn the model 90°). */ turned: boolean; score: number; missingBalls: number }

const SPAN_TOL = 1.2; // mm, summed over both axes — under one ball pitch of slack per axis (an LGA1151 pad field is 1.3 from Polaris)
const PITCH_TOL = 0.06;

/** Best record for a measured ball field, or null. Span and pitch decide; a count above the nominal rules a record
 *  out, a count below it costs a little (balls the file left out). */
export function matchPackage(m: PackageMeasure, specs: readonly PackageSpec[] = PACKAGES): PackageMatch | null {
  let best: PackageMatch | null = null;
  for (const s of specs) {
    const dp = Math.abs(s.pitch - m.pitch); if (dp > PITCH_TOL) continue;
    const fit = (a: number, b: number) => Math.abs(a - m.spanX) + Math.abs(b - m.spanY);
    const straight = fit(s.span[0], s.span[1]), turned = fit(s.span[1], s.span[0]);
    const ds = Math.min(straight, turned); if (ds > SPAN_TOL) continue;
    if (m.balls > s.balls * 1.01 || m.balls < s.balls * 0.8) continue;
    const missing = Math.max(0, s.balls - m.balls);
    const score = ds + 20 * dp + (missing ? 0.5 + 2 * missing / s.balls : 0);
    if (!best || score < best.score) best = { spec: s, turned: turned < straight, score, missingBalls: missing };
  }
  return best;
}

// Die rectangles: a die's published area is turned into a rectangle with the aspect of its die shot where known,
// else near-square. Spans without a sample board are body − 2 × 1.0 mm (edge margin of a typical FC-BGA).
const sq = (area: number, aspect = 1) => ({ w: +Math.sqrt(area * aspect).toFixed(1), d: +Math.sqrt(area / aspect).toFixed(1) });

export const PACKAGES: PackageSpec[] = [
  // ── Intel mobile — "Balls Anywhere" fields (no regular grid), bare flip-chip dies, land-side caps in the depopulated
  // centre. Body sizes and pitches from Intel datasheets (doc numbers in `sources`); die areas from third-party die
  // shots (±5 %); die *positions* from package photos. CPU die on the A1 side, PCH beside it along L.
  { id: 'intel-bga1515', vendor: 'intel', name: 'Intel BGA1515 (Skylake-Y / Kaby Lake-Y / Amber Lake-Y)', balls: 1515, pitch: 0.4, body: { L: 20, W: 16.5, H: 1.0, sub: 0.6 }, span: [18.7, 15.2], style: 'two bare dies (CPU + PCH-LP)',
    dies: [{ kind: 'cpu', label: 'CPU', x: -3.6, y: 0, w: 10.3, d: 9.6, h: 0.45 }, { kind: 'pch', label: 'PCH-LP', x: 5.2, y: 0, w: 5.6, d: 9.0, h: 0.45 }],
    used: 'Core m3/m5/m7-6Yxx, i5/i7-7Yxx, i5-8210Y, i7-8500Y; MacBook 12", MacBook Air 2018–19', mapId: 'bga1515', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/332990'], confidence: 'count, pitch, body primary (Intel 332990 Table 8-1); span measured (A1932); PCH die size guessed' },
  { id: 'intel-bga1356', vendor: 'intel', name: 'Intel BGA1356 (Skylake-U / Kaby Lake-U / Kaby Lake-R)', balls: 1356, pitch: 0.65, body: { L: 42, W: 24, H: 1.3, sub: 0.8 }, span: [40.7, 22.8], style: 'two bare dies (CPU + PCH-LP), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -5.0, y: 0, w: 11.0, d: 10.0, h: 0.6 }, { kind: 'pch', label: 'PCH-LP', x: 6.5, y: 0, w: 7.4, d: 11.6, h: 0.6 }],
    caps: [{ x: -14.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 14.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i3/i5/i7-6xxxU, 7xxxU, i5-8250U/i7-8650U; MacBook Pro 13" 2016–17 (A1706/A1708), Dell XPS 13 9350–9360', mapId: 'bga1356', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/332990'], confidence: 'count, pitch, body primary (Intel 332990); span measured on seven boards; dies: 2+2 die 98.6 mm², quad 123 mm² — drawn between; Iris SKUs add an eDRAM die (not drawn)' },
  { id: 'intel-bga1440', vendor: 'intel', name: 'Intel BGA1440 (Skylake-H → Comet Lake-H)', balls: 1440, pitch: 0.65, body: { L: 42, W: 28, H: 1.49, sub: 0.8 }, span: [40.7, 26.8], style: 'one bare die, die-side caps; PCH-H separate',
    dies: [{ kind: 'cpu', label: 'CPU', x: 0, y: 0, w: 13.7, d: 10.9, h: 0.65 }], caps: [{ x: -10.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 10.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i7-6700HQ, 7700HQ, 8750H, 9980HK, 10750H; Dell XPS 15 9550–9500, MacBook Pro 15" 2016–19 (A1707/A1990/A2141), Mac mini 2018', mapId: 'bga1440', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/337344', 'https://cdrdv2-public.intel.com/334408/6th-gen-core-pentium-celeron-xeon-e3-v5-processor-h-s-u-series-eds-addendum.pdf'], confidence: 'count, pitch, body, height primary (Intel 337344, 334408); span measured on nine boards; die drawn at the 6-core 150 mm²' },
  { id: 'intel-bga1528', vendor: 'intel', name: 'Intel BGA1528 (Coffee Lake-U 28 W / Whiskey Lake-U / Comet Lake-U)', balls: 1528, pitch: 0.65, body: { L: 46, W: 24, H: 1.3, sub: 0.8 }, span: [44.7, 22.7], style: 'two bare dies (CPU + PCH-LP), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -6.0, y: 0, w: 12.3, d: 10.0, h: 0.6 }, { kind: 'pch', label: 'PCH-LP', x: 7.5, y: 0, w: 7.4, d: 11.6, h: 0.6 }],
    caps: [{ x: -16.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 16.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i5-8259U/i7-8559U, i5-8265U/i7-8565U, i5-10210U/i7-10710U; MacBook Pro 13" 2018–20 (A1989/A2159/A2289), ThinkPad X1 Carbon Gen 7', mapId: 'bga1528', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/337344', 'https://cdrdv2.intel.com/v1/dl/getContent/338023'], confidence: 'count, pitch, body primary (Intel 337344/338023); span measured on six boards; 28 W GT3e SKUs carry a third (eDRAM) die, not drawn' },
  { id: 'intel-bga1526', vendor: 'intel', name: 'Intel BGA1526 (Ice Lake-U)', balls: 1526, pitch: 0.65, body: { L: 50, W: 25, H: 1.3, sub: 0.8 }, span: [44.0, 23.2], style: 'two bare dies (CPU + PCH-LP), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -5.5, y: 0, w: 11.4, d: 10.7, h: 0.6 }, { kind: 'pch', label: 'PCH-LP', x: 6.5, y: 0, w: 5.7, d: 9.4, h: 0.6 }],
    caps: [{ x: -16.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 16.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i3-1005G1, i5-1035G7, i7-1065G7; MacBook Pro 13" 2020 4-port (A2251), Dell XPS 13 9300', mapId: 'bga1526', sources: ['https://www.intel.com/content/www/us/en/products/sku/196597/intel-core-i71065g7-processor-8m-cache-up-to-3-90-ghz/specifications.html'],
    confidence: 'count and body from ARK; pitch secondary; the only sample (A2251 XZZ) lists 1,344 balls over 44.0 × 23.2 mm, which is the span recorded — a file listing all 1,526 may span more and miss', notes: 'Die sizes measured by third parties: CPU 11.44 × 10.71 mm, PCH-LP 5.74 × 9.42 mm.' },
  { id: 'intel-bga1449', vendor: 'intel', name: 'Intel BGA1449 (Tiger Lake UP3 / H35)', balls: 1449, pitch: 0.65, body: { L: 45.5, W: 25, H: 1.185, sub: 0.6 }, span: [44.1, 23.6], style: 'two bare dies (CPU + PCH-LP), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -5.0, y: 0, w: 13.6, d: 10.7, h: 0.55 }, { kind: 'pch', label: 'PCH-LP', x: 7.5, y: 0, w: 6.0, d: 9.5, h: 0.55 }],
    used: 'i5-1135G7, i7-1165G7, i7-1185G7, i7-11375H; Dell XPS 13 9310, Surface Pro 8', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/631121'], confidence: 'count, pitch, body, height primary (Intel 631121 Table 14-1); no sample — span derived (body − 1.4 mm); CPU die 13.6 × 10.7 secondary, PCH guessed' },
  { id: 'intel-bga1598', vendor: 'intel', name: 'Intel BGA1598 (Tiger Lake UP4)', balls: 1598, pitch: 0.4, body: { L: 26.5, W: 18.5, H: 0.963, sub: 0.5 }, span: [25.3, 17.3], style: 'two bare dies (CPU + PCH-LP)',
    dies: [{ kind: 'cpu', label: 'CPU', x: -4.0, y: 0, w: 13.6, d: 10.7, h: 0.45 }, { kind: 'pch', label: 'PCH-LP', x: 7.5, y: 0, w: 6.0, d: 9.5, h: 0.45 }],
    used: 'i5-1130G7, i7-1160G7, i7-1180G7; ThinkPad X1 Nano Gen 1', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/631121'], confidence: 'count, pitch, body, height primary (Intel 631121); no sample — span derived' },
  { id: 'intel-bga1787', vendor: 'intel', name: 'Intel BGA1787 (Tiger Lake-H45)', balls: 1787, pitch: 0.65, body: { L: 50, W: 26.5, H: 1.41, sub: 0.7 }, span: [48.6, 25.1], style: 'one bare die, land-side caps; PCH-H separate',
    dies: [{ kind: 'cpu', label: 'CPU', x: 0, y: 0, w: 15.7, d: 12.1, h: 0.65 }], caps: [{ x: -12.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 12.5, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i5-11400H, i7-11800H, i9-11980HK; Dell XPS 15 9510, Legion 5 Pro 2021', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/631121'], confidence: 'count, pitch, body primary (Intel 631121; height 1.41 from the table, §1.2 says 1.325); no sample — span derived; die ≈190 mm² secondary' },
  { id: 'intel-bga1744', vendor: 'intel', name: 'Intel BGA1744 (Alder Lake-P/H/U15, Raptor Lake-P/H/U)', balls: 1744, pitch: 0.65, body: { L: 50, W: 25, H: 1.185, sub: 0.594 }, span: [49.2, 24.5], style: 'two bare dies (CPU + PCH-P), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -5.5, y: 0, w: 10.6, d: 20.5, h: 0.55 }, { kind: 'pch', label: 'PCH-P', x: 6.5, y: 0, w: 7.0, d: 7.7, h: 0.55 }],
    caps: [{ x: 15.5, y: 0, n: 10, dir: 'y', pitch: 1.2 }, { x: -16, y: 0, n: 10, dir: 'y', pitch: 1.2 }],
    used: 'i7-1260P, i7-12700H, i7-1255U, i7-1360P, i7-13700H, Core 7 150U; Dell XPS 13 Plus 9320, XPS 15 9520/9530', mapId: 'bga1744', sources: ['https://cdrdv2-public.intel.com/655258/655258-011.pdf', 'https://cdrdv2.intel.com/v1/dl/getContent/743844'], confidence: 'count, pitch, body, substrate, height primary (Intel 655258 / 743844 Table 99); span measured (LA-P161P); 6+8 die 217 mm² ≈ 10.6 × 20.5 and PCH-P ≈ 54 mm² secondary; the 2+8 U die is smaller' },
  { id: 'intel-bga1781', vendor: 'intel', name: 'Intel BGA1781 (Alder Lake-U 9 W)', balls: 1781, pitch: 0.4, body: { L: 28.5, W: 19, H: 1.033, sub: 0.5 }, span: [27.3, 17.8], style: 'two bare dies (CPU + PCH-P)',
    dies: [{ kind: 'cpu', label: 'CPU', x: -4.0, y: 0, w: 9.5, d: 15.5, h: 0.45 }, { kind: 'pch', label: 'PCH-P', x: 7.0, y: 0, w: 7.0, d: 7.7, h: 0.45 }],
    used: 'i5-1230U, i7-1250U, i7-1260U; Dell XPS 13 9315', sources: ['https://cdrdv2-public.intel.com/655258/655258-011.pdf'], confidence: 'count, pitch, body, height primary (Intel 655258); no sample — span derived; 2+8 die size guessed' },
  { id: 'intel-bga1792', vendor: 'intel', name: 'Intel BGA1792 (Raptor Lake-PX)', balls: 1792, pitch: 0.62, body: { L: 40, W: 25, H: 1.171, sub: 0.6 }, span: [38.8, 23.8], style: 'two bare dies (CPU + PCH-PX)',
    dies: [{ kind: 'cpu', label: 'CPU', x: -4.5, y: 0, w: 10.6, d: 20.5, h: 0.55 }, { kind: 'pch', label: 'PCH-PX', x: 7.0, y: 0, w: 7.0, d: 7.7, h: 0.55 }],
    used: 'optional 40 × 25 form factor of some 13th-gen P/H SKUs', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/743844'], confidence: 'count, pitch, body, height primary (Intel 743844 Table 100); no sample — span derived' },
  { id: 'intel-bga1964', vendor: 'intel', name: 'Intel BGA1964 (Alder Lake-HX / Raptor Lake-HX)', balls: 1964, pitch: 0.8, body: { L: 45, W: 37.5, H: 2.005, sub: 1.119 }, span: [42.4, 36.0], style: 'one bare desktop die, die-side caps, regular 0.8 mm grid; PCH-S separate', mapId: 'bga1964',
    dies: [{ kind: 'cpu', label: 'CPU', x: 0, y: 0, w: 23.8, d: 10.8, h: 0.75 }], caps: [{ x: 0, y: 9.5, n: 12, dir: 'x', pitch: 1.3 }, { x: 0, y: -9.5, n: 12, dir: 'x', pitch: 1.3 }],
    used: 'i9-12900HX, i9-13980HX, i9-14900HX; MSI Raider GE78 HX, Dell Precision 7670', sources: ['https://cdrdv2-public.intel.com/655258/655258-011.pdf', 'https://cdrdv2.intel.com/v1/dl/getContent/743844'], confidence: 'count, pitch, body, substrate, height primary (Intel 655258 / 743844 Table 98 — the 1.185 in §1.2 is a copy error); span measured (Lenovo Legion Pro 5 16IRX9, NM-F701); RPL-S 8+16 die 257 mm² ≈ 23.8 × 10.8 secondary' },
  { id: 'intel-bga2049', vendor: 'intel', name: 'Intel BGA2049 (Meteor Lake-U/H, Arrow Lake-H/U)', balls: 2049, pitch: 0.65, body: { L: 50, W: 25, H: 1.245, sub: 0.644 }, span: [48.7, 23.7], style: 'Foveros: four tiles in a row on a base tile, bare',
    interposer: { w: 24.2, d: 11.3, h: 0.25, x: 0, y: 0 },
    dies: [{ kind: 'gpu', label: 'GPU', x: -9.6, y: 0, w: 4.4, d: 10.4, h: 0.35, onInterposer: true }, { kind: 'io', label: 'SoC', x: -2.3, y: 0, w: 9.6, d: 10.4, h: 0.35, onInterposer: true }, { kind: 'cpu', label: 'Compute', x: 5.9, y: 0, w: 6.4, d: 10.4, h: 0.35, onInterposer: true }, { kind: 'pch', label: 'IOE', x: 10.6, y: 0, w: 2.6, d: 10.4, h: 0.35, onInterposer: true }],
    caps: [{ x: -16, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 16, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'Core Ultra 5 125H/U, 7 155H/165H, 9 185H, Ultra 5 225H, 7 255H, 9 285H; Dell XPS 14 9440, Yoga Pro 9i Gen 10', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/792044', 'https://cdrdv2.intel.com/v1/dl/getContent/842704'], confidence: 'count, pitch, body, substrate, height primary (Intel 792044 / 842704 Table 10); no sample — span derived; tile areas from Locuza/TechInsights estimates, the row order GPU · SoC · Compute · IOE from Intel\'s package photo; Arrow Lake-H tiles unknown, drawn as Meteor Lake' },
  { id: 'intel-bga2551', vendor: 'intel', name: 'Intel BGA2551 (Meteor Lake-U Type 4)', balls: 2551, pitch: 0.37, body: { L: 23, W: 19, H: 0.675, sub: 0.24 }, span: [22.0, 18.0], style: 'Foveros tiles in a row on a thin base, bare, low-temperature solder',
    interposer: { w: 22.2, d: 10.4, h: 0.15, x: 0, y: 0 }, dies: [{ kind: 'gpu', label: 'GPU', x: -8.8, y: 0, w: 4.0, d: 9.6, h: 0.25, onInterposer: true }, { kind: 'io', label: 'SoC', x: -2.1, y: 0, w: 8.8, d: 9.6, h: 0.25, onInterposer: true }, { kind: 'cpu', label: 'Compute', x: 5.4, y: 0, w: 5.9, d: 9.6, h: 0.25, onInterposer: true }, { kind: 'pch', label: 'IOE', x: 9.7, y: 0, w: 2.4, d: 9.6, h: 0.25, onInterposer: true }],
    used: 'Core Ultra 5 134U, 7 164U', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/792044'], confidence: 'count, pitch (0.37 corner / 0.40 under the tile), body, height primary (Intel 792044 Table 11); no sample — span derived' },
  { id: 'intel-bga2114', vendor: 'intel', name: 'Intel BGA2114 (Arrow Lake-HX)', balls: 2114, pitch: 0.65, body: { L: 37.5, W: 30.2, H: 2.0, sub: 1.1 }, span: [36.2, 28.9], style: 'Foveros: desktop Arrow Lake tiles in a row on a base tile, bare; PCH separate',
    interposer: { w: 25.5, d: 11.9, h: 0.3 }, dies: [{ kind: 'cpu', label: 'Compute', x: -7.2, y: 0, w: 10.6, d: 11.0, h: 0.4, onInterposer: true }, { kind: 'gpu', label: 'GPU', x: -0.2, y: 2.8, w: 4.2, d: 5.4, h: 0.4, onInterposer: true }, { kind: 'base', label: 'filler', x: -0.2, y: -2.8, w: 4.2, d: 5.4, h: 0.4, onInterposer: true }, { kind: 'io', label: 'SoC', x: 6.1, y: 0, w: 7.9, d: 11.0, h: 0.4, onInterposer: true }, { kind: 'pch', label: 'IOE', x: 11.3, y: 0, w: 2.3, d: 11.0, h: 0.4, onInterposer: true }],
    used: 'Core Ultra 5 235HX, 7 255HX, 9 275HX/285HX; Legion Pro 7i Gen 10, MSI Raider 18 HX', sources: ['https://cdrdv2-public.intel.com/834774/834774_024.pdf'], confidence: 'count and body primary (Intel 834774 spec update); pitch unpublished — 0.65 inferred (0.8 cannot hold 2,114 balls on 37.5 × 30.2); height guessed from the HX line; tiles as the desktop 285K die photo' },
  { id: 'intel-bga2833', vendor: 'intel', name: 'Intel BGA2833 (Lunar Lake, Core Ultra 200V)', balls: 2833, pitch: 0.5, body: { L: 27.5, W: 27, H: 1.58, sub: 0.584 }, span: [26.3, 25.8], style: 'Foveros stack + two LPDDR5X packages on the substrate, bare',
    interposer: { w: 15.5, d: 13.5, h: 0.25, x: -5, y: 0 }, dies: [{ kind: 'cpu', label: 'Compute', x: -7.3, y: 0, w: 10.6, d: 12.8, h: 0.35, onInterposer: true }, { kind: 'pch', label: 'PCT', x: -0.2, y: 0, w: 3.6, d: 12.8, h: 0.35, onInterposer: true }, { kind: 'mem', label: 'LPDDR5X', x: 8.0, y: 6.4, w: 9.5, d: 11.0, h: 0.95 }, { kind: 'mem', label: 'LPDDR5X', x: 8.0, y: -6.4, w: 9.5, d: 11.0, h: 0.95 }],
    used: 'Core Ultra 5 226V–9 288V; Dell XPS 13 9350 (2024), Asus Zenbook S 14', sources: ['https://cdrdv2-public.intel.com/829568/829568-004.pdf', 'https://www.hc2024.hotchips.org/assets/program/conference/day1/56_HC2024.Intel.AGihon.final.pdf'], confidence: 'count, pitch, body, substrate, heights primary (Intel 829568 Table 10: 1.34 mm with 2 × 8 GB, 1.58 with 2 × 16 GB DRAM); no sample — span derived; tile sizes secondary, DRAM placement from photos' },
  { id: 'intel-fcbga1338', vendor: 'intel', name: 'Intel FCBGA1338 (Jasper Lake)', balls: 1338, pitch: 0.593, body: { L: 35, W: 24, H: 1.406, sub: 0.8 }, span: [33.8, 22.8], style: 'two bare dies (compute + PCH)',
    dies: [{ kind: 'cpu', label: 'SoC', x: -4.5, y: 0, w: 9.0, d: 8.5, h: 0.6 }, { kind: 'pch', label: 'PCH', x: 5.5, y: 0, w: 6.0, d: 7.5, h: 0.6 }],
    used: 'Celeron N4500/N5100, Pentium Silver N6000; Vivobook Go 15 E510', sources: ['https://cdrdv2-public.intel.com/633935/633935-006.pdf'], confidence: 'count, pitch, body, height primary (Intel 633935 Table 1-1); no sample — span derived; die sizes guessed' },
  // older Intel parts the local corpus carries
  { id: 'intel-bga1364', vendor: 'intel', name: 'Intel BGA1364 (Haswell-H / Broadwell-H)', balls: 1364, pitch: 0.7, body: { L: 37.5, W: 32, H: 1.5, sub: 0.8 }, span: [35.9, 30.6], style: 'one bare die, die-side caps; PCH-H separate',
    dies: [{ kind: 'cpu', label: 'CPU', x: 0, y: 0, w: 15.5, d: 11.5, h: 0.65 }], caps: [{ x: -11, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 11, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i7-4700HQ–4980HQ, i7-5700HQ; MacBook Pro 15" 2013–15 (A1398), iMac 21.5" 2014–15', mapId: 'bga1364', confidence: 'ball field measured on nine boards (Allegro HASWELL_BGA_1364P); body from the span; die drawn at the 4+3e GT3e size' },
  { id: 'intel-bga1168', vendor: 'intel', name: 'Intel BGA1168 (Haswell-ULT / Broadwell-U)', balls: 1168, pitch: 0.65, body: { L: 40, W: 24, H: 1.3, sub: 0.8 }, span: [38.7, 22.7], style: 'two bare dies (CPU + PCH-LP), land-side caps',
    dies: [{ kind: 'cpu', label: 'CPU', x: -5.5, y: 0, w: 11.0, d: 10.0, h: 0.6 }, { kind: 'pch', label: 'PCH-LP', x: 6.5, y: 0, w: 7.0, d: 10.5, h: 0.6 }],
    caps: [{ x: -14, y: 0, n: 8, dir: 'y', pitch: 1.2 }, { x: 14, y: 0, n: 8, dir: 'y', pitch: 1.2 }],
    used: 'i5-4250U–4650U, i5-5250U–5350U; MacBook Air 2013–17, MacBook Pro 13" 2013–15 (A1502)', mapId: 'bga1168', confidence: 'ball field measured on twelve boards (Allegro SHARK-BAY-ULT_BGA_1168P); body from the span' },
  { id: 'intel-bga1380', vendor: 'intel', name: 'Intel BGA1380 (Bay Trail-M/D)', balls: 1380, pitch: 0.4, body: { L: 17, W: 17, H: 1.2, sub: 0.6 }, span: [16.0, 16.0], style: 'one bare die',
    dies: [{ kind: 'cpu', label: 'SoC', x: 0, y: 0, w: 9.0, d: 9.0, h: 0.5 }], used: 'Celeron N2830/N2940, Pentium N3530', mapId: 'bga1380', confidence: 'ball field measured (Allegro BGA1380-INTEL-VALLEYVIEW); body from the span; die guessed' },
  // desktop sockets on the pad field (iMac, Mac Pro): the socket body and a lidded CPU
  { id: 'intel-lga1151', vendor: 'intel', name: 'Intel LGA1151 / LGA1200 socket', balls: 1200, pitch: 0.914, body: { L: 44, W: 44, H: 4.4, sub: 0 }, span: [36.6, 37.9], style: 'LGA socket with a lidded CPU',
    socket: { w: 44, d: 44, t: 3.2, h: 2.4 }, lid: { w: 32, d: 32, h: 2.0 }, used: 'iMac 21.5"/27" 2015–20 (A1418/A1419/A2115), desktop Skylake → Rocket Lake', mapId: 'lga1151', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/337344'], confidence: 'pad field measured on five iMac boards (1,151 / 1,200 pads @ 0.914 mm); socket body approximate' },
  { id: 'intel-lga2066', vendor: 'intel', name: 'Intel LGA2066 socket', balls: 2066, pitch: 1.0, body: { L: 58, W: 51, H: 5.0, sub: 0 }, span: [51.4, 45.9], style: 'LGA socket with a lidded CPU',
    socket: { w: 58, d: 51, t: 3.5, h: 2.8 }, lid: { w: 48, d: 42, h: 2.2 }, used: 'iMac Pro A1862 (Xeon W), Skylake-X / Cascade Lake-X desktops', mapId: 'lga2066', confidence: 'pad field measured (A1862); socket body approximate' },

  // ── AMD mobile — every FP/FL package is a lidless flip-chip die (or dies) inside a peripheral stiffener frame
  // (AMD XAPP1377); the ball field is multi-pitch, so pitch here is the minimum. No AMD board in the local corpus.
  { id: 'amd-fp5', vendor: 'amd', name: 'AMD FP5 (Raven Ridge / Picasso / Dali)', balls: 1140, pitch: 0.7, body: { L: 35, W: 25, H: 1.38, sub: 0.9 }, span: [33, 23], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'cpu', label: 'APU', x: 0, y: 0, ...sq(210, 1.1), h: 0.6 }], ring: { w: 33.5, d: 23.5, t: 1.6, h: 0.65 },
    used: 'Ryzen 2000U/3000U, Athlon 300U, Ryzen Embedded V1000/R1000', sources: ['https://en.wikichip.org/wiki/amd/packages/fp5'], confidence: 'secondary (WikiChip); 0.7 mm minimum pitch, multi-pitch field' },
  { id: 'amd-fp6', vendor: 'amd', name: 'AMD FP6 / FP7 / FP7r2 (Renoir → Hawk Point)', balls: 1140, pitch: 0.65, body: { L: 35, W: 25, H: 1.38, sub: 0.9 }, span: [33, 23], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'cpu', label: 'APU', x: 0, y: 0, ...sq(178, 1.1), h: 0.6 }], ring: { w: 33.5, d: 23.5, t: 1.6, h: 0.65 },
    used: 'Ryzen 4000 / 5000 (FP6), Ryzen 6000 / 7035 / 7040 / 8040 (FP7, FP7r2), Ryzen Embedded V2000 / V3000 / 8000', sources: ['https://en.wikichip.org/wiki/amd/packages/fp6', 'https://www.amd.com/content/dam/amd/en/documents/products/embedded/ryzen/ryzen-embedded-v3000-series-product-brief.pdf', 'https://www.amd.com/content/dam/amd/en/documents/products/embedded/ryzen/amd-ryzen-embedded-8000-product-brief.pdf', 'https://docs.amd.com/r/en-US/xapp1377-heatsinks-thermal/Embedded-x86-BGA-Packages-Ryzen-and-EPYC-Covers-FPx-FLx-and-SPx'],
    confidence: 'primary count, pitch, body, height (AMD V3000 / Embedded 8000 briefs: 1140 balls, 0.65 mm, 25 × 35 × 1.38, lidless); no sample — span derived; die 156–210 mm² secondary',
    notes: 'FP6, FP7 and FP7r2 share one body and ball count and cannot be told apart from the ball field; the model is the same (one die in a frame).' },
  { id: 'amd-fp8', vendor: 'amd', name: 'AMD FP8 (Phoenix / Hawk Point / Strix Point / Krackan)', balls: 1377, pitch: 0.65, body: { L: 40, W: 25, H: 1.4, sub: 0.9 }, span: [38, 23], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'cpu', label: 'APU', x: 0, y: 0, ...sq(232.5, 1.2), h: 0.6 }], ring: { w: 38.5, d: 23.5, t: 1.6, h: 0.65 },
    used: 'Ryzen 7040 (FP8 SKUs), 8040, Ryzen AI 300, Ryzen AI 7 350', sources: ['https://hothardware.com/news/strix-point-bga-2077-leak', 'https://newsroom.amd.com/news/2026/1/5/amd-introduces-ryzen-ai-embedded-processor-portfol/'], confidence: 'body primary (AMD press release 25×40); 1377 balls from a leaked AMD document; pitch unpublished — 0.65 assumed' },
  { id: 'amd-fp11', vendor: 'amd', name: 'AMD FP11 (Strix Halo, Ryzen AI Max)', balls: 2077, pitch: 0.65, body: { L: 45, W: 37.5, H: 1.5, sub: 0.9 }, span: [43, 35.5], style: 'three bare dies on a fan-out interposer, stiffener frame',
    interposer: { w: 36, d: 22, h: 0.15 },
    dies: [{ kind: 'io', label: 'IOD + GPU', x: 0, y: 0, w: 19.2, d: 16.0, h: 0.6, onInterposer: true }, { kind: 'cpu', label: 'CCD', x: -14.5, y: 0, w: 7.3, d: 9.1, h: 0.6, onInterposer: true }, { kind: 'cpu', label: 'CCD', x: 14.5, y: 0, w: 7.3, d: 9.1, h: 0.6, onInterposer: true }], ring: { w: 43.5, d: 36, t: 1.8, h: 0.8 },
    used: 'Ryzen AI Max 385 / 390 / Max+ 395', sources: ['https://www.techpowerup.com/324271/amd-strix-halo-a-large-rectangular-bga-package-the-size-of-an-lga1700-processor', 'https://www.techinsights.com/blog/amd-ryzen-series-strix-halo-advanced-packaging-quick-look-analysis'], confidence: 'body and count from a leaked AMD document; die sizes from an annotated die shot; pitch unpublished — 0.65 assumed' },
  { id: 'amd-fl1', vendor: 'amd', name: 'AMD FL1 (Dragon Range / Fire Range HX)', balls: 1763, pitch: 0.65, body: { L: 40, W: 40, H: 1.6, sub: 1.0 }, span: [38, 38], style: 'desktop chiplets, bare, no IHS',
    dies: [{ kind: 'io', label: 'cIOD', x: 0, y: -6, w: 12.6, d: 9.7, h: 0.6 }, { kind: 'cpu', label: 'CCD', x: -5.2, y: 6.5, w: 9.6, d: 7.4, h: 0.6 }, { kind: 'cpu', label: 'CCD', x: 5.2, y: 6.5, w: 9.6, d: 7.4, h: 0.6 }], ring: { w: 38.5, d: 38.5, t: 1.8, h: 0.8 },
    used: 'Ryzen 7045HX, 8045HX, 9955HX', sources: ['https://www.techpowerup.com/303007/amd-launches-ryzen-7045hx-series-16-core-dragon-range-enthusiast-mobile-processors'], confidence: 'body secondary (40×40), 1763 balls from one database; chiplet placement as on desktop Raphael; pitch unpublished — 0.65 assumed' },

  // ── AMD GPUs — bare flip-chip die, centred, in a perimeter stiffener frame. Spans measured on sample boards.
  { id: 'amd-polaris', vendor: 'amd', name: 'AMD Polaris 10 / 20 (RX 470–590, Radeon Pro 570X–580X)', balls: 1401, pitch: 0.9, body: { L: 39.5, W: 39.5, H: 2.3, sub: 1.4 }, span: [37.4, 37.4], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Polaris', x: 0, y: 0, ...sq(232), h: 0.8 }], ring: { w: 38, d: 38, t: 2.6, h: 0.8 }, caps: [{ x: 0, y: 11, n: 10, dir: 'x', pitch: 1.3 }, { x: 0, y: -11, n: 10, dir: 'x', pitch: 1.3 }],
    used: 'RX 480/580 (MSI RX 580 sample), iMac 2017 A1419 Radeon Pro 580', mapId: 'polaris', confidence: 'ball field measured on two boards (GenCAD names it BGA_ELLESMEREL4); body from the span; die 232 mm² secondary' },
  { id: 'amd-vega10', vendor: 'amd', name: 'AMD Vega 10 (Vega 56/64, iMac Pro)', balls: 2013, pitch: 1.0, body: { L: 47.5, W: 47.5, H: 3.0, sub: 1.5 }, span: [44.8, 44.9], style: 'GPU + two HBM2 stacks on an interposer, stiffener frame',
    interposer: { w: 33, d: 31, h: 0.1 }, dies: [{ kind: 'gpu', label: 'Vega 10', x: 4.5, y: 0, w: 21.0, d: 23.0, h: 0.8, onInterposer: true }, { kind: 'mem', label: 'HBM2', x: -10.5, y: 6.5, w: 7.8, d: 11.9, h: 0.9, onInterposer: true }, { kind: 'mem', label: 'HBM2', x: -10.5, y: -6.5, w: 7.8, d: 11.9, h: 0.9, onInterposer: true }],
    ring: { w: 46, d: 46, t: 3.5, h: 0.9 }, used: 'iMac Pro A1862 (Radeon Pro Vega 56/64), RX Vega 56/64', mapId: 'vega10', confidence: 'ball field measured (A1862); 47.5 mm body and the interposer layout from public teardowns; die rectangles approximate' },
  { id: 'amd-navi10', vendor: 'amd', name: 'AMD Navi 10 (RX 5600M/5700M, Radeon Pro 5700/5700 XT)', balls: 1928, pitch: 0.8, body: { L: 42.5, W: 42.5, H: 2.6, sub: 1.4 }, span: [39.9, 39.9], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Navi 10', x: 0, y: 0, ...sq(251), h: 0.8 }], ring: { w: 41, d: 41, t: 3.0, h: 0.8 }, caps: [{ x: 0, y: 12.5, n: 12, dir: 'x', pitch: 1.2 }, { x: 0, y: -12.5, n: 12, dir: 'x', pitch: 1.2 }],
    used: 'iMac 27" 2020 (A2115 820-01823, Radeon Pro 5700/5700 XT), Dell G5 15 SE (RX 5600M), Alienware Area-51m R2 (RX 5700M)', mapId: 'imac2019-gpu', sources: ['https://www.techpowerup.com/gpu-specs/amd-navi-10.g861'], confidence: 'ball field measured (1,928 balls @ 0.8 mm, 39.9 mm span — TechPowerUp BGA-1928); body from the span; die 251 mm² secondary' },
  { id: 'amd-pitcairn', vendor: 'amd', name: 'AMD Pitcairn (HD 7970M, R9 M290X, FirePro D300)', balls: 1737, pitch: 0.8, body: { L: 41, W: 41, H: 2.5, sub: 1.3 }, span: [38.6, 38.6], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Pitcairn', x: 0, y: 0, ...sq(212), h: 0.8 }], ring: { w: 39.5, d: 39.5, t: 2.8, h: 0.8 }, caps: [{ x: 0, y: 11.5, n: 12, dir: 'x', pitch: 1.2 }, { x: 0, y: -11.5, n: 12, dir: 'x', pitch: 1.2 }],
    used: 'iMac 27" 2014–2015 (A1419 820-4652 / 820-00292, R9 M290X/M295X), Clevo P170EM (HD 7970M)', mapId: 'amd-pitcairn', confidence: 'ball field measured on four iMac boards (1,737 balls — TechPowerUp FCBGA-1737); body from the span; die 212 mm² secondary' },

  // ── AMD mobile GPUs measured on MacBook Pro boards (bare die in a perimeter frame, like every AMD/NVIDIA GPU photo)
  { id: 'amd-polaris21', vendor: 'amd', name: 'AMD Polaris 21 / Baffin (Radeon Pro 450–560X, RX 460/560)', balls: 769, pitch: 0.65, body: { L: 25, W: 25, H: 2.0, sub: 1.1 }, span: [22.6, 22.6], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Polaris 21', x: 0, y: 0, ...sq(123), h: 0.7 }], ring: { w: 23, d: 23, t: 2.0, h: 0.7 }, caps: [{ x: 0, y: 7.4, n: 8, dir: 'x', pitch: 1.2 }, { x: 0, y: -7.4, n: 8, dir: 'x', pitch: 1.2 }],
    used: 'MacBook Pro 15" 2016–2019 (A1707/A1990 Radeon Pro 450/455/460/555X/560X), RX 460/560 laptops', mapId: 'amd-polaris21', confidence: 'ball field measured on three boards (769 balls @ 0.686 mm, 22.6 mm span); body from the span; die 123 mm² secondary' },
  { id: 'amd-navi14', vendor: 'amd', name: 'AMD Navi 14 (Radeon Pro 5300M/5500M, RX 5500M)', balls: 1125, pitch: 0.8, body: { L: 33, W: 33, H: 2.3, sub: 1.2 }, span: [30.4, 30.4], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Navi 14', x: 0, y: 0, w: 13.6, d: 11.5, h: 0.75 }], ring: { w: 31, d: 31, t: 2.4, h: 0.75 }, caps: [{ x: 0, y: 9.5, n: 10, dir: 'x', pitch: 1.2 }, { x: 0, y: -9.5, n: 10, dir: 'x', pitch: 1.2 }],
    used: 'MacBook Pro 16" 2019 (A2141), iMac 27" 2020 (A2115 820-01799), RX 5500M laptops', mapId: 'amd-navi14', confidence: 'ball field measured on two boards (1,125 balls @ 0.787 mm, 30.4 mm span); body from the span; die 158 mm² secondary' },
  { id: 'amd-capeverde', vendor: 'amd', name: 'AMD Cape Verde (R9 M370X, HD 7770M class)', balls: 962, pitch: 0.8, body: { L: 30, W: 30, H: 2.0, sub: 1.1 }, span: [27.6, 27.6], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'Cape Verde', x: 0, y: 0, ...sq(123), h: 0.7 }], ring: { w: 28, d: 28, t: 2.2, h: 0.7 }, caps: [{ x: 0, y: 8.5, n: 8, dir: 'x', pitch: 1.2 }, { x: 0, y: -8.5, n: 8, dir: 'x', pitch: 1.2 }],
    used: 'MacBook Pro 15" mid-2015 (A1398 820-00426, R9 M370X); the 2011 HD 6xxxM (Whistler) shares the footprint', mapId: 'amd-capeverde', confidence: 'ball field measured (962 balls @ 0.787 mm, 27.6 mm span — distinct from the NVIDIA 908-ball 29 mm package); body from the span; die 123 mm² secondary' },

  // ── Memory — overmoulded FBGA, body and matrix from vendor mechanical drawings (Micron / Samsung / SK hynix; JEDEC
  // MO-207 / MO-210 / MO-328). Bodies vary per vendor; the most common one is recorded. Mixed-pitch families carry the
  // nearest-neighbour pitch. DDR3 and DDR4 x8/x16 share a footprint (only the body differs) — one record each.
  { id: 'mem-ddr-78', vendor: 'memory', name: 'DDR3 / DDR4 / DDR5 x8 FBGA-78', balls: 78, pitch: 0.8, body: { L: 11, W: 7.5, H: 1.1, sub: 0.25 }, span: [9.6, 6.4], style: 'moulded', mold: { h: 0.75 },
    used: 'soldered DDR3L/DDR4 on MacBook Air 2013–17, MacBook Pro 2018–19 (A1990), most laptops with soldered RAM', mapId: 'ddr4-78', sources: ['https://classes.engineering.wustl.edu/cse362/images/0/0c/8Gb_DDR4_SDRAM.pdf'], confidence: 'matrix 6 × 13 (cols 1–3, 7–9), 0.8 mm, span 6.4 × 9.6 primary (Micron drawings); body 7.5 × 11 (DDR4/DDR5) — DDR3 is 8 × 10.5, indistinguishable from the field' },
  { id: 'mem-ddr-96', vendor: 'memory', name: 'DDR3 / DDR4 x16 FBGA-96', balls: 96, pitch: 0.8, body: { L: 14, W: 8, H: 1.1, sub: 0.25 }, span: [12.0, 6.4], style: 'moulded', mold: { h: 0.75 },
    used: 'soldered DDR3L x16 (MacBook Air 2013), DDR4 x16 on laptops and SBCs', mapId: 'ddr3-96', sources: ['https://classes.engineering.wustl.edu/cse362/images/0/0c/8Gb_DDR4_SDRAM.pdf'], confidence: 'matrix 6 × 16, 0.8 mm, span 6.4 × 12.0 primary; body 8 × 14 (also 7.5 × 13.5, 9 × 14)' },
  { id: 'mem-ddr5-102', vendor: 'memory', name: 'DDR5 x16 FBGA-102', balls: 102, pitch: 0.8, body: { L: 14, W: 7.5, H: 0.9, sub: 0.25 }, span: [12.8, 6.4], style: 'moulded', mold: { h: 0.6 },
    used: 'soldered DDR5 x16', sources: ['https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/7969/16gb-ddr5-sdram-dierevd.pdf'], confidence: 'matrix 6 × 17, 0.8 mm, span 6.4 × 12.8 primary (Micron MO-210-AT); no sample' },
  { id: 'mem-lpddr3-178', vendor: 'memory', name: 'LPDDR3 x32 178-ball', balls: 178, pitch: 0.65, body: { L: 11.5, W: 11, H: 1.0, sub: 0.25 }, span: [10.4, 9.6], style: 'moulded', mold: { h: 0.7 },
    used: 'MacBook Pro 13" 2016–17 (A1706/A1708), iMac 2014–17; Haswell/Broadwell-U laptops', mapId: 'lpddr3-178', sources: ['https://files.pine64.org/doc/rock64/H9CCNNNCLTMLAR%28Rev1.2%29.pdf'], confidence: 'matrix 12 × 17 (col 7 empty, rows C–R narrower), 0.65 × 0.8 mm, span 10.4 × 9.6 primary; body 11 × 11.5 (Micron, SK hynix)' },
  { id: 'mem-lpddr3-253', vendor: 'memory', name: 'LPDDR3 x64 253-ball', balls: 253, pitch: 0.5, body: { L: 11.5, W: 11.5, H: 1.1, sub: 0.25 }, span: [8.0, 8.0], style: 'moulded', mold: { h: 0.8 },
    used: 'MacBook 12" 2015–17 (A1534), MacBook Air 2018–19 (A1932)', mapId: 'lpddr3-253', sources: ['https://www.ickey.cn/static-pf/datasheet/20/d4/b535/20/aa0f3aaf4d1c174d503f4f8fd529288f.pdf'], confidence: 'matrix 17 × 17 with a 6 × 6 central void, 0.5 mm, span 8 × 8 primary (Micron); body 11.5 × 11.5' },
  { id: 'mem-lpddr4-200', vendor: 'memory', name: 'LPDDR4 / LPDDR4X x32 200-ball', balls: 200, pitch: 0.65, body: { L: 14.5, W: 10, H: 1.0, sub: 0.25 }, span: [13.65, 8.8], style: 'moulded', mold: { h: 0.7 },
    used: 'Nintendo Switch / Switch Lite, Raspberry Pi 4, phones and tablets', mapId: 'lpddr4-200', sources: ['https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8606/z42m-embedded-lpddr4x-lpddr4.pdf'], confidence: 'matrix 10 × 22 (cols 6–7 and rows L–M empty), 0.65 × 0.8 mm, span 8.8 × 13.65 primary (JESD209-4 MO-311); body 10 × 14.5 (Micron), 10 × 15 (Samsung, SK hynix)' },
  { id: 'mem-lpddr4-366', vendor: 'memory', name: 'LPDDR4 / LPDDR4X x64 366-ball', balls: 366, pitch: 0.5, body: { L: 15, W: 15, H: 0.65, sub: 0.2 }, span: [14.0, 14.0], style: 'moulded', mold: { h: 0.45 },
    used: 'Pinebook Pro, SBCs, Chromebooks', sources: ['https://www.farnell.com/datasheets/3761308.pdf'], confidence: 'matrix 29 × 29 perimeter (rows F–AD only the outer two columns each side), 0.5 mm, span 14 × 14 primary (Micron NK); no sample' },
  { id: 'mem-lpddr4-376', vendor: 'memory', name: 'LPDDR4X x64 376-ball', balls: 376, pitch: 0.4, body: { L: 14, W: 14, H: 0.71, sub: 0.2 }, span: [13.2, 13.2], style: 'moulded', mold: { h: 0.5 },
    used: 'thin laptops and tablets (Micron NZ, SK hynix)', sources: ['https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8606/z42m-embedded-lpddr4x-lpddr4.pdf'], confidence: 'matrix 34 × 34 perimeter, 0.4 mm, span 13.2 × 13.2 primary (Micron); no sample' },
  { id: 'mem-lpddr4-556', vendor: 'memory', name: 'LPDDR4X x64 556-ball', balls: 556, pitch: 0.4, body: { L: 12.4, W: 12.4, H: 1.1, sub: 0.2 }, span: [11.2, 11.2], style: 'moulded', mold: { h: 0.85 },
    used: 'laptops 2019–2022 (Micron HJ/TN)', sources: ['https://www.farnell.com/datasheets/3760672.pdf'], confidence: 'matrix 29 × 29 perimeter (rows H–AB only five columns each side), 0.4 mm, span 11.2 × 11.2 primary (Micron); no sample' },
  { id: 'mem-lpddr5-315', vendor: 'memory', name: 'LPDDR5 / LPDDR5X x32 315-ball', balls: 315, pitch: 0.7, body: { L: 15, W: 12.4, H: 1.1, sub: 0.25 }, span: [14.0, 11.2], style: 'moulded', mold: { h: 0.8 },
    used: 'phones, tablets, Chromebooks (Micron DS/DV, Samsung K3LKBKB0BM, SK hynix H9JCNNNBK3MLYR)', sources: ['https://www.farnell.com/datasheets/4530575.pdf'], confidence: 'matrix 15 × 21 full, 0.7 × 0.8 mm, span 11.2 × 14.0 primary (Micron); body 12.4 × 15; no sample — distinct from the Apple NAND BGA315 (0.483 mm, 10 × 7 span)' },
  { id: 'mem-lpddr5-441', vendor: 'memory', name: 'LPDDR5 / LPDDR5X x64 441-ball', balls: 441, pitch: 0.65, body: { L: 14, W: 14, H: 1.1, sub: 0.25 }, span: [13.0, 13.0], style: 'moulded', mold: { h: 0.8 },
    used: 'laptops 2022+ with soldered LPDDR5 (Micron EK, Samsung K3KL3L30QM)', sources: ['https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8885/315b-441b-561b-y52q-sdp-ddp-lpddr5x.pdf'], confidence: 'matrix 21 × 21 full, 0.65 mm, span 13 × 13 primary (Micron); body 14 × 14; no sample' },
  { id: 'mem-lpddr5-496', vendor: 'memory', name: 'LPDDR5X x64 496-ball', balls: 496, pitch: 0.4, body: { L: 14, W: 12.4, H: 0.56, sub: 0.15 }, span: [10.8, 10.4], style: 'moulded', mold: { h: 0.38 },
    used: 'thin laptops 2023+ (Micron ZX, Samsung K3LK7K70BM)', sources: ['https://mm.digikey.com/Volume0/opasdata/d220001/medias/docus/8885/315b-441b-561b-y52q-sdp-ddp-lpddr5x.pdf'], confidence: 'matrix 28 × 27 perimeter, 0.4 mm, span 10.8 × 10.4 primary (Micron); body 14 × 12.4; no sample' },
  { id: 'mem-gddr5-170', vendor: 'memory', name: 'GDDR5 x32 FBGA-170', balls: 170, pitch: 0.8, body: { L: 14, W: 12, H: 1.1, sub: 0.3 }, span: [12.8, 10.4], style: 'moulded', mold: { h: 0.75 },
    used: 'GTX 900M/10-series laptops, RX 400/500, MacBook Pro 15" 2016–19 (Radeon Pro 4xx/5xx)', mapId: 'gddr5-170', sources: ['https://datasheet.chipsmall.com/MT51J256M32HF-70-A-TR/252006.pdf'], confidence: 'matrix 10 × 17 (cols 6–9 empty), 0.8 mm, span 10.4 × 12.8 primary (Micron); body 12 × 14; measured on four boards' },
  { id: 'mem-gddr5x-190', vendor: 'memory', name: 'GDDR5X x32 FBGA-190', balls: 190, pitch: 0.65, body: { L: 14, W: 10, H: 1.1, sub: 0.3 }, span: [11.7, 8.45], style: 'moulded', mold: { h: 0.75 },
    used: 'GTX 1080 / 1080 Ti, Titan X (Pascal)', sources: ['https://www.rxelectronics.cz/datasheet/be/MT58K256M321JA-100-A.pdf'], confidence: 'matrix 10 × 19 (cols 6–9 empty), 0.65 mm, span 8.45 × 11.7 primary (Micron MO-246); body 10 × 14; no sample' },
  { id: 'mem-gddr6-180', vendor: 'memory', name: 'GDDR6 / GDDR6X x32 FBGA-180', balls: 180, pitch: 0.75, body: { L: 14, W: 12, H: 1.1, sub: 0.3 }, span: [12.75, 9.75], style: 'moulded', mold: { h: 0.75 },
    used: 'RTX 20/30/40 cards and laptops, RX 5000/6000/7000, iMac 2020 (Navi), PS5 / Xbox Series', mapId: 'gddr6-180', sources: ['https://assets.sourcengine.com/datasheets/810969df-46bf-40b2-9bc7-215fdae2d760.pdf'], confidence: 'matrix 10 × 18 (cols 6–9 empty), 0.75 mm, span 9.75 × 12.75 primary (Micron JE, Samsung MO-328); body 12 × 14; measured on three boards' },
  { id: 'mem-gddr7-266', vendor: 'memory', name: 'GDDR7 x32 FBGA-266', balls: 266, pitch: 0.73, body: { L: 14, W: 12, H: 1.1, sub: 0.3 }, span: [13.1, 11.0], style: 'moulded', mold: { h: 0.75 },
    used: 'RTX 50 cards and laptops (Legion Pro 5 16IRX9: Micron MT68A512M32DF)', mapId: 'gddr7-266', sources: ['https://my.micron.com/content/dam/micron/global/public/products/product-flyer/gddr7-product-brief.pdf'], confidence: 'body 12 × 14 × 1.1 and 266 balls primary (Micron brief); the matrix is not public — the field measured on the Legion Pro 5 is 13.1 × 11.0 mm @ 0.73 mm (14 × 19 full array)' },

  // ── Apple NAND — moulded packages with a metallic finish
  { id: 'apple-nand-bga315', vendor: 'apple', name: 'Apple NAND BGA315 (M-series Macs)', balls: 315, pitch: 0.483, body: { L: 11.5, W: 8.5, H: 1.2, sub: 0.3 }, span: [10.0, 7.0], style: 'moulded, silver',
    mold: { h: 0.9, finish: 'silver' }, used: 'SSD NAND on M1/M2/M3 MacBooks and Mac mini (UN000–UN800)', mapId: 'nand-bga315', confidence: 'ball field measured on three boards (315 balls @ 0.483 mm, 10.0 × 7.0 span); body from the span; finish per Alexey' },
  { id: 'apple-nand-bga110', vendor: 'apple', name: 'Apple SSD NAND BGA110 (2018–2020 Intel Macs)', balls: 110, pitch: 1.114, body: { L: 14.5, W: 11.5, H: 1.3, sub: 0.3 }, span: [12.8, 9.6], style: 'moulded, silver',
    mold: { h: 1.0, finish: 'silver' }, used: 'SSD NAND on MacBook Air/Pro 2018–2020 (U8600–U8900)', mapId: 'nand-bga110', confidence: 'ball field measured on nine boards (110 balls @ 1.11 mm, 12.8 × 9.6 span); body from the span; finish per Alexey' },

  // ── NVIDIA — bare flip-chip die, centred, perimeter stiffener frame, caps between die and frame (every public photo;
  // no NVIDIA document describes it). Ball pitches are measured on sample boards: the web has none.
  { id: 'nv-bga908', vendor: 'nvidia', name: 'NVIDIA 128-bit laptop GPU, 29 mm (GK107/GK208, GM107, GP107)', balls: 908, pitch: 0.8, body: { L: 29, W: 29, H: 2.0, sub: 1.1 }, span: [27.4, 27.4], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GPU', x: 0, y: 0, ...sq(140), h: 0.7 }], ring: { w: 27.8, d: 27.8, t: 2.2, h: 0.7 }, caps: [{ x: 0, y: 8.6, n: 8, dir: 'x', pitch: 1.2 }, { x: 0, y: -8.6, n: 8, dir: 'x', pitch: 1.2 }],
    used: 'GT 640M/650M/750M (N13P/N13M), 920M–940MX (N16S), GTX 960M (N15P-GT, GM107), GTX 1050/1050 Ti (N17P-G0/G1, GP107), iMac GK107', mapId: 'n17p', sources: ['https://www.notebookcheck.net/NVIDIA-GeForce-GTX-960M.138006.0.html'],
    confidence: 'ball field measured on five boards (N13P-GS, N13M, N15P-GT, N17P-G0 package names); die drawn at ~140 mm² (GM107 148, GP107 132)' },
  { id: 'nv-gb4b', vendor: 'nvidia', name: 'NVIDIA GB4B-256 (TU116 / TU106 / TU104, 37.5 mm)', balls: 2228, pitch: 0.7, body: { L: 37.5, W: 37.5, H: 2.4, sub: 1.3 }, span: [35.7, 35.7], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GPU', x: 0, y: 0, ...sq(445), h: 0.8 }], ring: { w: 36.3, d: 36.3, t: 2.6, h: 0.8 }, caps: [{ x: 0, y: 14.2, n: 12, dir: 'x', pitch: 1.2 }, { x: 0, y: -14.2, n: 12, dir: 'x', pitch: 1.2 }],
    used: 'GTX 1660 Ti (N18E-G0), RTX 2060/2070 (N18E-G1/G2), RTX 2080 (N18E-G3); desktop RTX 2060–2080', mapId: 'ga106', sources: ['https://www.nvidia.com/content/dam/cpmassets/folder2/NPN-09335-001_v01.pdf', 'https://www.nvidia.com/content/dam/cpmassets/folder2/NPN-09746-001_v01.pdf'],
    confidence: 'count and body primary (NVIDIA NPN sheets: 2228 balls, 37.5 mm); pitch measured on the MSI MS-V385 sample (GenCAD BGA_2228_P070_375X375); die drawn at TU106 size' },
  { id: 'nv-gn22-x4', vendor: 'nvidia', name: 'NVIDIA GN22-X4 (GB206 laptop, RTX 5060 class)', balls: 2088, pitch: 0.65, body: { L: 33, W: 33, H: 2.3, sub: 1.2 }, span: [31.2, 31.2], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GB206', x: 0, y: 0, ...sq(181), h: 0.75 }], ring: { w: 31.8, d: 31.8, t: 2.4, h: 0.75 }, caps: [{ x: 0, y: 9.8, n: 10, dir: 'x', pitch: 1.1 }, { x: 0, y: -9.8, n: 10, dir: 'x', pitch: 1.1 }],
    used: 'RTX 5060 laptop (GN22-X4), RTX 5070 laptop (GN22-X6)', mapId: 'gn22', sources: ['https://wccftech.com/nvidia-next-gen-geforce-rtx-50-blackwell-laptop-gpu-lineup-gddr7-leak-2025-launch/'],
    confidence: 'ball field measured on LA-P161P (Allegro GN22-X4-A1_FCBGA_2088P); body from the span; die 181 mm² secondary' },
  { id: 'nv-gn21-1358', vendor: 'nvidia', name: 'NVIDIA GA107 / AD107 / AD106 laptop, 29 mm (RTX 3050, 4050, 4060, 4070)', balls: 1358, pitch: 0.65, body: { L: 29, W: 29, H: 2.2, sub: 1.2 }, span: [27.3, 27.3], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GPU', x: 0, y: 0, ...sq(159), h: 0.75 }], ring: { w: 27.8, d: 27.8, t: 2.2, h: 0.75 }, caps: [{ x: 0, y: 8.8, n: 8, dir: 'x', pitch: 1.2 }, { x: 0, y: -8.8, n: 8, dir: 'x', pitch: 1.2 }],
    used: 'RTX 3050/3050 Ti (GN20-P0/P1, GA107), RTX 4050/4060 (GN21-X2/X4, AD107), RTX 4070 (GN21-X6, AD106); Lenovo Legion Pro 5 16IRX9', mapId: 'ad107', sources: ['https://videocardz.com/newz/notebooks-with-nvidia-ga107-gpu-can-easily-be-upgraded-to-rtx-40-ad106-107-gpus'],
    confidence: 'ball field measured (Legion Pro 5 NM-F701: 1,358 balls @ 0.686 mm nearest-neighbour — a 0.65 mm staggered core, 27.3 mm span); TechPowerUp FCBGA-1358 for GA107; AD107/AD106 laptop parts drop into GA107 boards; die drawn at AD107 159 mm²' },
  { id: 'intel-pch-hx-1045', vendor: 'intel', name: 'Intel 700-series PCH for HX laptops (HM770 / WM790)', balls: 1045, pitch: 0.571, body: { L: 28, W: 25, H: 1.7, sub: 0.9 }, span: [26.7, 23.7], style: 'bare die',
    dies: [{ kind: 'pch', label: 'PCH', x: 0, y: 0, w: 10, d: 9, h: 0.6 }], used: 'Alder / Raptor Lake-HX laptops (Legion Pro 5 16IRX9)', mapId: 'pch-hx-1045', sources: ['https://cdrdv2.intel.com/v1/dl/getContent/743844'], confidence: 'ball field measured (1,045 balls @ 0.57 mm, 26.7 × 23.7 span); 25 × 28 × 1.7 body from Intel\'s HX platform diagram; die size guessed' },
  { id: 'nv-fcbga1745', vendor: 'nvidia', name: 'NVIDIA 256-bit GPU, 40 mm (GK104, GM204)', balls: 1745, pitch: 0.8, body: { L: 40, W: 40, H: 2.6, sub: 1.4 }, span: [38.4, 38.4], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GPU', x: 0, y: 0, ...sq(340), h: 0.8 }], ring: { w: 38.8, d: 38.8, t: 2.8, h: 0.8 }, caps: [{ x: 0, y: 13.5, n: 12, dir: 'x', pitch: 1.2 }, { x: 0, y: -13.5, n: 12, dir: 'x', pitch: 1.2 }],
    used: 'GTX 680MX/775M/780M (GK104), GTX 970M/980M (GM204, N16E), iMac 2012–2013 GK104', mapId: 'gk104', sources: ['https://videocardz.com/58101/nvidia-gp104-and-first-polaris-gpu-supposedly-spotted-on-zauba'],
    confidence: 'ball field measured on the iMac A1418 D8 (GK104); GM204 FCBGA-1745 / 40 mm secondary; die drawn between GK104 294 and GM204 398 mm²' },
  { id: 'nv-bga3328', vendor: 'nvidia', name: 'NVIDIA GA102 / AD102 (RTX 3080–4090, 51 mm)', balls: 3328, pitch: 0.8, body: { L: 51, W: 51, H: 3.0, sub: 1.6 }, span: [49.4, 49.4], style: 'bare die in a stiffener frame',
    dies: [{ kind: 'gpu', label: 'GPU', x: 0, y: 0, w: 24.7, d: 24.7, h: 0.8 }], ring: { w: 49.5, d: 49.5, t: 3.2, h: 0.8 }, caps: [{ x: 0, y: 16.5, n: 16, dir: 'x', pitch: 1.2 }, { x: 0, y: -16.5, n: 16, dir: 'x', pitch: 1.2 }, { x: 16.5, y: 0, n: 16, dir: 'y', pitch: 1.2 }, { x: -16.5, y: 0, n: 16, dir: 'y', pitch: 1.2 }],
    used: 'RTX 3080/3090 (GA102), RTX 4090/4080 desktop (AD102/AD103 share the body class)', mapId: 'ad102', confidence: 'ball field measured on two boards (GenCAD BGA_3328_P080_P090_510X510: 0.8/0.9 mm mixed pitch, 51 × 51); die 608–628 mm²' },

  // ── Intel PCH (separate chips on H-series boards) — small bare flip-chip die, no lid.
  { id: 'intel-pch-h-837', vendor: 'intel', name: 'Intel 100/200-series PCH-H (Sunrise Point / Union Point)', balls: 837, pitch: 0.543, body: { L: 23, W: 23, H: 1.3, sub: 0.8 }, span: [22.0, 22.0], style: 'bare die',
    dies: [{ kind: 'pch', label: 'PCH', x: 0, y: 0, w: 8.5, d: 8.5, h: 0.6 }], used: 'HM170/HM175/QM170… on Skylake-H / Kaby Lake-H boards', mapId: 'pch-skl-h', confidence: 'ball field measured (Allegro SKY-S-PCH_BGA_837P); die size guessed' },
  { id: 'intel-pch-h-874', vendor: 'intel', name: 'Intel 300-series PCH-H (Cannon Point-H)', balls: 874, pitch: 0.535, body: { L: 24.8, W: 23.8, H: 1.3, sub: 0.8 }, span: [23.6, 22.6], style: 'bare die',
    dies: [{ kind: 'pch', label: 'PCH', x: 0, y: 0, w: 9, d: 9, h: 0.6 }], used: 'HM370/QM370/CM246 on Coffee Lake-H boards', mapId: 'pch-cnp-h', confidence: 'ball field measured (Allegro CNP-H_BGA_874P); die size guessed' },

  // ── Apple silicon — SoC under a nickel lid, LPDDR packages beside it on the substrate. Measured on the XZZ boardviews.
  { id: 'apple-m1', vendor: 'apple', name: 'Apple M1 (A2337 / A2338 / A2348)', balls: 2502, pitch: 0.5, body: { L: 28.5, W: 24, H: 2.4, sub: 0.9 }, span: [27.0, 22.5], style: 'lidded SoC + 2 LPDDR4X packages',
    lid: { w: 15.5, d: 15.5, h: 1.1, x: -5.5, y: 0 }, dies: [{ kind: 'mem', label: 'LPDDR4X', x: 8.0, y: 5.5, w: 9, d: 10, h: 0.9 }, { kind: 'mem', label: 'LPDDR4X', x: 8.0, y: -5.5, w: 9, d: 10, h: 0.9 }],
    used: 'MacBook Air/Pro M1, Mac mini M1', mapId: 'm1', confidence: 'ball field measured; lid and memory placement from photos of the package' },
  { id: 'apple-m2', vendor: 'apple', name: 'Apple M2 (A2681 / A2338 2022 / A2941)', balls: 2565, pitch: 0.483, body: { L: 28.5, W: 24.5, H: 2.4, sub: 0.9 }, span: [27.0, 23.0], style: 'lidded SoC + 2 LPDDR5 packages',
    lid: { w: 16, d: 16, h: 1.1, x: -5.5, y: 0 }, dies: [{ kind: 'mem', label: 'LPDDR5', x: 8.0, y: 5.7, w: 9, d: 10.5, h: 0.9 }, { kind: 'mem', label: 'LPDDR5', x: 8.0, y: -5.7, w: 9, d: 10.5, h: 0.9 }],
    used: 'MacBook Air M2 13/15, MacBook Pro 13 M2', confidence: 'ball field measured; layout from photos' },
  { id: 'apple-m1pro', vendor: 'apple', name: 'Apple M1 Pro (A2442 / A2485)', balls: 2971, pitch: 0.635, body: { L: 57, W: 25, H: 2.6, sub: 1.0 }, span: [55.2, 23.4], style: 'lidded SoC + 2 LPDDR5 packages',
    lid: { w: 24, d: 22, h: 1.2, x: 0, y: 0 }, dies: [{ kind: 'mem', label: 'LPDDR5', x: -20.5, y: 0, w: 11, d: 20, h: 0.9 }, { kind: 'mem', label: 'LPDDR5', x: 20.5, y: 0, w: 11, d: 20, h: 0.9 }],
    used: 'MacBook Pro 14/16 2021 M1 Pro', confidence: 'ball field measured; layout from photos' },
  { id: 'apple-m1max', vendor: 'apple', name: 'Apple M1 Max (A2442 / A2485)', balls: 4183, pitch: 0.635, body: { L: 57, W: 36, H: 2.6, sub: 1.0 }, span: [55.2, 34.4], style: 'lidded SoC + 4 LPDDR5 packages',
    lid: { w: 24, d: 22, h: 1.2, x: 0, y: 0 }, dies: [{ kind: 'mem', label: 'LPDDR5', x: -20.5, y: 8, w: 11, d: 14, h: 0.9 }, { kind: 'mem', label: 'LPDDR5', x: -20.5, y: -8, w: 11, d: 14, h: 0.9 }, { kind: 'mem', label: 'LPDDR5', x: 20.5, y: 8, w: 11, d: 14, h: 0.9 }, { kind: 'mem', label: 'LPDDR5', x: 20.5, y: -8, w: 11, d: 14, h: 0.9 }],
    used: 'MacBook Pro 14/16 2021 M1 Max', mapId: 'm1max', confidence: 'ball field measured; layout from photos' },
  { id: 'apple-t2', vendor: 'apple', name: 'Apple T2 (2018–2020 Intel Macs)', balls: 1406, pitch: 0.381, body: { L: 16.2, W: 15.8, H: 1.2, sub: 0.7 }, span: [14.8, 14.4], style: 'bare die',
    dies: [{ kind: 'cpu', label: 'T2', x: 0, y: 0, w: 9, d: 9.5, h: 0.5 }], used: 'MacBook Air/Pro 2018–2020, iMac Pro, Mac mini 2018', mapId: 't2', confidence: 'ball field measured on seven boards; die size guessed' },
];
for (const p of PACKAGES) if (p.mapId && SIGNATURES[p.mapId]) p.sig = SIGNATURES[p.mapId];
