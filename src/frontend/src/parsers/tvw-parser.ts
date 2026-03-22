/**
 * TVW (Teboview) binary board view parser.
 *
 * Ported from eagleview by Pavel Kovalenko (MIT)
 * https://github.com/nitrocaster/eagleview
 *
 * Format: binary little-endian, Pascal strings (u8 length + data),
 * Fixed32 coordinates (raw / 100 = mils), position-dependent string cipher.
 */

import type { BoardData, Part, Pin, Net, Point, BBox, Nail, Trace, Via } from './types';
import { computeBBox, buildNets } from './types';

const textDecoder = new TextDecoder('utf-8');
const TVW_DEBUG = false;

/** Outline margin around each butterfly column (mils) */
const OUTLINE_MARGIN = 50;

/** Max pin radius in mils — clamps oversized thermal/connector pads */
const MAX_PIN_RADIUS = 30;

/** Padding around pin bounds for component outline (mils) */
const BOUNDS_PAD = 10;

/** Max body-to-pin-spread ratio — prevents oversized outlines on small passives */
const BOUNDS_CLAMP_RATIO = 1.2;

/** Minimum component body dimension in mils (for single-pin or zero-spread parts) */
const BOUNDS_MIN_SIZE = 30;

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

const enum TvwLayerType {
  Document = 0,
  Top = 1,
  Bottom = 2,
  Signal = 3,
  Plane = 4,
  SolderTop = 5,
  SolderBottom = 6,
  SilkTop = 7,
  SilkBottom = 8,
  PasteTop = 9,
  PasteBottom = 10,
  Drill = 11,
  Roul = 12,
}

const enum TvwObjectType {
  Through = 1,
  Logic = 3,
}

const enum TvwShapeType {
  Round = 0,
  Rect = 1,
  RoundRect = 3,
  Poly = 5,
}

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
  objType: TvwObjectType.Logic;
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
  objType: TvwObjectType.Through;
  name: string;
  layerType: TvwLayerType;
  toolSizes: number[];  // drill diameters in mils
  holes: TvwDrillHole[];
  slots: TvwDrillSlot[];
}

type TvwLayer = TvwLogicLayer | TvwThroughLayer;

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
  pins: TvwPin[];
}

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

function detectObjectType(r: TvwReader): TvwObjectType {
  for (let i = 0; i < 4; i++) {
    const type = r.readU32();
    if (type === TvwObjectType.Through || type === TvwObjectType.Logic) return type;
  }
  throw new Error(`TVW: could not detect object type at offset 0x${(r.tell() - 16).toString(16)}`);
}

function readLayerHeader(r: TvwReader): { name: string; initialName: string; path: string; layerType: TvwLayerType; padColor: number; lineColor: number } {
  const magic0 = r.readU32(); // expected: 2
  const magic1 = r.readU32(); // expected: 1
  if (magic0 !== 2 || magic1 !== 1) {
    console.warn(`TVW: unexpected layer header magic ${magic0}/${magic1} at offset 0x${(r.tell() - 8).toString(16)}`);
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
  const shapes: TvwShape[] = [];
  // Two termination styles:
  //   1. Sentinel: marker == 0 → consume 4 bytes, stop
  //   2. End entry: marker == 1, w == 0 → consume 12 bytes (marker+w+h), stop
  // After termination, pad count follows directly (no separate flag+markers).
  const safetyLimit = maxDCode + 10;
  for (let i = 0; i < safetyLimit; i++) {
    const marker = r.readU32();
    if (marker === 0) break; // sentinel
    // marker should be 1
    const w = r.readFixed32();
    const h = r.readFixed32();
    if (w === 0) break; // end entry (marker=1, w=0, h=x)
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
        if (TVW_DEBUG) console.warn(`TVW: unknown shape type ${shapeType}, skipping 8 bytes`);
        r.readFixed32(); r.readFixed32();
        break;
    }
    shapes.push({ type: shapeType, width: w, height: h, turn });
    if (i === safetyLimit - 1) {
      console.warn(`TVW: shape safety limit reached (maxDCode=${maxDCode}), possible parse error`);
    }
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
  // shapes loaded
  let pads: TvwPad[] = [];
  let lines: TvwLine[] = [];
  let arcs: TvwArc[] = [];

  // Pads, lines, arcs, surfaces only exist when shapes are present
  if (shapes.length > 0) {
    pads = loadPads(r, shapes);
    lines = loadLines(r);
    arcs = loadArcs(r);
    skipSurfaces(r);
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
    } else if (code === 0x0A || code === 0x0B) {
      // drill slot — line segment
      const net = r.readS32();
      r.readU32(); // tool
      const start = r.readVec2S();
      const end = r.readVec2S();
      r.readU32(); // zero
      slots.push({ net, start, end });
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

function loadLayer(r: TvwReader): TvwLayer {
  const objType = detectObjectType(r);
  const header = readLayerHeader(r);

  if (objType === TvwObjectType.Logic) {
    return loadLogicLayer(r, header);
  } else if (objType === TvwObjectType.Through) {
    return loadThroughLayer(r, header);
  }
  throw new Error(`TVW: unknown object type ${objType}`);
}

// ─── Parts Parsing ──────────────────────────────────────────────────────────

function loadPin(r: TvwReader): TvwPin {
  const handle = r.readU32();
  r.readU32(); // z1 = 0
  const id = r.readU32();
  const name = r.readPStr();
  r.readU32(); // z2 = 0
  return { handle, id, name };
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
  r.readS32(); // height
  const flag0 = r.readBool8();
  const value = r.readPStr();
  r.readPStr(); // toleranceP
  r.readPStr(); // toleranceN
  r.readPStr(); // desc
  if (flag0) {
    r.readPStr(); // serial
    r.readU32();  // z2 = 0
  }
  const pinCount = r.readU32();
  const layer = r.readU32();
  r.readU32(); // p2 = 0

  const pins: TvwPin[] = [];
  for (let i = 0; i < pinCount; i++) {
    pins.push(loadPin(r));
  }

  return { name, bboxMin, bboxMax, pos, angle, partType, layer, value, pins };
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
  r.skip(2);   // p12, p13
}

// ─── Decal Skipping ─────────────────────────────────────────────────────────

function skipDecal(r: TvwReader): void {
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

// ─── Main Parse Function ────────────────────────────────────────────────────

function parseTvwBinary(buffer: ArrayBuffer): TvwBoard {
  const r = new TvwReader(buffer);

  // ─ Header
  const type = decodeString(r.readPStr());
  r.readU32(); // const1
  const customer = decodeString(r.readPStr());
  r.readU8(); // const2 = 0
  const date = decodeString(r.readPStr());
  r.readBytes(3); // const3
  r.readU32(); // size1
  r.readU32(); // size2
  r.readU32(); // size3
  const layerCount = r.readU32();

  if (TVW_DEBUG) console.log(`TVW: "${type}" customer="${customer}" date="${date}" layers=${layerCount}`);

  // ─ Layers
  const layers: TvwLayer[] = [];
  for (let i = 0; i < layerCount; i++) {
    try {
      const layer = loadLayer(r);
      layers.push(layer);
      if (TVW_DEBUG) console.log(`TVW: layer[${i}] "${layer.name}" type=${layer.layerType} ${layer.objType === TvwObjectType.Logic ? `pads=${(layer as TvwLogicLayer).pads.length} lines=${(layer as TvwLogicLayer).lines.length}` : `holes=${(layer as TvwThroughLayer).holes.length}`}`);
    } catch (e) {
      console.warn(`TVW: failed to parse layer ${i} at offset 0x${r.tell().toString(16)}: ${e}`);
      break; // stop on first failure — remaining data can't be parsed reliably
    }
  }

  // ─ Skip 4 zero dwords
  r.skip(16);

  // ─ Net names
  const netCount = r.readU32();
  const netCount2 = r.readU32();
  if (netCount !== netCount2) {
    console.warn(`TVW: net count mismatch ${netCount} vs ${netCount2}`);
  }
  const nets: string[] = [];
  for (let i = 0; i < netCount; i++) {
    nets.push(r.readPStr());
  }
  if (TVW_DEBUG) console.log(`TVW: ${nets.length} nets loaded`);

  // ─ Probes, fixtures, mysterious block (skip)
  try {
    skipProbeRegistry(r);
    skipFixtureRegistry(r);
    skipMysteriousBlock(r);
  } catch (e) {
    console.warn(`TVW: failed to skip probe/fixture data: ${e}`);
  }

  // ─ Parts
  const parts: TvwPart[] = [];
  try {
    const partCount = r.readU32();
    r.readU32(); // skip
    if (TVW_DEBUG) console.log(`TVW: loading ${partCount} parts`);
    for (let i = 0; i < partCount; i++) {
      parts.push(loadPart(r));
    }
  } catch (e) {
    console.warn(`TVW: failed to parse parts at offset 0x${r.tell().toString(16)}: ${e}`);
  }

  if (TVW_DEBUG) console.log(`TVW: parsed ${layers.length} layers, ${nets.length} nets, ${parts.length} parts`);

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

  // Place parts — no offset, all layers stacked at native coordinates
  for (const tvwPart of tvw.parts) {
    const col = layerIdxToCol.get(tvwPart.layer);
    if (col === undefined) continue; // part on non-copper layer (silk, mask, etc.)

    const layer = copperLayers[col];
    const side = sideFromLayerType(layer.layerType);

    const pins: Pin[] = [];
    const padLayer = tvw.layers[tvwPart.layer];
    const pads = padLayer.objType === TvwObjectType.Logic ? (padLayer as TvwLogicLayer).pads : [];

    for (const tvwPin of tvwPart.pins) {
      const padIdx = Math.floor(tvwPin.handle / 8);
      const pad = padIdx >= 0 && padIdx < pads.length ? pads[padIdx] : null;
      if (!pad) {
        if (TVW_DEBUG) console.log(`TVW: pin "${tvwPin.name}" handle=${tvwPin.handle} → padIdx=${padIdx} not found in ${pads.length} pads`);
        continue;
      }

      const netName = getNetName(tvw.nets, pad.net);
      const rawRadius = pad.shapeRef ? Math.max(pad.shapeRef.width, pad.shapeRef.height) / 2 : 15;
      const radius = Math.min(Math.max(rawRadius, 5), MAX_PIN_RADIUS);

      pins.push({
        name: tvwPin.name,
        number: String(tvwPin.id),
        position: { x: pad.pos.x, y: pad.pos.y },
        radius,
        side,
        net: netName,
      });
    }

    if (pins.length === 0) continue;

    const pinBBox = computeBBox(pins.map(p => p.position));
    const nativeW = tvwPart.bboxMax.x - tvwPart.bboxMin.x;
    const nativeH = tvwPart.bboxMax.y - tvwPart.bboxMin.y;
    const cx = tvwPart.pos.x;
    const cy = tvwPart.pos.y;
    const pinW = pinBBox.maxX - pinBBox.minX;
    const pinH = pinBBox.maxY - pinBBox.minY;
    const bounds: BBox = {
      minX: Math.min(cx - nativeW / 2, pinBBox.minX - BOUNDS_PAD),
      minY: Math.min(cy - nativeH / 2, pinBBox.minY - BOUNDS_PAD),
      maxX: Math.max(cx + nativeW / 2, pinBBox.maxX + BOUNDS_PAD),
      maxY: Math.max(cy + nativeH / 2, pinBBox.maxY + BOUNDS_PAD),
    };
    const maxW = Math.max(pinW * BOUNDS_CLAMP_RATIO, BOUNDS_MIN_SIZE);
    const maxH = Math.max(pinH * BOUNDS_CLAMP_RATIO, BOUNDS_MIN_SIZE);
    const bw = bounds.maxX - bounds.minX;
    const bh = bounds.maxY - bounds.minY;
    if (bw > maxW) {
      bounds.minX = cx - maxW / 2;
      bounds.maxX = cx + maxW / 2;
    }
    if (bh > maxH) {
      bounds.minY = cy - maxH / 2;
      bounds.maxY = cy + maxH / 2;
    }
    const origin: Point = { x: cx, y: cy };

    allParts.push({
      name: tvwPart.name,
      side,
      type: 'smd',
      origin,
      pins,
      bounds,
      layer: col,
    });
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
    if (TVW_DEBUG) console.log(`TVW: outline from Roul Through layer: ${roulThroughLayer.slots.length} slots → ${paths.length} paths`);
  }

  // Try Roul Logic layer (lines + arcs)
  if (outlinePoints.length === 0 && roulLogicLayer && (roulLogicLayer.lines.length > 0 || roulLogicLayer.arcs.length > 0)) {
    const paths = chainLines(roulLogicLayer.lines, roulLogicLayer.arcs);
    for (let i = 0; i < paths.length; i++) {
      if (i > 0) outlinePoints.push({ x: NaN, y: NaN });
      outlinePoints.push(...paths[i]);
    }
    if (TVW_DEBUG) console.log(`TVW: outline from Roul Logic layer: ${roulLogicLayer.lines.length} lines, ${roulLogicLayer.arcs.length} arcs → ${paths.length} paths`);
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

  // Convert TVW lines from copper layers into traces — tagged with layer index
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
  }

  // Build layer labels: copper columns + drill
  const layerNames: string[] = copperLayers.map(l => {
    const typeName = LAYER_TYPE_NAMES[l.layerType] ?? '';
    return l.name !== typeName ? `${l.name} (${typeName})` : l.name;
  });
  if (drillLayer) layerNames.push(drillLayer.name || 'Drill');

  const board: BoardData = {
    format: 'TVW',
    outline: outlinePoints,
    parts: allParts,
    nails: allNails,
    nets,
    bounds: allBounds,
    traces: allTraces.length > 0 ? allTraces : undefined,
    vias: allVias.length > 0 ? allVias : undefined,
    layerNames,
  };

  if (TVW_DEBUG) console.log(`TVW→BoardData: ${allParts.length} parts, ${allNails.length} nails, ${board.nets.size} nets, ${copperLayers.length}+${drillLayer ? 1 : 0} layers (stacked)`);

  return board;
}
