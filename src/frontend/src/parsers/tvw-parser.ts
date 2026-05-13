/**
 * TVW (Teboview) binary board view parser.
 *
 * Ported from eagleview by Pavel Kovalenko (MIT)
 * https://github.com/nitrocaster/eagleview
 *
 * Format: binary little-endian, Pascal strings (u8 length + data),
 * Fixed32 coordinates (raw / 100 = mils), position-dependent string cipher.
 */

import type { BoardData, Part, Pin, Point, BBox, Nail, Trace, Via, SilkscreenPath, Pad } from './types';
import { computeBBox, buildNets } from './types';
import { log } from '../store/log-store';
import { detectPositionOverlapRevisions } from './post-processing/detect-revisions';

const textDecoder = new TextDecoder('utf-8');

/** Outline margin around each butterfly column (mils) */
const OUTLINE_MARGIN = 50;

/** Max pin radius in mils — clamps oversized thermal/connector pads */
const MAX_PIN_RADIUS = 30;


// ─── Binary Reader ──────────────────────────────────────────────────────────

class TvwReader {
  private view: DataView;
  private pos = 0;

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  tell(): number { return this.pos; }
  size(): number { return this.view.byteLength; }
  remaining(): number { return this.view.byteLength - this.pos; }

  private ensure(n: number): void {
    if (this.pos + n > this.view.byteLength) {
      throw new Error(`TVW: unexpected end of file at offset 0x${this.pos.toString(16)} (need ${n} bytes, ${this.remaining()} available)`);
    }
  }

  readU8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readU32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readS32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat(): number {
    this.ensure(4);
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readBool8(): boolean {
    return this.readU8() !== 0;
  }

  /** Read a Pascal string: u8 length + UTF-8 bytes */
  readPStr(): string {
    const len = this.readU8();
    if (len === 0) return '';
    this.ensure(len);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len);
    this.pos += len;
    return textDecoder.decode(bytes);
  }

  /** Read Fixed32: i32 / 100 → value with 2 decimal places */
  readFixed32(): number {
    return this.readS32() / 100;
  }

  /** Read a 2D position as Fixed32 pair → { x, y } in mils */
  readVec2S(): Point {
    const x = this.readFixed32();
    const y = this.readFixed32();
    return { x, y };
  }

  /** Skip N bytes */
  skip(n: number): void {
    this.ensure(n);
    this.pos += n;
  }

  /** Returns a view (not a copy) into the source buffer */
  readBytes(n: number): Uint8Array {
    this.ensure(n);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return bytes;
  }

  /** Seek to absolute position */
  seek(pos: number): void {
    if (pos < 0 || pos > this.view.byteLength) {
      throw new Error(`TVW: seek out of bounds: ${pos}`);
    }
    this.pos = pos;
  }

  /** Peek a u32 at offset from current position without advancing */
  peekU32(offset: number): number {
    const p = this.pos + offset;
    if (p + 4 > this.view.byteLength) return -1;
    return this.view.getUint32(p, true);
  }

  /** Access underlying DataView for bulk scanning */
  getView(): DataView { return this.view; }
}

// ─── String Decryption ──────────────────────────────────────────────────────

function decodeString(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let out = c;

    if (c >= 0x61 && c <= 0x6A) {       // lowercase a-j
      let x = c - (i % 3) - 4;
      if (x < 0x61) x += 10;
      out = 154 - x;
    } else if (c >= 0x6B && c <= 0x7A) { // lowercase k-z
      let x = c - (i % 10) - 5;
      if (x < 0x6B) x += 16;
      out = x;
    } else if (c >= 0x41 && c <= 0x5A) { // uppercase A-Z
      let x = c + (i % 10) + 5;
      if (x > 0x5A) x -= 26;
      out = x;
    } else if (c >= 0x30 && c <= 0x39) { // digits 0-9
      let x = c + (i % 3) + 4;
      if (x > 0x39) x -= 10;
      out = x + 49;
    }
    result += String.fromCharCode(out);
  }
  return result;
}

// ─── TVW Internal Types ─────────────────────────────────────────────────────

const TvwLayerType = {
  Document: 0,
  Top: 1,
  Bottom: 2,
  Signal: 3,
  Plane: 4,
  SolderTop: 5,
  SolderBottom: 6,
  SilkTop: 7,
  SilkBottom: 8,
  PasteTop: 9,
  PasteBottom: 10,
  Drill: 11,
  Roul: 12,
} as const;
type TvwLayerType = typeof TvwLayerType[keyof typeof TvwLayerType];

const TvwObjectType = {
  Through: 1,
  Logic: 3,
} as const;
type TvwObjectType = typeof TvwObjectType[keyof typeof TvwObjectType];

const TvwShapeType = {
  Round: 0,
  Rect: 1,
  RoundRect: 3,
  Poly: 5,
} as const;
type TvwShapeType = typeof TvwShapeType[keyof typeof TvwShapeType];

interface TvwShape {
  type: TvwShapeType;
  width: number;  // mils
  height: number; // mils
  turn: number;   // degrees
}

interface TvwPad {
  net: number;    // index into net name table, -1 = unconnected
  dcode: number;
  pos: Point;
  isExposed: boolean;
  isCopper: boolean;
  testpointParam: number;
  shapeRef: TvwShape | null;
}

interface TvwLine {
  net: number;
  dcode: number;
  start: Point;
  end: Point;
}

interface TvwArc {
  net: number;
  dcode: number;
  center: Point;
  radius: number;
  startAngle: number;
  sweepAngle: number;
}

interface TvwDrillHole {
  net: number;
  toolIndex: number;
  pos: Point;
}

interface TvwLogicLayer {
  objType: typeof TvwObjectType.Logic;
  name: string;
  layerType: TvwLayerType;
  shapes: TvwShape[];
  pads: TvwPad[];
  lines: TvwLine[];
  arcs: TvwArc[];
}

interface TvwDrillSlot {
  net: number;
  start: Point;
  end: Point;
}

interface TvwThroughLayer {
  objType: typeof TvwObjectType.Through;
  name: string;
  layerType: TvwLayerType;
  toolSizes: number[];  // drill diameters in mils
  holes: TvwDrillHole[];
  slots: TvwDrillSlot[];
}

/** Placeholder for a layer that we couldn't fully parse — kept so the user
 *  can still see "this layer exists" in the sidebar. Carries whatever
 *  metadata we managed to read before parsing failed (or none). */
interface TvwPlaceholderLayer {
  objType: 'placeholder';
  name: string;             // empty if we couldn't read the header
  layerType: TvwLayerType;  // 0 if unknown
  reason: string;           // why we couldn't parse it (for logs / debug)
  startOffset: number;      // file offset where this layer starts
}

type TvwLayer = TvwLogicLayer | TvwThroughLayer | TvwPlaceholderLayer;

interface TvwPin {
  handle: number;
  id: number;
  name: string;
}

interface TvwPart {
  name: string;
  bboxMin: Point;
  bboxMax: Point;
  pos: Point;
  angle: number;
  partType: number;
  layer: number;  // 1=top-ish, 2=bottom-ish (but varies — eagleview uses 3/12)
  value: string;
  packageName: string;   // e.g., "CHIP0603R"
  serial: string;        // e.g., manufacturer P/N — empty if flag0 was unset
  heightMils: number;    // Z-height in mils
  pins: TvwPin[];
  /** Second pin list for dual-sided edge connectors (Landrex variant).
   *  These pins resolve to pads on the opposite copper layer from `pins`. */
  pinsExt?: TvwPin[];
}

/** PartType enum → display name. From the TVW format spec; missing entries
 *  fall back to "Unknown". */
const TVW_PART_TYPE_NAMES: Record<number, string> = {
  0: 'IC', 1: 'Diode', 2: 'Transistor', 3: 'Resistor', 4: 'Resistor Net (SI)',
  5: 'Capacitor', 6: 'Capacitor Net (SI)', 7: 'Zener', 8: 'LED', 9: 'Jumper',
  10: 'Battery', 11: 'Mask', 12: 'Relay', 13: 'Fuse', 14: 'Choke',
  15: 'Crystal', 16: 'Switch', 17: 'Connector', 18: 'Test Point', 19: 'Transformer',
  20: 'Potentiometer', 21: 'Mechanical', 22: 'Resistor Net (DI)', 23: 'Resistor Net (SB)',
  24: 'Resistor Net (DB)', 25: 'Capacitor Net (DI)', 26: 'Capacitor Net (SB)',
  27: 'Capacitor Net (DB)', 28: 'Strap', 29: 'Fiducial', 30: 'Unknown',
};

interface TvwBoard {
  header: {
    type: string;
    customer: string;
    date: string;
    layerCount: number;
  };
  layers: TvwLayer[];
  nets: string[];
  parts: TvwPart[];
}

// ─── Layer Parsing ──────────────────────────────────────────────────────────

function detectObjectType(r: TvwReader): TvwObjectType | undefined {
  const startPos = r.tell();
  for (let i = 0; i < 4; i++) {
    const type = r.readU32();
    if (type === TvwObjectType.Through || type === TvwObjectType.Logic) return type;
    // eagleview returns first non-zero as object type — if it's unknown, bail
    if (type !== 0) {
      log.parser.warn(`unknown object type ${type} at offset 0x${startPos.toString(16)}`);
      return undefined;
    }
  }
  return undefined;
}

function readLayerHeader(r: TvwReader): { name: string; initialName: string; path: string; layerType: TvwLayerType; padColor: number; lineColor: number } {
  const magic0 = r.readU32(); // expected: 2
  const magic1 = r.readU32(); // expected: 1
  if (magic0 !== 2 || magic1 !== 1) {
    log.parser.warn(`unexpected layer header magic ${magic0}/${magic1} at offset 0x${(r.tell() - 8).toString(16)}`);
  }
  const name = r.readPStr();
  const initialName = r.readPStr();
  const path = r.readPStr();
  const layerType = r.readU32() as TvwLayerType;
  const padColor = r.readU32();
  const lineColor = r.readU32();
  return { name, initialName, path, layerType, padColor, lineColor };
}


function loadShapes(r: TvwReader): TvwShape[] {
  const maxDCode = r.readU32();
  if (maxDCode === 0) return [];
  // maxDCode is the highest D-code index; shapes are D10..D(maxDCode-1)
  const shapeCount = maxDCode - 10;
  const shapes: TvwShape[] = [];
  for (let i = 0; i < shapeCount; i++) {
    r.readU32(); // marker = 1
    const w = r.readFixed32();
    const h = r.readFixed32();
    const shapeType = r.readU32() as TvwShapeType;
    let turn = 0;
    switch (shapeType) {
      case TvwShapeType.Round:
        r.readFixed32(); r.readFixed32();
        break;
      case TvwShapeType.Rect:
        turn = r.readFloat();
        r.readS32();
        break;
      case TvwShapeType.RoundRect:
        turn = r.readFloat();
        r.readS32();
        break;
      case TvwShapeType.Poly: {
        r.readU32();
        r.readPStr();
        r.readFixed32(); r.readFixed32();
        r.readFixed32(); r.readFixed32();
        const subObjCount = r.readU32();
        for (let s = 0; s < subObjCount; s++) {
          const subType = r.readU32();
          if (subType === 2) {
            r.skip(12); // Flags: int32_t[3]
            const vertexCount = r.readU32();
            for (let v = 0; v < vertexCount; v++) {
              r.readFixed32(); r.readFixed32();
            }
          } else if (subType === 5) {
            r.readU32(); r.readU32(); r.readU32();
            r.readFixed32(); r.readFixed32();
            r.readFixed32(); r.readFixed32();
            r.readS32();
          }
        }
        break;
      }
      default:
        log.parser.warn(`unknown shape type ${shapeType}, skipping 8 bytes`);
        r.readFixed32(); r.readFixed32();
        break;
    }
    shapes.push({ type: shapeType, width: w, height: h, turn });
  }
  return shapes;
}

/** Resolve dcode → shape from the shape table (dcode offset by 10) */
function resolveShape(shapes: TvwShape[], dcode: number): TvwShape | null {
  const idx = dcode - 10;
  return idx >= 0 && idx < shapes.length ? shapes[idx] : null;
}

function loadPads(r: TvwReader, shapes: TvwShape[]): TvwPad[] {
  const count = r.readU32();
  if (count === 0) return [];
  r.readU32(); // marker = 2
  const pads: TvwPad[] = [];
  for (let i = 0; i < count; i++) {
    const net = r.readS32();
    const dcode = r.readU32();
    const pos = r.readVec2S();
    const isExposed = r.readBool8();
    const isCopper = r.readBool8();
    const testpointParam = r.readU8();
    const shapeRef = resolveShape(shapes, dcode);

    if (isCopper) {
      const isSomething = r.readBool8();
      if (testpointParam === 1) r.skip(12); // test point data
      if (isExposed || isSomething) {
        r.skip(16); // exposed bbox (4 × Fixed32)
      }
      const hasHole = r.readBool8();
      r.readU8(); // tailParam
      if (hasHole) {
        r.skip(7);  // hole data7
        r.skip(8);  // hole size (2 × Fixed32)
        r.skip(1);  // hole param
      }
    }
    // non-copper pads have no extra data

    pads.push({ net, dcode, pos, isExposed, isCopper, testpointParam, shapeRef });
  }
  return pads;
}

function loadLines(r: TvwReader): TvwLine[] {
  const count = r.readU32();
  if (count === 0) return [];
  r.readU32(); // marker = 0
  const lines: TvwLine[] = [];
  for (let i = 0; i < count; i++) {
    const net = r.readS32();
    const dcode = r.readU32();
    const start = r.readVec2S();
    const end = r.readVec2S();
    lines.push({ net, dcode, start, end });
  }
  return lines;
}

function loadArcs(r: TvwReader): TvwArc[] {
  const count = r.readU32();
  if (count === 0) return [];
  r.readU32(); // marker = 0
  const arcs: TvwArc[] = [];
  for (let i = 0; i < count; i++) {
    const net = r.readS32();
    const dcode = r.readU32();
    const center = r.readVec2S();
    const radius = r.readFixed32();
    const startAngle = r.readFloat();
    const sweepAngle = r.readFloat();
    arcs.push({ net, dcode, center, radius, startAngle, sweepAngle });
  }
  return arcs;
}

function skipSurfaces(r: TvwReader): void {
  const count = r.readU32();
  if (count === 0) return;
  r.readU32(); // marker = 2
  for (let i = 0; i < count; i++) {
    r.readS32(); // net
    const edgeCount = r.readU32();
    r.skip(edgeCount * 8); // vertices (2 × Fixed32 each)
    r.readS32(); // lineWidth
    const voidCount = r.readU32();
    if (voidCount > 0) {
      for (let v = 0; v < voidCount; v++) {
        r.readU32(); // tag
        const voidEdgeCount = r.readU32();
        r.skip(voidEdgeCount * 8); // void vertices
      }
      r.readU32(); // voidFlags
    }
  }
}

function skipUnknownItems(r: TvwReader): void {
  const count = r.readU32();
  r.readU32(); // param
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      r.readPStr(); // name
      r.skip(8);    // pos (2 × Fixed32)
      r.skip(24);   // z1 + 4 params + z2 + z3 (6 × i32)
      r.skip(3);    // flags
      r.skip(4);    // param4
    }
    r.readU32(); // trailing 0
  }
  r.readU32(); // trailing 7
}

function skipTestpoints(r: TvwReader): void {
  // TestPoints (type 1)
  const tpCount = r.readU32();
  for (let i = 0; i < tpCount; i++) {
    r.readU8();  // flag1
    r.skip(16);  // p1, handle, p2, p3
    r.skip(8);   // pos
    r.skip(4);   // p4
    r.readU8();  // flag2
    r.skip(8);   // p5, p6
    r.skip(4);   // n
  }
  r.readU32(); // 0
  r.readU32(); // 4

  // TestPoints2
  const tp2Count = r.readU32();
  r.readU32(); // param
  for (let i = 0; i < tp2Count; i++) {
    r.skip(12);  // p1, handle, p2
    r.skip(24);  // pos, pos1, pos2 (3 × vec2)
    r.skip(3);   // flag1,2,3
    r.skip(4);   // nail
    r.skip(4);   // param
    r.skip(3);   // flag4,5,6
    r.skip(4);   // n
  }

  // TestPoints3
  const tp3Count = r.readU32();
  r.readU32(); // param
  for (let i = 0; i < tp3Count; i++) {
    r.skip(12);  // p1, handle, p2
    r.skip(24);  // pos, pos1, pos2
    r.skip(3);   // flags
    r.skip(4);   // nail
    r.skip(4);   // param
    r.skip(3);   // flags
    r.skip(4);   // n
  }

  // TestSequence
  const tsCount = r.readU32();
  const tsParam = r.readU32();
  for (let i = 0; i < tsCount; i++) {
    r.skip(8);   // current, next
    r.readU8();  // flag
  }
  if (tsParam === 1) {
    r.skip(12);  // 3 zero dwords
  }
}

function loadLogicLayer(r: TvwReader, header: ReturnType<typeof readLayerHeader>): TvwLogicLayer {
  const shapes = loadShapes(r);
  let pads: TvwPad[] = [];
  let lines: TvwLine[] = [];
  let arcs: TvwArc[] = [];

  // Pads, lines, arcs, surfaces only exist when shapes are present
  if (shapes.length > 0) {
    // 3 flag u32s before pads (eagleview: skip1/skip2/skip3)
    const dataOrder = r.readU32(); // 1 = normal, 2 = extra data (second lines+arcs pass)
    r.readU32(); // always 0
    r.readU32(); // always 1

    pads = loadPads(r, shapes);
    lines = loadLines(r);
    arcs = loadArcs(r);
    skipSurfaces(r);

    // Extra data mode: skip 4 u32s, then reload lines + arcs
    if (dataOrder === 2) {
      r.skip(16); // 4 × u32 unknown
      const extraLines = loadLines(r);
      const extraArcs = loadArcs(r);
      lines = lines.concat(extraLines);
      arcs = arcs.concat(extraArcs);
      r.readU32(); // trailing 0
    }
  }

  skipUnknownItems(r);
  skipTestpoints(r);

  return {
    objType: TvwObjectType.Logic,
    name: header.name,
    layerType: header.layerType,
    shapes,
    pads,
    lines,
    arcs,
  };
}

function loadThroughLayer(r: TvwReader, header: ReturnType<typeof readLayerHeader>): TvwThroughLayer {
  r.readU32(); // 0
  r.readU32(); // 0
  let toolCount = r.readU32();
  // Empty placeholder Through layer (Landrex variant on Gigabyte boards):
  // toolCount=0 with no body. eagleview asserts toolCount > 0 and never tested
  // this case, so following the eagleview-style read further would consume 25
  // bytes of the next layer's header and break the layer chain. Bail out here
  // and treat as an empty drill layer.
  if (toolCount === 0) {
    return {
      objType: TvwObjectType.Through,
      name: header.name,
      layerType: header.layerType,
      toolSizes: [],
      holes: [],
      slots: [],
    };
  }
  toolCount--; // eagleview does toolCount--
  const toolSizes: number[] = [];
  for (let i = 0; i < toolCount; i++) {
    r.readBool8(); // flag1
    r.readBool8(); // flag2
    const size = r.readFixed32(); // drill size in mils
    r.skip(20); // data5 (5 × u32)
    r.skip(3);  // data3
    toolSizes.push(size);
  }
  r.readU8(); // trailing 0

  const drillCount = r.readU32();
  r.readU32(); // v2
  r.skip(16); // 4 zero dwords

  const holes: TvwDrillHole[] = [];
  const slots: TvwDrillSlot[] = [];
  for (let i = 0; i < drillCount; i++) {
    const code = r.readU8();
    if (code === 0x08) {
      // drill hole
      const net = r.readS32();
      const toolIndex = r.readU32();
      const pos = r.readVec2S();
      holes.push({ net, toolIndex, pos });
    } else if (code === 0x0A) {
      // drill slot — line segment
      const net = r.readS32();
      r.readU32(); // tool
      const start = r.readVec2S();
      const end = r.readVec2S();
      r.readU32(); // zero
      slots.push({ net, start, end });
    } else if (code === 0x0B) {
      // ARC record (same 29-byte footprint as 0x0A slot but DIFFERENT field
      // layout). Eagleview / earlier BoardRipper builds treated it as another
      // slot variant — reading the center as `start` and the radius+angles
      // as `end`+`zero` produces 4,000–12,000 mil garbage diagonals all
      // anchored near (~20, 0). The ThinkPad P14s Gen 2 NM-D352 BoardView
      // file ships 59 of these alongside 90 real 0x0A slots; misreading them
      // is what produced the "diagonal fan from bottom-left corner" bug.
      //
      // Layout (verified geometrically against NM-D352's mount-hole fillets):
      //   net      : s32           — same position as 0x0A
      //   tool     : u32           — same
      //   center   : Vec2S         — (cx, cy), Fixed32 ×2
      //   radius   : Fixed32       — i32/100 mils
      //   start    : float32       — start angle in degrees (0 = +X axis)
      //   sweep    : float32       — sweep angle in degrees, signed (CW = negative)
      // The start/sweep angles are float32, not the Fixed32 / u32 that the
      // slot path would otherwise expect — that's why prior parsers saw the
      // diagonal-fan garbage on files with corner-fillet arcs.
      //
      // Tessellate to a polyline so the outline chains continuously. 16
      // sub-segments per arc matches the Logic-layer arc handling in
      // chainLines() and is plenty for the small corner-fillet radii these
      // arcs carry in practice (typically 5–60 mils).
      const net = r.readS32();
      r.readU32(); // tool
      const center = r.readVec2S();
      const radius = r.readFixed32();
      const startDeg = r.readFloat();
      const sweepDeg = r.readFloat();
      if (radius > 0 && isFinite(startDeg) && isFinite(sweepDeg) && Math.abs(sweepDeg) > 0.1) {
        const steps = 16;
        const startRad = startDeg * Math.PI / 180;
        const sweepRad = sweepDeg * Math.PI / 180;
        for (let s = 0; s < steps; s++) {
          const a1 = startRad + (sweepRad * s) / steps;
          const a2 = startRad + (sweepRad * (s + 1)) / steps;
          slots.push({
            net,
            start: { x: center.x + radius * Math.cos(a1), y: center.y + radius * Math.sin(a1) },
            end:   { x: center.x + radius * Math.cos(a2), y: center.y + radius * Math.sin(a2) },
          });
        }
      }
    } else {
      throw new Error(`TVW: unknown drill code 0x${code.toString(16)} at offset 0x${(r.tell() - 1).toString(16)}`);
    }
  }

  return {
    objType: TvwObjectType.Through,
    name: header.name,
    layerType: header.layerType,
    toolSizes,
    holes,
    slots,
  };
}

function loadLayer(r: TvwReader): TvwLayer | null {
  const objType = detectObjectType(r);
  if (objType === undefined) return null; // unknown layer type — caller should handle

  const header = readLayerHeader(r);

  if (objType === TvwObjectType.Logic) {
    return loadLogicLayer(r, header);
  } else {
    return loadThroughLayer(r, header);
  }
}

/** Scan forward for the next layer-header signature so we can resume parsing
 *  after a malformed/unknown layer. The signature is the first 16 bytes of
 *  every layer: u32 leading-zero, u32 obj-type (1 or 3), u32 magic0=2, u32 magic1=1.
 *  Returns the file offset of the leading zero, or -1 if not found within the
 *  given window. The window cap keeps a corrupted file from triggering a
 *  multi-MB linear scan. */
// scanForNextLayerHeader removed by 3e0988c — false matches in parts data
// were zeroing out clean files. Function deleted along with its call sites.

// ─── Parts Parsing ──────────────────────────────────────────────────────────

function loadPin(r: TvwReader, trailing = true): { pin: TvwPin; z2: number } {
  const handle = r.readU32();
  r.readU32(); // z1 = 0
  const id = r.readU32();
  const name = r.readPStr();
  let z2 = 0;
  if (trailing) z2 = r.readU32(); // 0 on normal pins; non-zero = opposite-side contact count for this pin
  return { pin: { handle, id, name }, z2 };
}

function loadPart(r: TvwReader): TvwPart {
  const name = r.readPStr();
  const bboxMin = r.readVec2S();
  const bboxMax = r.readVec2S();
  const pos = r.readVec2S();
  const angle = r.readS32();
  r.readU32(); // decal index
  const partType = r.readU32();
  r.readU32(); // z1 = 0
  const heightMils = r.readS32() / 100;  // Fixed32 → mils
  const flag0 = r.readBool8();
  const value = r.readPStr();
  r.readPStr(); // toleranceP
  r.readPStr(); // toleranceN
  const packageName = r.readPStr();
  let serial = '';
  if (flag0) {
    serial = r.readPStr();
    r.readU32();  // z2 = 0
  }
  const pinCount = r.readU32();
  const layer = r.readU32();
  r.readU32(); // p2 = 0

  const pins: TvwPin[] = [];
  let extContactSum = 0;
  for (let i = 0; i < pinCount; i++) {
    const { pin, z2 } = loadPin(r);
    pins.push(pin);
    extContactSum += z2;
  }

  // Two flavours of "extra pin block" follow the primary pin list:
  //
  //  (a) Per-pin opposite-side contacts (LianBao NM-D355 SWITCH variant) —
  //      each primary pin carries a z2 counter; when sum > 0, that many
  //      pin records follow, preceded by an 8-byte (contFlag, reserved)
  //      header. The pin records here have NO trailing z2 of their own.
  //
  //  (b) Whole-part opposite-side mirror (Landrex/Gigabyte edge & vertical
  //      connectors, LianBao Apple edge connectors with partType=0xFFFFFFFF)
  //      — the SAME primary pin list is repeated on the opposite copper
  //      layer. Detected via `looksLikePinExtension` peeking at the next
  //      bytes; reads `pinCount` more pins, with the last one missing its
  //      trailing z2 (the writer packs the next part's pstr there).
  //
  // (a) takes priority since it's driven by a hard signal (sum of z2s)
  // rather than a heuristic; (b) is the historical broad-match path.
  let pinsExt: TvwPin[] | undefined;
  if (extContactSum > 0) {
    r.readU32(); // contFlag
    r.readU32(); // reserved
    pinsExt = [];
    for (let i = 0; i < extContactSum; i++) {
      pinsExt.push(loadPin(r, i !== extContactSum - 1).pin);
    }
  } else if (pinCount > 0 && looksLikePinExtension(r)) {
    r.readU32(); // contFlag
    r.readU32(); // reserved
    pinsExt = [];
    for (let i = 0; i < pinCount; i++) {
      pinsExt.push(loadPin(r, i !== pinCount - 1).pin);
    }
  }

  return { name, bboxMin, bboxMax, pos, angle, partType, layer, value, packageName, serial, heightMils, pins, pinsExt };
}

/** Peek ahead to detect a dual-list extension after a pin list.
 *  Returns true iff bytes at current+8 look like a valid pin record
 *  (handle ≠ 0, z1 == 0, id plausibly small). */
function looksLikePinExtension(r: TvwReader): boolean {
  const contFlag = r.peekU32(0);
  const reserved = r.peekU32(4);
  if (reserved !== 0) return false;
  if (contFlag === 0 || contFlag > 16) return false;
  if (r.peekU32(12) !== 0) return false; // z1
  if (r.peekU32(8) === 0) return false;   // handle
  if (r.peekU32(16) > 100000) return false; // id
  return true;
}

// ─── Probe/Fixture/Mysterious Block Skipping ────────────────────────────────

function skipProbeDataItem(r: TvwReader): void {
  const present = r.readBool8();
  if (present) {
    r.skip(4);  // size
    r.skip(20); // params (5 × u32)
    r.skip(4);  // color
  }
}

function skipFixtureData(r: TvwReader): void {
  r.readU32(); // p1
  r.skip(24);  // px (6 × u32)
  r.skip(3);   // flags
  const itemCount = r.readU32();
  for (let i = 0; i < itemCount; i++) {
    skipProbeDataItem(r);
  }
  const boxCount = r.readU32();
  r.readU32(); // c1
  r.skip(16);  // v1, v2 (2 × vec2)
  for (let i = 0; i < boxCount; i++) {
    r.readU8();  // tag
    r.skip(16);  // n, a, p1, p2
  }
}

function skipProbeData(r: TvwReader): void {
  skipFixtureData(r);
  r.skip(16); // v3, v4 (2 × vec2)
  const box2Count = r.readU32();
  for (let i = 0; i < box2Count; i++) {
    r.readU32(); // tag
    // b1
    r.readS32(); r.skip(16); // tag + v1 + v2
    // b2
    r.readS32(); r.skip(16);
  }
}

function skipProbe(r: TvwReader): void {
  r.readBool8(); // flag
  r.readU32();   // tag
  r.readPStr();  // name
  r.skip(4);     // size1
  r.skip(4);     // param1
  r.skip(4);     // size2
  r.skip(4);     // param2
  r.skip(4);     // size3
  r.skip(4);     // param3
  r.skip(4);     // color
  r.skip(32);    // k1,v1,k2,v2,k3,v3,k4,v4
  const hasBody = r.readBool8();
  if (hasBody) {
    skipProbeData(r);
  }
  r.readU32();   // tail.tag
  r.skip(3);     // flags 1,2,3
  r.readU8();    // p0
  r.skip(12);    // p1,p2,p3
  // b1
  r.readS32(); r.skip(16);
  // b2
  r.readS32(); r.skip(16);
}

function skipProbeRegistry(r: TvwReader): void {
  r.readU32(); // z1 = 0
  r.readU32(); // z2 = 0
  r.readU32(); // param = 4
  r.readPStr(); // name
  r.readU32(); // defaultSize
  const packCount = r.readU32();
  for (let ip = 0; ip < packCount; ip++) {
    const probeCount = r.readU32();
    for (let i = 0; i < probeCount; i++) {
      skipProbe(r);
    }
  }
}

function skipFixtureVariant(r: TvwReader): void {
  r.readPStr();  // name
  r.readPStr();  // shortName
  r.readBool8(); // flag1
  r.readBool8(); // flag2
  skipFixtureData(r);
}

function skipFixtureSetting(r: TvwReader): void {
  r.readU32();  // tag = 3
  r.readPStr(); // name
  r.readU32();  // param = 0
  const variantCount = r.readU32();
  for (let i = 0; i < variantCount; i++) {
    skipFixtureVariant(r);
  }
  r.skip(8); // workspaceSize (vec2)
}

function skipFixtureRegistry(r: TvwReader): void {
  r.readU32(); // tag1 = 0
  r.readU32(); // tag2 = 7874
  for (let i = 0; i < 8; i++) {
    r.readPStr(); // grid names
  }
  skipFixtureSetting(r); // top
  skipFixtureSetting(r); // bottom
}

function skipMysteriousBlock(r: TvwReader): void {
  r.readU32(); // p1
  r.readU32(); // p2
  r.skip(8);   // topRight (vec2)
  r.readU32(); // p3
  r.readU32(); // p4
  r.skip(2);   // flag1, flag2
  r.skip(2);   // p5, p6
  r.skip(16);  // p7x (4 × u32)
  r.skip(6);   // flags (6 bools)
  r.skip(16);  // p8, p9, p10, p11
  // p12, p13 (trailing u16) exists in LianBao-variant TVWs but not Landrex-variant.
  // Peek the next 8 bytes as (partCount, skip) and skip the u16 only if the
  // layout without it looks implausible.
  const c1 = r.peekU32(0);
  const c1skip = r.peekU32(4);
  const c2 = r.peekU32(2);
  const c2skip = r.peekU32(6);
  const plausible = (n: number, s: number) => n > 0 && n < 200000 && s >= 0 && s < 0x100;
  if (plausible(c1, c1skip)) {
    // Landrex variant: no trailing u16
  } else if (plausible(c2, c2skip)) {
    r.skip(2); // LianBao variant: consume p12, p13
  } else {
    r.skip(2); // default to eagleview layout
  }
}

// ─── Decal Skipping ─────────────────────────────────────────────────────────

export function skipDecal(r: TvwReader): void {
  r.readBool8(); // flag1
  r.readPStr();  // name
  r.skip(12);    // headerParams (3 × u32)
  r.readBool8(); // flag
  for (let i = 0; i < 3; i++) {
    const present = r.readBool8();
    if (present) {
      // load embedded sub-layer
      loadLayer(r); // just parse and discard
    }
  }
  r.readBool8(); // outlineFlag
  r.readU32();   // param
  r.readS32();   // n1
  const vertexCount = r.readU32();
  r.skip(vertexCount * 8); // outline vertices
  r.skip(8);     // params (2 × u32)
}

// ─── Net Table Recovery ─────────────────────────────────────────────────────

/** Scan forward from current position to find the net table.
 *  Looks for two identical u32 values (count, count_dup) followed by valid pstrs.
 *  Returns the position of the first pstr and the count, or null. */
function scanForNetTable(r: TvwReader): { pos: number; count: number } | null {
  const startPos = r.tell();
  const endPos = r.size() - 8;
  const view = r.getView();

  // Scan at every byte position (DataView handles unaligned reads)
  for (let p = startPos; p < endPos; p++) {
    const v1 = view.getUint32(p, true);
    const v2 = view.getUint32(p + 4, true);

    // Net count should be a matching pair in plausible range
    if (v1 !== v2 || v1 < 200 || v1 > 50000) continue;

    // Verify: read a few pstrs from p+8 and check they look like net names
    const pstrStart = p + 8;
    let np = pstrStart;
    let valid = 0;
    const maxCheck = Math.min(v1, 20);
    let ok = true;
    for (let i = 0; i < maxCheck; i++) {
      if (np >= r.size()) { ok = false; break; }
      const len = view.getUint8(np); np++;
      if (len > 60) { ok = false; break; }
      if (np + len > r.size()) { ok = false; break; }
      if (len > 0) {
        // Check if string contains only printable ASCII (net name chars)
        for (let c = 0; c < len; c++) {
          const ch = view.getUint8(np + c);
          if (ch < 0x20 || ch > 0x7E) { ok = false; break; }
        }
        if (!ok) break;
        valid++;
      }
      np += len;
    }
    if (ok && valid >= Math.min(10, maxCheck)) {
      log.parser.log(`net table scan hit at 0x${p.toString(16)}: count=${v1}, ${valid}/${maxCheck} valid names`);
      return { pos: pstrStart, count: v1 };
    }
  }
  return null;
}

// ─── Main Parse Function ────────────────────────────────────────────────────

function parseTvwBinary(buffer: ArrayBuffer): TvwBoard {
  const r = new TvwReader(buffer);

  // ─ Header
  const type = decodeString(r.readPStr());
  r.readU32(); // const1
  const customer = decodeString(r.readPStr());
  r.readPStr(); // password pstr — usually empty; non-empty on protected files (see inflex notvwpwd.py)
  const date = decodeString(r.readPStr());
  // Three trailing header pstrs (h5/h6/h7 in TVW_FORMAT.md). All known
  // working samples ship them empty, which is why eagleview and earlier
  // BoardRipper builds read them as `readBytes(3)`. NM-D355_r1.0_HT4BT
  // carries a non-empty one ("q798"), which shifts every subsequent field
  // by 4 bytes and makes the parser read layerCount=2 instead of 20.
  r.readPStr(); r.readPStr(); r.readPStr();
  r.readU32(); // size1
  r.readU32(); // size2
  r.readU32(); // size3
  const layerCount = r.readU32();

  log.parser.log(`"${type}" customer="${customer}" date="${date}" layers=${layerCount}`);

  // ─ Layers
  // On any layer-parse failure we record a placeholder, mark the parse as
  // not-clean, and BREAK out — the rest of the file (net table + probes +
  // parts) is then recovered via `scanForNetTable`. We previously tried to
  // scan forward for the next layer-header signature inside the loop, but
  // that produced false-positive matches deep inside the parts/probe data
  // (the 16-byte `00 00 00 00 [01|03] 00 00 00 02 00 00 00 01 00 00 00`
  // pattern occasionally appears as random data), which corrupted the
  // reader position and zeroed out parts on otherwise-clean files like
  // HY568. Stick to "fail fast on the layer section, recover via the
  // net-table signature".
  const layers: TvwLayer[] = [];
  let layersParsedCleanly = true;
  for (let i = 0; i < layerCount; i++) {
    const layerStart = r.tell();
    try {
      const layer = loadLayer(r);
      if (layer === null) {
        const reason = `unknown obj type at 0x${layerStart.toString(16)}`;
        layers.push({ objType: 'placeholder', name: '', layerType: 0, reason, startOffset: layerStart });
        log.parser.warn(`layer[${i}] ${reason} — stopping layer parsing, will recover via net-table scan`);
        layersParsedCleanly = false;
        break;
      }
      layers.push(layer);
      log.parser.log(`layer[${i}] "${layer.name}" type=${layer.layerType} ${layer.objType === TvwObjectType.Logic ? `pads=${(layer as TvwLogicLayer).pads.length} lines=${(layer as TvwLogicLayer).lines.length}` : `holes=${(layer as TvwThroughLayer).holes.length}`}`);
    } catch (e) {
      const reason = `parse error at 0x${r.tell().toString(16)}: ${e instanceof Error ? e.message : String(e)}`;
      log.parser.warn(`layer[${i}] ${reason}`);
      layers.push({ objType: 'placeholder', name: '', layerType: 0, reason, startOffset: layerStart });
      layersParsedCleanly = false;
      break;
    }
  }

  // ─ Net names
  const nets: string[] = [];
  if (layersParsedCleanly) {
    // Normal path: 4 zero dwords separator, then net count pair
    r.skip(16);
    const netCount = r.readU32();
    const netCount2 = r.readU32();
    if (netCount !== netCount2) {
      log.parser.warn(`net count mismatch ${netCount} vs ${netCount2}`);
    }
    for (let i = 0; i < netCount; i++) {
      nets.push(r.readPStr());
    }
  } else {
    // Recovery: scan forward for net table (matching count pair + valid pstrs)
    const found = scanForNetTable(r);
    if (found) {
      r.seek(found.pos);
      for (let i = 0; i < found.count; i++) {
        nets.push(r.readPStr());
      }
      log.parser.log(`recovered net table at 0x${found.pos.toString(16)}: ${found.count} nets`);
    } else {
      log.parser.warn(`could not locate net table after layer parse failure`);
    }
  }
  log.parser.log(`${nets.length} nets loaded`);

  // ─ Probes, fixtures, mysterious block (skip)
  try {
    skipProbeRegistry(r);
    skipFixtureRegistry(r);
    skipMysteriousBlock(r);
  } catch (e) {
    log.parser.warn(`failed to skip probe/fixture data: ${e}`);
  }

  // ─ Parts
  const parts: TvwPart[] = [];
  try {
    const partCount = r.readU32();
    r.readU32(); // skip
    log.parser.log(`loading ${partCount} parts`);
    for (let i = 0; i < partCount; i++) {
      parts.push(loadPart(r));
    }
  } catch (e) {
    log.parser.warn(`failed to parse parts at offset 0x${r.tell().toString(16)}: ${e}`);
  }

  log.parser.log(`parsed ${layers.length} layers, ${nets.length} nets, ${parts.length} parts`);

  return {
    header: { type, customer, date, layerCount },
    layers,
    nets,
    parts,
  };
}

// ─── Convert to BoardData (Butterfly Multi-Layer Layout) ────────────────────

/** Human-readable layer names — used by layer selector UI */
const LAYER_TYPE_NAMES: Record<number, string> = {
  [TvwLayerType.Document]: 'Document',
  [TvwLayerType.Top]: 'Top',
  [TvwLayerType.Bottom]: 'Bottom',
  [TvwLayerType.Signal]: 'Signal',
  [TvwLayerType.Plane]: 'Plane',
  [TvwLayerType.SolderTop]: 'SolderMask Top',
  [TvwLayerType.SolderBottom]: 'SolderMask Bot',
  [TvwLayerType.SilkTop]: 'Silkscreen Top',
  [TvwLayerType.SilkBottom]: 'Silkscreen Bot',
  [TvwLayerType.PasteTop]: 'Paste Top',
  [TvwLayerType.PasteBottom]: 'Paste Bot',
  [TvwLayerType.Drill]: 'Drill',
  [TvwLayerType.Roul]: 'Outline',
};

/** Look up net name by index, returning '' for unconnected or out-of-range */
function getNetName(nets: string[], idx: number): string {
  return idx >= 0 && idx < nets.length ? nets[idx] : '';
}

/** Returns true if this is a copper layer we want to show in butterfly */
function isCopperLayer(lt: TvwLayerType): boolean {
  return lt === TvwLayerType.Top ||
         lt === TvwLayerType.Bottom ||
         lt === TvwLayerType.Signal ||
         lt === TvwLayerType.Plane;
}

/** Determine side from layer type */
function sideFromLayerType(lt: TvwLayerType): 'top' | 'bottom' {
  return lt === TvwLayerType.Bottom ? 'bottom' : 'top';
}

/** Chain line segments into ordered polygon paths.
 *  Returns an array of Point[] paths. Uses endpoint proximity
 *  to find the next connected segment (greedy, O(n²)). */
function chainLines(lines: TvwLine[], arcs: TvwArc[]): Point[][] {
  const EPS2 = 1 * 1;  // 1 mil tolerance squared

  // Build edge list from lines + tessellated arcs
  interface Edge { a: Point; b: Point; used: boolean }
  const edges: Edge[] = [];
  for (const l of lines) {
    edges.push({ a: l.start, b: l.end, used: false });
  }
  for (const arc of arcs) {
    // Tessellate arc into 16-segment polyline
    const steps = 16;
    const startRad = arc.startAngle * Math.PI / 180;
    const sweepRad = arc.sweepAngle * Math.PI / 180;
    for (let s = 0; s < steps; s++) {
      const a1 = startRad + (sweepRad * s) / steps;
      const a2 = startRad + (sweepRad * (s + 1)) / steps;
      edges.push({
        a: { x: arc.center.x + arc.radius * Math.cos(a1), y: arc.center.y + arc.radius * Math.sin(a1) },
        b: { x: arc.center.x + arc.radius * Math.cos(a2), y: arc.center.y + arc.radius * Math.sin(a2) },
        used: false,
      });
    }
  }

  if (edges.length === 0) return [];

  const dist2 = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

  const paths: Point[][] = [];
  while (true) {
    // Find first unused edge
    const start = edges.find(e => !e.used);
    if (!start) break;
    start.used = true;
    const path: Point[] = [start.a, start.b];
    let cursor = start.b;

    // Greedily extend the chain
    let found = true;
    while (found) {
      found = false;
      let bestIdx = -1;
      let bestDist = Infinity;
      let bestFlip = false;
      for (let i = 0; i < edges.length; i++) {
        if (edges[i].used) continue;
        const dA = dist2(cursor, edges[i].a);
        const dB = dist2(cursor, edges[i].b);
        if (dA < bestDist) { bestDist = dA; bestIdx = i; bestFlip = false; }
        if (dB < bestDist) { bestDist = dB; bestIdx = i; bestFlip = true; }
      }
      if (bestIdx >= 0 && bestDist < EPS2) {
        edges[bestIdx].used = true;
        const e = edges[bestIdx];
        const next = bestFlip ? e.a : e.b;
        path.push(next);
        cursor = next;
        found = true;
      }
    }
    // Close path if endpoints are close
    if (path.length > 2 && dist2(path[0], path[path.length - 1]) < EPS2) {
      path.push(path[0]); // explicit close
    }
    paths.push(path);
  }
  return paths;
}

export function parseTVW(buffer: ArrayBuffer): BoardData {
  const tvw = parseTvwBinary(buffer);

  // Collect copper logic layers for butterfly display
  const copperLayers = tvw.layers.filter(
    (l): l is TvwLogicLayer => l.objType === TvwObjectType.Logic && isCopperLayer(l.layerType)
  );

  // Also grab drill layer
  const drillLayer = tvw.layers.find(
    (l): l is TvwThroughLayer => l.objType === TvwObjectType.Through
  );

  // Find Roul (board outline) layer — can be either Logic or Through type
  const roulLogicLayer = tvw.layers.find(
    (l): l is TvwLogicLayer => l.objType === TvwObjectType.Logic && l.layerType === TvwLayerType.Roul
  );
  const roulThroughLayer = tvw.layers.find(
    (l): l is TvwThroughLayer => l.objType === TvwObjectType.Through && l.layerType === TvwLayerType.Roul
  );

  // Compute the natural board bounds from ALL pads across layers
  const allPadPoints: Point[] = copperLayers.flatMap(l => l.pads.map(p => p.pos));
  if (drillLayer) {
    for (const hole of drillLayer.holes) allPadPoints.push(hole.pos);
  }
  const globalBounds = allPadPoints.length > 0
    ? computeBBox(allPadPoints)
    : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const { minX: globalMinX, minY: globalMinY, maxX: globalMaxX, maxY: globalMaxY } = globalBounds;

  const boardW = globalMaxX - globalMinX;
  const boardH = globalMaxY - globalMinY;

  // Build parts from TVW parts + pin-to-pad-to-net mapping
  // Stacked mode: all layers at same coordinates, tagged with layer index
  const allParts: Part[] = [];
  const allNails: Nail[] = [];

  // Build a map: layer array index → copper column index (for layer tagging)
  const layerIdxToCol = new Map<number, number>();
  for (let col = 0; col < copperLayers.length; col++) {
    const globalIdx = tvw.layers.indexOf(copperLayers[col]);
    if (globalIdx >= 0) layerIdxToCol.set(globalIdx, col);
  }

  // Find TOP and BOTTOM layer global indices — used to resolve dual-sided
  // edge-connector pin extensions (Landrex variant).
  const topLayerGlobalIdx = tvw.layers.findIndex(l => l.layerType === TvwLayerType.Top);
  const botLayerGlobalIdx = tvw.layers.findIndex(l => l.layerType === TvwLayerType.Bottom);

  // Map TVW shape type → BoardData PadShape discriminator. Shared between
  // resolvePin (per-pin shape for selection highlight) and the global
  // pads[] extraction (pad-layer rendering). Round → 'round' so BGA balls
  // don't get squared-off halos under each pin sprite.
  const tvwShapeToPadShape = (st: TvwShapeType | undefined): Pad['shape'] => {
    switch (st) {
      case TvwShapeType.Round:     return 'round';
      case TvwShapeType.Rect:      return 'rect';
      case TvwShapeType.RoundRect: return 'roundrect';
      case TvwShapeType.Poly:      return 'poly';
      default: return undefined;
    }
  };

  /** AABB of a TVW shape (D-code rect/round) at the given centre. For
   *  non-axis rotations the AABB is widened to the rotated rect's extent.
   *  Returns null if the shape is missing or zero-sized. Shared between the
   *  per-pin `padBounds` and the global `pads[]` extraction so the
   *  pin-selection highlight matches the rendered pad rectangle exactly. */
  const computePadBounds = (cx: number, cy: number, shape: TvwShape | null): BBox | null => {
    if (!shape || shape.width <= 0 || shape.height <= 0) return null;
    let halfW = shape.width / 2;
    let halfH = shape.height / 2;
    if (shape.turn !== 0) {
      const rad = shape.turn * Math.PI / 180;
      const c = Math.abs(Math.cos(rad));
      const s = Math.abs(Math.sin(rad));
      halfW = (c * shape.width + s * shape.height) / 2;
      halfH = (s * shape.width + c * shape.height) / 2;
    }
    return { minX: cx - halfW, minY: cy - halfH, maxX: cx + halfW, maxY: cy + halfH };
  };

  const resolvePin = (tvwPin: TvwPin, padLayer: TvwLayer, side: 'top' | 'bottom'): Pin | null => {
    const pads = padLayer.objType === TvwObjectType.Logic ? (padLayer as TvwLogicLayer).pads : [];
    const padIdx = Math.floor(tvwPin.handle / 8);
    const pad = padIdx >= 0 && padIdx < pads.length ? pads[padIdx] : null;
    if (!pad) return null;
    const netName = getNetName(tvw.nets, pad.net);
    const rawRadius = pad.shapeRef ? Math.max(pad.shapeRef.width, pad.shapeRef.height) / 2 : 15;
    const radius = Math.min(Math.max(rawRadius, 5), MAX_PIN_RADIUS);
    const padBounds = computePadBounds(pad.pos.x, pad.pos.y, pad.shapeRef);
    // Shape info mirrors what we emit on board.pads so the selection
    // highlight uses the same primitive (round → circle, roundrect →
    // rounded rect, etc.) instead of the AABB rectangle.
    const padShape = tvwShapeToPadShape(pad.shapeRef?.type);
    return {
      name: tvwPin.name,
      number: String(tvwPin.id),
      position: { x: pad.pos.x, y: pad.pos.y },
      radius,
      side,
      net: netName,
      ...(padBounds ? { padBounds } : {}),
      ...(padShape ? { padShape } : {}),
      ...(pad.shapeRef ? {
        padWidth: pad.shapeRef.width,
        padHeight: pad.shapeRef.height,
        ...(pad.shapeRef.turn !== 0 ? { padAngleDeg: pad.shapeRef.turn } : {}),
      } : {}),
    };
  };

  // Place parts — no offset, all layers stacked at native coordinates
  for (const tvwPart of tvw.parts) {
    const col = layerIdxToCol.get(tvwPart.layer);
    if (col === undefined) continue; // part on non-copper layer (silk, mask, etc.)

    const layer = copperLayers[col];
    const side = sideFromLayerType(layer.layerType);
    const oppositeSide: 'top' | 'bottom' = side === 'top' ? 'bottom' : 'top';
    const oppositeLayerGlobalIdx = side === 'top' ? botLayerGlobalIdx : topLayerGlobalIdx;

    const padLayer = tvw.layers[tvwPart.layer];

    const primaryPins: Pin[] = [];
    for (const tvwPin of tvwPart.pins) {
      const p = resolvePin(tvwPin, padLayer, side);
      if (p) primaryPins.push(p);
      else log.parser.log(`pin "${tvwPin.name}" handle=${tvwPin.handle} not found in primary layer`);
    }

    // Extension pins (dual-sided edge connectors) — resolve in the opposite layer
    const extPins: Pin[] = [];
    if (tvwPart.pinsExt && oppositeLayerGlobalIdx >= 0) {
      const oppLayer = tvw.layers[oppositeLayerGlobalIdx];
      for (const tvwPin of tvwPart.pinsExt) {
        const p = resolvePin(tvwPin, oppLayer, oppositeSide);
        if (p) extPins.push(p);
      }
    }

    if (primaryPins.length === 0 && extPins.length === 0) continue;

    const cx = tvwPart.pos.x;
    const cy = tvwPart.pos.y;
    const origin: Point = { x: cx, y: cy };

    // Pack source-format metadata for the Component Info panel. Empty strings
    // and zero-height are dropped so the UI only renders fields that carry
    // information.
    const meta: NonNullable<Part['meta']> = {};
    if (tvwPart.value) meta.value = tvwPart.value;
    if (tvwPart.packageName) meta.package = tvwPart.packageName;
    if (tvwPart.serial) meta.serial = tvwPart.serial;
    if (tvwPart.heightMils > 0) meta.heightMils = tvwPart.heightMils;
    if (tvwPart.angle !== 0) meta.angleDeg = tvwPart.angle;
    const ptName = TVW_PART_TYPE_NAMES[tvwPart.partType];
    if (ptName && tvwPart.partType !== 0xFFFFFFFF) meta.partType = ptName;
    const hasMeta = Object.keys(meta).length > 0;

    // Primary side
    if (primaryPins.length > 0) {
      allParts.push({
        name: tvwPart.name,
        side,
        type: 'smd',
        origin,
        pins: primaryPins,
        bounds: computeBBox(primaryPins.map(p => p.position)),
        layer: col,
        ...(hasMeta ? { meta } : {}),
      });
    }

    // Opposite side (edge-connector extension) — emit as a separate part instance
    if (extPins.length > 0) {
      const oppCol = layerIdxToCol.get(oppositeLayerGlobalIdx);
      allParts.push({
        name: tvwPart.name,
        side: oppositeSide,
        type: 'smd',
        origin,
        pins: extPins,
        bounds: computeBBox(extPins.map(p => p.position)),
        ...(hasMeta ? { meta } : {}),
        layer: oppCol ?? col,
      });
    }
  }

  // Inner copper layers: show pads as nails (test-point-like)
  for (let col = 0; col < copperLayers.length; col++) {
    const layer = copperLayers[col];
    const isTopOrBottom = layer.layerType === TvwLayerType.Top || layer.layerType === TvwLayerType.Bottom;
    if (isTopOrBottom) continue;

    const side = sideFromLayerType(layer.layerType);
    for (const pad of layer.pads) {
      const netName = getNetName(tvw.nets, pad.net);
      if (!netName) continue;
      allNails.push({
        position: { x: pad.pos.x, y: pad.pos.y },
        side,
        net: netName,
      });
    }
  }

  // Board outline — prefer Roul layer geometry, fall back to bounding rectangle
  let outlinePoints: Point[] = [];

  // Try Roul Through layer (slots = line segments forming the outline)
  if (roulThroughLayer && roulThroughLayer.slots.length > 0) {
    // Convert slots to TvwLine-compatible edges for chainLines
    const slotLines: TvwLine[] = roulThroughLayer.slots.map(s => ({
      net: s.net, dcode: 0, start: s.start, end: s.end,
    }));
    const paths = chainLines(slotLines, []);
    for (let i = 0; i < paths.length; i++) {
      if (i > 0) outlinePoints.push({ x: NaN, y: NaN });
      outlinePoints.push(...paths[i]);
    }
    log.parser.log(`outline from Roul Through layer: ${roulThroughLayer.slots.length} slots → ${paths.length} paths`);
  }

  // Try Roul Logic layer (lines + arcs)
  if (outlinePoints.length === 0 && roulLogicLayer && (roulLogicLayer.lines.length > 0 || roulLogicLayer.arcs.length > 0)) {
    const paths = chainLines(roulLogicLayer.lines, roulLogicLayer.arcs);
    for (let i = 0; i < paths.length; i++) {
      if (i > 0) outlinePoints.push({ x: NaN, y: NaN });
      outlinePoints.push(...paths[i]);
    }
    log.parser.log(`outline from Roul Logic layer: ${roulLogicLayer.lines.length} lines, ${roulLogicLayer.arcs.length} arcs → ${paths.length} paths`);
  }

  // Sanitize outline: discard points far outside content bounds (corrupted Roul data).
  // Use 3× content extent as the plausible outline limit.
  if (outlinePoints.length > 0 && allPadPoints.length > 0) {
    const OUTLINE_SANITY = 3;
    const extentX = (globalMaxX - globalMinX) * OUTLINE_SANITY;
    const extentY = (globalMaxY - globalMinY) * OUTLINE_SANITY;
    const limMinX = globalMinX - extentX;
    const limMaxX = globalMaxX + extentX;
    const limMinY = globalMinY - extentY;
    const limMaxY = globalMaxY + extentY;
    const before = outlinePoints.length;
    outlinePoints = outlinePoints.filter(p =>
      isNaN(p.x) || (p.x >= limMinX && p.x <= limMaxX && p.y >= limMinY && p.y <= limMaxY)
    );
    // Remove leading/trailing/consecutive NaN separators left by filtering
    while (outlinePoints.length > 0 && isNaN(outlinePoints[0].x)) outlinePoints.shift();
    while (outlinePoints.length > 0 && isNaN(outlinePoints[outlinePoints.length - 1].x)) outlinePoints.pop();
    for (let i = outlinePoints.length - 1; i > 0; i--) {
      if (isNaN(outlinePoints[i].x) && isNaN(outlinePoints[i - 1].x)) outlinePoints.splice(i, 1);
    }
    if (before !== outlinePoints.length) {
      log.parser.warn(`outline sanitized: removed ${before - outlinePoints.length} out-of-bounds points`);
    }
  }

  if (outlinePoints.length === 0) {
    // Fallback: rectangle from pad bounds
    const ox = globalMinX - OUTLINE_MARGIN;
    const oy = globalMinY - OUTLINE_MARGIN;
    const ew = boardW + OUTLINE_MARGIN * 2;
    const eh = boardH + OUTLINE_MARGIN * 2;
    outlinePoints = [
      { x: ox, y: oy },
      { x: ox + ew, y: oy },
      { x: ox + ew, y: oy + eh },
      { x: ox, y: oy + eh },
      { x: ox, y: oy },
    ];
  }

  // Add drill layer nails + vias
  const allVias: Via[] = [];
  if (drillLayer) {
    for (const hole of drillLayer.holes) {
      const netName = getNetName(tvw.nets, hole.net);
      allNails.push({
        position: { x: hole.pos.x, y: hole.pos.y },
        side: 'top',
        net: netName,
      });
      const diameter = hole.toolIndex < drillLayer.toolSizes.length
        ? drillLayer.toolSizes[hole.toolIndex]
        : 10;
      allVias.push({
        position: { x: hole.pos.x, y: hole.pos.y },
        diameter: Math.max(diameter, 5),
        net: netName,
        layers: [], // resolved at scene build time via trace endpoint proximity
      });
    }
  }

  // Board bounds: from outline if available, else from pads
  const validOutlinePts = outlinePoints.filter(p => !isNaN(p.x));
  const allBounds: BBox = validOutlinePts.length > 2
    ? computeBBox(validOutlinePts)
    : {
        minX: globalMinX - OUTLINE_MARGIN,
        minY: globalMinY - OUTLINE_MARGIN,
        maxX: globalMaxX + OUTLINE_MARGIN,
        maxY: globalMaxY + OUTLINE_MARGIN,
      };

  // Build net map from parts, then ensure nail-only nets are also registered
  const nets = buildNets(allParts);
  for (const nail of allNails) {
    if (nail.net && !nets.has(nail.net)) {
      nets.set(nail.net, { name: nail.net, pinIndices: [] });
    }
  }

  // Convert TVW lines + arcs from copper layers into traces — tagged with layer index
  const allTraces: Trace[] = [];
  for (let col = 0; col < copperLayers.length; col++) {
    const layer = copperLayers[col];

    for (const line of layer.lines) {
      const shape = resolveShape(layer.shapes, line.dcode);
      const width = shape ? Math.max(shape.width, shape.height) : 5;

      allTraces.push({
        start: { x: line.start.x, y: line.start.y },
        end: { x: line.end.x, y: line.end.y },
        width,
        net: getNetName(tvw.nets, line.net),
        layer: col,
      });
    }

    // Tessellate arcs into straight-line trace segments (16 segments per arc)
    for (const arc of layer.arcs) {
      const shape = resolveShape(layer.shapes, arc.dcode);
      const width = shape ? Math.max(shape.width, shape.height) : 5;
      const net = getNetName(tvw.nets, arc.net);
      const steps = 16;
      const startRad = arc.startAngle * Math.PI / 180;
      const sweepRad = arc.sweepAngle * Math.PI / 180;
      for (let s = 0; s < steps; s++) {
        const a1 = startRad + (sweepRad * s) / steps;
        const a2 = startRad + (sweepRad * (s + 1)) / steps;
        allTraces.push({
          start: { x: arc.center.x + arc.radius * Math.cos(a1), y: arc.center.y + arc.radius * Math.sin(a1) },
          end:   { x: arc.center.x + arc.radius * Math.cos(a2), y: arc.center.y + arc.radius * Math.sin(a2) },
          width,
          net,
          layer: col,
        });
      }
    }
  }

  // Build layer labels.
  //
  // Indices 0..copperLayers.length-1 must stay aligned with the `trace.layer`
  // column index (renderer reads layerNames[trace.layer]). After that we
  // append other parsed layers that actually carry geometry — silkscreen,
  // soldermask, paste, drill, roul. Empty Document/placeholder layers are
  // skipped: they're cds2f-export padding with zero content, and listing them
  // just clutters the sidebar with un-toggleable entries.
  const hasGeometry = (l: TvwLayer): boolean => {
    if (l.objType === 'placeholder') return false;
    if (l.objType === TvwObjectType.Logic) {
      return l.shapes.length + l.pads.length + l.lines.length + l.arcs.length > 0;
    }
    return l.toolSizes.length + l.holes.length + l.slots.length > 0;
  };
  const layerNames: string[] = copperLayers.map(l => {
    const typeName = LAYER_TYPE_NAMES[l.layerType] ?? '';
    return l.name !== typeName ? `${l.name} (${typeName})` : l.name;
  });
  const copperSet = new Set<TvwLayer>(copperLayers);
  for (const l of tvw.layers) {
    if (copperSet.has(l)) continue;
    if (!hasGeometry(l)) continue;
    const typeName = LAYER_TYPE_NAMES[l.layerType] ?? `type ${l.layerType}`;
    const display = l.name && l.name !== typeName ? `${l.name} (${typeName})` : (l.name || typeName);
    layerNames.push(display);
  }

  // ── Silkscreen ──
  // Convert silkscreen-layer lines (and tessellated arcs) into per-side
  // SilkscreenPath entries that the renderer's silkscreen overlay knows how
  // to draw. Each line is its own 2-point path; arcs are tessellated to 16
  // segments. Side comes from the layer type (SilkTop=7 → 'top', SilkBot=8 →
  // 'bottom'). The renderer toggles visibility via `showSilkscreen`.
  const silkscreenPaths: SilkscreenPath[] = [];
  for (const layer of tvw.layers) {
    if (layer.objType !== TvwObjectType.Logic) continue;
    if (layer.layerType !== TvwLayerType.SilkTop && layer.layerType !== TvwLayerType.SilkBottom) continue;
    const side: 'top' | 'bottom' = layer.layerType === TvwLayerType.SilkTop ? 'top' : 'bottom';
    for (const ln of layer.lines) {
      silkscreenPaths.push({ side, points: [{ x: ln.start.x, y: ln.start.y }, { x: ln.end.x, y: ln.end.y }] });
    }
    for (const arc of layer.arcs) {
      const steps = 16;
      const startRad = arc.startAngle * Math.PI / 180;
      const sweepRad = arc.sweepAngle * Math.PI / 180;
      const pts: Point[] = [];
      for (let s = 0; s <= steps; s++) {
        const a = startRad + sweepRad * (s / steps);
        pts.push({ x: arc.center.x + arc.radius * Math.cos(a), y: arc.center.y + arc.radius * Math.sin(a) });
      }
      silkscreenPaths.push({ side, points: pts });
    }
  }

  // ── Pads ──
  // Real copper pad rectangles, one entry per pad on the TOP and BOTTOM
  // copper layers. The shape's width × height comes from the D-code table;
  // for non-axis-aligned rotations the AABB is widened to the rotated rect's
  // extent. Inner copper-layer pads are skipped — they'd just render as
  // stacked dots at the same coords as the TOP layer pads (TVW butterfly
  // mode keeps all layers aligned at native coords).
  //
  // Each pad is tagged with `attached: true` if its center coincides with a
  // component pin (sub-mil tolerance via 2-decimal coord rounding) and
  // `attached: false` otherwise. The unattached set is dominated by GND
  // stitching pads, power-rail tie-downs, and mounting-hole pads — the
  // renderer routes them to a separate, default-OFF visibility layer.
  //
  // We additionally exclude pins from "passive copper parts" — single-pin
  // GND parts whose `partType` is `Mechanical` or unset — when building the
  // pin-coord set. Those parts model bare copper features (mounting holes
  // like H11..H32, shield pads like SH9..SH19) rather than real components,
  // so their large GND-net pads visually behave like copper drops and the
  // user expects them to follow the Copper-drops toggle. Real GND test
  // points (partType=Test Point) are preserved as attached.
  const isPassiveCopperPart = (part: Part): boolean => {
    if (part.pins.length !== 1) return false;
    if (!part.pins[0].net.toUpperCase().includes('GND')) return false;
    const pt = part.meta?.partType;
    return pt === 'Mechanical' || !pt;
  };
  const pinCoordKeys = new Set<string>();
  const coordKey = (x: number, y: number): string => `${x.toFixed(2)},${y.toFixed(2)}`;
  for (const part of allParts) {
    if (isPassiveCopperPart(part)) continue;
    for (const pin of part.pins) pinCoordKeys.add(coordKey(pin.position.x, pin.position.y));
  }
  const padRects: Pad[] = [];
  for (const layer of tvw.layers) {
    if (layer.objType !== TvwObjectType.Logic) continue;
    if (layer.layerType !== TvwLayerType.Top && layer.layerType !== TvwLayerType.Bottom) continue;
    const side: 'top' | 'bottom' = layer.layerType === TvwLayerType.Top ? 'top' : 'bottom';
    for (const pad of layer.pads) {
      const bounds = computePadBounds(pad.pos.x, pad.pos.y, pad.shapeRef);
      if (!bounds) continue;
      const netName = getNetName(tvw.nets, pad.net);
      const attached = pinCoordKeys.has(coordKey(pad.pos.x, pad.pos.y));
      const shape = tvwShapeToPadShape(pad.shapeRef?.type);
      padRects.push({
        bounds,
        side,
        attached,
        ...(netName ? { net: netName } : {}),
        ...(shape ? { shape } : {}),
        ...(pad.shapeRef ? {
          width: pad.shapeRef.width,
          height: pad.shapeRef.height,
          ...(pad.shapeRef.turn !== 0 ? { angleDeg: pad.shapeRef.turn } : {}),
        } : {}),
      });
    }
  }

  const board: BoardData = {
    format: 'TVW',
    outline: outlinePoints,
    parts: allParts,
    nails: allNails,
    nets,
    bounds: allBounds,
    traces: allTraces.length > 0 ? allTraces : undefined,
    vias: allVias.length > 0 ? allVias : undefined,
    silkscreen: silkscreenPaths.length > 0 ? silkscreenPaths : undefined,
    pads: padRects.length > 0 ? padRects : undefined,
    layerNames,
  };

  log.parser.log(`TVW→BoardData: ${allParts.length} parts, ${allNails.length} nails, ${board.nets.size} nets, ${copperLayers.length}+${drillLayer ? 1 : 0} layers, ${silkscreenPaths.length} silk paths, ${padRects.length} pad rects`);

  // BOM/revision detection — TVW writers (Tebo-ictview / Landrex) often
  // accumulate every BOM revision into one component list, with multiple
  // refdes occupying the same footprint. The detector groups overlapping
  // parts into per-revision sets and exposes them via the Revisions tab.
  // No-op when no overlap pattern is found. See detect-revisions.ts for
  // the heuristics + the rationale for keeping this TVW-local for now.
  detectPositionOverlapRevisions(board);

  return board;
}

// ─── Debug: Per-Layer PNG Export ────────────────────────────────────────────

/** Debug helper: render every parsed layer (copper, silkscreen, mask, paste,
 *  drill, etc.) into its own PNG so each layer's geometry can be visually
 *  inspected. Returns one entry per non-empty parsed layer with a Blob URL.
 *  Caller is responsible for revoking the URLs.
 *
 *  This bypasses the BoardData converter (which only forwards copper-layer
 *  traces) and walks the raw `TvwBoard` directly — that's the whole point of
 *  the export, since silkscreen/mask geometry is otherwise not visible. */
export interface TvwLayerImage {
  index: number;
  name: string;
  layerType: number;
  layerTypeName: string;
  shapeCount: number;
  padCount: number;
  lineCount: number;
  arcCount: number;
  holeCount: number;
  slotCount: number;
  blob: Blob;
}

export async function debugRenderTvwLayersToPng(buffer: ArrayBuffer): Promise<TvwLayerImage[]> {
  const tvw = parseTvwBinary(buffer);

  // Compute shared bounds across every layer with geometry, so each PNG uses
  // the same coordinate frame and they're directly visually comparable.
  const allPts: Point[] = [];
  for (const l of tvw.layers) {
    if (l.objType === 'placeholder') continue;
    if (l.objType === TvwObjectType.Logic) {
      for (const p of l.pads) allPts.push(p.pos);
      for (const ln of l.lines) { allPts.push(ln.start); allPts.push(ln.end); }
      for (const a of l.arcs) {
        allPts.push({ x: a.center.x - a.radius, y: a.center.y - a.radius });
        allPts.push({ x: a.center.x + a.radius, y: a.center.y + a.radius });
      }
    } else {
      for (const h of l.holes) allPts.push(h.pos);
      for (const s of l.slots) { allPts.push(s.start); allPts.push(s.end); }
    }
  }
  if (allPts.length === 0) return [];

  const bbox = computeBBox(allPts);
  const PAD = 50;             // mils of padding around the geometry
  const TARGET_W = 2048;      // PNG width in pixels
  const w = (bbox.maxX - bbox.minX) + PAD * 2;
  const h = (bbox.maxY - bbox.minY) + PAD * 2;
  const scale = TARGET_W / w;
  const pxW = TARGET_W;
  const pxH = Math.max(64, Math.ceil(h * scale));
  const tx = (mx: number) => (mx - bbox.minX + PAD) * scale;
  // Y-axis is flipped: PCB coords have Y growing up, image Y grows down
  const ty = (my: number) => pxH - (my - bbox.minY + PAD) * scale;

  const images: TvwLayerImage[] = [];

  const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
    new Promise((resolve, reject) =>
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png'));

  for (let i = 0; i < tvw.layers.length; i++) {
    const layer = tvw.layers[i];
    if (layer.objType === 'placeholder') continue;

    let shapeCount = 0, padCount = 0, lineCount = 0, arcCount = 0, holeCount = 0, slotCount = 0;
    if (layer.objType === TvwObjectType.Logic) {
      shapeCount = layer.shapes.length;
      padCount = layer.pads.length;
      lineCount = layer.lines.length;
      arcCount = layer.arcs.length;
    } else {
      holeCount = layer.holes.length;
      slotCount = layer.slots.length;
    }
    if (shapeCount + padCount + lineCount + arcCount + holeCount + slotCount === 0) continue;

    const canvas = document.createElement('canvas');
    canvas.width = pxW;
    canvas.height = pxH;
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, pxW, pxH);

    // Draw a faint board outline rectangle for spatial reference
    ctx.strokeStyle = '#2a2a2a';
    ctx.lineWidth = 1;
    ctx.strokeRect(tx(bbox.minX), ty(bbox.maxY), (bbox.maxX - bbox.minX) * scale, (bbox.maxY - bbox.minY) * scale);

    if (layer.objType === TvwObjectType.Logic) {
      // Pads
      ctx.fillStyle = '#ff5050';
      for (const p of layer.pads) {
        const shape = resolveShape(layer.shapes, p.dcode);
        const r = shape ? Math.max(shape.width, shape.height) / 2 * scale : 1.5;
        ctx.beginPath();
        ctx.arc(tx(p.pos.x), ty(p.pos.y), Math.max(r, 1), 0, Math.PI * 2);
        ctx.fill();
      }
      // Lines
      ctx.strokeStyle = '#80ff80';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (const ln of layer.lines) {
        ctx.moveTo(tx(ln.start.x), ty(ln.start.y));
        ctx.lineTo(tx(ln.end.x), ty(ln.end.y));
      }
      ctx.stroke();
      // Arcs (tessellated to 32 segments each — Canvas2D arcs would mis-render
      // with the flipped Y axis if we used ctx.arc directly).
      ctx.strokeStyle = '#ffff80';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      for (const arc of layer.arcs) {
        const startRad = arc.startAngle * Math.PI / 180;
        const sweepRad = arc.sweepAngle * Math.PI / 180;
        const steps = 32;
        for (let s = 0; s <= steps; s++) {
          const a = startRad + sweepRad * (s / steps);
          const px = tx(arc.center.x + arc.radius * Math.cos(a));
          const py = ty(arc.center.y + arc.radius * Math.sin(a));
          if (s === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
    } else {
      // Drill holes
      ctx.fillStyle = '#80a0ff';
      for (const hole of layer.holes) {
        const sz = layer.toolSizes[hole.toolIndex] ?? 5;
        ctx.beginPath();
        ctx.arc(tx(hole.pos.x), ty(hole.pos.y), Math.max(sz / 2 * scale, 1.5), 0, Math.PI * 2);
        ctx.fill();
      }
      // Slots (drawn as thick lines)
      ctx.strokeStyle = '#a0c0ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const s of layer.slots) {
        ctx.moveTo(tx(s.start.x), ty(s.start.y));
        ctx.lineTo(tx(s.end.x), ty(s.end.y));
      }
      ctx.stroke();
    }

    // Caption: layer name + element counts in the top-left corner
    const layerTypeName = LAYER_TYPE_NAMES[layer.layerType] ?? `type ${layer.layerType}`;
    ctx.fillStyle = '#e0e0e0';
    ctx.font = '20px monospace';
    ctx.textBaseline = 'top';
    const labelLine1 = `[${i}] ${layer.name || '(unnamed)'} — ${layerTypeName}`;
    const labelLine2 = layer.objType === TvwObjectType.Logic
      ? `shapes=${shapeCount} pads=${padCount} lines=${lineCount} arcs=${arcCount}`
      : `holes=${holeCount} slots=${slotCount} tools=${layer.toolSizes.length}`;
    ctx.fillText(labelLine1, 12, 12);
    ctx.fillText(labelLine2, 12, 36);

    const blob = await canvasToBlob(canvas);
    images.push({
      index: i,
      name: layer.name || `layer_${i}`,
      layerType: layer.layerType,
      layerTypeName,
      shapeCount, padCount, lineCount, arcCount, holeCount, slotCount,
      blob,
    });
  }

  return images;
}
