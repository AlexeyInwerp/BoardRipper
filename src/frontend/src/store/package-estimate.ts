/**
 * Package estimate — what a part physically looks like, from what the file says.
 *
 * Two independent answers: the **family** and size (from the package name when
 * the file has one, else from the pin geometry) and the **kind** of a two-pin
 * chip (resistor / capacitor / …, from the package name, else the refdes
 * prefix). Every answer carries its evidence so a viewer can show which parts
 * are known and which are guessed.
 *
 * Pure: no store, no renderer. Positions in mils (board frame, Y up), body
 * dimensions in mm. Prototype for the 3D mode — see
 * docs/specs/2026-11-14-3d-mode-design.md.
 */
import type { Part, Pin } from '../parsers/types';

const MIL_PER_MM = 1 / 0.0254;
const mm = (mils: number) => mils * 0.0254;

export type Evidence = 'package' | 'geometry' | 'fallback';
export type Family =
  | 'none' | 'hole' | 'fiducial' | 'testpoint'
  | 'chip' | 'sod123' | 'sod323' | 'sot23' | 'sot23-5'
  | 'son' | 'qfn' | 'soic' | 'bga'
  | 'crystal' | 'button' | 'button-ra' | 'led3535'
  | 'molded-cap' | 'inductor' | 'chip3t' | 'coax' | 'b2b' | 'standoff'
  | 'conn' | 'usb-c' | 'header' | 'box';
export type ChipKind = 'R' | 'C' | 'L' | 'FB' | 'D' | 'LED' | 'F' | 'chip';

export interface PartEstimate {
  family: Family;
  kind?: ChipKind;
  /** EIA code for chips, series name for connectors ("JST SH"…). */
  size?: string;
  /** Body in mm: L along the body X axis, W across, H tall. */
  L: number; W: number; H: number;
  /** Body centre, mils, board frame. */
  cx: number; cy: number;
  /** Body X axis angle, degrees CCW, board frame. */
  rotDeg: number;
  /** Family parameters: pitch (mm), perSide, rows, cols, signal count… */
  p: Record<string, number>;
  /** False for a footprint the file marks as not fitted (pads only). */
  populated: boolean;
  evidence: Evidence;
  why: string;
}

export interface EstimateOptions {
  /** Read `meta.package`. Off = what a plain boardview (pins only) allows. */
  usePackage: boolean;
}

// ── EIA chip table (mm) ────────────────────────────────────────────────────
const EIA: Record<string, { L: number; W: number; Hr: number; Hc: number }> = {
  '01005': { L: 0.4, W: 0.2, Hr: 0.13, Hc: 0.2 },
  '0201': { L: 0.6, W: 0.3, Hr: 0.23, Hc: 0.3 },
  '0402': { L: 1.0, W: 0.5, Hr: 0.35, Hc: 0.5 },
  '0603': { L: 1.6, W: 0.8, Hr: 0.45, Hc: 0.8 },
  '0805': { L: 2.0, W: 1.25, Hr: 0.5, Hc: 1.0 },
  '1206': { L: 3.2, W: 1.6, Hr: 0.55, Hc: 1.15 },
  '1210': { L: 3.2, W: 2.5, Hr: 0.55, Hc: 1.6 },
  '2010': { L: 5.0, W: 2.5, Hr: 0.55, Hc: 1.6 },
  '2512': { L: 6.4, W: 3.2, Hr: 0.55, Hc: 1.6 },
};
const METRIC: Record<string, string> = { '0402': '01005', '0603': '0201', '1005': '0402', '1608': '0603', '2012': '0805', '3216': '1206', '3225': '1210', '5025': '2010', '6332': '2512' };

/** Pin span (centre to centre, mils) → EIA. 98.1 % agreement with package
 *  names on 9,859 two-pin parts (KiCad, Allegro, GenCAD), 2026-11-14. */
/** Gap between the two pads' inner edges (mils) → EIA. Footprint styles differ
 *  in how far the pads reach *outward* (hand-solder, IPC-L/N/M), barely in the
 *  gap under the body, so this is the better rule whenever pad sizes exist. */
export function chipSizeFromGap(gapMils: number, acrossMils?: number): string | null {
  if (gapMils < 4) return '01005';
  if (gapMils < 8.5) return '0201';
  if (gapMils < 21.5) return '0402';
  if (gapMils < 32) return '0603';
  if (gapMils < 50) return '0805';
  if (gapMils < 90) return acrossMils && acrossMils > 85 ? '1210' : '1206';
  if (gapMils < 150) return '2010';
  if (gapMils < 210) return '2512';
  return null;
}
/** Pad width across the pin axis (mils) → EIA: tracks the body width (≈1.3·W)
 *  and is the dimension footprint styles change least. */
export function chipSizeFromAcross(acrossMils: number): string | null {
  if (acrossMils < 9) return '01005';
  if (acrossMils < 17) return '0201';
  if (acrossMils < 31) return '0402';
  if (acrossMils < 45) return '0603';
  if (acrossMils < 62) return '0805';
  if (acrossMils < 85) return '1206';
  if (acrossMils < 115) return '1210';
  return null;
}
/** Two of three: span, inner gap, pad width. Each alone fails on some footprint
 *  style (hand-solder pads stretch the span, odd pad stacks break the gap);
 *  measured on 9,881 two-pin parts the vote beats every single rule. */
export function chipSizeVote(spanMils: number, gapMils?: number, acrossMils?: number): { size: string | null; rule: string } {
  const s = chipSizeFromSpan(spanMils, acrossMils);
  if (gapMils === undefined || acrossMils === undefined || !(gapMils > 0)) return { size: s, rule: `span ${spanMils.toFixed(0)} mil` };
  const g = chipSizeFromGap(gapMils, acrossMils), a = chipSizeFromAcross(acrossMils);
  if (g === a) return { size: g, rule: `pad gap ${gapMils.toFixed(0)} + pad width ${acrossMils.toFixed(0)} mil` };
  if (s === g || s === a) return { size: s, rule: `span ${spanMils.toFixed(0)} + ${s === g ? 'pad gap' : 'pad width'}` };
  return { size: a, rule: `pad width ${acrossMils.toFixed(0)} mil (span and gap disagree)` };
}
export function chipSizeFromSpan(spanMils: number, acrossMils?: number): string | null {
  if (spanMils < 14) return '01005';
  if (spanMils < 26) return '0201';
  if (spanMils < 43) return '0402';
  if (spanMils < 60) return '0603';
  if (spanMils < 90) return '0805';
  if (spanMils < 150) return acrossMils && acrossMils > 85 ? '1210' : '1206';
  if (spanMils < 215) return '2010';
  if (spanMils < 280) return '2512';
  return null;
}

function kindFromPrefix(ref: string): ChipKind {
  const p = (ref.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
  if (/^(LED|LD)$/.test(p)) return 'LED';
  if (/^(FB|FL|BEAD)$/.test(p)) return 'FB';
  if (/^P?R[A-Z]?$/.test(p) && !/^RV$/.test(p)) return 'R';
  if (/^P?C[A-Z]?$/.test(p)) return 'C';
  if (/^P?L[A-Z]?$/.test(p)) return 'L';
  if (/^(D|ZD|PD)$/.test(p)) return 'D';
  if (/^F$/.test(p)) return 'F';
  return 'chip';
}

// ── geometry helpers ───────────────────────────────────────────────────────
interface V { x: number; y: number }
const rot = (v: V, deg: number): V => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const wrap = (d: number) => ((d % 360) + 540) % 360 - 180;

/** Grid angle of a pin cloud, folded to [-45, 45): circular mean of 4θ over
 *  nearest-neighbour vectors. */
function gridAngle(pts: V[]): number {
  // only the shortest neighbour links: a SOT-23's lone pin reaches its
  // neighbours diagonally and would skew the mean by ~20°
  const nn = pts.map((p, i) => Math.min(...pts.map((q, j) => (i === j ? Infinity : Math.hypot(q.x - p.x, q.y - p.y) || Infinity))));
  const keep = Math.min(...nn) * 1.15;
  let cs = 0, sn = 0;
  for (let i = 0; i < pts.length; i++) {
    if (nn[i] > keep) continue;
    let best = Infinity, bv: V | null = null;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y, d = dx * dx + dy * dy;
      if (d > 1e-6 && d < best) { best = d; bv = { x: dx, y: dy }; }
    }
    if (!bv) continue;
    const t = Math.atan2(bv.y, bv.x) * 4; cs += Math.cos(t); sn += Math.sin(t);
  }
  const deg = Math.atan2(sn, cs) / 4 * 180 / Math.PI;
  return Math.abs(deg) < 0.5 ? 0 : deg;
}
/** Cluster 1-D values within tol; returns centres sorted with member counts. */
function clusters(vals: number[], tol: number): { c: number; n: number }[] {
  const s = [...vals].sort((a, b) => a - b), out: { c: number; n: number; sum: number }[] = [];
  for (const v of s) { const last = out[out.length - 1]; if (last && v - last.c <= tol) { last.sum += v; last.n++; last.c = last.sum / last.n; } else out.push({ c: v, n: 1, sum: v }); }
  return out.map(({ c, n }) => ({ c, n }));
}
const pitchOf = (sorted: number[]) => median(sorted.slice(1).map((v, i) => v - sorted[i]));

interface Frame { cx: number; cy: number; deg: number; loc: V[] }
function frame(pins: Pin[], deg: number, idx = pins.map((_, i) => i)): Frame {
  const sel = idx.map(i => pins[i].position);
  const cx = sel.reduce((a, p) => a + p.x, 0) / sel.length, cy = sel.reduce((a, p) => a + p.y, 0) / sel.length;
  return { cx, cy, deg, loc: pins.map(p => rot({ x: p.position.x - cx, y: p.position.y - cy }, -deg)) };
}
const bboxOf = (vs: V[]) => vs.reduce((b, v) => ({ x0: Math.min(b.x0, v.x), x1: Math.max(b.x1, v.x), y0: Math.min(b.y0, v.y), y1: Math.max(b.y1, v.y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
/** Body centre in board mils for a centre given in the frame's local mils. */
const toBoard = (f: Frame, lx: number, ly: number): V => { const r = rot({ x: lx, y: ly }, f.deg); return { x: f.cx + r.x, y: f.cy + r.y }; };

function pinSize(p: Pin): number {
  if (p.padWidth && p.padHeight) return Math.max(p.padWidth, p.padHeight);
  if (p.padBounds) return Math.max(p.padBounds.maxX - p.padBounds.minX, p.padBounds.maxY - p.padBounds.minY);
  return p.radius * 2;
}

// ── package-name rules ─────────────────────────────────────────────────────
interface PkgHint { family: Family; size?: string; kind?: ChipKind; dims?: Partial<Pick<PartEstimate, 'L' | 'W' | 'H'>>; p?: Record<string, number>; populated?: boolean; label: string }
export function parsePackageName(name: string, ref: string): PkgHint | null {
  const n = name.toUpperCase();
  const unpop = /NOCREAM|DNP|NOPOP|NOT_?FITTED/.test(n);
  const chip = n.match(/(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|2010|2512)(?![0-9])/) ?? n.match(/(?:^|[^0-9])(1005|1608|2012|3216|3225|5025|6332)METRIC/);
  if (/FIDUCIAL/.test(n)) return { family: 'fiducial', label: 'fiducial' };
  if (/MOUNTING_?HOLE|^HOLE|MTG/.test(n)) return { family: 'hole', label: 'mounting hole' };
  if (/TEST_?POINT|^TP|TPB/.test(n)) return { family: 'testpoint', label: 'test point' };
  if (/USB.?C|TYPE.?C/.test(n)) return { family: 'usb-c', label: 'USB-C receptacle' };
  if (/LED.?3535|WS2812.*3535/.test(n)) return { family: 'led3535', label: 'RGB LED 3535' };
  if (/LED.?5050|WS2812B?$/.test(n)) return { family: 'led3535', dims: { L: 5, W: 5, H: 1.6 }, label: 'RGB LED 5050' };
  if (/SOD-?123/.test(n)) return { family: 'sod123', label: 'SOD-123' };
  if (/SOD-?323/.test(n)) return { family: 'sod323', label: 'SOD-323' };
  if (/SOT-?23-?[56]|SOT-?353|SC-?70-?5/.test(n)) return { family: 'sot23-5', label: 'SOT-23-5' };
  if (/SOT-?23/.test(n)) return { family: 'sot23', label: 'SOT-23' };
  let m = n.match(/QFN-?(\d+)[_-]?(\d+(?:\.\d+)?)(?:X(\d+(?:\.\d+)?))?MM/);
  if (m) return { family: 'qfn', dims: { L: +m[2], W: +(m[3] ?? m[2]), H: 0.9 }, label: `QFN-${m[1]} ${m[2]} mm` };
  m = n.match(/[UVWX]?(?:SON|DFN)-?(\d+)[_-]?(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)/);
  if (m) return { family: 'son', dims: { L: +m[2], W: +m[3], H: 0.55 }, label: `SON-${m[1]} ${m[2]}×${m[3]}` };
  m = n.match(/CRYSTAL[_-]?(\d+(?:\.\d+)?)X(\d+(?:\.\d+)?)/);
  if (m) return { family: 'crystal', dims: { L: +m[1], W: +m[2], H: 0.8 }, label: `crystal ${m[1]}×${m[2]}` };
  if (/TACTILE.*RA|RA.*TACT|_RA_|RIGHT.?ANGLE/.test(n) && /BTN|SW|TACT|SPST/.test(n)) return { family: 'button-ra', label: 'right-angle tact switch' };
  if (/BTN|TACT|KMR|SPST|SWITCH/.test(n)) return { family: 'button', label: 'tact switch' };
  if (/JST.?SH|SM\d+B-SR/.test(n)) return { family: 'conn', size: 'JST SH', label: 'JST SH' };
  if (/JST.?PH|S\d+B-PH/.test(n)) return { family: 'conn', size: 'JST PH', label: 'JST PH' };
  if (/FPC|FFC|ZIF/.test(n)) return { family: 'conn', size: 'FPC', label: 'FPC' };
  m = n.match(/^(\d)X(\d+)/);
  if (m) return { family: 'header', populated: !unpop, p: { rows: +m[1] }, label: `header ${m[1]}×${m[2]}${unpop ? ' (not fitted)' : ''}` };
  if (/CHIPLED|LED_?0603|LED_?0805|LED_?0402/.test(n) && chip) { const size = EIA[chip[1]] ? chip[1] : METRIC[chip[1]]; return { family: 'chip', size, kind: 'LED', label: `LED ${size}` }; }
  if (chip) { const size = METRIC[chip[1]] && !EIA[chip[1]] ? METRIC[chip[1]] : chip[1]; const kind = /^C|CAP/.test(n) ? 'C' : /^R|RES/.test(n) ? 'R' : /^L|IND/.test(n) ? 'L' : kindFromPrefix(ref); return { family: 'chip', size, kind, label: `${kind} ${size}` }; }
  return null;
}

// ── main ───────────────────────────────────────────────────────────────────
export function estimatePart(part: Part, opts: EstimateOptions): PartEstimate {
  const pins = part.pins, n = pins.length, ref = part.name;
  const hint = opts.usePackage && part.meta?.package ? parsePackageName(part.meta.package, ref) : null;
  const ev: Evidence = hint ? 'package' : 'geometry';
  const pkgWhy = hint ? `package "${part.meta!.package}" → ${hint.label}` : '';
  const out = (e: Omit<PartEstimate, 'evidence' | 'why' | 'populated' | 'p'> & { p?: Record<string, number>; populated?: boolean }, why: string, evidence: Evidence = ev): PartEstimate =>
    ({ populated: hint?.populated ?? true, p: {}, ...e, evidence, why: hint ? pkgWhy : why });
  const center = (): V => { const b = bboxOf(pins.map(p => p.position)); return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; };

  if (n === 0) { const c = part.origin; return out({ family: 'none', L: 0, W: 0, H: 0, cx: c.x, cy: c.y, rotDeg: 0 }, 'no pins — artwork or a mechanical feature', 'fallback'); }

  // ── single pin ──
  if (n === 1) {
    const p = pins[0]; const d = mm(p.drill ?? 0), pad = mm(pinSize(p));
    const pw = mm(p.padWidth ?? pinSize(p)), ph = mm(p.padHeight ?? pinSize(p));
    // A pad of ≥ 3.8 mm is a plated mounting hole even when the file gives no drill
    // (Apple SH04xx: oval and round screw rings, listed on one side only). A 2.3–3.8 mm
    // pad named like a standoff (SH/ST/ZS/SP) is an SMD spacer nut.
    const fam: Family = hint?.family === 'hole' || hint?.family === 'fiducial' || hint?.family === 'testpoint' ? hint.family
      : d >= 2 || pad >= 3.8 ? 'hole' : pad >= 2.3 && /^(SH|ST|ZS|SP|SO)/i.test(ref) ? 'standoff' : !p.net ? 'fiducial' : 'testpoint';
    if (fam === 'standoff') return out({ family: fam, L: pw, W: ph, H: 1.6, cx: p.position.x, cy: p.position.y, rotDeg: 0 }, `1 pin, ${pw.toFixed(1)}×${ph.toFixed(1)} mm pad, refdes ${ref} → SMD standoff`);
    return out({ family: fam, L: pw, W: ph, H: 0, cx: p.position.x, cy: p.position.y, rotDeg: 0, p: { drill: d || pad * 0.5 } },
      fam === 'hole' ? (d ? `1 pin, ${d.toFixed(1)} mm drill → mounting hole` : `1 pin, ${pw.toFixed(1)}×${ph.toFixed(1)} mm pad → plated mounting hole (both sides)`) : fam === 'fiducial' ? '1 pin, no net → fiducial' : '1 pin on a net → test point');
  }

  // ── headers: every pin drilled ──
  const drilled = pins.filter(p => (p.drill ?? 0) > 0);
  if ((hint?.family === 'header') || (!hint && drilled.length === n && n >= 2 && (n > 2 || mm(Math.hypot(pins[1].position.x - pins[0].position.x, pins[1].position.y - pins[0].position.y)) > 1.9))) {
    const f0 = frame(pins, gridAngle(pins.map(p => p.position)));
    const b = bboxOf(f0.loc); const long = b.x1 - b.x0 >= b.y1 - b.y0;
    const f = long ? f0 : frame(pins, f0.deg + 90);
    const xs = clusters(f.loc.map(v => v.x), 8), ys = clusters(f.loc.map(v => v.y), 8);
    const pitch = mm(pitchOf(xs.map(c => c.c))) || 2.54;
    return out({ family: 'header', L: xs.length * pitch, W: ys.length * pitch, H: 2.5, cx: f.cx, cy: f.cy, rotDeg: f.deg, p: { cols: xs.length, rows: ys.length, pitch }, populated: hint?.populated ?? true },
      `${n} drilled pins in ${ys.length} row${ys.length > 1 ? 's' : ''} @ ${pitch.toFixed(2)} → header`);
  }

  // ── two pins: chip / SOD ──
  if (n === 2) {
    const [a, b] = pins; const dx = b.position.x - a.position.x, dy = b.position.y - a.position.y, span = Math.hypot(dx, dy);
    const deg = Math.atan2(dy, dx) * 180 / Math.PI; const c = center();
    // pad extent along / across the pin axis, from the pad AABB (axis-aligned chips only)
    const axial = Math.abs(dx) > 10 * Math.abs(dy) ? 'x' : Math.abs(dy) > 10 * Math.abs(dx) ? 'y' : null;
    const ext = (p: Pin, ax: 'x' | 'y') => p.padBounds ? (ax === 'x' ? p.padBounds.maxX - p.padBounds.minX : p.padBounds.maxY - p.padBounds.minY) : undefined;
    const along = axial ? ((ext(a, axial) ?? NaN) + (ext(b, axial) ?? NaN)) / 2 : NaN;
    const across = axial ? ext(a, axial === 'x' ? 'y' : 'x') : undefined;
    const gap = span - along;
    const kind = hint?.kind ?? kindFromPrefix(ref);
    if (hint?.family === 'sod123' || (!hint && kind === 'D' && span > 120)) return out({ family: 'sod123', L: 2.7, W: 1.6, H: 1.1, cx: c.x, cy: c.y, rotDeg: deg }, `2 pins, span ${span.toFixed(0)} mil, refdes ${ref} → SOD-123`);
    if (hint?.family === 'sod323' || (!hint && kind === 'D' && span > 75 && !(across !== undefined && across > 40))) return out({ family: 'sod323', L: 1.7, W: 1.25, H: 0.9, cx: c.x, cy: c.y, rotDeg: deg }, `2 pins, span ${span.toFixed(0)} mil, refdes ${ref} → SOD-323`);
    // Large two-terminal parts are molded, not chips: polymer/tantalum caps
    // (black, J-lead) and power inductors (grey). Measured on 820-02016.
    const alongMm = Number.isFinite(along) ? mm(along) : undefined, acrossMm = across !== undefined ? mm(across) : undefined;
    if (!hint && kind === 'C' && span > 140) {
      const L = Math.min(mm(span) * 1.15, 7.6), W = acrossMm ? Math.min(acrossMm * 1.65, L * 0.75) : L * 0.6;
      return out({ family: 'molded-cap', kind, L, W, H: L > 6 ? 1.9 : 1.6, cx: c.x, cy: c.y, rotDeg: deg }, `2 pins, span ${span.toFixed(0)} mil, refdes ${ref} → molded polymer cap ${L.toFixed(1)}×${W.toFixed(1)}`);
    }
    if (!hint && kind === 'L' && span > 140) {
      const L = mm(span) + (alongMm ?? mm(span) * 0.4) * 0.5, W = span > 250 ? L : Math.max((acrossMm ?? 0) * 1.1, L * 0.85);
      return out({ family: 'inductor', kind, L, W, H: L > 8 ? 3.0 : L > 5 ? 2.0 : 1.2, cx: c.x, cy: c.y, rotDeg: deg }, `2 pins, span ${span.toFixed(0)} mil, refdes ${ref} → molded power inductor ${L.toFixed(1)}×${W.toFixed(1)}`);
    }
    const vote = chipSizeVote(span, Number.isFinite(gap) ? gap : undefined, across);
    const size = hint?.size && EIA[hint.size] ? hint.size : vote.size;
    if (size) {
      const e = EIA[size]; const H = kind === 'C' ? e.Hc : kind === 'LED' ? 0.6 : kind === 'R' ? e.Hr : (e.Hr + e.Hc) / 2;
      return out({ family: 'chip', kind, size, L: e.L, W: e.W, H, cx: c.x, cy: c.y, rotDeg: deg },
        `2 pins, ${vote.rule} → ${size}; refdes ${ref} → ${kind === 'chip' ? 'neutral chip' : kind}`);
    }
    return out({ family: 'box', L: mm(span) + 1, W: mm(span) * 0.5 + 0.5, H: 1, cx: c.x, cy: c.y, rotDeg: deg }, `2 pins ${span.toFixed(0)} mil apart — too large for a chip`, 'fallback');
  }

  // ── split pins into signal pins and large ones (tabs, thermal pads) ──
  const sizes = pins.map(pinSize);
  const area = (p: Pin) => (p.padWidth && p.padHeight ? p.padWidth * p.padHeight : 4 * p.radius * p.radius);
  const medA = median(pins.map(area));
  const big = pins.map((_, i) => i).filter(i => area(pins[i]) > medA * 3 || ((pins[i].drill ?? 0) > 0 && drilled.length < n));
  const small = pins.map((_, i) => i).filter(i => !big.includes(i));
  const f0 = frame(pins, gridAngle(small.map(i => pins[i].position)), small);
  const sloc = small.map(i => f0.loc[i]);
  const tol = Math.max(4, median(sizes) * 0.35);

  const shapeKey = (p: Pin) => { const w = p.padWidth ?? p.radius * 2, h = p.padHeight ?? p.radius * 2; return `${Math.round(Math.min(w, h) / 3)}:${Math.round(Math.max(w, h) / 3)}`; };
  const groups = new Map<string, number[]>(); pins.forEach((p, i) => (groups.get(shapeKey(p)) ?? groups.set(shapeKey(p), []).get(shapeKey(p))!).push(i));
  // Four pins in a plus: two pairs on perpendicular axes through the centre.
  // Unequal arms → 3-terminal capacitor (end terminals + side ground pads);
  // equal arms → RF coax receptacle (U.FL / MHF4).
  if (n === 4 && !hint) {
    // pair each pin with the one opposite it through the centre
    const P = pins.map(p => p.position), c = { x: P.reduce((a, q) => a + q.x, 0) / 4, y: P.reduce((a, q) => a + q.y, 0) / 4 };
    const j = [1, 2, 3].find(k => Math.hypot(P[0].x + P[k].x - 2 * c.x, P[0].y + P[k].y - 2 * c.y) < 4);
    const rest = [1, 2, 3].filter(k => k !== j);
    const pa = j !== undefined ? { x: P[j].x - P[0].x, y: P[j].y - P[0].y } : null, pb = { x: P[rest[1]].x - P[rest[0]].x, y: P[rest[1]].y - P[rest[0]].y };
    const opposite = j !== undefined && Math.hypot(P[rest[0]].x + P[rest[1]].x - 2 * c.x, P[rest[0]].y + P[rest[1]].y - 2 * c.y) < 4;
    const ax = pa ? Math.hypot(pa.x, pa.y) : 0, ay = Math.hypot(pb.x, pb.y);
    if (pa && opposite && Math.abs(pa.x * pb.x + pa.y * pb.y) < 0.15 * ax * ay) {
      const lo = Math.min(ax, ay), hi = Math.max(ax, ay), long = ax >= ay ? pa : pb;
      const deg = Math.atan2(long.y, long.x) * 180 / Math.PI; const f = { cx: c.x, cy: c.y };
      if (hi / lo < 1.3) { const s = Math.max(2, mm(hi) + 0.6); return out({ family: 'coax', L: s, W: s, H: 1.2, cx: f.cx, cy: f.cy, rotDeg: deg }, `4 pins in a plus, equal arms ${mm(lo).toFixed(1)} mm → RF coax receptacle`); }
      const L = mm(hi) * 1.25 + 0.15, W = Math.max(mm(lo) * 1.4, L * 0.5);
      return out({ family: 'chip3t', kind: 'C', L, W, H: W * 0.9, cx: f.cx, cy: f.cy, rotDeg: deg }, `4 pins in a plus, arms ${hi.toFixed(0)}/${lo.toFixed(0)} mil → 3-terminal capacitor`);
    }
  }

  // Board-to-board receptacle: the most common pad shape forms two equal rows at
  // 0.3–0.5 mm, a few mm apart; other pads (tabs, ground) around them.
  if (n >= 16 && !hint) {
    const sig = [...groups.values()].sort((a, b) => b.length - a.length)[0];
    if (sig.length >= 12) {
      for (const extra of [0, 90]) {
        const f = frame(pins, gridAngle(sig.map(i => pins[i].position)) + extra, sig); const sl = sig.map(i => f.loc[i]);
        const yc = clusters(sl.map(v => v.y), tol).sort((a, b) => b.n - a.n).slice(0, 2).sort((a, b) => a.c - b.c);
        if (yc.length !== 2 || yc[0].n < 8 || Math.abs(yc[0].n - yc[1].n) > 1 || yc[0].n + yc[1].n < 0.6 * sig.length) continue;
        const row = sl.filter(v => Math.abs(v.y - yc[0].c) <= tol).map(v => v.x).sort((a, b) => a - b); const p = mm(pitchOf(row)), gap = mm(Math.abs(yc[1].c - yc[0].c));
        if (p < 0.25 || p > 0.55 || gap > 4.5) continue;
        const L = mm(row[row.length - 1] - row[0]) + 1.6, W = gap + 0.3;
        return out({ family: 'b2b', L, W, H: 0.9, cx: f.cx, cy: f.cy, rotDeg: f.deg, p: { perSide: row.length, pitch: p } }, `${sig.length} pads in two rows ${gap.toFixed(1)} mm apart @ ${p.toFixed(2)} + ${n - sig.length} others → board-to-board connector`);
      }
    }
  }

  // USB-C: ≥10 small pins on two close rows at ~0.5 mm + large/drilled shell tabs.
  if (hint?.family === 'usb-c' || (!hint && small.length >= 10 && big.length >= 2)) {
    for (const extra of [0, 90]) {
      const f = frame(pins, f0.deg + extra, small); const sl = small.map(i => f.loc[i]);
      const ys = clusters(sl.map(v => v.y), 14), xs = clusters(sl.map(v => v.x), 6);
      const p = mm(pitchOf(xs.map(c => c.c)));
      if (ys.length <= 2 && (hint || (p > 0.2 && p < 0.65))) {
        // body extends from the signal row away from the shell tabs' far side: opening faces the tabs.
        const tabY = big.length ? big.reduce((a, i) => a + f.loc[i].y, 0) / big.length : 0;
        const rowY = sl.reduce((a, v) => a + v.y, 0) / sl.length; const dir = tabY < rowY ? -1 : 1;
        const D = 7.35; const by = rowY + dir * (D / 2 - 0.4) * MIL_PER_MM;
        const c = toBoard(f, 0, by);
        return out({ family: 'usb-c', L: 8.94, W: D, H: 3.26, cx: c.x, cy: c.y, rotDeg: wrap(f.deg + (dir > 0 ? 180 : 0)), p: { signals: small.length } },
          `${small.length} pins in two rows @ ${p.toFixed(2)} + ${big.length} shell tabs → USB-C`);
      }
    }
  }

  // Row connector: one row of identical signal pads at 0.3–2.6 mm + 2–4 pads of
  // another shape outside the row's ends (JST SH/PH, FPC, PicoBlade). Grouped
  // by pad shape, not size: a JST PH's signal pads are longer than its tabs.
  const connTry = (sig: number[], tabs: number[]): PartEstimate | null => {
    const fs = frame(pins, gridAngle(sig.map(i => pins[i].position)), sig);
    for (const extra of [0, 90]) {
      const f = frame(pins, fs.deg + extra, sig); const sl = sig.map(i => f.loc[i]);
      const ys = clusters(sl.map(v => v.y), tol); if (ys.length !== 1) continue;
      const xsS = sl.map(v => v.x).sort((a, b) => a - b); const p = mm(sig.length > 1 ? pitchOf(xsS) : 0);
      if (!hint && (p < 0.25 || p > 2.6)) continue;
      if (!tabs.every(i => f.loc[i].x < xsS[0] - 2 || f.loc[i].x > xsS[xsS.length - 1] + 2)) continue;
      const series = hint?.size ?? (p < 0.6 ? 'FPC' : p < 1.1 ? 'JST SH' : p < 1.4 ? 'PicoBlade' : p < 2.2 ? 'JST PH' : 'JST XH');
      const dims: Record<string, [number, number, number]> = { FPC: [3.6, 1.0, 1.6], 'JST SH': [4.25, 2.9, 3.0], PicoBlade: [5.5, 3.2, 3.2], 'JST PH': [6.0, 4.8, 3.9], 'JST XH': [7.0, 5.75, 4.9] };
      const [D, H, extraL] = dims[series] ?? [5, 4, 3];
          const tabY = tabs.reduce((a, i) => a + f.loc[i].y, 0) / tabs.length, rowY = ys[0].c; const dir = tabY > rowY ? 1 : -1;
      const L = (sig.length - 1) * p + extraL;
      const c = toBoard(f, (xsS[0] + xsS[xsS.length - 1]) / 2, rowY + dir * (D / 2 + 0.2) * MIL_PER_MM);
      // model convention: signal row at body -y, mating face +y
      return out({ family: 'conn', size: series, L, W: D, H, cx: c.x, cy: c.y, rotDeg: wrap(f.deg + (dir > 0 ? 0 : 180)), p: { n: sig.length, pitch: p } },
        `${sig.length} pins in one row @ ${p.toFixed(2)} + ${tabs.length} tabs outside its ends → ${series}`);
    }
    return null;
  };
  if (groups.size === 2 && (hint?.family === 'conn' || !hint)) {
    const [g1, g2] = [...groups.values()];
    for (const [sig, tabs] of [[g1, g2], [g2, g1]]) if (tabs.length >= 2 && tabs.length <= 4 && sig.length >= 2) { const r = connTry(sig, tabs); if (r) return r; }
  }

  // Four pins at rectangle corners: crystal / tact switch / 3535 LED by refdes.
  if (n === 4 || (hint && ['crystal', 'button', 'button-ra', 'led3535'].includes(hint.family))) {
    const f = frame(pins, f0.deg); const b = bboxOf(f.loc);
    let w = mm(b.x1 - b.x0), h = mm(b.y1 - b.y0), deg = f.deg; if (h > w) { [w, h] = [h, w]; deg += 90; }
    const pre = (ref.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
    const fam: Family = hint?.family ?? (/^(Y|X|XT|XTAL|OSC)$/.test(pre) ? 'crystal' : /^(SW|S|BTN|KEY|K)$/.test(pre) ? 'button' : /^(LED|D)$/.test(pre) ? 'led3535' : 'box');
    const c = { x: f.cx, y: f.cy };
    if (fam === 'crystal') return out({ family: fam, L: hint?.dims?.L ?? w + 0.7, W: hint?.dims?.W ?? h + 0.5, H: 0.8, cx: c.x, cy: c.y, rotDeg: deg }, `4 pins at the corners of ${w.toFixed(1)}×${h.toFixed(1)} mm, refdes ${ref} → crystal`);
    if (fam === 'button') return out({ family: fam, L: w + 0.1, W: Math.max(h + 1.0, 2.6), H: 1.9, cx: c.x, cy: c.y, rotDeg: deg }, `4 pins at the corners of ${w.toFixed(1)}×${h.toFixed(1)} mm, refdes ${ref} → tact switch`);
    if (fam === 'button-ra') return out({ family: fam, L: w + 0.6, W: 3.5, H: 2.2, cx: c.x, cy: c.y, rotDeg: deg }, pkgWhy);
    if (fam === 'led3535') { const s = hint?.dims?.L ?? (Math.max(w, h) > 3.6 ? 5 : 3.5); return out({ family: fam, L: s, W: s, H: hint?.dims?.H ?? 0.9, cx: c.x, cy: c.y, rotDeg: deg }, `4 pins on a ${w.toFixed(1)}×${h.toFixed(1)} mm rectangle, refdes ${ref} → RGB LED ${s === 5 ? 5050 : 3535}`); }
  }

  // Three / five pins: SOT-23 family (2+1, 3+2 at 0.95 mm).
  if (n === 3 || n === 5 || hint?.family === 'sot23' || hint?.family === 'sot23-5') {
    for (const extra of [0, 90]) {
      const f = frame(pins, f0.deg + extra); const ys = clusters(f.loc.map(v => v.y), tol);
      if (ys.length !== 2) continue;
      const lo = f.loc.filter(v => Math.abs(v.y - ys[0].c) <= tol).length, hi = n - lo;
      const fam: Family = n === 3 ? 'sot23' : 'sot23-5';
      // model convention: the row with more pins at body -y
      const flip = lo < hi ? 180 : 0;
      return out({ family: fam, L: 2.9, W: 1.6, H: 1.1, cx: f.cx, cy: f.cy + 0, rotDeg: wrap(f.deg + flip) },
        `${n} pins, ${Math.max(lo, hi)}+${Math.min(lo, hi)} rows ${mm(Math.abs(ys[1].c - ys[0].c)).toFixed(1)} mm apart → ${fam === 'sot23' ? 'SOT-23' : 'SOT-23-5'}`);
    }
  }

  // No-lead / leaded ICs and grids, on the signal pins.
  {
    const b = bboxOf(sloc); const xs = clusters(sloc.map(v => v.x), tol), ys = clusters(sloc.map(v => v.y), tol);
    const onEdge = (v: V) => Math.abs(v.x - b.x0) < tol || Math.abs(v.x - b.x1) < tol || Math.abs(v.y - b.y0) < tol || Math.abs(v.y - b.y1) < tol;
    const perimeter = sloc.every(onEdge);
    const ep = big.length === 1 && Math.hypot(f0.loc[big[0]].x, f0.loc[big[0]].y) < 0.25 * Math.max(b.x1 - b.x0, b.y1 - b.y0);
    const pitchX = mm(pitchOf(sloc.filter(v => Math.abs(v.y - b.y0) < tol).map(v => v.x).sort((a, c) => a - c)));
    const pitchY = mm(pitchOf(sloc.filter(v => Math.abs(v.x - b.x0) < tol).map(v => v.y).sort((a, c) => a - c)));
    const spanX = mm(b.x1 - b.x0), spanY = mm(b.y1 - b.y0);
    const pin1 = pins.findIndex(p => p.number === '1' || p.name === '1');
    // rotate a square/rect body so pin 1 sits at (-x, +y)
    const pin1Turn = (f: Frame) => { if (pin1 < 0) return 0; const v = f.loc[pin1]; return v.x <= 0 && v.y >= 0 ? 0 : v.x <= 0 ? 90 : v.y >= 0 ? -90 : 180; };
    const sides = [b.x0, b.x1].map(x => sloc.filter(v => Math.abs(v.x - x) < tol).length).concat([b.y0, b.y1].map(y => sloc.filter(v => Math.abs(v.y - y) < tol).length));
    if (hint?.family === 'qfn' || (!hint && perimeter && sides.every(s => s >= 3))) {
      const L = hint?.dims?.L ?? spanX + 0.8, W = hint?.dims?.W ?? spanY + 0.8;
      return out({ family: 'qfn', L, W, H: hint?.dims?.H ?? 0.9, cx: f0.cx, cy: f0.cy, rotDeg: wrap(f0.deg + pin1Turn(f0)), p: { perSide: Math.round(small.length / 4), pitch: pitchX || pitchY, ep: ep ? 1 : 0 } },
        `${small.length} pins on four sides @ ${(pitchX || pitchY).toFixed(2)}${ep ? ' + centre pad' : ''} → QFN ${L.toFixed(1)}×${W.toFixed(1)}`);
    }
    for (const extra of [0, 90]) {
      const f = frame(pins, f0.deg + extra, small); const sl = small.map(i => f.loc[i]);
      const yc = clusters(sl.map(v => v.y), tol);
      if (yc.length !== 2 || Math.abs(yc[0].n - yc[1].n) > 1) continue;
      const row = sl.filter(v => Math.abs(v.y - yc[0].c) <= tol).map(v => v.x).sort((a, c) => a - c); const p = mm(pitchOf(row));
      const gap = mm(Math.abs(yc[1].c - yc[0].c)), len = mm(row[row.length - 1] - row[0]);
      const noLead = hint?.family === 'son' || (!hint && (ep || gap < 4.2));
      if (noLead) {
        const L = hint?.dims?.L ?? len + 1.2, W = hint?.dims?.W ?? gap + 0.4;
        return out({ family: 'son', L, W, H: hint?.dims?.H ?? 0.55, cx: f.cx, cy: f.cy, rotDeg: wrap(f.deg + (pin1Turn(f) === 0 || pin1Turn(f) === 90 ? 0 : 180)), p: { perSide: row.length, pitch: p, ep: ep ? 1 : 0, rowGap: gap } },
          `${small.length} pins, two rows ${gap.toFixed(1)} mm apart @ ${p.toFixed(2)}${ep ? ' + centre pad' : ''} → SON/DFN`);
      }
      const W = gap - 1.6, L = len + 1.0;
      return out({ family: 'soic', L, W, H: p >= 1.2 ? 1.5 : 1.0, cx: f.cx, cy: f.cy, rotDeg: wrap(f.deg + (pin1Turn(f) === 0 || pin1Turn(f) === 90 ? 0 : 180)), p: { perSide: row.length, pitch: p, span: gap } },
        `${small.length} pins, two rows ${gap.toFixed(1)} mm apart @ ${p.toFixed(2)} → ${p >= 1.2 ? 'SOIC' : 'TSSOP'}`);
    }
    // grids: try the nearest-neighbour angle and 45° off it (staggered ball fields)
    // a checkerboard field has diagonal nearest neighbours; the package edge is the angle with the tighter box
    const area = (d: number) => { const B = bboxOf(frame(pins, d, small).loc); return (B.x1 - B.x0) * (B.y1 - B.y0); };
    for (const extra of area(f0.deg) <= area(f0.deg + 45) * 1.02 ? [0, 45] : [45, 0]) {
      const f = frame(pins, f0.deg + extra, small); const sl = small.map(i => f.loc[i]);
      const gx = clusters(sl.map(v => v.x), tol), gy = clusters(sl.map(v => v.y), tol);
      if (gx.length >= 4 && gy.length >= 4 && small.length >= 16 && small.length >= 0.3 * gx.length * gy.length) {
        const B = bboxOf(sl), p = mm(pitchOf(gx.map(c => c.c)));
        return out({ family: 'bga', L: mm(B.x1 - B.x0) + 1.6, W: mm(B.y1 - B.y0) + 1.6, H: 1.2, cx: f.cx, cy: f.cy, rotDeg: wrap(f.deg), p: { cols: gx.length, rows: gy.length, pitch: p, balls: small.length } },
          `${small.length} balls on a ${gx.length}×${gy.length} grid @ ${p.toFixed(2)} → BGA`);
      }
    }
    // fallback: body = pin box + margin, height guessed
    const B = bboxOf(f0.loc);
    return out({ family: 'box', L: mm(B.x1 - B.x0) + 0.8, W: mm(B.y1 - B.y0) + 0.8, H: 1.0, cx: f0.cx, cy: f0.cy, rotDeg: f0.deg }, `${n} pins, no known pattern → body = pin box + margin, height guessed`, 'fallback');
  }
}
