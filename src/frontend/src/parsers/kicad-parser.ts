/**
 * KiCad `.kicad_pcb` Parser
 *
 * KiCad stores its board files as a single S-expression document:
 *
 *   (kicad_pcb (version 20221018) (generator pcbnew)
 *     (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) …)
 *     (net 0 "") (net 1 "GND") …
 *     (footprint "lib:name" (layer "F.Cu") (at X Y [ROT])
 *       (fp_text reference "R1" …)
 *       (pad "1" smd roundrect (at x y [rot]) (size w h) (layers …) (net 1 "GND")))
 *     (gr_line (start …) (end …) (layer "Edge.Cuts") …)
 *     (segment (start …) (end …) (width …) (layer "F.Cu") (net 1))
 *     (via (at …) (size …) (drill …) (layers "F.Cu" "B.Cu") (net 1)))
 *
 * Nothing is obfuscated or compressed — the whole job is a tokenizer plus a
 * faithful reading of the placement maths. Extracted: footprints → parts,
 * pads → pins + copper pads, Edge.Cuts graphics → outline,
 * (segment)/(arc)/(via) → traces + vias, and (zone) → copper-fill surfaces.
 * See docs/formats/KICAD_PCB_FORMAT.md for the full field-by-field account of
 * what is read and what is skipped.
 *
 * Coordinates: KiCad is millimetres with **Y pointing down** (screen
 * orientation). BoardRipper is mils, also Y-down for un-flipped formats, so
 * every coordinate is scaled by 1000/25.4 and nothing else — the format
 * descriptor leaves `flipY` false.
 *
 * Angles: KiCad's `(at x y ROT)` angle is degrees counter-clockwise **as
 * displayed**. Because the stored frame is Y-down, "CCW on screen" is a
 * negative rotation in raw file coordinates — see `applyXf`.
 *
 * Reference: KiCad board file format documentation,
 * https://dev-docs.kicad.org/en/file-formats/sexpr-pcb/
 */

import type { BoardData, BBox, Nail, Pad, PadShape, Part, Pin, Point, Surface, Trace, Via } from './types';
import {
  computeBBox,
  buildNets,
  computePartGeometry,
  chainSegments,
  generateSyntheticOutline,
  detectGhostComponents,
} from './types';
import { log } from '../store/log-store';

const decoder = new TextDecoder('utf-8');

/** Mils per millimetre. Every KiCad coordinate is scaled by this on the way in. */
const MM_TO_MILS = 1000 / 25.4; // 39.370078740157…

// ---------------------------------------------------------------------------
// S-expression tokenizer
// ---------------------------------------------------------------------------

/** A parsed S-expression node: either an atom (string) or a list of nodes. */
export type SNode = string | SNode[];

/**
 * Tokenize a KiCad S-expression document into a node tree.
 *
 * Deliberately minimal and allocation-cheap — a 4.7 MB board is ~2 M tokens,
 * so the loop works on char codes and slices rather than regexes. Iterative
 * (explicit stack) rather than recursive so a pathological nesting depth
 * can't blow the JS stack.
 *
 * Atoms are returned verbatim as strings; quoted strings are unescaped
 * (`\"`, `\\`, `\n`, `\t`, `\r`) and are NOT distinguished from bare atoms,
 * which is what lets the same code read both the modern quoted spelling
 * (`(layer "F.Cu")`) and the legacy bare one (`(layer F.Cu)`).
 *
 * Unbalanced parentheses are tolerated rather than thrown on: a truncated
 * file still yields everything that parsed, and `parseKiCadPCB` does the
 * real structural validation on the root node.
 */
export function parseSExpr(src: string): SNode[] {
  const root: SNode[] = [];
  const stack: SNode[][] = [root];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const c = src.charCodeAt(i);

    // Whitespace
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }

    // List open
    if (c === 40 /* ( */) {
      const list: SNode[] = [];
      stack[stack.length - 1].push(list);
      stack.push(list);
      i++;
      continue;
    }

    // List close
    if (c === 41 /* ) */) {
      if (stack.length > 1) stack.pop();
      i++;
      continue;
    }

    // Quoted string
    if (c === 34 /* " */) {
      i++;
      let out = '';
      let chunk = i;
      while (i < n) {
        const d = src.charCodeAt(i);
        if (d === 92 /* \ */) {
          out += src.slice(chunk, i);
          const e = src[i + 1];
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : (e ?? '');
          i += 2;
          chunk = i;
          continue;
        }
        if (d === 34) break;
        i++;
      }
      out += src.slice(chunk, i);
      i++; // consume the closing quote (a no-op at EOF)
      stack[stack.length - 1].push(out);
      continue;
    }

    // Bare atom — runs until whitespace, a paren, or a quote
    const start = i;
    while (i < n) {
      const d = src.charCodeAt(i);
      if (d === 32 || d === 9 || d === 10 || d === 13 || d === 40 || d === 41 || d === 34) break;
      i++;
    }
    stack[stack.length - 1].push(src.slice(start, i));
  }

  return root;
}

// --- node accessors --------------------------------------------------------

function isList(n: SNode | undefined): n is SNode[] {
  return Array.isArray(n);
}

/** Keyword at the head of a list, or '' for atoms / headless lists. */
function head(n: SNode | undefined): string {
  return isList(n) && typeof n[0] === 'string' ? n[0] : '';
}

/** First direct child list headed by `name`. */
function child(n: SNode[], name: string): SNode[] | undefined {
  for (let i = 1; i < n.length; i++) {
    const c = n[i];
    if (isList(c) && c[0] === name) return c;
  }
  return undefined;
}

/** All direct child lists headed by `name`. */
function childrenOf(n: SNode[], name: string): SNode[][] {
  const out: SNode[][] = [];
  for (let i = 1; i < n.length; i++) {
    const c = n[i];
    if (isList(c) && c[0] === name) out.push(c);
  }
  return out;
}

/** Positional atom, or '' when absent / a nested list. */
function atom(n: SNode[] | undefined, i: number): string {
  const v = n?.[i];
  return typeof v === 'string' ? v : '';
}

/** Positional number, or `fallback` when absent / unparseable. */
function num(n: SNode[] | undefined, i: number, fallback = 0): number {
  if (!n) return fallback;
  const v = n[i];
  if (typeof v !== 'string') return fallback;
  const f = parseFloat(v);
  return Number.isFinite(f) ? f : fallback;
}

/** All positional atoms after the head keyword. */
function tailAtoms(n: SNode[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < n.length; i++) {
    const v = n[i];
    if (typeof v === 'string') out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Placement transform
// ---------------------------------------------------------------------------

/** Footprint placement: origin in mm plus a precomputed rotation. */
interface Xf {
  ox: number;
  oy: number;
  cos: number;
  sin: number;
}

const IDENTITY_XF: Xf = { ox: 0, oy: 0, cos: 1, sin: 0 };

function makeXf(ox: number, oy: number, deg: number): Xf {
  const r = (deg * Math.PI) / 180;
  return { ox, oy, cos: Math.cos(r), sin: Math.sin(r) };
}

/**
 * Footprint-local millimetres → board mils.
 *
 * KiCad angles are counter-clockwise as displayed, and the stored frame has Y
 * pointing down, so a positive angle is a *negative* rotation in raw file
 * coordinates. Verified against the fixtures by checking that pad centres of
 * rotated footprints land on the track endpoints that route to them.
 */
function applyXf(xf: Xf, x: number, y: number): Point {
  return {
    x: (xf.ox + x * xf.cos + y * xf.sin) * MM_TO_MILS,
    y: (xf.oy - x * xf.sin + y * xf.cos) * MM_TO_MILS,
  };
}

/** Board millimetres → board mils (no rotation). */
function toMils(x: number, y: number): Point {
  return { x: x * MM_TO_MILS, y: y * MM_TO_MILS };
}

/**
 * KiCad's as-authored angle → the angle in BoardRipper's raw board frame,
 * normalised to [0, 360).
 *
 * `Part.angleDeg`, `Pin.padAngleDeg` and `Pad.angleDeg` are consumed as plain
 * `(cos θ, sin θ)` axes over the stored coordinates (`computeRotatedOBB`,
 * `drawPadShape`), so they must be expressed in the same frame the
 * coordinates live in. KiCad's angle is CCW-as-displayed over a Y-down frame,
 * which is the negation. The as-authored value is kept separately in
 * `part.meta.angleDeg` for the Component Info panel, where "90°" should read
 * back exactly as KiCad wrote it.
 */
function toBoardAngle(kicadDeg: number): number {
  return ((-kicadDeg % 360) + 360) % 360;
}

// ---------------------------------------------------------------------------
// Arc sampling
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
/** Chord resolution for tessellated arcs: one segment per 15° of sweep. */
const ARC_STEP_RAD = Math.PI / 12;
const ARC_MAX_STEPS = 96;

/**
 * Sample a KiCad three-point arc `(start)(mid)(end)` into a polyline.
 *
 * KiCad stores a real point ON the arc as the middle token, which makes the
 * arc **unambiguous**: the sweep is whichever direction passes through `mid`,
 * major or minor. There is therefore deliberately NO shortest-arc
 * normalisation here — that idiom is exactly the bug tracked as issue #33 in
 * the XZZ (`xzzArcSweepDeg`) and GenCAD (`gencadArcSweepRad`) parsers, where
 * the source format really did store two bare angles and a >180° sweep got
 * silently folded into its complement.
 *
 * Points are consumed and returned in whatever space the caller supplies
 * (this parser always passes board mils), so no unit handling lives here.
 * Collinear or degenerate inputs fall back to a straight chord.
 */
export function kicadArcPoints(s: Point, m: Point, e: Point): Point[] {
  // Circumcentre of the three points.
  const d = 2 * (s.x * (m.y - e.y) + m.x * (e.y - s.y) + e.x * (s.y - m.y));
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return [s, e];

  const s2 = s.x * s.x + s.y * s.y;
  const m2 = m.x * m.x + m.y * m.y;
  const e2 = e.x * e.x + e.y * e.y;
  const cx = (s2 * (m.y - e.y) + m2 * (e.y - s.y) + e2 * (s.y - m.y)) / d;
  const cy = (s2 * (e.x - m.x) + m2 * (s.x - e.x) + e2 * (m.x - s.x)) / d;
  const r = Math.hypot(s.x - cx, s.y - cy);
  if (!Number.isFinite(r) || r <= 0) return [s, e];

  const a0 = Math.atan2(s.y - cy, s.x - cx);
  const am = Math.atan2(m.y - cy, m.x - cx);
  const a1 = Math.atan2(e.y - cy, e.x - cx);

  const norm = (a: number) => ((a % TAU) + TAU) % TAU; // → [0, 2π)
  const dMid = norm(am - a0);
  const dEnd = norm(a1 - a0);
  // If `mid` is reached before `end` walking counter-clockwise from `start`,
  // the arc is counter-clockwise; otherwise it runs the other way round. A
  // closed arc (start === end) degenerates to dEnd === 0 and correctly falls
  // into the second branch, giving a full -2π turn.
  const sweep = dMid <= dEnd ? dEnd : dEnd - TAU;

  const steps = Math.min(ARC_MAX_STEPS, Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD)));
  const pts: Point[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    pts[i] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  return pts;
}

/**
 * Sample the legacy KiCad 4/5 arc spelling: `(start CX CY) (end X Y) (angle A)`
 * where `start` is the CENTRE, `end` is the arc's first endpoint and `angle`
 * is the signed sweep in degrees (CCW as displayed, so negative in the raw
 * Y-down frame — same convention as `applyXf`).
 *
 * Only reachable from files old enough to still use `(module …)`; no fixture
 * in the corpus exercises it, so the sweep sign is taken from KiCad's
 * documented angle convention rather than measured. Documented as such in
 * docs/formats/KICAD_PCB_FORMAT.md.
 */
function legacyArcPoints(centre: Point, start: Point, angleDeg: number): Point[] {
  const r = Math.hypot(start.x - centre.x, start.y - centre.y);
  if (!Number.isFinite(r) || r <= 0) return [start];
  const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
  const sweep = (-angleDeg * Math.PI) / 180;
  const steps = Math.min(ARC_MAX_STEPS, Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP_RAD)));
  const pts: Point[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const a = a0 + (sweep * i) / steps;
    pts[i] = { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) };
  }
  return pts;
}

/** Sample a full circle of radius |end - centre| about `centre`. */
function circlePoints(centre: Point, edge: Point): Point[] {
  const r = Math.hypot(edge.x - centre.x, edge.y - centre.y);
  if (!Number.isFinite(r) || r <= 0) return [];
  const steps = 32;
  const pts: Point[] = new Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const a = (TAU * i) / steps;
    pts[i] = { x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) };
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const COPPER_LAYER_RE = /^(\*|F|B|In\d+)\.Cu$/;

/** Layer names of a `(layers …)` / `(layer …)` child, in file order. */
function layerNamesOf(n: SNode[]): string[] {
  const multi = child(n, 'layers');
  if (multi) return tailAtoms(multi);
  const single = child(n, 'layer');
  if (single) return tailAtoms(single);
  return [];
}

/** First layer name of a graphic item's `(layer …)`. */
function graphicLayer(n: SNode[]): string {
  const names = layerNamesOf(n);
  return names[0] ?? '';
}

/**
 * Which board side a pad's copper sits on.
 *
 * `*.Cu` (through-hole wildcard) and any F.Cu+B.Cu pairing are 'both'. A pad
 * whose layer set carries no copper at all (soldermask-relief apertures,
 * paste-only stencil helpers) returns null and is dropped from the pin /
 * pad output — it is not an electrical connection point.
 */
function padCopperSide(names: string[]): 'top' | 'bottom' | 'both' | null {
  let f = false, b = false, inner = false;
  for (const raw of names) {
    if (raw === '*.Cu') return 'both';
    if (!COPPER_LAYER_RE.test(raw)) continue;
    if (raw === 'F.Cu') f = true;
    else if (raw === 'B.Cu') b = true;
    else inner = true;
  }
  if (f && b) return 'both';
  if (f) return 'top';
  if (b) return 'bottom';
  if (inner) return 'both'; // inner-only copper spans the stack-up
  return null;
}

// ---------------------------------------------------------------------------
// Pad shape
// ---------------------------------------------------------------------------

/**
 * Map a KiCad pad shape keyword onto the renderer's `PadShape` vocabulary.
 *
 *   circle    → 'round'
 *   rect      → 'rect'
 *   roundrect → 'roundrect' (corner radius from `roundrect_rratio`)
 *   oval      → 'roundrect' with a full end-cap radius (a stadium)
 *   trapezoid → 'rect'      (the taper is not representable; AABB is close)
 *   custom    → 'rect'      (the base `size` box; primitives are skipped)
 */
function mapPadShape(kw: string, w: number, h: number, rratio: number): { shape: PadShape; cornerRadius?: number } {
  switch (kw) {
    case 'circle':    return { shape: 'round' };
    case 'oval':      return { shape: 'roundrect', cornerRadius: Math.min(w, h) / 2 };
    case 'roundrect': return { shape: 'roundrect', cornerRadius: Math.min(w, h) * rratio };
    case 'rect':
    case 'trapezoid':
    case 'custom':
    default:          return { shape: 'rect' };
  }
}

/** Axis-aligned envelope of a w×h rectangle centred at `c` and rotated by `deg`. */
function rotatedAABB(c: Point, w: number, h: number, deg: number): BBox {
  const r = (deg * Math.PI) / 180;
  const ex = (Math.abs(Math.cos(r)) * w + Math.abs(Math.sin(r)) * h) / 2;
  const ey = (Math.abs(Math.sin(r)) * w + Math.abs(Math.cos(r)) * h) / 2;
  return { minX: c.x - ex, minY: c.y - ey, maxX: c.x + ex, maxY: c.y + ey };
}

// ---------------------------------------------------------------------------
// Graphics → polylines
// ---------------------------------------------------------------------------

/**
 * Convert one graphic item (`gr_*` at board level or `fp_*` inside a
 * footprint) into a polyline in board mils, or null when the shape is one we
 * don't sample (text, dimensions, bezier curves).
 */
function graphicPolyline(n: SNode[], xf: Xf): Point[] | null {
  const at = (c: SNode[] | undefined) => applyXf(xf, num(c, 1), num(c, 2));

  switch (head(n)) {
    case 'gr_line':
    case 'fp_line': {
      const s = child(n, 'start'), e = child(n, 'end');
      if (!s || !e) return null;
      return [at(s), at(e)];
    }

    case 'gr_arc':
    case 'fp_arc': {
      const s = child(n, 'start'), m = child(n, 'mid'), e = child(n, 'end');
      if (s && m && e) return kicadArcPoints(at(s), at(m), at(e));
      // Legacy centre/endpoint/sweep spelling.
      const ang = child(n, 'angle');
      if (s && e && ang) return legacyArcPoints(at(s), at(e), num(ang, 1));
      return null;
    }

    case 'gr_circle':
    case 'fp_circle': {
      const c = child(n, 'center'), e = child(n, 'end');
      if (!c || !e) return null;
      const pts = circlePoints(at(c), at(e));
      return pts.length > 0 ? pts : null;
    }

    case 'gr_rect':
    case 'fp_rect': {
      const s = child(n, 'start'), e = child(n, 'end');
      if (!s || !e) return null;
      // Corners are footprint-local, so each is transformed independently —
      // a rect inside a rotated footprint is a rotated rectangle, not an AABB.
      const x0 = num(s, 1), y0 = num(s, 2), x1 = num(e, 1), y1 = num(e, 2);
      const a = applyXf(xf, x0, y0), b = applyXf(xf, x1, y0);
      const c = applyXf(xf, x1, y1), d = applyXf(xf, x0, y1);
      return [a, b, c, d, a];
    }

    case 'gr_poly':
    case 'fp_poly': {
      const pts = child(n, 'pts');
      if (!pts) return null;
      const out: Point[] = [];
      for (const xy of childrenOf(pts, 'xy')) out.push(applyXf(xf, num(xy, 1), num(xy, 2)));
      if (out.length < 2) return null;
      out.push(out[0]); // close
      return out;
    }

    default:
      return null;
  }
}

/** `(pts (xy X Y) …)` → board mils. Returns [] when the node is missing. */
function ptsOfMils(pts: SNode[] | undefined): Point[] {
  if (!pts) return [];
  const out: Point[] = [];
  for (let i = 1; i < pts.length; i++) {
    const xy = pts[i];
    if (!isList(xy) || xy[0] !== 'xy') continue;
    out.push(toMils(num(xy, 1), num(xy, 2)));
  }
  return out;
}

/**
 * Resolve a zone's own layer field to copper-layer indices.
 *
 * Needed only for unfilled zones — a filled one carries a real layer name on
 * every `(filled_polygon)`. KiCad may write a layer *set* shorthand here
 * instead of a name: `F&B.Cu` (outer layers) or `*.Cu` (the whole stack-up).
 * Unknown names resolve to nothing, and the caller skips the zone rather than
 * defaulting it onto F.Cu.
 */
function expandZoneLayers(names: string[], copperIndex: Map<string, number>, copperCount: number): number[] {
  const out = new Set<number>();
  for (const name of names) {
    if (name === '*.Cu') {
      for (let i = 0; i < copperCount; i++) out.add(i);
      continue;
    }
    if (name === 'F&B.Cu') {
      const f = copperIndex.get('F.Cu');
      const b = copperIndex.get('B.Cu');
      if (f !== undefined) out.add(f);
      if (b !== undefined) out.add(b);
      continue;
    }
    const li = copperIndex.get(name);
    if (li !== undefined) out.add(li);
  }
  return [...out].sort((a, b) => a - b);
}

/** Append a polyline to a segment list as consecutive point pairs. */
function pushPolyline(segments: Array<[Point, Point]>, pts: Point[]): void {
  for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1], pts[i]]);
}

// ---------------------------------------------------------------------------
// Net names
// ---------------------------------------------------------------------------

/**
 * KiCad qualifies sheet-local nets with a leading slash (`/SPI_MISO`,
 * `/Connections/AUX OUT`) while global labels and power symbols stay bare
 * (`GND`, `+3V3`). Every other BoardRipper format carries bare names, and
 * users search for `SPI_MISO`, so the leading slash is stripped — but only
 * when doing so is injective. If a file happens to hold both `GND` and
 * `/GND`, stripping would merge two genuinely distinct nets, so the whole
 * file keeps its verbatim names and the caller records a parser note.
 */
function buildNetRenamer(rawNames: Iterable<string>): { rename: (s: string) => string; collided: boolean } {
  const seen = new Set<string>();
  for (const raw of rawNames) {
    if (raw) seen.add(raw);
  }
  // Two distinct names mapping to one stripped name is the whole hazard —
  // and that covers the `GND` / `/GND` pairing too, since both strip to `GND`.
  const stripped = new Set<string>();
  let collided = false;
  for (const raw of seen) {
    const s = raw.startsWith('/') ? raw.slice(1) : raw;
    if (stripped.has(s)) { collided = true; break; }
    stripped.add(s);
  }
  if (collided) return { rename: (s) => s, collided: true };
  return { rename: (s) => (s.startsWith('/') ? s.slice(1) : s), collided: false };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseKiCadPCB(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const roots = parseSExpr(text);

  const rootNode = roots.find(r => head(r) === 'kicad_pcb');
  if (!isList(rootNode)) {
    throw new Error('KiCad: file does not contain a (kicad_pcb …) root expression');
  }
  const root = rootNode;

  const version = atom(child(root, 'version'), 1);
  const generator = atom(child(root, 'generator'), 1);

  // --- copper stack-up ----------------------------------------------------
  // The (layers …) block lists every layer in stacking order; the copper ones
  // get a compact 0-based index (F.Cu = 0 … B.Cu = last) that traces and vias
  // are tagged with, so the renderer can colour and layer-hop them.
  const copperIndex = new Map<string, number>();
  const layerNames: string[] = [];
  const layersNode = child(root, 'layers');
  if (layersNode) {
    for (let i = 1; i < layersNode.length; i++) {
      const l = layersNode[i];
      if (!isList(l)) continue;
      const name = atom(l, 1);
      if (!name || !COPPER_LAYER_RE.test(name)) continue;
      copperIndex.set(name, layerNames.length);
      layerNames.push(name);
    }
  }

  // --- net table ----------------------------------------------------------
  const netById = new Map<number, string>();
  for (const netNode of childrenOf(root, 'net')) {
    const id = num(netNode, 1, -1);
    if (id < 0) continue;
    netById.set(id, atom(netNode, 2));
  }

  // Pads may name a net the top-level table doesn't (hand-edited files), so
  // the renamer is built over the union of both sources.
  const rawNetNames = new Set<string>(netById.values());
  for (const fp of childrenOf(root, 'footprint')) collectPadNetNames(fp, rawNetNames);
  for (const fp of childrenOf(root, 'module')) collectPadNetNames(fp, rawNetNames);
  for (const zone of childrenOf(root, 'zone')) {
    const zn = atom(child(zone, 'net_name'), 1);
    if (zn) rawNetNames.add(zn);
  }
  const { rename, collided } = buildNetRenamer(rawNetNames);

  const netName = (n: SNode[] | undefined): string => {
    if (!n) return '';
    const byName = atom(n, 2);
    if (byName) return rename(byName);
    const id = num(n, 1, -1);
    const looked = id >= 0 ? netById.get(id) : undefined;
    return looked ? rename(looked) : '';
  };

  // --- footprints → parts -------------------------------------------------
  const parts: Part[] = [];
  const pads: Pad[] = [];
  const outlineSegments: Array<[Point, Point]> = [];
  let droppedNoPad = 0;
  let droppedNoCopper = 0;

  const footprintNodes = [...childrenOf(root, 'footprint'), ...childrenOf(root, 'module')];

  for (const fp of footprintNodes) {
    const libId = atom(fp, 1);
    const atNode = child(fp, 'at');
    const fx = num(atNode, 1);
    const fy = num(atNode, 2);
    const frot = num(atNode, 3);
    const xf = makeXf(fx, fy, frot);

    const fpSide: 'top' | 'bottom' = graphicLayer(fp) === 'B.Cu' ? 'bottom' : 'top';
    const name = footprintReference(fp) || libId.split(':').pop() || `FP${parts.length + 1}`;

    const pins: Pin[] = [];
    let anyThruHole = false;
    let anySmd = false;

    for (const padNode of childrenOf(fp, 'pad')) {
      const number = atom(padNode, 1);
      const kind = atom(padNode, 2);   // smd | thru_hole | np_thru_hole | connect
      const shapeKw = atom(padNode, 3);

      const layers = layerNamesOf(padNode);
      const copperSide = padCopperSide(layers);

      const padAt = child(padNode, 'at');
      const centre = applyXf(xf, num(padAt, 1), num(padAt, 2));
      // The pad's own `at` angle is stored ABSOLUTE (footprint rotation
      // already folded in) — confirmed against the fixtures, where a
      // footprint at 90° carries pads at 90°. Absent ⇒ 0, matching KiCad.
      const padAngle = toBoardAngle(num(padAt, 3));

      const sizeNode = child(padNode, 'size');
      const w = num(sizeNode, 1) * MM_TO_MILS;
      const h = num(sizeNode, 2) * MM_TO_MILS;

      const drillNode = child(padNode, 'drill');
      // `(drill D)`, `(drill oval DX DY)`, `(drill D (offset x y))`.
      const drill = drillNode
        ? (atom(drillNode, 1) === 'oval'
            ? Math.min(num(drillNode, 2), num(drillNode, 3)) * MM_TO_MILS
            : num(drillNode, 1) * MM_TO_MILS)
        : 0;

      const rratio = num(child(padNode, 'roundrect_rratio'), 1, 0.25);
      const { shape, cornerRadius } = mapPadShape(shapeKw, w, h, rratio);
      const padBounds = rotatedAABB(centre, w, h, padAngle);
      const net = netName(child(padNode, 'net'));

      if (copperSide === null) {
        // Soldermask / paste apertures wearing the `pad` keyword — no copper,
        // so no pin and no pad.
        droppedNoCopper++;
        continue;
      }

      const isNp = kind === 'np_thru_hole';

      const pad: Pad = {
        bounds: padBounds,
        side: copperSide,
        shape,
        width: w,
        height: h,
        angleDeg: padAngle,
        attached: !isNp,
      };
      if (net) pad.net = net;
      if (drill > 0) pad.drill = drill;
      if (cornerRadius !== undefined && cornerRadius > 0) pad.cornerRadius = cornerRadius;
      pads.push(pad);

      if (isNp) continue; // unplated mounting hole — geometry only, never a pin

      if (kind === 'thru_hole') anyThruHole = true;
      else if (kind === 'smd') anySmd = true;

      const pin: Pin = {
        name: number,
        number,
        position: centre,
        // Pin sprite radius: the inscribed circle of the pad, so oblong and
        // finger pads don't get a circle that overflows the narrow axis.
        radius: Math.max(1, Math.min(w, h) / 2),
        // Pin.side is two-valued; a through-hole pad belongs to the side its
        // footprint is placed on.
        side: copperSide === 'both' ? fpSide : copperSide,
        net,
        padBounds,
        padShape: shape,
        padWidth: w,
        padHeight: h,
        padAngleDeg: padAngle,
      };
      if (drill > 0) pin.drill = drill;
      if (cornerRadius !== undefined && cornerRadius > 0) pin.padCornerRadius = cornerRadius;
      pins.push(pin);
    }

    // Board edges are sometimes drawn inside a footprint (edge-connector
    // cut-outs, board-outline helper footprints), so footprint graphics are
    // swept for Edge.Cuts alongside the top-level ones.
    collectEdgeCuts(fp, xf, outlineSegments);

    if (pins.length === 0) {
      // Fiducials, mounting-hole-only and pure-annotation footprints. Nothing
      // to render and nothing to connect — the renderer derives every part
      // box from its pins.
      droppedNoPad++;
      continue;
    }

    const { origin, bounds } = computePartGeometry(pins);
    const part: Part = {
      name,
      side: fpSide,
      type: anyThruHole ? 'throughhole' : anySmd ? 'smd' : 'unknown',
      origin,
      pins,
      bounds,
      angleDeg: toBoardAngle(frot),
      meta: {
        package: libId.includes(':') ? libId.split(':').slice(1).join(':') : libId,
        angleDeg: frot, // as authored, for the Component Info panel
      },
    };
    const value = footprintValue(fp);
    if (value && part.meta) part.meta.value = value;
    parts.push(part);
  }

  if (parts.length === 0) {
    throw new Error('KiCad: file parsed but contains no placed footprints with copper pads');
  }

  // --- board outline (Edge.Cuts) -----------------------------------------
  collectEdgeCuts(root, IDENTITY_XF, outlineSegments);

  // --- traces + vias ------------------------------------------------------
  const traces: Trace[] = [];
  for (const seg of childrenOf(root, 'segment')) {
    const s = child(seg, 'start'), e = child(seg, 'end');
    if (!s || !e) continue;
    traces.push({
      start: toMils(num(s, 1), num(s, 2)),
      end: toMils(num(e, 1), num(e, 2)),
      width: num(child(seg, 'width'), 1) * MM_TO_MILS,
      net: netName(child(seg, 'net')),
      layer: copperIndex.get(graphicLayer(seg)) ?? 0,
    });
  }
  // KiCad 6+ curved tracks: same three-point arc as gr_arc, sampled into the
  // straight-segment trace model the renderer uses.
  for (const arcNode of childrenOf(root, 'arc')) {
    const s = child(arcNode, 'start'), m = child(arcNode, 'mid'), e = child(arcNode, 'end');
    if (!s || !m || !e) continue;
    const pts = kicadArcPoints(
      toMils(num(s, 1), num(s, 2)),
      toMils(num(m, 1), num(m, 2)),
      toMils(num(e, 1), num(e, 2)),
    );
    const width = num(child(arcNode, 'width'), 1) * MM_TO_MILS;
    const net = netName(child(arcNode, 'net'));
    const layer = copperIndex.get(graphicLayer(arcNode)) ?? 0;
    for (let i = 1; i < pts.length; i++) {
      traces.push({ start: pts[i - 1], end: pts[i], width, net, layer });
    }
  }

  const vias: Via[] = [];
  const copperCount = layerNames.length;
  for (const viaNode of childrenOf(root, 'via')) {
    const at = child(viaNode, 'at');
    if (!at) continue;
    const drill = num(child(viaNode, 'drill'), 1) * MM_TO_MILS;
    const spans = layerNamesOf(viaNode)
      .map(n => copperIndex.get(n))
      .filter((n): n is number => n !== undefined);
    // `layers: []` means "through-hole, all layers" per the Via contract, so
    // a via spanning the full stack-up is normalised to the empty array.
    const full = spans.length === 2 && Math.min(...spans) === 0 && Math.max(...spans) === copperCount - 1;
    vias.push({
      position: toMils(num(at, 1), num(at, 2)),
      diameter: drill > 0 ? drill : num(child(viaNode, 'size'), 1) * MM_TO_MILS,
      net: netName(child(viaNode, 'net')),
      layers: full ? [] : spans,
    });
  }

  // --- zones → copper-fill surfaces ---------------------------------------
  //
  // `Surface.voids` is deliberately never populated, because KiCad hands us
  // no hole list to put in it. Its fills are stored *fractured*
  // (`SHAPE_POLY_SET::Fracture()`): every cutout — via clearance, thermal
  // relief, pad keepout — is stitched into the outer boundary by a
  // zero-width slit, so what the file contains is a set of self-touching
  // single rings, not outer-ring-plus-holes.
  //
  // Measured on the fixtures rather than assumed: of starfish's 125 fill
  // rings, 11 carry duplicated vertices (762 of them) and **every** ring
  // winds counter-clockwise — not one is a reversed inner ring. Comparing
  // the edges incident on each duplicate pair shows the walk goes out and
  // straight back along itself (381 backtracking pairs for 762 duplicate
  // vertices, i.e. all of them). tomu-fpga agrees: 3/30 rings, 16 duplicate
  // vertices, 8 backtracks, 30/30 counter-clockwise.
  //
  // That representation is what the renderer wants anyway. `drawSurface` in
  // board-scene emits one `moveTo`/`lineTo`/`closePath` sub-path and fills,
  // and the slit's two coincident edges cancel under the fill rule, so the
  // holes appear for free — with no void punching, which board-scene
  // explicitly refuses to do on performance grounds. Splitting the rings
  // back into outer + voids would therefore be work that produces a worse
  // input for the only consumer.
  const surfaces: Surface[] = [];
  let keepoutZones = 0;
  let unfilledZones = 0;
  let unresolvedZoneLayers = 0;

  for (const zone of childrenOf(root, 'zone')) {
    // Keepouts / rule areas are DRC constructs wearing the `zone` keyword —
    // they describe where copper may NOT go. Emitting one as a surface would
    // paint a solid plane over the exact area that has no copper. They are
    // also the zones most likely to be unfilled, so this check has to come
    // before the `(polygon)` fallback below, not after.
    if (child(zone, 'keepout')) { keepoutZones++; continue; }

    const zoneNetRaw = atom(child(zone, 'net_name'), 1);
    const zoneNet = zoneNetRaw ? rename(zoneNetRaw) : netName(child(zone, 'net'));
    const zoneLayerName = graphicLayer(zone);

    const fills = childrenOf(zone, 'filled_polygon');
    if (fills.length > 0) {
      // KiCad stores the *computed* fill, one `(filled_polygon)` per island,
      // each already clipped for clearances, thermal reliefs and cutouts.
      // Never emit the zone's `(polygon)` boundary alongside these — that
      // would double-draw the pour at its un-clipped extent.
      for (const fp of fills) {
        const polygon = ptsOfMils(child(fp, 'pts'));
        if (polygon.length < 3) continue;
        // The island's own `(layer …)` wins: a zone may declare
        // `(layers F&B.Cu)` — a layer-SET shorthand that names no single
        // layer — and fill several layers from one boundary.
        const layerName = graphicLayer(fp) || zoneLayerName;
        const surface: Surface = { polygon };
        if (zoneNet) surface.net = zoneNet;
        const li = copperIndex.get(layerName);
        if (li !== undefined) surface.layer = li;
        else unresolvedZoneLayers++;
        surfaces.push(surface);
      }
      continue;
    }

    // No computed fill: the zone was drawn but never poured (the user hasn't
    // run "Fill all zones"). The user-drawn boundary is the only geometry
    // there is — it over-states the copper, since none of the clearances or
    // thermal reliefs have been subtracted, so it is emitted but counted and
    // surfaced in parserNotes rather than passed off as a real fill.
    const boundary = ptsOfMils(child(child(zone, 'polygon') ?? [], 'pts'));
    if (boundary.length < 3) continue;
    // `(layers F&B.Cu)` and `(layers *.Cu)` are set shorthands rather than
    // layer names, so they are expanded here — this is the one path where a
    // zone's own layer field has to be resolved.
    const targets = expandZoneLayers(layerNamesOf(zone), copperIndex, layerNames.length);
    if (targets.length === 0) { unresolvedZoneLayers++; continue; }
    unfilledZones++;
    for (const li of targets) {
      const surface: Surface = { polygon: boundary, layer: li };
      if (zoneNet) surface.net = zoneNet;
      surfaces.push(surface);
    }
  }

  // --- assembly -----------------------------------------------------------
  const outline = outlineSegments.length > 0 ? chainSegments(outlineSegments) : [];

  const pinPoints: Point[] = [];
  for (const p of parts) for (const pin of p.pins) pinPoints.push(pin.position);

  const framePoints: Point[] = [...pinPoints, ...vias.map(v => v.position)];
  if (outline.length > 0) framePoints.push(...outline);
  const bounds = computeBBox(framePoints);

  const nets = buildNets(parts);
  const nails: Nail[] = [];
  const ghosts = detectGhostComponents(parts);

  const parserNotes: string[] = [
    `KiCad board file (version ${version || 'unknown'}${generator ? `, generator ${generator}` : ''})`,
  ];
  if (outline.length === 0) {
    parserNotes.push('No Edge.Cuts geometry found — board outline is a synthetic bounding rectangle.');
  }
  if (collided) {
    parserNotes.push(
      'Net names kept verbatim (with their leading "/") because stripping the sheet prefix would have merged two distinct nets.',
    );
  }
  if (unfilledZones > 0) {
    parserNotes.push(
      `${unfilledZones} copper zone${unfilledZones === 1 ? '' : 's'} carried no computed fill, so the user-drawn ` +
      'boundary is shown instead — it over-states the copper (no clearances or thermal reliefs subtracted). ' +
      'Re-run "Fill all zones" in KiCad and re-export for the true pour.',
    );
  }

  log.parser.log(
    `KiCad: ${parts.length} parts, ${pinPoints.length} pins, ${nets.size} nets, ` +
    `${outline.length} outline pts, ${traces.length} traces, ${vias.length} vias, ${pads.length} pads, ` +
    `${surfaces.length} surfaces` +
    (droppedNoPad > 0 ? `, ${droppedNoPad} pad-less footprints skipped` : '') +
    (droppedNoCopper > 0 ? `, ${droppedNoCopper} non-copper pads skipped` : '') +
    (keepoutZones > 0 ? `, ${keepoutZones} keepout zone(s) skipped` : '') +
    (unfilledZones > 0 ? `, ${unfilledZones} unfilled zone(s) approximated` : '') +
    (unresolvedZoneLayers > 0 ? `, ${unresolvedZoneLayers} zone fill(s) on an unrecognised layer` : ''),
  );

  const board: BoardData = {
    format: 'KICAD',
    formatVersion: version ? `KiCad ${version}` : 'KiCad',
    outline: outline.length > 0 ? outline : generateSyntheticOutline(pinPoints),
    parts,
    nails,
    nets,
    bounds,
    parserNotes,
  };
  if (traces.length > 0) board.traces = traces;
  if (vias.length > 0) board.vias = vias;
  if (pads.length > 0) board.pads = pads;
  if (surfaces.length > 0) board.surfaces = surfaces;
  if (layerNames.length > 0) board.layerNames = layerNames;
  if (ghosts.length > 0) board.ghosts = ghosts;
  return board;
}

// ---------------------------------------------------------------------------
// Footprint helpers
// ---------------------------------------------------------------------------

/**
 * Reference designator of a footprint.
 *
 * KiCad ≤ 7 stores it as `(fp_text reference "R1" …)`; KiCad 8+ moved it to
 * `(property "Reference" "R1" …)` while keeping the old spelling readable.
 * Both are checked, newest first. The library id (`"lib:R_0402"`) is
 * deliberately NOT used — that is the footprint, not the component.
 */
function footprintReference(fp: SNode[]): string {
  for (const prop of childrenOf(fp, 'property')) {
    if (atom(prop, 1) === 'Reference') {
      const v = atom(prop, 2);
      if (v) return v;
    }
  }
  for (const t of childrenOf(fp, 'fp_text')) {
    if (atom(t, 1) === 'reference') {
      const v = atom(t, 2);
      if (v) return v;
    }
  }
  return '';
}

/** BOM value of a footprint (`"470p"`, `"100K"`), same two spellings. */
function footprintValue(fp: SNode[]): string {
  for (const prop of childrenOf(fp, 'property')) {
    if (atom(prop, 1) === 'Value') {
      const v = atom(prop, 2);
      if (v) return v;
    }
  }
  for (const t of childrenOf(fp, 'fp_text')) {
    if (atom(t, 1) === 'value') {
      const v = atom(t, 2);
      if (v) return v;
    }
  }
  return '';
}

/** Union every pad net name of a footprint into `out`. */
function collectPadNetNames(fp: SNode[], out: Set<string>): void {
  for (const padNode of childrenOf(fp, 'pad')) {
    const n = child(padNode, 'net');
    if (!n) continue;
    const name = atom(n, 2);
    if (name) out.add(name);
  }
}

/**
 * Sweep a container (the board root or one footprint) for Edge.Cuts graphics
 * and append their sampled polylines to `segments`.
 */
function collectEdgeCuts(container: SNode[], xf: Xf, segments: Array<[Point, Point]>): void {
  for (let i = 1; i < container.length; i++) {
    const n = container[i];
    if (!isList(n)) continue;
    const kw = head(n);
    if (kw.length === 0) continue;
    if (!(kw.startsWith('gr_') || kw.startsWith('fp_'))) continue;
    if (graphicLayer(n) !== 'Edge.Cuts') continue;
    const pts = graphicPolyline(n, xf);
    if (pts && pts.length >= 2) pushPolyline(segments, pts);
  }
}
