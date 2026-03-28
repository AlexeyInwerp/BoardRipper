/**
 * Cadence Allegro BRD Binary Parser
 *
 * Parses Cadence Allegro PCB design files (.brd) — a proprietary, undocumented
 * binary format. All knowledge here comes from community reverse engineering,
 * primarily the brd_parser project by Jeff Wheeler (MIT license).
 *
 * Supports Allegro versions 16.0 through 17.4.
 *
 * Binary structure overview:
 *   - Header (~800 bytes): magic (version), object count, linked list heads, version string
 *   - Layer map: 25 × 2 × uint32 pairs (immediately after header)
 *   - Strings table at offset 0x1200: id (u32) + null-terminated string, word-aligned
 *   - Records: sequential stream of typed records (type byte 0x01–0x3C), each with
 *     version-dependent size. Records form a serialized in-memory pointer graph.
 *
 * Coordinate system: signed 32-bit integers in internal Allegro units.
 * Divide by 100 to get mils (confirmed by comparison with known board dimensions).
 *
 * Reference: https://github.com/bernayigit/brd_parser (jeffwheeler/brd_parser)
 * See also: docs/formats/ALLEGRO_BRD_FORMAT.md
 */

import type { BoardData, Part, Pin, Nail, Point, Trace } from './types';
import { computeBBox, buildNets } from './types';
import { log } from '../store/log-store';
const dbg = log.parser;

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

/** Allegro version classes — determines struct sizes */
const AllegroVer = { V160: 0, V164: 1, V165: 2, V172: 3, V174: 4 } as const;
type AllegroVer = typeof AllegroVer[keyof typeof AllegroVer];

function detectVersion(magic: number): AllegroVer | null {
  switch (magic) {
    case 0x00130000: case 0x00130200:
      return AllegroVer.V160;
    case 0x00130402:
      return AllegroVer.V160; // V162 same struct sizes as V160
    case 0x00130C03:
      return AllegroVer.V164;
    case 0x00131003:
      return AllegroVer.V165;
    case 0x00131503: case 0x00131504:
      return AllegroVer.V165; // V166 — mostly same as V165
    case 0x00140400: case 0x00140500: case 0x00140501:
    case 0x00140502: case 0x00140600: case 0x00140700:
      return AllegroVer.V172;
    case 0x00140900: case 0x00140901: case 0x00140902:
    case 0x00140E00:
      return AllegroVer.V174;
    default:
      // Try range-based detection
      if ((magic & 0xFFFF0000) === 0x00130000) return AllegroVer.V165;
      if ((magic & 0xFFFF0000) === 0x00140000) return AllegroVer.V172;
      return null;
  }
}

function versionName(magic: number): string {
  if ((magic & 0xFFFF0000) === 0x00130000) {
    const minor = (magic >> 8) & 0xFF;
    if (minor < 4) return '16.0';
    if (minor < 0x0C) return '16.2';
    if (minor < 0x10) return '16.4';
    if (minor < 0x15) return '16.5';
    return '16.6';
  }
  if ((magic & 0xFFFF0000) === 0x00140000) {
    const minor = (magic >> 8) & 0xFF;
    if (minor < 9) return '17.2';
    return '17.4';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Record size table — empirically verified against real Allegro BRD files
// ---------------------------------------------------------------------------

/**
 * Fixed-size record sizes per version class.
 * Verified by parsing complete files (485K+ records for v16.5, 14K+ for v17.2).
 * Variable-size records (0 entries) are handled inline during parsing.
 */
function buildRecordSizes(ver: AllegroVer): number[] {
  const v17 = ver >= AllegroVer.V172;
  const v174 = ver >= AllegroVer.V174;

  const s = new Array<number>(0x3E).fill(0);

  if (v17) {
    // v17.2+ sizes — empirically verified against 43MB and 68MB files
    s[0x01] = 84;
    s[0x02] = 72;
    s[0x04] = v174 ? 24 : 20;
    s[0x05] = 72;
    s[0x06] = 40;
    s[0x07] = 48;
    s[0x08] = 32;
    s[0x09] = v174 ? 52 : 48;
    s[0x0A] = 44;
    s[0x0B] = 72;
    s[0x0C] = 72;
    s[0x0D] = v174 ? 48 : 44;
    s[0x0E] = 68;
    s[0x0F] = v174 ? 64 : 60;
    s[0x10] = v174 ? 44 : 36;
    s[0x11] = v174 ? 28 : 28;
    s[0x12] = v174 ? 32 : 28;
    s[0x14] = 36;
    s[0x15] = 44;
    s[0x16] = 44;
    s[0x17] = 44;
    s[0x1B] = 60;
    s[0x20] = v174 ? 80 : 40;
    s[0x22] = 44;
    s[0x23] = v174 ? 92 : 88;
    // x24 is VARIABLE — handled inline
    s[0x24] = 0;
    s[0x26] = v174 ? 28 : 24;
    s[0x28] = 76;
    s[0x2B] = 76;
    s[0x2C] = 44;
    s[0x2D] = 72;
    s[0x2E] = 40;
    s[0x2F] = 32;
    s[0x30] = v174 ? 56 : 52;
    s[0x32] = 84;
    s[0x33] = 76;
    s[0x34] = 36;
    s[0x37] = v174 ? 432 : 428;
    s[0x38] = v174 ? 56 : 52;
    s[0x39] = 60;
    s[0x3A] = v174 ? 20 : 16;
  } else {
    // v16.x sizes — empirically verified against 21MB file (485K records, 100% coverage)
    s[0x01] = 80;
    s[0x02] = 36;
    s[0x04] = 20;
    s[0x05] = 60;
    s[0x06] = 36;
    s[0x07] = 40;
    s[0x08] = 24;
    s[0x09] = 44;
    s[0x0A] = 68;
    s[0x0C] = 56;
    s[0x0D] = 40;
    s[0x0E] = 60;
    s[0x0F] = 56;
    s[0x10] = 32;
    s[0x11] = 24;
    s[0x12] = ver >= AllegroVer.V165 ? 28 : 24;
    s[0x14] = 32;
    s[0x15] = 40;
    s[0x16] = 40;
    s[0x17] = 40;
    s[0x1B] = 56;
    s[0x20] = 40;
    s[0x22] = 40;
    s[0x23] = ver >= AllegroVer.V164 ? 84 : 68;
    // x24 is VARIABLE — handled inline
    s[0x24] = 0;
    s[0x26] = 20;
    s[0x28] = 68;
    s[0x2B] = ver >= AllegroVer.V164 ? 72 : 64;
    s[0x2C] = 36;
    s[0x2D] = 64;
    s[0x2E] = 36;
    s[0x2F] = 32;
    s[0x30] = 44;
    s[0x32] = 76;
    s[0x33] = 72;
    s[0x34] = 32;
    s[0x37] = 428;
    s[0x38] = 64;
    s[0x39] = 60;
    s[0x3A] = 16;
  }

  return s;
}

// ---------------------------------------------------------------------------
// Binary reader
// ---------------------------------------------------------------------------

class AllegroReader {
  private view: DataView;
  private _pos: number;
  private _decoder = new TextDecoder('ascii');
  readonly size: number;

  readonly buffer: ArrayBuffer;
  constructor(buffer: ArrayBuffer) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this._pos = 0;
    this.size = buffer.byteLength;
  }

  get pos(): number { return this._pos; }
  set pos(v: number) { this._pos = v; }

  get remaining(): number { return this.size - this._pos; }

  u8(): number {
    const v = this.view.getUint8(this._pos);
    this._pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this._pos, true);
    this._pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this._pos, true);
    this._pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this._pos, true);
    this._pos += 4;
    return v;
  }

  u32At(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  u16At(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  u8At(offset: number): number {
    return this.view.getUint8(offset);
  }

  i32At(offset: number): number {
    return this.view.getInt32(offset, true);
  }

  skip(n: number): void {
    this._pos += n;
  }

  /** Read null-terminated ASCII string at current position */
  cString(): string {
    const bytes = new Uint8Array(this.buffer, this._pos);
    let end = 0;
    while (end < bytes.length && bytes[end] !== 0) end++;
    const str = this._decoder.decode(bytes.subarray(0, end));
    return str;
  }

  /** Read null-terminated string and advance past it + word padding */
  cStringAligned(): { str: string; len: number } {
    const str = this.cString();
    const rawLen = str.length + 1; // +1 for null terminator
    const padded = roundToWord(rawLen);
    this._pos += padded;
    return { str, len: padded };
  }
}

function roundToWord(len: number): number {
  return len % 4 !== 0 ? (Math.floor(len / 4) + 1) * 4 : len;
}

// ---------------------------------------------------------------------------
// Header struct
// ---------------------------------------------------------------------------

const STRINGS_OFFSET = 0x1200;

interface LinkedListPtrs {
  tail: number;
  head: number;
}

interface AllegroHeader {
  magic: number;
  objectCount: number;
  allegroVersion: string;
  maxKey: number;
  stringsCount: number;
  x27EndOffset: number;
  llX2B: LinkedListPtrs;  // footprint list
  llX1B: LinkedListPtrs;  // net list
  llX04: LinkedListPtrs;  // net/shape pairs
}

function parseHeader(r: AllegroReader): AllegroHeader {
  r.pos = 0;
  const magic = r.u32();
  // un1[4]
  r.skip(16);
  const objectCount = r.u32();
  // un2[9]
  r.skip(36);

  // We are now at offset 60 — start of linked list pointers
  // Layout: ll_x04(8), ll_x06(8), ll_x0C_2(8), ll_x0E_x28(8), ll_x14(8),
  //         ll_x1B(8), ll_x1C(8), ll_x24_x28(8), ll_unused_1(8), ll_x2B(8),
  //         ll_x03_x30(8), ll_x0A_2(8), ll_x1D_x1E_x1F(8), ll_unused_2(8),
  //         ll_x38(8), ll_x2C(8), ll_x0C(8), ll_unused_3(8),
  //         x35_start(4), x35_end(4),
  //         ll_x36(8), ll_x21(8), ll_unused_4(8), ll_x0A(8),
  //         un5(4), allegro_version[60], un6(4), max_key(4),
  //         un7[20](80), x27_end_offset(4), un8(4), strings_count(4), un9[166](664)

  // Each ll_ptrs is 8 bytes: tail(u32) + head(u32)
  const llBase = 60;

  // ll_x04 at offset 60
  const llX04: LinkedListPtrs = {
    tail: r.u32At(llBase),
    head: r.u32At(llBase + 4),
  };

  // ll_x1B at offset 60 + 5*8 = 100
  const llX1B: LinkedListPtrs = {
    tail: r.u32At(llBase + 40),
    head: r.u32At(llBase + 44),
  };

  // ll_x2B at offset 60 + 9*8 = 132
  const llX2B: LinkedListPtrs = {
    tail: r.u32At(llBase + 72),
    head: r.u32At(llBase + 76),
  };

  // Version string at fixed offset 248
  const versionOffset = 248;
  r.pos = versionOffset;
  const versionBytes = new Uint8Array(r.buffer, versionOffset, 60);
  let vEnd = 0;
  while (vEnd < 60 && versionBytes[vEnd] !== 0) vEnd++;
  const allegroVersion = new TextDecoder('ascii').decode(versionBytes.subarray(0, vEnd));

  // un6(4) + max_key(4)
  r.pos = versionOffset + 60;
  r.skip(4); // un6
  const maxKey = r.u32();

  // un7[20](80) + x27_end_offset(4) + un8(4) + strings_count(4)
  r.skip(80);
  const x27EndOffset = r.u32();
  r.skip(4); // un8
  const stringsCount = r.u32();

  return { magic, objectCount, allegroVersion, maxKey, stringsCount, x27EndOffset, llX2B, llX1B, llX04 };
}

// ---------------------------------------------------------------------------
// Strings table
// ---------------------------------------------------------------------------

function parseStrings(r: AllegroReader, count: number): Map<number, string> {
  const strings = new Map<number, string>();
  r.pos = STRINGS_OFFSET;

  for (let i = 0; i < count; i++) {
    if (r.remaining < 8) break;
    const id = r.u32();
    const { str } = r.cStringAligned();
    strings.set(id, str);
  }

  dbg.log(`Parsed ${strings.size} strings`);
  return strings;
}

// ---------------------------------------------------------------------------
// Record scanning — build key→offset map and extract data
// ---------------------------------------------------------------------------

/** Extracted data from x2D (placed symbol) records */
interface PlacedSymbol {
  key: number;
  layer: number;
  rotation: number;       // millidegrees
  x: number;
  y: number;
  instRef: number;        // key → x07 (instance)
  firstPadPtr: number;    // key → x32 (first pin)
  next: number;           // → next x2D in x2B chain
}

/** Extracted data from x07 (instance) records */
interface Instance {
  key: number;
  refdesStringRef: number; // → strings table
  ptr1: number;            // → x2D
}

/** Extracted data from x32 (symbol pin) records */
interface SymbolPin {
  key: number;
  layer: number;
  ptr1: number;  // → x04 (net/shape pair)
  ptr3: number;  // → x2B or x2D (parent component)
  ptr5: number;  // → x0D (pin definition)
  next: number;  // → next x32 or x2D/x2B (end of chain)
  coords: [number, number, number, number]; // bounding box
}

/** Extracted data from x0D (pin definition) records */
interface PinDef {
  key: number;
  strPtr: number;  // → strings table (pin name)
  coords: [number, number]; // relative to symbol
}

/** Extracted data from x1B (net) records */
interface NetRecord {
  key: number;
  netName: number; // → strings table
  next: number;    // → next x1B
}

/** Extracted data from x04 (net/shape pair) */
interface NetShapePair {
  key: number;
  netPtr: number;  // → x1B
  shapePtr: number; // → x05/x32/x33
}

/** Extracted from x28 (shape) */
interface ShapeRecord {
  key: number;
  layer: number;
  subtype: number;
  firstSegPtr: number;
  bbox: [number, number, number, number];
}

/** Extracted from x15/x16/x17 (line segments) */
interface LineSegment {
  key: number;
  next: number;
  parent: number;
  width: number;
  coords: [number, number, number, number]; // startX, startY, endX, endY
}

/** Extracted from x2A (layer names) */
interface LayerInfo {
  name: string;
  isTop: boolean;
  isBottom: boolean;
  isSignal: boolean;
  isPower: boolean;
  isInner: boolean;
}

/** Extracted from x2B (footprint) records */
interface Footprint {
  key: number;
  next: number;      // → next x2B
  ptr2: number;      // → first x2D
  coords: [number, number, number, number]; // bounding box
}

/** Extracted from x05 (composite line) records */
interface CompositeLine {
  key: number;
  layer: number;
  firstSegPtr: number;  // → x01/x15/x16/x17
}

interface ParsedRecords {
  placedSymbols: Map<number, PlacedSymbol>;
  instances: Map<number, Instance>;
  symbolPins: Map<number, SymbolPin>;
  pinDefs: Map<number, PinDef>;
  nets: Map<number, NetRecord>;
  netShapePairs: Map<number, NetShapePair>;
  shapes: Map<number, ShapeRecord>;
  lineSegments: Map<number, LineSegment>;
  layers: LayerInfo[];
  footprints: Map<number, Footprint>;
  compositeLines: Map<number, CompositeLine>;
  // Raw pointer map: key → type byte
  ptrTypes: Map<number, number>;
}

function scanRecords(
  r: AllegroReader,
  hdr: AllegroHeader,
  ver: AllegroVer,
  strings: Map<number, string>,
): ParsedRecords {
  const recordSizes = buildRecordSizes(ver);
  const v17 = ver >= AllegroVer.V172;
  const v174 = ver >= AllegroVer.V174;
  const v165 = ver >= AllegroVer.V165;
  const v164 = ver >= AllegroVer.V164;

  const result: ParsedRecords = {
    placedSymbols: new Map(),
    instances: new Map(),
    symbolPins: new Map(),
    pinDefs: new Map(),
    nets: new Map(),
    netShapePairs: new Map(),
    shapes: new Map(),
    lineSegments: new Map(),
    layers: [],
    footprints: new Map(),
    compositeLines: new Map(),
    ptrTypes: new Map(),
  };

  let totalRecords = 0;
  const VARIABLE_TYPES = new Set([0x03, 0x1C, 0x1D, 0x1E, 0x1F, 0x21, 0x24, 0x27, 0x2A, 0x31, 0x35, 0x36, 0x3B, 0x3C]);
  const isValidType = (b: number) => b >= 0x01 && b <= 0x3C && (recordSizes[b] > 0 || VARIABLE_TYPES.has(b));

  while (r.remaining > 0) {
    const t = r.u8At(r.pos);
    if (t === 0x00) {
      // Skip null padding blocks. If records resume after, continue.
      let nullEnd = r.pos;
      while (nullEnd < r.size && r.u8At(nullEnd) === 0x00) nullEnd++;
      if (nullEnd < r.size && isValidType(r.u8At(nullEnd))) {
        r.pos = nullEnd;
        continue;
      }
      break;
    }

    const recordStart = r.pos;

    // Read key (always at offset 4 for most records, but some use offset 1-3 for flags)
    // Most records: bytes 0-3 are type+flags, bytes 4-7 are key
    const key = r.u32At(r.pos + 4);
    result.ptrTypes.set(key, t);

    try {
      switch (t) {
        case 0x03: {
          // Variable size — x03 string/property container
          // v17: fixed=24, subtype at pos+16, size at pos+18
          // v16: fixed=16, subtype at pos+12, size at pos+14
          const fixedSize = v17 ? 24 : 16;
          const subtypeT = r.u8At(r.pos + (v17 ? 16 : 12));
          const subtypeSize = r.u16At(r.pos + (v17 ? 18 : 14));
          r.skip(fixedSize);

          switch (subtypeT & 0xFF) {
            case 0x65:
              break;
            case 0x64: case 0x66: case 0x67: case 0x6A:
              r.skip(4);
              break;
            case 0x6D: case 0x6E: case 0x6F: case 0x68:
            case 0x6B: case 0x71: case 0x73: case 0x78:
              r.skip(roundToWord(subtypeSize));
              break;
            case 0x69:
              r.skip(8);
              break;
            case 0x6C: {
              const sz = r.u32();
              r.skip(4 * sz);
              break;
            }
            case 0x70: case 0x74: {
              const x0 = r.u16();
              const x1 = r.u16();
              r.skip(x1 + 4 * x0);
              break;
            }
            case 0xF6:
              r.skip(80);
              break;
            default:
              // Unknown subtype — try to skip a reasonable amount
              dbg.warn(`x03 unknown subtype=0x${subtypeT.toString(16)} at ${recordStart.toString(16)}`);
              r.skip(roundToWord(subtypeSize));
              break;
          }
          break;
        }

        case 0x05: {
          // Composite line — extract layer and first segment pointer
          const size = recordSizes[0x05];
          // type(2)+subtype(1)+layer(1)=4, k(4)=8
          const layer = r.u8At(r.pos + 3);
          // First segment ptr: v16 at offset 48, v17 at offset 60
          const firstSegOffset = v17 ? 60 : 48;
          const firstSegPtr = r.u32At(r.pos + firstSegOffset);
          result.compositeLines.set(key, { key, layer, firstSegPtr });
          r.skip(size);
          break;
        }

        case 0x07: {
          // Instance — extract refdes string ref
          const size = recordSizes[0x07];
          // v16: t(4)+k(4)+un1(4)=12 + ptr1(4)=16 + un5(4)=20 + refdes(4)=24
          // v17: t(4)+k(4)+un1(4)=12 + ptr0(4)+un4(4)+un2(4)=24 + ptr1(4)=28 + refdes(4)=32
          const refdesOffset = v17 ? 28 : 20;
          const inst: Instance = {
            key,
            refdesStringRef: r.u32At(r.pos + refdesOffset),
            ptr1: r.u32At(r.pos + (v17 ? 24 : 12)),
          };
          result.instances.set(key, inst);
          r.skip(size);
          break;
        }

        case 0x0D: {
          // Pin in symbol — extract pin name string ptr
          const size = recordSizes[0x0D];
          // t(4), k(4), str_ptr(4)
          const strPtr = r.u32At(r.pos + 8);
          const cx = r.i32At(r.pos + 16);
          const cy = r.i32At(r.pos + 20);
          result.pinDefs.set(key, {
            key,
            strPtr,
            coords: [cx, cy],
          });
          r.skip(size);
          break;
        }

        case 0x04: {
          // Net/shape pair
          const size = recordSizes[0x04];
          // t(4), k(4), next(4), ptr1(4)=net, ptr2(4)=shape
          const netPtr = r.u32At(r.pos + 12);
          const shapePtr = r.u32At(r.pos + 16);
          result.netShapePairs.set(key, { key, netPtr, shapePtr });
          r.skip(size);
          break;
        }

        case 0x15: case 0x16: case 0x17: {
          // Line segments — extract coords
          const size = recordSizes[t];
          // t(4), k(4), next(4), parent(4), un3/bitmask(4), [v17: un4(4)], width(4), coords[4](16)
          const baseOff = v17 ? 24 : 20;
          const width = r.u32At(r.pos + baseOff);
          const cx0 = r.i32At(r.pos + baseOff + 4);
          const cy0 = r.i32At(r.pos + baseOff + 8);
          const cx1 = r.i32At(r.pos + baseOff + 12);
          const cy1 = r.i32At(r.pos + baseOff + 16);
          const next = r.u32At(r.pos + 8);
          const parent = r.u32At(r.pos + 12);
          result.lineSegments.set(key, {
            key, next, parent, width,
            coords: [cx0, cy0, cx1, cy1],
          });
          r.skip(size);
          break;
        }

        case 0x1B: {
          // Net
          const size = recordSizes[0x1B];
          // t(4), k(4), next(4), net_name(4)
          const netNameKey = r.u32At(r.pos + 12);
          const next = r.u32At(r.pos + 8);
          result.nets.set(key, { key, netName: netNameKey, next });
          r.skip(size);
          break;
        }

        case 0x1C: {
          // Pad definition — VARIABLE SIZE
          // v17: fixed=188, layerCount at pos+44, t13Size=36, numT13=21+lc*4, THEN +4, THEN n*280+4
          // v16: fixed=112(v165)/80(v160), layerCount at pos+50, t13Size=28, numT13=10+lc*3, THEN n*280 (NO trailing +4)
          const fixedSize = v17 ? 188 : (v165 ? 112 : 80);
          const layerCountOffset = v17 ? 44 : 50;
          const layerCount = r.u16At(r.pos + layerCountOffset);
          const n = r.u8At(r.pos + 2);

          r.skip(fixedSize);

          // Variable: layer_count × t13 sub-records
          const t13Size = v17 ? 36 : 28;
          const numT13 = v17 ? (21 + layerCount * 4) : (10 + layerCount * 3);
          r.skip(numT13 * t13Size);

          if (v17) r.skip(4);

          // Variable tail: n × 280 + trailing bytes
          if (v17) {
            r.skip(n * 280 + 4);
          } else {
            r.skip(n * 280);
          }
          break;
        }

        case 0x1D: {
          // Variable size
          // t(4), k(4), un[3](12), size_a(u16), size_b(u16) = 24
          // 24 + sizeB*(v164?56:48) + sizeA*256 + (v17?4:0)
          const sizeA = r.u16At(r.pos + 20);
          const sizeB = r.u16At(r.pos + 22);
          r.skip(24);
          r.skip(sizeB * (v164 ? 56 : 48));
          r.skip(sizeA * 256);
          if (v17) r.skip(4);
          break;
        }

        case 0x1E: {
          // Model info — variable
          // 24 + roundToWord(u32@pos+20) + (v17?4:0)
          const varSize = r.u32At(r.pos + 20);
          r.skip(24);
          r.skip(roundToWord(varSize));
          if (v17) r.skip(4);
          break;
        }

        case 0x1F: {
          // Variable
          // 28 + fSize*280 + (v174?8 : v164?4 : 4) — same for v17.2 and v16.4+
          const fSize = r.u16At(r.pos + 26);
          r.skip(28);
          r.skip(fSize * 280);
          r.skip(v174 ? 8 : 4);
          break;
        }

        case 0x21: {
          // Stackup — variable. The u32 at offset 4 IS the total record size.
          const sz21 = r.u32At(r.pos + 4);
          r.skip(sz21);
          break;
        }

        case 0x24: {
          // Variable: 52 bytes if byte[1]==0x00, else 48
          r.skip(r.u8At(r.pos + 1) === 0x00 ? 52 : 48);
          break;
        }

        case 0x27: {
          // Offset jump — the entire x27 "record" spans from here to x27_end_offset-1.
          const jt = hdr.x27EndOffset - 1;
          if (jt > r.pos && jt < r.size) {
            r.pos = jt;
          } else {
            dbg.warn('x27 jump failed, stopping parse');
            return result;
          }
          break;
        }

        case 0x2A: {
          // Layer names — variable
          // 4 + (v174?4:0) + layerSize*12 + 4
          const layerSize = r.u16At(r.pos + 2);
          r.skip(4);
          if (v174) r.skip(4);

          // Reference entries: ptr(4) + properties(4) + un1(4) = 12 bytes each (ALWAYS)
          for (let i = 0; i < layerSize; i++) {
            const ptr = r.u32At(r.pos);
            const props = r.u32At(r.pos + 4);
            const name = strings.get(ptr) ?? `Layer_${i}`;
            result.layers.push({
              name,
              isTop: !!(props & (1 << 12)),
              isBottom: !!(props & (1 << 13)),
              isSignal: !!(props & (1 << 9)),
              isPower: !!(props & (1 << 1)),
              isInner: !!(props & (1 << 2)),
            });
            r.skip(12);
          }
          // Final key
          r.skip(4);
          break;
        }

        case 0x28: {
          // Shape — extract bbox for board outline detection
          const size = recordSizes[0x28];
          const subtype = r.u8At(r.pos + 2);
          const layer = r.u8At(r.pos + 3);

          // First segment pointer at different offsets
          const firstSegOffset = v17 ? 44 : 36;
          const firstSegPtr = r.u32At(r.pos + firstSegOffset);

          // Bounding box at end of record
          const bboxOffset = size - 16;
          const bbox: [number, number, number, number] = [
            r.i32At(r.pos + bboxOffset),
            r.i32At(r.pos + bboxOffset + 4),
            r.i32At(r.pos + bboxOffset + 8),
            r.i32At(r.pos + bboxOffset + 12),
          ];

          result.shapes.set(key, { key, layer, subtype, firstSegPtr, bbox });
          r.skip(size);
          break;
        }

        case 0x2B: {
          // Footprint — extract linked list pointers and bounding box
          const size = recordSizes[0x2B];
          // t(4)+k(4)+fsr(4)+un1(4)+coords[4](16)=32
          // next at offset 36, ptr2 at offset 40 for all versions
          const next = r.u32At(r.pos + 36);
          const ptr2 = r.u32At(r.pos + 40);
          const coords: [number, number, number, number] = [
            r.i32At(r.pos + 16),
            r.i32At(r.pos + 20),
            r.i32At(r.pos + 24),
            r.i32At(r.pos + 28),
          ];
          result.footprints.set(key, { key, next, ptr2, coords });
          r.skip(size);
          break;
        }

        case 0x2D: {
          // Placed symbol — the main component record
          const size = recordSizes[0x2D];
          const layer = r.u8At(r.pos + 2);

          // Field offsets differ by version
          let rotationOffset: number, coordsOffset: number, instRefOffset: number, firstPadOffset: number, nextOffset: number;

          if (v17) {
            // v17: t(2)+layer(1)+un0(1) + k(4) + next(4) + un4(4) + un2(2)+un3(2) + un5(4) +
            //       bitmask1(4) + rotation(4) + coords[2](8) + inst_ref(4) + ptr1(4) + first_pad_ptr(4)
            nextOffset = r.pos + 8;
            rotationOffset = r.pos + 28;
            coordsOffset = r.pos + 32;
            instRefOffset = r.pos + 40;
            firstPadOffset = r.pos + 48;
          } else {
            // v16 field starts: type=0, k=4, next=8, inst_ref_16x=12, un2+un3=16,
            //   bitmask1=20, rotation=24, coords=28, ptr1=36, first_pad=40, ptr3=44,
            //   ptr4[3]=48, group=60 → total=64
            nextOffset = r.pos + 8;
            rotationOffset = r.pos + 24;
            coordsOffset = r.pos + 28;
            instRefOffset = r.pos + 12;
            firstPadOffset = r.pos + 40;
          }

          const ps: PlacedSymbol = {
            key,
            layer,
            rotation: r.u32At(rotationOffset),
            x: r.i32At(coordsOffset),
            y: r.i32At(coordsOffset + 4),
            instRef: r.u32At(instRefOffset),
            firstPadPtr: r.u32At(firstPadOffset),
            next: r.u32At(nextOffset),
          };
          result.placedSymbols.set(key, ps);
          r.skip(size);
          break;
        }

        case 0x31: {
          // String graphic — variable.
          // Fixed=24 (v16/v17.2) or 28 (v174). String length at pos+22. Then roundToWord(len).
          const fixedSize31 = v174 ? 28 : 24;
          const len31 = r.u16At(r.pos + 22);
          r.skip(fixedSize31);
          if (len31 > 0) {
            r.skip(roundToWord(len31));
          }
          break;
        }

        case 0x32: {
          // Symbol pin
          const size = recordSizes[0x32];
          const pinLayer = r.u8At(r.pos + 3);

          // Extract pointer fields
          // t(2)+subtype(1)+layer(1) + k(4) + un1(4) + ptr1(4) + bitmask1(4) = 20
          const ptr1 = r.u32At(r.pos + 12); // → x04 (net/shape pair)
          // v17: +prev(4), next(4) vs v16: next(4)
          const nextOffset = v17 ? 24 : 20;
          const next = r.u32At(r.pos + nextOffset);
          // ptr3..ptr8 follow
          const ptr3Offset = nextOffset + 4;
          const ptr3 = r.u32At(r.pos + ptr3Offset);
          const ptr5 = r.u32At(r.pos + ptr3Offset + 8); // ptr3, ptr4, ptr5

          // Coords at end
          const coordsOffset = size - 16;
          const coords: [number, number, number, number] = [
            r.i32At(r.pos + coordsOffset),
            r.i32At(r.pos + coordsOffset + 4),
            r.i32At(r.pos + coordsOffset + 8),
            r.i32At(r.pos + coordsOffset + 12),
          ];

          result.symbolPins.set(key, {
            key,
            layer: pinLayer,
            ptr1, ptr3, ptr5, next,
            coords,
          });
          r.skip(size);
          break;
        }

        case 0x35: {
          // Fixed 124 bytes
          r.skip(124);
          break;
        }

        case 0x36: {
          // Variable — x36 configuration tables
          // v17: header=32, size field at pos+16
          // v16: header=28, size field at pos+12
          // v174: header has extra un2(4) = 36
          const c = r.u16At(r.pos + 2);
          const sizeOffset = v17 ? 16 : 12;
          const sz36 = r.u32At(r.pos + sizeOffset);
          const fixedHdr = v174 ? 36 : v17 ? 32 : 28;
          r.skip(fixedHdr);

          // Sub-record sizes differ by version
          const subSizesV17: Record<number, number> = {
            0x02: 76, 0x03: 64, 0x05: 28, 0x06: 8, 0x08: 52,
            0x0B: 1016, 0x0C: 232, 0x0D: 200, 0x0F: 16, 0x10: 108,
          };
          const subSizesV16: Record<number, number> = {
            0x02: 100, 0x03: 32, 0x05: 28, 0x06: 208, 0x08: 24,
            0x0B: 1016, 0x0C: 232, 0x0D: 200, 0x0F: 16, 0x10: 108,
          };

          const subSizes = v17 ? subSizesV17 : subSizesV16;
          const entrySize = subSizes[c];
          if (entrySize !== undefined) {
            r.skip(sz36 * entrySize);
          } else {
            dbg.warn(`x36 unknown c=0x${c.toString(16)}`);
            // Bail out rather than corrupt
            return result;
          }
          break;
        }

        case 0x3B: {
          // SI model — variable
          // v17 fixed=180, v16=176. Then roundToWord(u32@pos+4).
          const fixedSize = v17 ? 180 : 176;
          const len = r.u32At(r.pos + 4);
          r.skip(fixedSize);
          r.skip(roundToWord(len));
          break;
        }

        case 0x3C: {
          // Pair — variable
          // v174: fixed=16, sz@pos+12. Others: fixed=12, sz@pos+8. Then sz*4.
          const sizeOffset = v174 ? 12 : 8;
          const sz3C = r.u32At(r.pos + sizeOffset);
          const fixedSize = v174 ? 16 : 12;
          r.skip(fixedSize);
          r.skip(sz3C * 4);
          break;
        }

        default: {
          // Fixed-size record — use the table
          const size = recordSizes[t];
          if (size > 0) {
            r.skip(size);
          } else {
            // Unknown or unhandled record type — resync by scanning forward
            // for the next valid record type byte. The x27 blob contains standard
            // records interspersed with a few unhandled types (0x1A, etc.).
            const scanStart = r.pos;
            r.skip(4); // skip past current bad type
            let resynced = false;
            for (let probe = 0; probe < 4096 && r.remaining > 8; probe += 4) {
              const nextT = r.u8At(r.pos);
              if (isValidType(nextT)) {
                resynced = true;
                break;
              }
              r.skip(4);
            }
            if (!resynced) {
              dbg.warn(`Cannot resync after 0x${t.toString(16)} at 0x${scanStart.toString(16)}, scanned ${r.pos - scanStart} bytes. Stopping.`);
              dbg.log(`Scan stopped at ${(100 * r.pos / r.size).toFixed(1)}% (${totalRecords} records)`);
              return result;
            }
            break;
          }
          break;
        }
      }
    } catch {
      // Parse error in variable-size record — resync forward
      r.pos = recordStart + 4;
      for (let probe = 0; probe < 4096 && r.remaining > 8; probe += 4) {
        if (isValidType(r.u8At(r.pos))) break;
        r.skip(4);
      }
    }

    totalRecords++;

    // Safety: ensure we're making forward progress and didn't overshoot
    if (r.pos <= recordStart) {
      dbg.warn(`No progress at 0x${recordStart.toString(16)}, type=0x${t.toString(16)}`);
      break;
    }
    // If a variable-size handler skipped too far (> 1MB per record), resync
    if (r.pos - recordStart > 1_000_000) {
      r.pos = recordStart + 4;
      for (let probe = 0; probe < 4096 && r.remaining > 8; probe += 4) {
        if (isValidType(r.u8At(r.pos))) break;
        r.skip(4);
      }
    }
  }

  const phase1End = r.pos;
  const phase1Pct = (100 * phase1End / r.size).toFixed(1);

  // Phase 2: Flat extraction through remainder of file.
  // The x27 blob contains standard fixed-size records interspersed with
  // unhandled types and raw design data. Extract only fixed-size records
  // by stepping exactly their size — no variable-size handling needed.
  // This safely captures x32 (pins), x0D (pin defs), x04 (net pairs),
  // x05 (traces), x15/x16/x17 (line segments), etc.
  if (phase1End < r.size * 0.95) {
    let pos2 = phase1End;
    let phase2Records = 0;
    while (pos2 < r.size - 8) {
      const t2 = r.u8At(pos2);
      const sz = recordSizes[t2];
      if (sz > 0 && pos2 + sz <= r.size) {
        const key2 = r.u32At(pos2 + 4);
        // Only extract record types we care about for rendering
        switch (t2) {
          case 0x04: {
            const netPtr = r.u32At(pos2 + 12);
            const shapePtr = r.u32At(pos2 + 16);
            if (!result.netShapePairs.has(key2)) {
              result.netShapePairs.set(key2, { key: key2, netPtr, shapePtr });
            }
            break;
          }
          case 0x05: {
            const lineLayer = r.u8At(pos2 + 3);
            const firstSegOff = v17 ? 60 : 48;
            const firstSeg = r.u32At(pos2 + firstSegOff);
            if (!result.compositeLines.has(key2)) {
              result.compositeLines.set(key2, { key: key2, layer: lineLayer, firstSegPtr: firstSeg });
            }
            break;
          }
          case 0x07: {
            const refOff = v17 ? 28 : 20;
            const refdesRef = r.u32At(pos2 + refOff);
            if (!result.instances.has(key2)) {
              result.instances.set(key2, { key: key2, refdesStringRef: refdesRef, ptr1: r.u32At(pos2 + (v17 ? 24 : 12)) });
            }
            break;
          }
          case 0x0D: {
            const strPtr = r.u32At(pos2 + 8);
            if (!result.pinDefs.has(key2)) {
              result.pinDefs.set(key2, { key: key2, strPtr, coords: [r.i32At(pos2 + 16), r.i32At(pos2 + 20)] });
            }
            break;
          }
          case 0x15: case 0x16: case 0x17: {
            const baseOff2 = v17 ? 24 : 20;
            if (!result.lineSegments.has(key2)) {
              result.lineSegments.set(key2, {
                key: key2, next: r.u32At(pos2 + 8), parent: r.u32At(pos2 + 12),
                width: r.u32At(pos2 + baseOff2),
                coords: [r.i32At(pos2 + baseOff2 + 4), r.i32At(pos2 + baseOff2 + 8), r.i32At(pos2 + baseOff2 + 12), r.i32At(pos2 + baseOff2 + 16)],
              });
            }
            break;
          }
          case 0x1B: {
            const netNameKey = r.u32At(pos2 + 12);
            const nextNet = r.u32At(pos2 + 8);
            if (!result.nets.has(key2)) {
              result.nets.set(key2, { key: key2, netName: netNameKey, next: nextNet });
            }
            break;
          }
          case 0x2D: {
            const layer = r.u8At(pos2 + 2);
            const rotOff = v17 ? 28 : 24;
            const coordOff = v17 ? 32 : 28;
            const instOff = v17 ? 40 : 12;
            const padOff = v17 ? 48 : 40;
            if (!result.placedSymbols.has(key2)) {
              result.placedSymbols.set(key2, {
                key: key2, layer, rotation: r.u32At(pos2 + rotOff),
                x: r.i32At(pos2 + coordOff), y: r.i32At(pos2 + coordOff + 4),
                instRef: r.u32At(pos2 + instOff), firstPadPtr: r.u32At(pos2 + padOff),
                next: r.u32At(pos2 + 8),
              });
            }
            break;
          }
          case 0x32: {
            const pinLayer = r.u8At(pos2 + 3);
            const ptr1 = r.u32At(pos2 + 12);
            const nextOff = v17 ? 24 : 20;
            const next32 = r.u32At(pos2 + nextOff);
            const ptr3Off = nextOff + 4;
            const ptr3 = r.u32At(pos2 + ptr3Off);
            const ptr5 = r.u32At(pos2 + ptr3Off + 8);
            const cOff = sz - 16;
            if (!result.symbolPins.has(key2)) {
              result.symbolPins.set(key2, {
                key: key2, layer: pinLayer, ptr1, ptr3, ptr5, next: next32,
                coords: [r.i32At(pos2 + cOff), r.i32At(pos2 + cOff + 4), r.i32At(pos2 + cOff + 8), r.i32At(pos2 + cOff + 12)],
              });
            }
            result.ptrTypes.set(key2, t2);
            break;
          }
        }
        pos2 += sz;
        phase2Records++;
      } else {
        pos2 += 4; // skip unknown/variable-size, advance by alignment
      }
    }
    dbg.log(`Phase 2 flat scan: ${phase2Records} records from ${phase1Pct}% to 100%`);
  }

  dbg.log(`Scan complete: ${totalRecords}+phase2 records`);
  return result;
}

// ---------------------------------------------------------------------------
// BoardData assembly
// ---------------------------------------------------------------------------

/** Convert Allegro internal units to mils. Raw coords are in centi-mils (1/100 mil). */
const COORD_SCALE = 1 / 100;

function assembleBoard(
  records: ParsedRecords,
  strings: Map<number, string>,
  hdr: AllegroHeader,
): BoardData {
  const parts: Part[] = [];
  // allPins removed — was declared but never read
  const nails: Nail[] = [];

  // Build net name lookup: x1B key → net name string
  const netNameMap = new Map<number, string>();
  for (const [k, net] of records.nets) {
    const name = strings.get(net.netName);
    if (name) netNameMap.set(k, name);
  }

  // Build net/shape pair lookup: x04 key → net name
  const pairToNet = new Map<number, string>();
  for (const [k, pair] of records.netShapePairs) {
    const netName = netNameMap.get(pair.netPtr);
    if (netName) pairToNet.set(k, netName);
  }

  // Resolve pin net: x32.ptr1 → x04 → x1B → name
  function resolvePinNet(pin: SymbolPin): string {
    if (pin.ptr1 === 0) return '';
    // ptr1 should point to x04 (net/shape pair)
    const netName = pairToNet.get(pin.ptr1);
    if (netName) return netName;
    // Fallback: ptr1 might directly be x1B
    const directNet = netNameMap.get(pin.ptr1);
    return directNet ?? '';
  }

  // Resolve pin name: x32.ptr5 → x0D → str_ptr → strings
  function resolvePinName(pin: SymbolPin): string {
    if (pin.ptr5 === 0) return '';
    const def = records.pinDefs.get(pin.ptr5);
    if (!def) return '';
    return strings.get(def.strPtr) ?? '';
  }

  const MAX_PINS = 50000; // safety limit for pin chain walk

  /** Walk x32 pin chain from a placed symbol, return pins + bounds */
  function buildPartFromSymbol(ps: PlacedSymbol, refdes: string): Part {
    const compX = ps.x * COORD_SCALE;
    const compY = ps.y * COORD_SCALE;
    const side: 'top' | 'bottom' = ps.layer === 0 ? 'top' : 'bottom';

    const compPins: Pin[] = [];
    let pinKey = ps.firstPadPtr;
    const visitedPins = new Set<number>();
    let pinCount = 0;

    while (pinKey !== 0 && !visitedPins.has(pinKey) && pinCount < MAX_PINS) {
      visitedPins.add(pinKey);
      const sp = records.symbolPins.get(pinKey);
      if (!sp) break;

      const px = ((sp.coords[0] + sp.coords[2]) / 2) * COORD_SCALE;
      const py = ((sp.coords[1] + sp.coords[3]) / 2) * COORD_SCALE;
      const pw = Math.abs(sp.coords[2] - sp.coords[0]) * COORD_SCALE;
      const ph = Math.abs(sp.coords[3] - sp.coords[1]) * COORD_SCALE;
      const radius = Math.max(Math.min(Math.max(pw, ph) / 2, 30), 3);

      compPins.push({
        name: resolvePinName(sp) || String(pinCount + 1),
        number: String(pinCount + 1),
        position: { x: px, y: py },
        radius,
        side,
        net: resolvePinNet(sp),
      });

      pinCount++;
      if (sp.next === 0) break;
      const nextType = records.ptrTypes.get(sp.next);
      if (nextType !== 0x32) break;
      pinKey = sp.next;
    }

    let bounds;
    if (compPins.length > 0) {
      bounds = computeBBox(compPins.map(p => p.position));
    } else {
      const PAD = 50;
      bounds = { minX: compX - PAD, minY: compY - PAD, maxX: compX + PAD, maxY: compY + PAD };
    }

    return { name: refdes, side, type: 'smd', origin: { x: compX, y: compY }, pins: compPins, bounds };
  }

  // Determine layer names for multi-layer display
  const layerNames: string[] = [];
  const copperLayers: LayerInfo[] = [];
  for (const l of records.layers) {
    if (l.isTop || l.isBottom || l.isSignal || l.isPower || l.isInner) {
      copperLayers.push(l);
      layerNames.push(l.name);
    }
  }

  // --- Pointer-based component/pin extraction via x2B linked list ---
  const processedX2D = new Set<number>();

  let x2bKey = hdr.llX2B.head;
  const visitedX2B = new Set<number>();
  while (x2bKey !== 0 && x2bKey !== hdr.llX2B.tail && !visitedX2B.has(x2bKey)) {
    visitedX2B.add(x2bKey);
    const x2b = records.footprints.get(x2bKey);
    if (!x2b) break;

    // Each x2B has ptr2 → first x2D in chain
    let x2dKey = x2b.ptr2;
    const visitedX2D = new Set<number>();
    while (x2dKey !== 0 && x2dKey !== x2b.key && !visitedX2D.has(x2dKey)) {
      visitedX2D.add(x2dKey);
      const ps = records.placedSymbols.get(x2dKey);
      if (!ps) break;
      processedX2D.add(x2dKey);

      // Get component name (refdes) through x07 instance
      let refdes = '';
      if (ps.instRef !== 0) {
        const inst = records.instances.get(ps.instRef);
        if (inst) {
          refdes = strings.get(inst.refdesStringRef) ?? '';
        }
      }

      // Skip symbols without refdes (board-level graphics, etc.)
      if (!refdes) {
        x2dKey = ps.next;
        const nextType = records.ptrTypes.get(x2dKey);
        if (nextType !== 0x2D) break;
        continue;
      }

      parts.push(buildPartFromSymbol(ps, refdes));

      // Follow x2D chain within x2B
      x2dKey = ps.next;
      const nextType = records.ptrTypes.get(x2dKey);
      if (nextType !== 0x2D) break;
    }

    x2bKey = x2b.next; // x2B linked list
  }

  // Fallback: process any x2D records not reached via x2B chain
  for (const [_key, ps] of records.placedSymbols) {
    if (processedX2D.has(ps.key)) continue;

    let refdes = '';
    if (ps.instRef !== 0) {
      const inst = records.instances.get(ps.instRef);
      if (inst) {
        refdes = strings.get(inst.refdesStringRef) ?? '';
      }
    }
    if (!refdes) continue;

    parts.push(buildPartFromSymbol(ps, refdes));
  }

  // Compute bounds from ALL part origins (most reliable source)
  const partOrigins = parts.map(p => p.origin);
  const partBounds = partOrigins.length > 0 ? computeBBox(partOrigins) : null;

  // Board outline: use part-derived bounding rectangle with margin
  let outline: Point[] = [];
  if (partBounds) {
    const mx = (partBounds.maxX - partBounds.minX) * 0.02; // 2% margin
    const my = (partBounds.maxY - partBounds.minY) * 0.02;
    outline = [
      { x: partBounds.minX - mx, y: partBounds.minY - my },
      { x: partBounds.maxX + mx, y: partBounds.minY - my },
      { x: partBounds.maxX + mx, y: partBounds.maxY + my },
      { x: partBounds.minX - mx, y: partBounds.maxY + my },
    ];
  }

  // Final bounds: union of outline, part origins, and pin positions
  const allPoints = [
    ...outline,
    ...partOrigins,
    ...parts.flatMap(p => p.pins.map(pin => pin.position)),
  ];
  const bounds = allPoints.length > 0 ? computeBBox(allPoints) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  // --- Trace extraction from x05 composite lines ---
  const traces: Trace[] = [];
  for (const [_k, line] of records.compositeLines) {
    let segKey = line.firstSegPtr;
    const visitedSegs = new Set<number>();
    while (segKey !== 0 && !visitedSegs.has(segKey)) {
      visitedSegs.add(segKey);
      const seg = records.lineSegments.get(segKey);
      if (!seg) break;
      // Filter: skip zero-width (geometric outlines) and very wide (>50 mil copper fills)
      const traceW = seg.width * COORD_SCALE;
      if (traceW > 0.5 && traceW < 50) {
        traces.push({
          start: { x: seg.coords[0] * COORD_SCALE, y: seg.coords[1] * COORD_SCALE },
          end: { x: seg.coords[2] * COORD_SCALE, y: seg.coords[3] * COORD_SCALE },
          width: traceW,
          net: '',
          layer: line.layer,
        });
      }
      segKey = seg.next;
      if (segKey === line.firstSegPtr) break; // circular
    }
  }

  // Build nets
  const nets = buildNets(parts);

  dbg.log(`Assembled: ${parts.length} parts, ${nets.size} nets, ${traces.length} traces, ${layerNames.length} layers`);
  dbg.log(`Records: ${records.placedSymbols.size} x2D, ${records.instances.size} x07, ${records.symbolPins.size} x32, ${records.pinDefs.size} x0D, ${records.nets.size} x1B, ${records.netShapePairs.size} x04, ${records.footprints.size} x2B, ${records.compositeLines.size} x05`);

  const board: BoardData = {
    format: 'ALLEGRO_BRD',
    outline,
    parts,
    nails,
    nets,
    bounds,
    traces: traces.length > 0 ? traces : undefined,
  };

  return board;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function parseAllegroBRD(buffer: ArrayBuffer): BoardData {
  const r = new AllegroReader(buffer);

  // Parse header
  const hdr = parseHeader(r);
  const ver = detectVersion(hdr.magic);
  if (ver === null) {
    throw new Error(`Unsupported Allegro BRD version: magic=0x${hdr.magic.toString(16)}`);
  }

  dbg.log(`Version: ${versionName(hdr.magic)} (magic=0x${hdr.magic.toString(16)})`);
  dbg.log(`Objects: ${hdr.objectCount}, Strings: ${hdr.stringsCount}`);
  dbg.log(`Allegro version string: "${hdr.allegroVersion}"`);
  dbg.log(`Linked lists: x2B(head=0x${hdr.llX2B.head.toString(16)}, tail=0x${hdr.llX2B.tail.toString(16)}), x1B(head=0x${hdr.llX1B.head.toString(16)}, tail=0x${hdr.llX1B.tail.toString(16)})`);

  // Parse strings table
  const strings = parseStrings(r, hdr.stringsCount);

  // Scan all records
  const records = scanRecords(r, hdr, ver, strings);

  // Assemble BoardData
  return assembleBoard(records, strings, hdr);
}
