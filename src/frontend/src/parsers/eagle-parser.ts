/**
 * Autodesk / CadSoft EAGLE `.brd` Parser (XML — EAGLE 6.0 and newer)
 *
 * EAGLE 6.0 (2011) replaced the old proprietary binary `.brd` container with a
 * plain XML document. Only that XML flavour is handled here; pre-6.0 binary
 * files are rejected with an actionable message (re-save from EAGLE 6+ to
 * convert).
 *
 * The format's defining trait — and the whole difficulty of parsing it — is
 * **indirection**. Unlike every other boardview format we read, a `.brd` does
 * not store pin positions. It stores three cross-referencing tables:
 *
 *   <libraries><library><packages><package>   footprint geometry, PACKAGE-LOCAL
 *     <smd  name dx dy layer rot roundness/>  surface-mount pad
 *     <pad  name drill diameter shape rot/>   through-hole pad
 *     <wire layer=20|21|22 curve/>            outline / silkscreen
 *   <elements><element name package x y rot/> placement referencing a package
 *   <signals><signal><contactref element pad/> nets, by (element, pad) NAME
 *
 * So a pin position is `package pad coords → element transform → board coords`,
 * and its net comes from a name-pair lookup that never mentions a coordinate.
 *
 * Element transform (the crux — see `makeElementXform`):
 *   `rot` is `[S][M]R<degrees>`. `M` mirrors the footprint across its local Y
 *   axis (x → −x) and puts the part on the BOTTOM side; the rotation is then
 *   applied CCW *after* the mirror, i.e. `p' = R(a)·M·p + t`. This matches
 *   KiCad's EAGLE importer, which expresses the same composite as
 *   "flip about X, then rotate by a+180" — algebraically identical.
 *
 * Units: EAGLE XML always stores millimetres regardless of the editor's grid
 * unit. Everything is converted to mils (BoardRipper's internal unit) on the
 * way in, exactly once, in `mm()`.
 *
 * Spec: docs/formats/EAGLE_BRD_FORMAT.md
 *
 * Part of BoardRipper (AGPL-3.0-or-later, see ../../../../LICENSE). Written
 * from the public EAGLE DTD / file documentation; no code was copied from
 * EAGLE or from a GPL importer.
 */

import type {
  BBox, BoardData, Nail, Pad, PadShape, Part, Pin, Point, SilkscreenPath, Trace, Via,
} from './types';
import { buildNets, computeBBox, computePartGeometry, generateSyntheticOutline } from './types';
import { log } from '../store/log-store';

const decoder = new TextDecoder('utf-8');

/** EAGLE XML coordinates are millimetres; BoardRipper works in mils. */
const MM_TO_MILS = 1000 / 25.4;

/** EAGLE layer numbers we care about. */
const LAYER_TOP        = 1;
const LAYER_BOTTOM     = 16;
const LAYER_DIMENSION  = 20;   // board outline
const LAYER_TPLACE     = 21;   // top silkscreen
const LAYER_BPLACE     = 22;   // bottom silkscreen

/** Max chord angle when flattening an arc, degrees. */
const ARC_SEG_DEG = 5;

/** Endpoint-join tolerance when chaining outline wires into a perimeter (mils). */
const OUTLINE_JOIN_TOL = 2;

// ---------------------------------------------------------------------------
// Minimal XML reader
// ---------------------------------------------------------------------------
//
// `DOMParser` is browser-only and the parsers are imported directly by
// Node-hosted tests, so we carry a small, self-contained reader instead of
// taking a dependency. It handles exactly the subset EAGLE emits: elements,
// attributes (single- or double-quoted, with the five predefined entities and
// numeric character references), self-closing tags, comments, CDATA, the XML
// declaration and the DOCTYPE (including an inline internal subset). Character
// data between tags is discarded — no EAGLE board datum lives in a text node.

export interface EagleXmlNode {
  name: string;
  attrs: Record<string, string>;
  children: EagleXmlNode[];
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
};

function decodeEntities(s: string): string {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

const NAME_END = /[\s/>]/;

/**
 * Parse an XML document into a lightweight node tree. Throws on structurally
 * broken input (unterminated tag, stray close tag) rather than guessing.
 */
export function parseEagleXml(text: string): EagleXmlNode {
  const root: EagleXmlNode = { name: '#document', attrs: {}, children: [] };
  const stack: EagleXmlNode[] = [root];
  const len = text.length;
  let i = 0;

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt + 1;

    // <!-- comment -->  /  <![CDATA[ ... ]]>  /  <!DOCTYPE ...>
    if (text[i] === '!') {
      if (text.startsWith('!--', i)) {
        const end = text.indexOf('-->', i);
        i = end === -1 ? len : end + 3;
      } else if (text.startsWith('![CDATA[', i)) {
        const end = text.indexOf(']]>', i);
        i = end === -1 ? len : end + 3;
      } else {
        // Declaration. An internal DTD subset (`[ ... ]`) may itself contain
        // '>' characters, so skip past the subset before looking for the end.
        const bracket = text.indexOf('[', i);
        const close = text.indexOf('>', i);
        if (bracket !== -1 && (close === -1 || bracket < close)) {
          const subsetEnd = text.indexOf(']', bracket);
          const declEnd = subsetEnd === -1 ? -1 : text.indexOf('>', subsetEnd);
          i = declEnd === -1 ? len : declEnd + 1;
        } else {
          i = close === -1 ? len : close + 1;
        }
      }
      continue;
    }

    // <?xml ... ?>  (processing instruction)
    if (text[i] === '?') {
      const end = text.indexOf('?>', i);
      i = end === -1 ? len : end + 2;
      continue;
    }

    // </name>
    if (text[i] === '/') {
      const end = text.indexOf('>', i);
      if (end === -1) throw new Error('Eagle XML: unterminated closing tag');
      const name = text.slice(i + 1, end).trim();
      // Pop to the matching open element. EAGLE is well-formed, but a
      // tolerant pop keeps one stray tag from derailing the whole board.
      for (let d = stack.length - 1; d > 0; d--) {
        if (stack[d].name === name) { stack.length = d; break; }
      }
      i = end + 1;
      continue;
    }

    // <name attr="value" ...>  or  <name .../>
    let j = i;
    while (j < len && !NAME_END.test(text[j])) j++;
    const name = text.slice(i, j);
    if (!name) { i = j + 1; continue; }

    const node: EagleXmlNode = { name, attrs: {}, children: [] };
    let selfClosing = false;
    i = j;

    for (;;) {
      while (i < len && /\s/.test(text[i])) i++;
      if (i >= len) throw new Error(`Eagle XML: unterminated tag <${name}>`);
      if (text[i] === '/') { selfClosing = true; i++; continue; }
      if (text[i] === '>') { i++; break; }

      let k = i;
      while (k < len && text[k] !== '=' && !/[\s/>]/.test(text[k])) k++;
      const attrName = text.slice(i, k);
      i = k;
      while (i < len && /\s/.test(text[i])) i++;
      if (text[i] !== '=') { if (attrName) node.attrs[attrName] = ''; continue; }
      i++;
      while (i < len && /\s/.test(text[i])) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") throw new Error(`Eagle XML: unquoted attribute in <${name}>`);
      const close = text.indexOf(quote, i + 1);
      if (close === -1) throw new Error(`Eagle XML: unterminated attribute in <${name}>`);
      node.attrs[attrName] = decodeEntities(text.slice(i + 1, close));
      i = close + 1;
    }

    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
  }

  return root;
}

function firstChild(node: EagleXmlNode | undefined, name: string): EagleXmlNode | undefined {
  if (!node) return undefined;
  for (const c of node.children) if (c.name === name) return c;
  return undefined;
}

function childrenNamed(node: EagleXmlNode | undefined, name: string): EagleXmlNode[] {
  if (!node) return [];
  return node.children.filter(c => c.name === name);
}

/** Resolve `a/b/c` from a node, returning undefined at the first missing hop. */
function descend(node: EagleXmlNode | undefined, ...path: string[]): EagleXmlNode | undefined {
  let cur = node;
  for (const step of path) cur = firstChild(cur, step);
  return cur;
}

function num(node: EagleXmlNode, key: string, fallback = 0): number {
  const v = parseFloat(node.attrs[key]);
  return Number.isFinite(v) ? v : fallback;
}

function intAttr(node: EagleXmlNode, key: string, fallback = 0): number {
  const v = parseInt(node.attrs[key], 10);
  return Number.isFinite(v) ? v : fallback;
}

/** Millimetres → mils. Single conversion point for the whole parser. */
function mm(v: number): number {
  return v * MM_TO_MILS;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Flatten an EAGLE arc wire into a polyline (endpoints included).
 *
 * `curve` is the arc's **signed included angle in degrees, CCW-positive**,
 * in the open range (−360, 360). It is fully unambiguous on its own:
 * `curve="270"` is a 270° arc, not the 90° short way round. We therefore
 * consume it verbatim and never fold it into a "shortest arc" normal form —
 * that idiom is exactly what broke the XZZ and GenCAD arc paths (issue #33,
 * see `xzzArcSweepDeg` / `gencadArcSweepRad`), where the sweep had to be
 * *reconstructed* from two endpoint angles and the reconstruction silently
 * picked the wrong side of the circle.
 *
 * Centre derivation: with chord P1→P2 of length L and half-angle h = θ/2, the
 * signed radius is R = L / (2·sin h) and the centre sits at
 * `midpoint − R·cos(h)·w`, where `w` is the chord direction rotated −90°.
 */
export function eagleArcPoints(
  x1: number, y1: number, x2: number, y2: number,
  curveDeg: number, maxSegDeg = ARC_SEG_DEG,
): Point[] {
  const straight: Point[] = [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  if (!Number.isFinite(curveDeg) || Math.abs(curveDeg) < 1e-9) return straight;

  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) return straight;

  const theta = (curveDeg * Math.PI) / 180;
  const half = theta / 2;
  const sinHalf = Math.sin(half);
  if (Math.abs(sinHalf) < 1e-12) return straight;   // θ ≈ ±360° — degenerate

  const ux = dx / L;
  const uy = dy / L;
  const R = L / (2 * sinHalf);                       // signed
  const k = R * Math.cos(half);
  const cx = (x1 + x2) / 2 - k * uy;
  const cy = (y1 + y2) / 2 + k * ux;

  const r = Math.abs(R);
  const a0 = Math.atan2(y1 - cy, x1 - cx);
  const steps = Math.max(2, Math.ceil(Math.abs(curveDeg) / maxSegDeg));
  const pts: Point[] = new Array(steps + 1);
  for (let s = 0; s <= steps; s++) {
    const a = a0 + (theta * s) / steps;
    pts[s] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }
  // Pin the endpoints exactly so chaining sees identical coordinates.
  pts[0] = { x: x1, y: y1 };
  pts[steps] = { x: x2, y: y2 };
  return pts;
}

/**
 * Chain a bag of polylines into as few sub-paths as possible, greedily joining
 * endpoints that coincide within `tol`. Sub-paths are separated by NaN points,
 * the convention `drawOutline` already understands.
 */
function chainPolylines(polys: Point[][], tol: number): Point[] {
  const usable = polys.filter(p => p.length >= 2);
  const used = new Uint8Array(usable.length);
  const out: Point[] = [];
  let remaining = usable.length;
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

  while (remaining > 0) {
    let seed = -1;
    for (let i = 0; i < usable.length; i++) if (!used[i]) { seed = i; break; }
    if (seed < 0) break;
    used[seed] = 1;
    remaining--;
    const chain = usable[seed].slice();

    // Grow from the tail, then from the head.
    for (const forward of [true, false]) {
      for (;;) {
        const anchor = forward ? chain[chain.length - 1] : chain[0];
        let best = -1, bestD = Infinity, flip = false;
        for (let j = 0; j < usable.length; j++) {
          if (used[j]) continue;
          const p = usable[j];
          const d0 = near(anchor, p[0]);
          if (d0 < bestD) { bestD = d0; best = j; flip = false; }
          const d1 = near(anchor, p[p.length - 1]);
          if (d1 < bestD) { bestD = d1; best = j; flip = true; }
        }
        if (best < 0 || bestD > tol) break;
        used[best] = 1;
        remaining--;
        const seg = usable[best];
        const ordered = forward === flip ? seg.slice().reverse() : seg;
        // `ordered[0]` duplicates the anchor — skip it.
        if (forward) {
          for (let k = 1; k < ordered.length; k++) chain.push(ordered[k]);
        } else {
          for (let k = ordered.length - 2; k >= 0; k--) chain.unshift(ordered[k]);
        }
      }
    }

    if (out.length > 0) out.push({ x: NaN, y: NaN });
    for (const p of chain) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Element placement transform
// ---------------------------------------------------------------------------

interface Xform {
  /** Board-space translation, mils. */
  tx: number;
  ty: number;
  cos: number;
  sin: number;
  /** Rotation in degrees CCW, as written in the file. */
  angleDeg: number;
  /** `M` prefix — footprint mirrored across its local Y axis; part is on the
   *  bottom side. */
  mirror: boolean;
}

/** Parse an EAGLE `rot` attribute (`R90`, `MR180`, `SR45`, `SMR0`, …). */
export function parseEagleRot(rot: string | undefined): { angleDeg: number; mirror: boolean; spin: boolean } {
  const m = /^\s*(S?)(M?)R(-?[\d.]+)\s*$/i.exec(rot ?? '');
  if (!m) return { angleDeg: 0, mirror: false, spin: false };
  const a = parseFloat(m[3]);
  return {
    angleDeg: Number.isFinite(a) ? a : 0,
    mirror: m[2].toUpperCase() === 'M',
    spin: m[1].toUpperCase() === 'S',
  };
}

/**
 * Build the package-local → board transform for a placed element:
 * mirror across the local Y axis first, then rotate CCW, then translate.
 * `p' = R(a)·M·p + t`.
 */
function makeElementXform(xMm: number, yMm: number, rot: string | undefined): Xform {
  const { angleDeg, mirror } = parseEagleRot(rot);
  const rad = (angleDeg * Math.PI) / 180;
  return {
    tx: mm(xMm),
    ty: mm(yMm),
    cos: Math.cos(rad),
    sin: Math.sin(rad),
    angleDeg,
    mirror,
  };
}

/** Apply an element transform to a package-local point given in millimetres. */
function xf(t: Xform, lxMm: number, lyMm: number): Point {
  const lx = t.mirror ? -mm(lxMm) : mm(lxMm);
  const ly = mm(lyMm);
  return {
    x: t.tx + lx * t.cos - ly * t.sin,
    y: t.ty + lx * t.sin + ly * t.cos,
  };
}

/**
 * Compose a package-local angle (degrees CCW) with the element transform.
 * Under a mirror, local angle φ maps to `a + 180 − φ`; pads are 180°-symmetric
 * so the caller only needs it modulo 180.
 */
function xfAngle(t: Xform, localDeg: number): number {
  return t.mirror ? t.angleDeg - localDeg : t.angleDeg + localDeg;
}

/** Does this element's transform put the package's layer-1 features on top? */
function sideOfLayer(t: Xform, eagleLayer: number): 'top' | 'bottom' {
  const onTop = eagleLayer !== LAYER_BOTTOM && eagleLayer !== LAYER_BPLACE;
  return (t.mirror ? !onTop : onTop) ? 'top' : 'bottom';
}

// ---------------------------------------------------------------------------
// Design rules — pad diameter when `<pad>` omits it
// ---------------------------------------------------------------------------

/** Parse a design-rule dimension (`"10mil"`, `"0.25mm"`, `"0.01in"`) → mm. */
function ruleMm(raw: string | undefined, fallbackMm: number): number {
  if (!raw) return fallbackMm;
  const m = /^\s*(-?[\d.]+)\s*(mm|mil|inch|in)?\s*$/i.exec(raw);
  if (!m) return fallbackMm;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return fallbackMm;
  switch ((m[2] ?? 'mm').toLowerCase()) {
    case 'mil':  return v * 0.0254;
    case 'in':
    case 'inch': return v * 25.4;
    default:     return v;
  }
}

interface PadRules {
  /** Restring as a fraction of the drill diameter. */
  rv: number;
  /** Restring floor / ceiling, mm. */
  rlMin: number;
  rlMax: number;
}

function readPadRules(board: EagleXmlNode | undefined): PadRules {
  // EAGLE's own factory defaults, used when the file carries no <designrules>.
  const rules: PadRules = { rv: 0.25, rlMin: 0.25, rlMax: 20 };
  const dr = firstChild(board, 'designrules');
  if (!dr) return rules;
  const raw = new Map<string, string>();
  for (const p of childrenNamed(dr, 'param')) raw.set(p.attrs.name ?? '', p.attrs.value ?? '');
  const rv = parseFloat(raw.get('rvPadTop') ?? '');
  if (Number.isFinite(rv)) rules.rv = rv;
  rules.rlMin = ruleMm(raw.get('rlMinPadTop'), rules.rlMin);
  rules.rlMax = ruleMm(raw.get('rlMaxPadTop'), rules.rlMax);
  return rules;
}

/** Through-hole pad diameter in mm: explicit attribute, else drill + restring. */
function padDiameterMm(node: EagleXmlNode, drillMm: number, rules: PadRules): number {
  const explicit = num(node, 'diameter', 0);
  if (explicit > 0) return explicit;
  const restring = Math.min(Math.max(drillMm * rules.rv, rules.rlMin), rules.rlMax);
  return drillMm + 2 * restring;
}

// ---------------------------------------------------------------------------
// Package geometry, resolved once per <package>
// ---------------------------------------------------------------------------

/** One pad of a package, in package-local millimetres. */
interface PkgPad {
  name: string;
  /** Local centre, mm. */
  x: number;
  y: number;
  /** Pre-rotation size, mm. */
  w: number;
  h: number;
  /** Local rotation, degrees CCW. */
  rotDeg: number;
  shape: PadShape;
  /** Octagon corner set (unit circle radius 1, pre-scaled by w/2). */
  octagon: boolean;
  cornerRadiusMm: number;
  smd: boolean;
  /** Copper layer the SMD pad lives on (1/16); through-hole pads span both. */
  layer: number;
  drillMm: number;
}

/** A package-local polyline on a graphic layer, in millimetres. */
interface PkgPath {
  layer: number;
  pts: Point[];
}

interface PkgGeometry {
  pads: PkgPad[];
  /** Board-outline (layer 20) contributions carried by the footprint. */
  outline: PkgPath[];
  /** Silkscreen (layers 21/22). */
  silk: PkgPath[];
  hasSmd: boolean;
  hasThrough: boolean;
}

/** Sample a `<wire>` (straight or curved) into a package-local polyline. */
function wirePoints(node: EagleXmlNode): Point[] {
  const x1 = num(node, 'x1'), y1 = num(node, 'y1');
  const x2 = num(node, 'x2'), y2 = num(node, 'y2');
  const curve = num(node, 'curve', 0);
  return eagleArcPoints(x1, y1, x2, y2, curve);
}

/** Sample a `<circle>` into a closed package-local polyline. */
function circlePoints(node: EagleXmlNode): Point[] {
  const cx = num(node, 'x'), cy = num(node, 'y'), r = num(node, 'radius');
  if (!(r > 0)) return [];
  const steps = 48;
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function resolvePackage(pkg: EagleXmlNode, rules: PadRules): PkgGeometry {
  const pads: PkgPad[] = [];
  const outline: PkgPath[] = [];
  const silk: PkgPath[] = [];
  let hasSmd = false;
  let hasThrough = false;

  for (const c of pkg.children) {
    switch (c.name) {
      case 'smd': {
        const w = num(c, 'dx');
        const h = num(c, 'dy');
        const roundness = num(c, 'roundness', 0);
        pads.push({
          name: c.attrs.name ?? '',
          x: num(c, 'x'), y: num(c, 'y'),
          w, h,
          rotDeg: parseEagleRot(c.attrs.rot).angleDeg,
          shape: roundness > 0 ? 'roundrect' : 'rect',
          octagon: false,
          cornerRadiusMm: roundness > 0 ? (Math.min(w, h) / 2) * (roundness / 100) : 0,
          smd: true,
          layer: intAttr(c, 'layer', LAYER_TOP),
          drillMm: 0,
        });
        hasSmd = true;
        break;
      }
      case 'pad': {
        const drill = num(c, 'drill', 0);
        const dia = padDiameterMm(c, drill, rules);
        const kind = (c.attrs.shape ?? 'round').toLowerCase();
        const h = dia;
        let w = dia, shape: PadShape = 'round', octagon = false, corner = 0;
        if (kind === 'square') {
          shape = 'rect';
        } else if (kind === 'octagon') {
          shape = 'poly';
          octagon = true;
        } else if (kind === 'long' || kind === 'offset') {
          shape = 'roundrect';
          w = dia * 2;
          corner = dia / 2;
        }
        pads.push({
          name: c.attrs.name ?? '',
          x: num(c, 'x'), y: num(c, 'y'),
          w, h,
          rotDeg: parseEagleRot(c.attrs.rot).angleDeg,
          shape,
          octagon,
          cornerRadiusMm: corner,
          smd: false,
          layer: 0,
          drillMm: drill,
        });
        hasThrough = true;
        break;
      }
      case 'wire': {
        const layer = intAttr(c, 'layer', 0);
        if (layer === LAYER_DIMENSION) outline.push({ layer, pts: wirePoints(c) });
        else if (layer === LAYER_TPLACE || layer === LAYER_BPLACE) silk.push({ layer, pts: wirePoints(c) });
        break;
      }
      case 'circle': {
        const layer = intAttr(c, 'layer', 0);
        if (layer === LAYER_DIMENSION) outline.push({ layer, pts: circlePoints(c) });
        else if (layer === LAYER_TPLACE || layer === LAYER_BPLACE) silk.push({ layer, pts: circlePoints(c) });
        break;
      }
      case 'rectangle': {
        // Only the Dimension layer. A `<rectangle>` on tPlace/bPlace is a
        // *filled* silkscreen area, and EAGLE renders raster logos as
        // thousands of 0.5 mm boxes — stroking those as outlines turns the
        // logo into visual noise, so silkscreen takes wires and circles only.
        if (intAttr(c, 'layer', 0) !== LAYER_DIMENSION) break;
        const x1 = num(c, 'x1'), y1 = num(c, 'y1'), x2 = num(c, 'x2'), y2 = num(c, 'y2');
        outline.push({
          layer: LAYER_DIMENSION,
          pts: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }],
        });
        break;
      }
      default:
        break;
    }
  }

  return { pads, outline, silk, hasSmd, hasThrough };
}

/** Corner points of a pad footprint in board coordinates. */
function padCorners(pad: PkgPad, t: Xform): Point[] {
  const a = (xfAngle(t, pad.rotDeg) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const hw = mm(pad.w) / 2;
  const hh = mm(pad.h) / 2;
  const centre = xf(t, pad.x, pad.y);
  const out: Point[] = [];
  for (const [dx, dy] of [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]] as const) {
    out.push({ x: centre.x + dx * c - dy * s, y: centre.y + dx * s + dy * c });
  }
  return out;
}

/** Octagon vertices (board coords) for an EAGLE octagonal through-hole pad. */
function octagonPolygon(pad: PkgPad, t: Xform): Point[] {
  const centre = xf(t, pad.x, pad.y);
  const flat = mm(pad.w) / 2;                    // inscribed-circle radius
  const r = flat / Math.cos(Math.PI / 8);        // circumscribed radius
  const base = (xfAngle(t, pad.rotDeg) * Math.PI) / 180 + Math.PI / 8;
  const pts: Point[] = [];
  for (let i = 0; i < 8; i++) {
    const a = base + (i * Math.PI) / 4;
    pts.push({ x: centre.x + r * Math.cos(a), y: centre.y + r * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseEagleBRD(buffer: ArrayBuffer): BoardData {
  const text = decoder.decode(buffer);
  const head = text.slice(0, 2048);
  if (!/<\s*(\?xml|!DOCTYPE\s+eagle|eagle[\s>])/i.test(head)) {
    throw new Error(
      'This .brd is not an EAGLE XML board. EAGLE 5.x and older wrote a ' +
      'proprietary binary .brd — open it in EAGLE 6 or newer and re-save to ' +
      'convert it to the XML format, which BoardRipper can read.',
    );
  }

  const doc = parseEagleXml(text);
  const eagle = firstChild(doc, 'eagle');
  if (!eagle) throw new Error('EAGLE file has no <eagle> root element.');
  const version = eagle.attrs.version ?? '';
  const board = descend(eagle, 'drawing', 'board');
  if (!board) {
    throw new Error(
      'EAGLE file contains no <board> section — this looks like a schematic ' +
      '(.sch) or library (.lbr) rather than a board.',
    );
  }

  const rules = readPadRules(board);

  // ── Layer table ─────────────────────────────────────────────────────────
  // Copper layers are 1 (top) … 16 (bottom). Keep the file's names so the
  // per-layer trace palette has something meaningful to label.
  const layerNameByNumber = new Map<number, string>();
  for (const l of childrenNamed(firstChild(board, 'layers'), 'layer')) {
    layerNameByNumber.set(intAttr(l, 'number', -1), l.attrs.name ?? '');
  }

  // ── Packages ────────────────────────────────────────────────────────────
  // Keyed by `${library}\u0000${package}`; a bare package-name index resolves
  // files whose element `library` attribute doesn't match a <library name>
  // (EAGLE 7+ can key libraries by urn instead).
  const packages = new Map<string, PkgGeometry>();
  const packagesByName = new Map<string, PkgGeometry>();
  const duplicatedNames = new Set<string>();
  for (const lib of childrenNamed(firstChild(board, 'libraries'), 'library')) {
    const libName = lib.attrs.name ?? '';
    for (const pkg of childrenNamed(firstChild(lib, 'packages'), 'package')) {
      const pkgName = pkg.attrs.name ?? '';
      const geom = resolvePackage(pkg, rules);
      packages.set(`${libName}\u0000${pkgName}`, geom);
      if (packagesByName.has(pkgName)) duplicatedNames.add(pkgName);
      else packagesByName.set(pkgName, geom);
    }
  }

  // ── Signals: (element, pad) → net ───────────────────────────────────────
  const signals = childrenNamed(firstChild(board, 'signals'), 'signal');
  const netByContact = new Map<string, string>();
  for (const sig of signals) {
    const netName = sig.attrs.name ?? '';
    if (!netName) continue;
    for (const cr of childrenNamed(sig, 'contactref')) {
      const el = cr.attrs.element ?? '';
      const pad = cr.attrs.pad ?? '';
      if (!el || !pad) continue;
      netByContact.set(`${el}\u0000${pad}`, netName);
    }
  }

  // ── Elements → parts / pins / pads / silkscreen ──────────────────────────
  const parts: Part[] = [];
  const pads: Pad[] = [];
  const silkscreen: SilkscreenPath[] = [];
  const elementOutlines: Point[][] = [];
  let missingPackages = 0;
  let unmatchedContacts = 0;
  let ambiguousFallbacks = 0;

  for (const el of childrenNamed(firstChild(board, 'elements'), 'element')) {
    const name = el.attrs.name ?? '';
    const libName = el.attrs.library ?? '';
    const pkgName = el.attrs.package ?? '';
    let geom = packages.get(`${libName}\u0000${pkgName}`);
    if (!geom) {
      // EAGLE 7+ may key a library by `urn` instead of the plain name the
      // element cites; fall back to a package-name-only match.
      geom = packagesByName.get(pkgName);
      if (geom && duplicatedNames.has(pkgName)) ambiguousFallbacks++;
    }
    const t = makeElementXform(num(el, 'x'), num(el, 'y'), el.attrs.rot);
    const side: 'top' | 'bottom' = t.mirror ? 'bottom' : 'top';

    if (!geom) {
      missingPackages++;
      continue;
    }

    const pins: Pin[] = [];
    const padCornerPts: Point[] = [];
    for (const p of geom.pads) {
      const centre = xf(t, p.x, p.y);
      const corners = padCorners(p, t);
      for (const c of corners) padCornerPts.push(c);
      const bounds = computeBBox(corners);
      const pinSide = p.smd ? sideOfLayer(t, p.layer) : side;
      const net = netByContact.get(`${name}\u0000${p.name}`) ?? '';
      const angleDeg = xfAngle(t, p.rotDeg);
      const polygon = p.octagon ? octagonPolygon(p, t) : undefined;
      const radius = Math.max(mm(Math.min(p.w, p.h)) / 2, 0.5);

      const pin: Pin = {
        name: p.name,
        number: p.name,
        position: centre,
        radius,
        side: pinSide,
        net,
        padBounds: bounds,
        padShape: p.shape,
        padWidth: mm(p.w),
        padHeight: mm(p.h),
        padAngleDeg: angleDeg,
      };
      if (p.cornerRadiusMm > 0) pin.padCornerRadius = mm(p.cornerRadiusMm);
      if (polygon) pin.padPolygon = polygon;
      if (!p.smd && p.drillMm > 0) pin.drill = mm(p.drillMm);
      pins.push(pin);

      const padRec: Pad = {
        bounds,
        side: p.smd ? pinSide : 'both',
        net: net || undefined,
        attached: true,
        shape: p.shape,
        width: mm(p.w),
        height: mm(p.h),
        angleDeg,
      };
      if (p.cornerRadiusMm > 0) padRec.cornerRadius = mm(p.cornerRadiusMm);
      if (polygon) padRec.polygon = polygon;
      if (!p.smd && p.drillMm > 0) padRec.drill = mm(p.drillMm);
      pads.push(padRec);
    }

    // Silkscreen — layer 21/22 polylines carried by the footprint.
    for (const path of geom.silk) {
      if (path.pts.length < 2) continue;
      silkscreen.push({
        points: path.pts.map(p => xf(t, p.x, p.y)),
        side: sideOfLayer(t, path.layer),
      });
    }
    // Some designs (notably shield/carrier footprints) carry the board
    // dimension on the package rather than in <plain>.
    for (const path of geom.outline) {
      if (path.pts.length < 2) continue;
      elementOutlines.push(path.pts.map(p => xf(t, p.x, p.y)));
    }

    // Geometry: pin cloud when the part has pads, package graphics otherwise
    // (fiducials, logos, mounting frames), so pin-less parts don't collapse
    // onto the board origin.
    let origin: Point;
    let bounds: BBox;
    if (pins.length > 0) {
      const g = computePartGeometry(pins);
      origin = g.origin;
      bounds = computeBBox(padCornerPts.length > 0 ? padCornerPts : pins.map(p => p.position));
    } else {
      origin = { x: t.tx, y: t.ty };
      const gfx: Point[] = [];
      for (const path of geom.silk) for (const p of path.pts) gfx.push(xf(t, p.x, p.y));
      for (const path of geom.outline) for (const p of path.pts) gfx.push(xf(t, p.x, p.y));
      bounds = gfx.length > 0
        ? computeBBox(gfx)
        : { minX: origin.x - 10, minY: origin.y - 10, maxX: origin.x + 10, maxY: origin.y + 10 };
    }

    const type: Part['type'] = geom.hasThrough ? 'throughhole' : geom.hasSmd ? 'smd' : 'unknown';
    const part: Part = {
      name,
      side,
      type,
      origin,
      pins,
      bounds,
      // A pad drawn at local angle 0 lands on the board at exactly `angleDeg`
      // whether or not the element is mirrored (mirroring negates the *local*
      // angle, not the element's own), so this is the right OBB angle for
      // `computePartRenderPoly` in both cases.
      angleDeg: t.angleDeg,
      meta: {
        value: el.attrs.value || undefined,
        package: pkgName || undefined,
        angleDeg: t.angleDeg,
      },
    };
    parts.push(part);
  }

  // Contactrefs that never found a pad (renamed package, missing library).
  if (netByContact.size > 0) {
    const seen = new Set<string>();
    for (const p of parts) for (const pin of p.pins) if (pin.net) seen.add(`${p.name}\u0000${pin.name}`);
    for (const key of netByContact.keys()) if (!seen.has(key)) unmatchedContacts++;
  }

  // ── Traces + vias from <signals> ────────────────────────────────────────
  const traces: Trace[] = [];
  const vias: Via[] = [];
  const copperLayersUsed = new Set<number>();
  for (const sig of signals) {
    const netName = sig.attrs.name ?? '';
    for (const c of sig.children) {
      if (c.name === 'wire') {
        const layer = intAttr(c, 'layer', 0);
        if (layer < LAYER_TOP || layer > LAYER_BOTTOM) continue;   // copper only
        copperLayersUsed.add(layer);
        const width = mm(num(c, 'width', 0));
        const pts = wirePoints(c);
        for (let i = 1; i < pts.length; i++) {
          traces.push({
            start: { x: mm(pts[i - 1].x), y: mm(pts[i - 1].y) },
            end:   { x: mm(pts[i].x),     y: mm(pts[i].y) },
            width,
            net: netName,
            layer,
          });
        }
      } else if (c.name === 'via') {
        vias.push({
          position: { x: mm(num(c, 'x')), y: mm(num(c, 'y')) },
          diameter: mm(num(c, 'drill', 0)),
          net: netName,
          layers: [],
        });
      }
    }
  }
  // Re-index trace layers to a dense 0-based order (top → bottom).
  const orderedCopper = [...copperLayersUsed].sort((a, b) => a - b);
  const layerIndex = new Map(orderedCopper.map((n, i) => [n, i]));
  for (const tr of traces) tr.layer = layerIndex.get(tr.layer!) ?? 0;
  const layerNames = orderedCopper.map(n => layerNameByNumber.get(n) || `Layer ${n}`);

  // ── Board outline ───────────────────────────────────────────────────────
  const outlinePolys: Point[][] = [];
  const plain = firstChild(board, 'plain');
  for (const c of plain?.children ?? []) {
    if (intAttr(c, 'layer', 0) !== LAYER_DIMENSION) continue;
    let pts: Point[] = [];
    if (c.name === 'wire') pts = wirePoints(c);
    else if (c.name === 'circle') pts = circlePoints(c);
    else if (c.name === 'rectangle') {
      const x1 = num(c, 'x1'), y1 = num(c, 'y1'), x2 = num(c, 'x2'), y2 = num(c, 'y2');
      pts = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }];
    }
    if (pts.length >= 2) outlinePolys.push(pts.map(p => ({ x: mm(p.x), y: mm(p.y) })));
  }
  const outlineFromPlain = outlinePolys.length;
  // Footprint-carried dimension wires (BeagleBone-style shield outlines) count
  // too — several designs put the whole board edge in one placed package.
  for (const poly of elementOutlines) outlinePolys.push(poly);

  let outline = chainPolylines(outlinePolys, OUTLINE_JOIN_TOL);
  let syntheticOutline = false;
  if (outline.length < 3) {
    const anchor: Point[] = [];
    for (const p of parts) for (const pin of p.pins) anchor.push(pin.position);
    outline = generateSyntheticOutline(anchor, 50);
    syntheticOutline = outline.length > 0;
  }

  // ── Nets + bounds ───────────────────────────────────────────────────────
  const nets = buildNets(parts);
  const boundsPoints: Point[] = [];
  for (const p of outline) if (!Number.isNaN(p.x) && !Number.isNaN(p.y)) boundsPoints.push(p);
  for (const p of parts) {
    boundsPoints.push({ x: p.bounds.minX, y: p.bounds.minY });
    boundsPoints.push({ x: p.bounds.maxX, y: p.bounds.maxY });
  }
  for (const v of vias) boundsPoints.push(v.position);
  const bounds = computeBBox(boundsPoints);

  const nails: Nail[] = [];
  const parserNotes: string[] = [];
  if (syntheticOutline) {
    parserNotes.push('No layer-20 (Dimension) geometry found — board outline synthesised from pin extents.');
  } else if (outlineFromPlain === 0 && elementOutlines.length > 0) {
    parserNotes.push('Board outline taken from a placed footprint’s layer-20 wires (the <plain> section has none).');
  }
  if (missingPackages > 0) {
    parserNotes.push(`${missingPackages} element(s) referenced a package missing from the file’s libraries and were skipped.`);
  }
  if (unmatchedContacts > 0) {
    parserNotes.push(`${unmatchedContacts} <contactref> entr(ies) named a pad that no placed footprint provides.`);
  }
  if (ambiguousFallbacks > 0) {
    parserNotes.push(`${ambiguousFallbacks} element(s) resolved their footprint by package name alone, and that name exists in more than one library — the first match was used.`);
  }

  let pinCount = 0;
  for (const p of parts) pinCount += p.pins.length;
  log.parser.log(
    `EAGLE ${version || '?'}: ${parts.length} parts, ${pinCount} pins, ${nets.size} nets, ` +
    `${traces.length} trace segments, ${vias.length} vias, ${outline.length} outline points ` +
    `(${outlineFromPlain} plain + ${elementOutlines.length} footprint dimension paths)`,
  );

  return {
    format: 'EAGLE_BRD',
    formatVersion: version || undefined,
    outline,
    parts,
    nails,
    nets,
    bounds,
    traces: traces.length > 0 ? traces : undefined,
    vias: vias.length > 0 ? vias : undefined,
    silkscreen: silkscreen.length > 0 ? silkscreen : undefined,
    pads: pads.length > 0 ? pads : undefined,
    layerNames: layerNames.length > 0 ? layerNames : undefined,
    parserNotes: parserNotes.length > 0 ? parserNotes : undefined,
  };
}
