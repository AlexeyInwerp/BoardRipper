# Allegro BRD Parser Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the heuristic Allegro BRD parser with a field-by-field Object DB architecture derived from KiCad 10's reverse engineering, supporting versions 16.0–18.0+.

**Architecture:** Three-phase pipeline: (1) Parse header + strings + all blocks field-by-field into a key→object Map, (2) Resolve cross-references between objects, (3) Walk linked lists to assemble BoardData. All ~35 block types parsed with version-conditional fields.

**Tech Stack:** TypeScript, existing BoardData/Pin/Part/Net/Trace/Via types, Playwright tests, scoped logging via `log.parser.*`

**Spec:** `docs/superpowers/specs/2026-03-28-allegro-brd-parser-rewrite-design.md`

**KiCad reference files** (downloaded to `/tmp/` during design, re-fetch if needed):
- `allegro_parser.cpp` (2,740 lines) — all block parser functions
- `allegro_db.h` / `allegro_db.cpp` — Object DB, reference resolution, linked list walking
- `allegro_pcb_structs.h` (56.9KB) — all block data structs with version-conditional fields
- `allegro_builder.cpp` (4,804 lines) — assembly: DB → KiCad board objects
- `allegro_stream.h` — binary stream reader
- `FORMAT.md` — reverse-engineered format documentation

Re-fetch any file with:
```bash
curl -s "https://raw.githubusercontent.com/KiCad/kicad-source-mirror/refs/heads/master/pcbnew/pcb_io/allegro/convert/<filename>" > /tmp/<filename>
```

---

### Task 1: Archive Old Parser & Create Module Skeleton

**Files:**
- Move: `src/frontend/src/parsers/allegro-brd-parser.ts` → `src/frontend/src/parsers/_archive/allegro-brd-parser.old.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-stream.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-types.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-header.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-blocks.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-db.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-assembler.ts`
- Create: `src/frontend/src/parsers/allegro/allegro-brd-parser.ts`
- Modify: `src/frontend/src/parsers/allegro-brd-format.ts` (update import path)
- Modify: `src/frontend/src/parsers/index.ts` (update import path)

- [ ] **Step 1: Create archive directory and move old parser**

```bash
mkdir -p src/frontend/src/parsers/_archive
mv src/frontend/src/parsers/allegro-brd-parser.ts src/frontend/src/parsers/_archive/allegro-brd-parser.old.ts
```

- [ ] **Step 2: Create the module directory and skeleton files**

```bash
mkdir -p src/frontend/src/parsers/allegro
```

Create `src/frontend/src/parsers/allegro/allegro-stream.ts`:
```typescript
/**
 * Binary stream reader for Allegro .brd files.
 * All multi-byte values are little-endian.
 */
export class AllegroStream {
  private view: DataView;
  private pos: number;
  private decoder = new TextDecoder('ascii');

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
    this.pos = 0;
  }

  get position(): number { return this.pos; }
  get size(): number { return this.view.byteLength; }
  get eof(): boolean { return this.pos >= this.view.byteLength; }

  seek(pos: number): void {
    if (pos > this.view.byteLength)
      throw new Error(`Seek past end: offset ${pos} exceeds file size ${this.view.byteLength}`);
    this.pos = pos;
  }

  skip(bytes: number): void {
    if (bytes > this.view.byteLength - this.pos)
      throw new Error(`Skip past end at offset ${this.pos}`);
    this.pos += bytes;
  }

  u8(): number {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  s16(): number {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  s32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Skip N uint32 values */
  skipU32(n = 1): void { this.skip(4 * n); }

  /** Read N uint32 values into an array */
  u32Array(n: number): number[] {
    const arr: number[] = [];
    for (let i = 0; i < n; i++) arr.push(this.u32());
    return arr;
  }

  /** Read N int32 values into an array */
  s32Array(n: number): number[] {
    const arr: number[] = [];
    for (let i = 0; i < n; i++) arr.push(this.s32());
    return arr;
  }

  /**
   * Read an Allegro float: two u32 words forming a big-endian IEEE 754 double.
   * Used for arc center coordinates and radii.
   */
  allegroFloat(): number {
    const a = this.u32();
    const b = this.u32();
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, a, false); // big-endian high word
    dv.setUint32(4, b, false); // big-endian low word
    return dv.getFloat64(0, false);
  }

  /**
   * Read a null-terminated string, optionally rounding position to next u32 boundary.
   */
  cString(roundToU32 = true): string {
    const start = this.pos;
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset);
    let end = start;
    while (end < bytes.length && bytes[end] !== 0) end++;
    const str = this.decoder.decode(bytes.slice(start, end));
    this.pos = end + 1; // skip null terminator
    if (roundToU32 && this.pos % 4 !== 0) {
      this.pos += 4 - (this.pos % 4);
    }
    return str;
  }

  /**
   * Read a fixed-length string, optionally rounding position to next u32 boundary.
   */
  fixedString(len: number, roundToU32 = true): string {
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, len);
    // Find null terminator within the fixed field
    let strLen = 0;
    while (strLen < len && bytes[strLen] !== 0) strLen++;
    const str = this.decoder.decode(bytes.slice(0, strLen));
    this.pos += len;
    if (roundToU32 && this.pos % 4 !== 0) {
      this.pos += 4 - (this.pos % 4);
    }
    return str;
  }

  /** Read raw bytes */
  bytes(n: number): Uint8Array {
    const result = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return new Uint8Array(result); // copy to avoid detachment issues
  }

  /** Peek at next byte without advancing */
  peekU8(): number | undefined {
    if (this.pos >= this.view.byteLength) return undefined;
    return this.view.getUint8(this.pos);
  }
}
```

Create `src/frontend/src/parsers/allegro/allegro-types.ts` — stub:
```typescript
// Populated in Task 2
export {}
```

Create remaining skeleton files (`allegro-header.ts`, `allegro-blocks.ts`, `allegro-db.ts`, `allegro-assembler.ts`) as empty stubs with `export {}`.

Create `src/frontend/src/parsers/allegro/allegro-brd-parser.ts`:
```typescript
import type { BoardData } from '../types';

export function parseAllegroBRD(_buffer: ArrayBuffer): BoardData {
  throw new Error('Allegro BRD parser rewrite in progress');
}
```

- [ ] **Step 3: Update imports in allegro-brd-format.ts and index.ts**

In `src/frontend/src/parsers/allegro-brd-format.ts`, change the import:
```typescript
// Old: import { parseAllegroBRD } from './allegro-brd-parser';
import { parseAllegroBRD } from './allegro/allegro-brd-parser';
```

Update `detect()` to also accept v17.5 and v18.0 magic:
```typescript
detect(header: Uint8Array): boolean {
  if (header.length < 12) return false;
  const magic = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
  const family = (magic >>> 16) & 0xFFFF;
  if (family !== 0x0013 && family !== 0x0014 && family !== 0x0015) return false;
  const check = header[8] | (header[9] << 8) | (header[10] << 16) | (header[11] << 24);
  return check === 1;
},
```

- [ ] **Step 4: Verify the project still compiles (parser throws but format registration works)**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: No type errors (the parser throws at runtime, but types are valid).

- [ ] **Step 5: Commit**

```bash
git add -A src/frontend/src/parsers/
git commit -m "refactor: archive old Allegro parser, create new module skeleton"
```

---

### Task 2: Types & Enums

**Files:**
- Create: `src/frontend/src/parsers/allegro/allegro-types.ts`

Define all enums, interfaces, and block data types. This is a reference file — transliterate from KiCad's `allegro_pcb_structs.h`.

- [ ] **Step 1: Write FmtVer enum, LayerInfo, and version-conditional helper**

Replace the stub in `allegro-types.ts`:

```typescript
/**
 * Allegro BRD binary format types.
 * Derived from KiCad 10's reverse-engineered Allegro importer (GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 */

/** Format version — determines struct field layouts */
export const enum FmtVer {
  V_PRE_V16 = -1,
  V_UNKNOWN = 0,
  V_160 = 1,
  V_162 = 2,
  V_164 = 3,
  V_165 = 4,
  V_166 = 5,
  V_172 = 6,
  V_174 = 7,
  V_175 = 8,
  V_180 = 9,
}

/** 2-byte layer encoding: class + subclass */
export interface LayerInfo {
  classCode: number;   // u8
  subclass: number;    // u8
}

/** Layer class codes */
export const enum LayerClass {
  BOARD_GEOMETRY = 0x01,
  COMPONENT_VALUE = 0x02,
  DEVICE_TYPE = 0x03,
  DRAWING_FORMAT = 0x04,
  DRC_ERROR = 0x05,
  ETCH = 0x06,
  MANUFACTURING = 0x07,
  ANALYSIS = 0x08,
  PACKAGE_GEOMETRY = 0x09,
  PACKAGE_KEEPIN = 0x0A,
  PACKAGE_KEEPOUT = 0x0B,
  PIN = 0x0C,
  REF_DES = 0x0D,
  ROUTE_KEEPIN = 0x0E,
  ROUTE_KEEPOUT = 0x0F,
  TOLERANCE = 0x10,
  USER_PART_NUMBER = 0x11,
  VIA_CLASS = 0x12,
  VIA_KEEPOUT = 0x13,
  ANTI_ETCH = 0x14,
  BOUNDARY = 0x15,
}

/** Header linked list descriptor */
export interface LinkedList {
  head: number;  // start key
  tail: number;  // end/sentinel key
}

/** Board unit types */
export const enum BoardUnits {
  MILS = 0x01,
  INCHES = 0x02,
  MILLIMETERS = 0x03,
  CENTIMETERS = 0x04,
  MICROMETERS = 0x05,
}

/** Parsed file header */
export interface FileHeader {
  magic: number;
  fmtVer: FmtVer;
  objectCount: number;
  allegroVersion: string;
  boardUnits: BoardUnits;
  unitsDivisor: number;
  maxKey: number;
  stringsCount: number;
  x27End: number;

  // Linked lists (22 for pre-V180)
  LL_0x04: LinkedList;
  LL_0x06: LinkedList;
  LL_0x0C: LinkedList;
  LL_Shapes: LinkedList;
  LL_0x14: LinkedList;
  LL_0x1B_Nets: LinkedList;
  LL_0x1C: LinkedList;
  LL_0x24_0x28: LinkedList;
  LL_Unknown1: LinkedList;
  LL_0x2B: LinkedList;
  LL_0x03_0x30: LinkedList;
  LL_0x0A: LinkedList;
  LL_0x1D_0x1E_0x1F: LinkedList;
  LL_Unknown2: LinkedList;
  LL_0x38: LinkedList;
  LL_0x2C: LinkedList;
  LL_0x0C_2: LinkedList;
  LL_Unknown3: LinkedList;
  LL_0x36: LinkedList;
  LL_Unknown6: LinkedList;
  LL_0x0A_2: LinkedList;

  // V180 extra linked lists
  LL_V18_1?: LinkedList;
  LL_V18_2?: LinkedList;
  LL_V18_3?: LinkedList;
  LL_V18_4?: LinkedList;
  LL_V18_5?: LinkedList;
  LL_V18_6?: LinkedList;

  // x35 file ref range
  x35Start: number;
  x35End: number;

  // Layer map
  layerMap: Array<{ a: number; layerList0x2A: number }>;
}

/**
 * Read a version-conditional field.
 * Returns value if the version matches the condition, undefined otherwise.
 */
export function readCond<T>(
  ver: FmtVer,
  threshold: FmtVer,
  dir: '>=' | '<',
  reader: () => T,
): T | undefined {
  const present = dir === '>=' ? ver >= threshold : ver < threshold;
  return present ? reader() : undefined;
}
```

- [ ] **Step 2: Write block data interfaces for all ~35 block types**

Add to `allegro-types.ts` — each block type gets an interface. Use `| undefined` for version-conditional fields. Below is the complete set (transliterated from KiCad's `allegro_parser.cpp` field-by-field parsing):

```typescript
/** Base block fields present in every block */
export interface BlockBase {
  blockType: number;  // 0x01–0x3C
  offset: number;     // file position (for debugging)
  key: number;        // unique ID in the DB
}

// --- 0x01 ARC ---
export interface Blk0x01Arc extends BlockBase {
  blockType: 0x01;
  unknownByte: number;
  subType: number;    // bit 6: sweep direction (0=CCW, 0x40=CW)
  next: number;
  parent: number;
  unknown1: number;
  unknown6?: number;  // >= V172
  width: number;
  startX: number; startY: number;
  endX: number; endY: number;
  centerX: number; centerY: number; // AllegroFloat
  radius: number; // AllegroFloat
  bbox: number[]; // 4 × s32
}

// --- 0x03 FIELD ---
export interface Blk0x03Field extends BlockBase {
  blockType: 0x03;
  hdr1: number; // u16
  next: number;
  unknown1?: number; // >= V172
  subType: number;   // u8
  hdr2: number;      // u8
  size: number;      // u16
  unknown2?: number; // >= V172
  substruct: Blk0x03Substruct;
}
export type Blk0x03Substruct =
  | { kind: 'u32'; value: number }
  | { kind: 'u32x2'; values: [number, number] }
  | { kind: 'string'; value: string }
  | { kind: '0x6C'; numEntries: number; entries: number[] }
  | { kind: '0x70_0x74'; x0: number; x1: number; entries: number[] }
  | { kind: '0xF6'; entries: number[] }
  | { kind: 'empty' };

// --- 0x04 NET_ASSIGN ---
export interface Blk0x04NetAssign extends BlockBase {
  blockType: 0x04;
  type: number; // u8
  r: number;    // u16
  next: number;
  net: number;      // key → 0x1B
  connItem: number; // key → 0x05 or 0x32
  unknown?: number; // >= V172
}

// --- 0x05 TRACK ---
export interface Blk0x05Track extends BlockBase {
  blockType: 0x05;
  layer: LayerInfo;
  next: number;
  netAssignment: number;
  unknownPtr1: number;
  unknown2: number;
  unknown3: number;
  unknownPtr2a: number;
  unknownPtr2b: number;
  unknown4: number;
  unknownPtr3a: number;
  unknownPtr3b: number;
  unknown5a?: number; // >= V172
  unknown5b?: number; // >= V172
  firstSegPtr: number;
  unknownPtr5: number;
  unknown6: number;
}

// --- 0x06 COMPONENT ---
export interface Blk0x06Component extends BlockBase {
  blockType: 0x06;
  next: number;
  compDeviceType: number; // str ref
  symbolName: number;     // str ref
  firstInstPtr: number;   // → 0x07 chain
  ptrFunctionSlot: number;
  ptrPinNumber: number;
  fields: number;
  unknown1?: number; // >= V172
}

// --- 0x07 COMPONENT_INST ---
export interface Blk0x07ComponentInst extends BlockBase {
  blockType: 0x07;
  next: number;
  unknownPtr1?: number; // >= V172
  unknown2?: number;    // >= V172
  unknown3?: number;    // >= V172
  fpInstPtr: number;    // → 0x2D
  unknown4?: number;    // >= V172
  refDesStrPtr: number; // str ref → refdes
  functionInstPtr: number;
  x03Ptr: number;
  unknown5: number;
  firstPadPtr: number;  // → 0x32 chain
}

// --- 0x08 PIN_NUMBER ---
export interface Blk0x08PinNumber extends BlockBase {
  blockType: 0x08;
  type: number;
  r: number;
  previous?: number;  // < V172
  strPtr16x?: number; // < V172 (str ref)
  next: number;
  strPtr?: number;    // >= V172 (str ref)
  pinNamePtr: number; // → 0x11
  unknown1?: number;  // >= V172
  ptr4: number;
}

// --- 0x09 FILL_LINK ---
export interface Blk0x09FillLink extends BlockBase {
  blockType: 0x09;
  unknownArray: number[]; // 7 × u32
  unknown1?: number; // >= V172
  unknownPtr1: number;
  unknownPtr2: number;
  unknown2: number;
  unknownPtr3: number;
  unknownPtr4: number;
  unknown3?: number; // >= V172
}

// --- 0x0A DRC ---
export interface Blk0x0ADrc extends BlockBase {
  blockType: 0x0A;
  t: number;
  layer: LayerInfo;
  next: number;
  unknown1: number;
  unknown2?: number; // >= V172
  coords: number[];  // 4 × s32
  unknown4: number[]; // 4 × u32
  unknown5: number[]; // varies
  unknown6?: number; // >= V172
}

// --- 0x0C PIN_DEF ---
export interface Blk0x0CPinDef extends BlockBase {
  blockType: 0x0C;
  t: number;
  layer: LayerInfo;
  next: number;
  unknown1: number;
  unknown2: number;
  shape?: number;         // < V172
  drillChar?: number;     // < V172
  unknownPadding?: number; // < V172
  shape16x?: number;      // >= V172
  drillChars?: number;    // >= V172
  unknown_16x?: number;   // >= V172
  unknown4: number;
  unknown5?: number;      // >= V172
  coords: number[];  // 4 × s32
  size: number[];    // 2 × s32
  groupPtr: number;
  unknown6: number;
  unknown7: number;
  unknown8?: number; // >= V172
}

// --- 0x0D PAD ---
export interface Blk0x0DPad extends BlockBase {
  blockType: 0x0D;
  nameStrId: number;  // str ref → pad name
  next: number;
  unknown1?: number;  // >= V172
  coordsX: number;    // s32 board-absolute
  coordsY: number;    // s32 board-absolute
  padStack: number;   // → 0x1C
  unknown2: number;
  unknown3?: number;  // >= V172
  flags: number;
  rotation: number;   // millidegrees, board-absolute
}

// --- 0x0E RECT ---
export interface Blk0x0ERect extends BlockBase {
  blockType: 0x0E;
  t: number;
  layer: LayerInfo;
  next: number;
  fpPtr: number;
  unknown1: number;
  unknown2: number;
  unknown3: number;
  unknown4?: number; // >= V172
  unknown5?: number; // >= V172
  coords: number[];  // 4 × s32
  unknownArr: number[]; // varies
  rotation: number;
}

// --- 0x0F FUNCTION_SLOT ---
export interface Blk0x0FFunctionSlot extends BlockBase {
  blockType: 0x0F;
  slotName: number;       // str ref
  compDeviceType: Uint8Array; // raw bytes
  ptr0x06: number;
  ptr0x11: number;
  unknown1: number;
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
}

// --- 0x10 FUNCTION_INST ---
export interface Blk0x10FunctionInst extends BlockBase {
  blockType: 0x10;
  unknown1?: number; // >= V172
  componentInstPtr: number;
  unknown2?: number; // >= V172
  ptrX12: number;
  unknown3: number;
  functionName: number; // str ref
  slots: number;
  fields: number;
}

// --- 0x11 PIN_NAME ---
export interface Blk0x11PinName extends BlockBase {
  blockType: 0x11;
  type: number;
  r: number;
  pinNameStrPtr: number; // str ref
  next: number;
  pinNumberPtr: number;  // → 0x08
  unknown1: number;
  unknown2?: number; // >= V172
}

// --- 0x12 XREF ---
export interface Blk0x12Xref extends BlockBase {
  blockType: 0x12;
  type: number;
  r: number;
  ptr1: number;
  ptr2: number;
  ptr3: number;
  unknown1: number;
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
}

// --- 0x14 GRAPHIC ---
export interface Blk0x14Graphic extends BlockBase {
  blockType: 0x14;
  type: number;
  layer: LayerInfo;
  next: number;
  parent: number;
  flags: number;
  unknown2?: number; // >= V172
  segmentPtr: number;
  ptr0x03: number;
  ptr0x26: number;
}

// --- 0x15/0x16/0x17 SEGMENT ---
export interface Blk0x15_16_17Segment extends BlockBase {
  blockType: 0x15 | 0x16 | 0x17;
  next: number;
  parent: number;
  flags: number;
  unknown2?: number; // >= V172
  width: number;
  startX: number; startY: number;
  endX: number; endY: number;
}

// --- 0x1B NET ---
export interface Blk0x1BNet extends BlockBase {
  blockType: 0x1B;
  next: number;
  netName: number;    // str ref
  unknown1: number;
  unknown2?: number;  // >= V172
  type: number;
  assignment: number; // → 0x04 chain head
  ratline: number;
  fieldsPtr: number;
  matchGroupPtr: number;
  modelPtr: number;
  unknownPtr4: number;
  unknownPtr5: number;
  unknownPtr6: number;
}

// --- 0x1C PADSTACK (variable-size) ---
export interface Blk0x1CPadstack extends BlockBase {
  blockType: 0x1C;
  unknownByte1: number;
  n: number;
  unknownByte2: number;
  next: number;
  padStr: number;
  drill: number;
  unknown2: number;
  padPath: number;
  padType: number;  // extracted from type nibble
  a: number;
  b: number;
  flags: number;
  d: number;
  layerCount: number;
  drillArr: number[]; // 8 × u32
  numFixedCompEntries: number;
  numCompsPerLayer: number;
  components: PadstackComponent[];
  unknownArrN: number[];
}

export interface PadstackComponent {
  type: number;
  unknownByte1: number;
  unknownByte2: number;
  unknownByte3: number;
  unknown1?: number; // >= V172
  w: number; // s32
  h: number; // s32
  z1?: number; // >= V172
  x3: number; // s32
  x4: number; // s32
  z?: number;  // >= V172
  strPtr: number;
  z2?: number; // present unless last entry in < V172
}

// --- 0x1D CONSTRAINT_SET (variable-size) ---
export interface Blk0x1DConstraintSet extends BlockBase {
  blockType: 0x1D;
  next: number;
  nameStrKey: number;
  fieldPtr: number;
  sizeA: number;
  sizeB: number;
  dataB: Uint8Array[];
  dataA: Uint8Array[];
  unknown4?: number; // >= V172
}

// --- 0x1E SI_MODEL (variable-size) ---
export interface Blk0x1ESiModel extends BlockBase {
  blockType: 0x1E;
  type: number;
  t2: number;
  next: number;
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
  strPtr: number;
  size: number;
  string: string;
  unknown4?: number; // >= V172
}

// --- 0x1F PADSTACK_DIM (variable-size) ---
export interface Blk0x1FPadstackDim extends BlockBase {
  blockType: 0x1F;
  next: number;
  unknown2: number;
  unknown3: number;
  unknown4: number;
  unknown5: number; // u16
  size: number;     // u16
  substruct: Uint8Array;
}

// --- 0x20 UNKNOWN ---
export interface Blk0x20Unknown extends BlockBase {
  blockType: 0x20;
  type: number;
  r: number;
  next: number;
  unknownArray1: number[]; // 5 × u32
  unknownArray2?: number[]; // >= V172, 2 × u32
}

// --- 0x21 BLOB (variable-size) ---
export interface Blk0x21Blob extends BlockBase {
  blockType: 0x21;
  type: number;
  r: number;
  size: number;
  data: Uint8Array;
}

// --- 0x22 UNKNOWN ---
export interface Blk0x22Unknown extends BlockBase {
  blockType: 0x22;
  type: number;
  t2: number;
  unknown1?: number; // >= V172
  unknownArray: number[]; // varies
}

// --- 0x23 RATLINE ---
export interface Blk0x23Ratline extends BlockBase {
  blockType: 0x23;
  type: number;
  layer: LayerInfo;
  next: number;
  flags: number[]; // 4 × u32
  ptr1: number;
  ptr2: number;
  ptr3: number;
  coords: number[]; // 4 × s32
  unknown1: number[]; // varies
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
}

// --- 0x24 RECT ---
export interface Blk0x24Rect extends BlockBase {
  blockType: 0x24;
  type: number;
  layer: LayerInfo;
  next: number;
  parent: number;
  unknown1: number;
  unknown2?: number; // >= V172
  coords: number[];  // 4 × s32
  ptr2: number;
  unknown3: number;
  unknown4: number;
  rotation: number;
}

// --- 0x26 MATCH_GROUP ---
export interface Blk0x26MatchGroup extends BlockBase {
  blockType: 0x26;
  type: number;
  r: number;
  memberPtr: number;
  unknown1?: number; // >= V172
  groupPtr: number;
  constPtr: number;
  unknown2?: number; // >= V172
}

// --- 0x27 CSTRMGR_XREF (blob) ---
export interface Blk0x27CstrMgrXref extends BlockBase {
  blockType: 0x27;
  refs: number[]; // u32 array
}

// --- 0x28 SHAPE ---
export interface Blk0x28Shape extends BlockBase {
  blockType: 0x28;
  type: number;
  layer: LayerInfo;
  next: number;
  ptr1: number;
  unknown1: number;
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
  ptr2: number;
  ptr3: number;
  firstKeepoutPtr: number;
  firstSegmentPtr: number;
  unknown4: number;
  unknown5: number;
  tablePtr?: number;     // >= V172
  ptr6: number;
  tablePtr_16x?: number; // < V172
  coords: number[];  // 4 × s32
}

// --- 0x29 PIN (.dra only) ---
export interface Blk0x29Pin extends BlockBase {
  blockType: 0x29;
  type: number;
  t: number;
  ptr1: number;
  ptr2: number;
  null_: number;
  ptr3: number;
  coord1: number;
  coord2: number;
  ptrPadstack: number;
  unknown1: number;
  ptrX30: number;
  unknown2: number;
  unknown3: number;
  unknown4: number;
}

// --- 0x2A LAYER_LIST (variable-size) ---
export interface Blk0x2ALayerList extends BlockBase {
  blockType: 0x2A;
  numEntries: number;
  unknown?: number; // >= V172
  // Pre-V172: inline strings
  nonRefEntries?: Array<{ name: string }>;
  // V172+: references to string table
  refEntries?: Array<{ layerNameId: number; properties: number; unknown: number }>;
}

// --- 0x2B FOOTPRINT_DEF ---
export interface Blk0x2BFootprintDef extends BlockBase {
  blockType: 0x2B;
  fpStrRef: number;  // str ref
  unknown1: number;
  coords: number[];  // 4 × u32
  next: number;
  firstInstPtr: number; // → 0x2D chain
  unknownPtr3: number;
  unknownPtr4: number;
  unknownPtr5: number;
  symLibPathPtr: number;
  unknownPtr6: number;
  unknownPtr7: number;
  unknownPtr8: number;
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
}

// --- 0x2C TABLE ---
export interface Blk0x2CTable extends BlockBase {
  blockType: 0x2C;
  type: number;
  subType: number;
  next: number;
  unknown1?: number; // >= V172
  unknown2?: number; // >= V172
  unknown3?: number; // >= V172
  stringPtr: number;
  unknown4?: number; // >= V172
  ptr1: number;
  ptr2: number;
  ptr3: number;
  flags: number;
}

// --- 0x2D FOOTPRINT_INST ---
export interface Blk0x2DFootprintInst extends BlockBase {
  blockType: 0x2D;
  unknownByte1: number;
  layer: number;         // 0=top, 1=bottom
  unknownByte2: number;
  next: number;
  unknown1?: number;     // >= V172
  instRef16x?: number;   // < V172 → 0x07
  unknown2: number;      // u16
  unknown3: number;      // u16
  unknown4?: number;     // >= V172
  flags: number;
  rotation: number;      // millidegrees
  coordX: number;        // s32
  coordY: number;        // s32
  instRef?: number;      // >= V172 → 0x07
  graphicPtr: number;    // → 0x14 chain
  firstPadPtr: number;   // → 0x32 chain
  textPtr: number;       // → 0x30 chain
  assemblyPtr: number;
  areasPtr: number;
  unknownPtr1: number;
  unknownPtr2: number;
}

// --- 0x2E CONNECTION ---
export interface Blk0x2EConnection extends BlockBase {
  blockType: 0x2E;
  type: number;
  t2: number;
  next: number;
  netAssignment: number;
  unknown1: number;
  coordX: number;
  coordY: number;
  connection: number;
  unknown2: number;
  unknown3?: number; // >= V172
}

// --- 0x2F UNKNOWN ---
export interface Blk0x2FUnknown extends BlockBase {
  blockType: 0x2F;
  type: number;
  t2: number;
  unknownArray: number[]; // 5 × u32
}

// --- 0x30 STR_WRAPPER ---
export interface Blk0x30StrWrapper extends BlockBase {
  blockType: 0x30;
  type: number;
  layer: LayerInfo;
  next: number;
  strGraphicPtr: number;
  coordsX: number;
  coordsY: number;
  unknown5: number;
  rotation: number;
}

// --- 0x31 SGRAPHIC (variable-size) ---
export interface Blk0x31Sgraphic extends BlockBase {
  blockType: 0x31;
  t: number;
  layer: number; // u16 encoded
  strGraphicWrapperPtr: number;
  coordsX: number;
  coordsY: number;
  unknown: number; // u16
  len: number;     // u16
  un2?: number;    // >= V172
  value: string;
}

// --- 0x32 PLACED_PAD ---
export interface Blk0x32PlacedPad extends BlockBase {
  blockType: 0x32;
  type: number;
  layer: LayerInfo;
  next: number;
  netPtr: number;     // → 0x04
  flags: number;
  prev?: number;      // >= V172
  nextInFp: number;   // follow THIS for footprint pad chain
  parentFp: number;
  track: number;
  padPtr: number;     // → 0x0D
  ptr6: number;
  ratline: number;
  ptrPinNumber: number; // → 0x08
  nextInCompInst: number;
  unknown2?: number;  // >= V172
  nameText: number;
  ptr11: number;
  coords: number[];   // 4 × s32 (bounding box)
}

// --- 0x33 VIA ---
export interface Blk0x33Via extends BlockBase {
  blockType: 0x33;
  layerInfo: LayerInfo;
  next: number;
  netPtr: number;     // → 0x04
  unknown2: number;
  unknown3?: number;  // >= V172
  unknownPtr1: number;
  unknownPtr2?: number; // >= V172
  coordsX: number;   // s32
  coordsY: number;   // s32
  connection: number;
  padstack: number;   // → 0x1C
  unknownPtr5: number;
  unknownPtr6: number;
  unknown4: number;
  unknown5: number;
  bbox: number[];     // 4 × s32
}

// --- 0x34 KEEPOUT ---
export interface Blk0x34Keepout extends BlockBase {
  blockType: 0x34;
  t: number;
  layer: LayerInfo;
  next: number;
  ptr1: number;
  unknown1?: number; // >= V172
  flags: number;
  firstSegmentPtr: number;
  ptr3: number;
  unknown2: number;
}

// --- 0x35 FILE_REF ---
export interface Blk0x35FileRef extends BlockBase {
  blockType: 0x35;
  t2: number;
  t3: number;
  content: Uint8Array; // fixed-size raw bytes
}

// --- 0x36 DEF_TABLE (variable-size) ---
export interface Blk0x36DefTable extends BlockBase {
  blockType: 0x36;
  code: number;   // u16 — determines substruct type
  next: number;
  unknown1?: number; // >= V172
  numItems: number;
  count: number;
  lastIdx: number;
  unknown2: number;
  unknown3?: number; // >= V172
  items: Blk0x36Item[];
}
export type Blk0x36Item =
  | { kind: 'x02'; string: string; xs: number[]; ys?: number[]; zs?: number[] }
  | { kind: 'x03'; str: string }
  | { kind: 'x05'; unknown: Uint8Array }
  | { kind: 'x06'; n: number; r: number; s: number; unknown1: number; unknown2?: number }
  | { kind: 'x08_font'; a: number; b: number; charHeight: number; charWidth: number; unknown2?: number; characterSpace: number; lineSpace: number; unknown3: number; strokeWidth: number; ys?: number[] }
  | { kind: 'x0B'; unknown: Uint8Array }
  | { kind: 'x0C'; unknown: Uint8Array }
  | { kind: 'x0D'; unknown: Uint8Array }
  | { kind: 'x0F'; key: number; ptrs: number[]; ptr2: number }
  | { kind: 'x10'; unknown: Uint8Array; unknown2?: number };

// --- 0x37 PTR_ARRAY (variable-size) ---
export interface Blk0x37PtrArray extends BlockBase {
  blockType: 0x37;
  t: number;
  t2: number;
  groupPtr: number;
  next: number;
  capacity: number;
  count: number;
  unknown2: number;
  unknown3?: number; // >= V172
  ptrs: number[];  // 100 × u32 (fixed array, count indicates how many are valid)
}

// --- 0x38 FILM ---
export interface Blk0x38Film extends BlockBase {
  blockType: 0x38;
  next: number;
  layerList: number;
  filmName?: string;      // < V172 (fixed 20 bytes)
  layerNameStr?: number;  // >= V172 (str ref)
  unknown2?: number;      // >= V172
  unknownArray1: number[]; // varies
  unknown3?: number;      // >= V172
}

// --- 0x39 FILM_LAYER_LIST ---
export interface Blk0x39FilmLayerList extends BlockBase {
  blockType: 0x39;
  parent: number;
  head: number;
  x: number[]; // varies × u16
}

// --- 0x3A FILM_LIST_NODE ---
export interface Blk0x3AFilmListNode extends BlockBase {
  blockType: 0x3A;
  layer: LayerInfo;
  next: number;
  unknown: number;
  unknown1?: number; // >= V172
}

// --- 0x3B PROPERTY (variable-size) ---
export interface Blk0x3BProperty extends BlockBase {
  blockType: 0x3B;
  t: number;
  subType: number;
  len: number;
  name: string;
  type: string;
  unknown1: number;
  unknown2: number;
  unknown3?: number; // >= V172
  value: string;
}

// --- 0x3C KEY_LIST (variable-size) ---
export interface Blk0x3CKeyList extends BlockBase {
  blockType: 0x3C;
  t: number;
  t2: number;
  unknown?: number; // >= V172
  numEntries: number;
  entries: number[];
}

/** Union of all block types */
export type AllegroBlock =
  | Blk0x01Arc | Blk0x03Field | Blk0x04NetAssign | Blk0x05Track
  | Blk0x06Component | Blk0x07ComponentInst | Blk0x08PinNumber
  | Blk0x09FillLink | Blk0x0ADrc | Blk0x0CPinDef | Blk0x0DPad
  | Blk0x0ERect | Blk0x0FFunctionSlot | Blk0x10FunctionInst
  | Blk0x11PinName | Blk0x12Xref | Blk0x14Graphic
  | Blk0x15_16_17Segment | Blk0x1BNet | Blk0x1CPadstack
  | Blk0x1DConstraintSet | Blk0x1ESiModel | Blk0x1FPadstackDim
  | Blk0x20Unknown | Blk0x21Blob | Blk0x22Unknown | Blk0x23Ratline
  | Blk0x24Rect | Blk0x26MatchGroup | Blk0x27CstrMgrXref
  | Blk0x28Shape | Blk0x29Pin | Blk0x2ALayerList | Blk0x2BFootprintDef
  | Blk0x2CTable | Blk0x2DFootprintInst | Blk0x2EConnection
  | Blk0x2FUnknown | Blk0x30StrWrapper | Blk0x31Sgraphic
  | Blk0x32PlacedPad | Blk0x33Via | Blk0x34Keepout | Blk0x35FileRef
  | Blk0x36DefTable | Blk0x37PtrArray | Blk0x38Film
  | Blk0x39FilmLayerList | Blk0x3AFilmListNode | Blk0x3BProperty
  | Blk0x3CKeyList;
```

- [ ] **Step 3: Verify types compile**

Run: `cd src/frontend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-types.ts
git commit -m "feat(allegro): add complete block type definitions for all 35 block types"
```

---

### Task 3: Header Parser

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-header.ts`

Transliterate KiCad's `HEADER_PARSER::ParseHeader()` and `FormatFromMagic()`.

- [ ] **Step 1: Implement version detection and header parsing**

Write the complete `allegro-header.ts`. Reference: KiCad `allegro_parser.cpp` lines 153–324.

Key implementation notes:
- `FormatFromMagic`: mask magic with `0xFFFFFF00`, switch on known values. Range `0x0014_04xx`–`0x0014_07xx` all map to V172.
- Linked list reading: pre-V180 reads `[tail, head]`; V180 reads `[head, tail]`.
- Header position assertions: at offset 0xF8 (pre-V180) or 0x124 (V180) before version string.
- Version string: 60 bytes at fixed offset.
- Board units: 1 byte, then skip 3 padding bytes.
- `unitsDivisor`: u32 at specific offset after units.
- Layer map: 256 × 2 u32 pairs.
- String count: from header field (pre-V180) or embedded V180 field.
- `x27End`: from header field (version-conditional location).
- Implement `readLL()` helper and `readCond()` calls matching KiCad's exact field order.

The function signature:
```typescript
import { AllegroStream } from './allegro-stream';
import type { FileHeader } from './allegro-types';
import { FmtVer, BoardUnits, readCond } from './allegro-types';

export function parseHeader(stream: AllegroStream): FileHeader { ... }
export function formatFromMagic(magic: number): FmtVer { ... }
```

- [ ] **Step 2: Verify header parser compiles**

Run: `cd src/frontend && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-header.ts
git commit -m "feat(allegro): implement header parser with version detection"
```

---

### Task 4: Block Parsers

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-blocks.ts`

Transliterate all ~35 `ParseBlock_0xNN()` functions from KiCad's `allegro_parser.cpp`.

- [ ] **Step 1: Implement all block parser functions**

Each function reads fields in exact KiCad order with `readCond()` for version-conditional fields. The module exports a single dispatch function:

```typescript
import { AllegroStream } from './allegro-stream';
import { FmtVer, readCond, type AllegroBlock, type LayerInfo } from './allegro-types';

function parseLayerInfo(s: AllegroStream): LayerInfo {
  return { classCode: s.u8(), subclass: s.u8() };
}

// ... one function per block type (parseBlock0x01, parseBlock0x03, etc.) ...

/**
 * Parse one block from the stream. Returns the block, or null if end-of-objects (0x00 byte).
 * Throws on unknown block types.
 */
export function parseBlock(stream: AllegroStream, ver: FmtVer, x27End: number): AllegroBlock | null {
  const offset = stream.position;
  const type = stream.u8();
  if (type === 0x00) return null; // end marker

  switch (type) {
    case 0x01: return parseBlock0x01(stream, ver, offset);
    case 0x03: return parseBlock0x03(stream, ver, offset);
    // ... all types ...
    default: throw new Error(`Unknown block type 0x${type.toString(16).padStart(2,'0')} at offset 0x${offset.toString(16)}`);
  }
}
```

Implementation order within the file: follow KiCad's `allegro_parser.cpp` order (0x01, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x14, 0x15/16/17, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x26, 0x27, 0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x3B, 0x3C).

Critical notes per block type (from KiCad source):
- **0x03**: subType switch (0x64–0x78, 0x6C, 0x70/0x74, 0xF6) determines substruct format
- **0x07**: `m_InstRef16x` is `COND_LT(V172)`, `m_InstRef` doesn't exist in 0x07 — it's in 0x2D
- **0x08**: `m_Previous` and `m_StrPtr16x` are `COND_LT(V172)`, `m_StrPtr` is `COND_GE(V172)`
- **0x0C**: multiple conditional blocks for shape/drill fields
- **0x1C**: complex variable-size — fixed slots (10 pre-V172, 21 V172+), per-layer components (3 pre-V172, 4 V172+), trailing N-array
- **0x1F**: substruct size depends on version: `size * 240 + 4` (pre-V162), `size * 280 + 4` (V162+), `size * 280 + 8` (V172+), `size * 384 + 8` (V175+)
- **0x27**: skip to `x27End - 1` (the blob is mostly opaque)
- **0x2D**: `m_InstRef16x` is `COND_LT(V172)`, `m_InstRef` is `COND_GE(V172)`
- **0x30**: has font text properties inline (version-conditional)
- **0x31**: variable-length string field (`m_Len`)
- **0x32**: `m_NextInFp` is the field to follow for footprint pad chains (NOT `m_Next`)
- **0x33**: has separate `m_CoordsX/Y` fields (not just bbox)
- **0x35**: fixed-size raw content (no key field — uses offset as key)
- **0x36**: subcode switch (0x02–0x10) with different item layouts per code
- **0x37**: `m_Ptrs` is a fixed 100-element u32 array
- **0x38**: `m_FilmName` is `COND_LT(V172)` fixed 20-byte string
- **0x3B**: variable-length strings (`name` 128 bytes, `type` 32 bytes, `value` from `m_Len`)
- **0x3C**: variable-length entry array

- [ ] **Step 2: Verify block parsers compile**

Run: `cd src/frontend && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-blocks.ts
git commit -m "feat(allegro): implement all 35 block parser functions"
```

---

### Task 5: Object DB & String Table

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-db.ts`

- [ ] **Step 1: Implement AllegroDb class**

```typescript
import { AllegroStream } from './allegro-stream';
import type { FileHeader, AllegroBlock, LinkedList } from './allegro-types';
import { FmtVer } from './allegro-types';
import { parseHeader } from './allegro-header';
import { parseBlock } from './allegro-blocks';
import { log } from '../../store/log-store';

const dbg = log.parser;
const STRING_TABLE_OFFSET = 0x1200;
const MAX_LL_ITERATIONS = 1_000_000;

export class AllegroDb {
  readonly header: FileHeader;
  readonly strings = new Map<number, string>();
  readonly blocks = new Map<number, AllegroBlock>();

  constructor(buffer: ArrayBuffer) {
    const stream = new AllegroStream(buffer);

    // Phase 1: Parse header
    this.header = parseHeader(stream);
    dbg.info(`Allegro ${this.header.allegroVersion.trim()}, ${this.header.objectCount} objects, ${this.header.stringsCount} strings`);

    // Phase 2: Read string table
    this.readStrings(stream);

    // Phase 3: Read all blocks
    this.readBlocks(stream);

    dbg.info(`Parsed ${this.blocks.size} blocks, ${this.strings.size} strings`);
  }

  /** Resolve a string table reference */
  getString(key: number): string {
    return this.strings.get(key) ?? '';
  }

  /** Look up a block by key */
  getBlock(key: number): AllegroBlock | undefined {
    return this.blocks.get(key);
  }

  /** Look up a block by key, expecting a specific type */
  getBlockAs<T extends AllegroBlock>(key: number, expectedType: number): T | undefined {
    const block = this.blocks.get(key);
    if (!block || block.blockType !== expectedType) return undefined;
    return block as T;
  }

  /**
   * Walk a linked list from header.
   * Follows m_Next fields, stopping at tail key, 0, or iteration limit.
   */
  walkLinkedList(ll: LinkedList, getNext: (block: AllegroBlock) => number): AllegroBlock[] {
    const result: AllegroBlock[] = [];
    let currentKey = ll.head;
    let iterations = 0;

    while (currentKey !== 0 && currentKey !== ll.tail && iterations < MAX_LL_ITERATIONS) {
      const block = this.blocks.get(currentKey);
      if (!block) break;
      result.push(block);
      currentKey = getNext(block);
      iterations++;
    }

    return result;
  }

  private readStrings(stream: AllegroStream): void {
    stream.seek(STRING_TABLE_OFFSET);
    for (let i = 0; i < this.header.stringsCount; i++) {
      const id = stream.u32();
      const str = stream.cString(true);
      this.strings.set(id, str);
    }
  }

  private readBlocks(stream: AllegroStream): void {
    const ver = this.header.fmtVer;
    const x27End = this.header.x27End;
    let count = 0;

    while (!stream.eof) {
      // V180: skip zero-padded gaps
      if (ver >= FmtVer.V_180) {
        while (!stream.eof && stream.peekU8() === 0x00) {
          stream.skip(1);
          // Try to re-align to 4-byte boundary
          if (!stream.eof) {
            const nextByte = stream.peekU8();
            if (nextByte !== undefined && nextByte > 0x00 && nextByte <= 0x3C) {
              // Re-align
              const pos = stream.position;
              if (pos % 4 !== 0) {
                const alignedPos = pos - (pos % 4);
                stream.seek(alignedPos);
              }
              break;
            }
          }
        }
        if (stream.eof) break;
      }

      const block = parseBlock(stream, ver, x27End);
      if (block === null) {
        // 0x00 end marker
        if (ver >= FmtVer.V_180) {
          // V18: might be a gap, try to continue
          continue;
        }
        break;
      }

      this.blocks.set(block.key, block);
      count++;
    }

    dbg.info(`Read ${count} blocks from stream`);
  }
}
```

- [ ] **Step 2: Verify DB compiles**

Run: `cd src/frontend && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-db.ts
git commit -m "feat(allegro): implement Object DB with string table and block parsing"
```

---

### Task 6: Assembler (DB → BoardData)

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-assembler.ts`

- [ ] **Step 1: Implement the assembler**

This is the core logic that walks the resolved DB and produces `BoardData`. Reference: KiCad's `allegro_builder.cpp` and `allegro_db.cpp` visit methods.

```typescript
import type { BoardData, Part, Pin, Trace, Via, Point, BBox } from '../types';
import { computeBBox, buildNets } from '../types';
import { AllegroDb } from './allegro-db';
import type {
  AllegroBlock, LinkedList, LayerInfo,
  Blk0x04NetAssign, Blk0x05Track, Blk0x07ComponentInst,
  Blk0x08PinNumber, Blk0x0DPad, Blk0x11PinName,
  Blk0x15_16_17Segment, Blk0x01Arc, Blk0x1BNet,
  Blk0x28Shape, Blk0x2BFootprintDef, Blk0x2DFootprintInst,
  Blk0x32PlacedPad, Blk0x33Via, Blk0x2ALayerList,
} from './allegro-types';
import { LayerClass } from './allegro-types';
import { log } from '../../store/log-store';

const dbg = log.parser;

/** Get the m_Next field from any block that has one */
function getNext(block: AllegroBlock): number {
  return 'next' in block ? (block as any).next : 0;
}

export function assembleBoard(db: AllegroDb): BoardData {
  const div = db.header.unitsDivisor || 100;
  const toMils = (v: number) => v / div;

  // Build net name lookup: 0x1B key → net name
  const netNames = buildNetNameMap(db);

  // Build net assignment lookup: 0x04 key → net name
  const netAssignMap = buildNetAssignMap(db, netNames);

  // Extract components and pins
  const { parts, allPins } = extractComponents(db, div, netAssignMap);

  // Extract traces
  const traces = extractTraces(db, div, netAssignMap);

  // Extract vias
  const vias = extractVias(db, div, netAssignMap);

  // Extract board outline
  const outline = extractOutline(db, div);

  // Extract layer names
  const layerNames = extractLayerNames(db);

  // Build nets from pin assignments
  const nets = buildNets(parts);

  // Compute bounds from parts + outline
  const allPoints: Point[] = [...outline];
  for (const p of parts) {
    allPoints.push(p.origin);
    for (const pin of p.pins) allPoints.push(pin.position);
  }
  const bounds = computeBBox(allPoints);

  dbg.info(`Assembled: ${parts.length} parts, ${allPins} pins, ${nets.size} nets, ${traces.length} traces, ${vias.length} vias`);

  return {
    format: 'ALLEGRO_BRD',
    outline,
    parts,
    nails: [],
    nets,
    bounds,
    traces: traces.length > 0 ? traces : undefined,
    vias: vias.length > 0 ? vias : undefined,
    layerNames: layerNames.length > 0 ? layerNames : undefined,
  };
}

function buildNetNameMap(db: AllegroDb): Map<number, string> {
  const map = new Map<number, string>();
  const nets = db.walkLinkedList(db.header.LL_0x1B_Nets, getNext);
  for (const block of nets) {
    if (block.blockType !== 0x1B) continue;
    const net = block as Blk0x1BNet;
    const name = db.getString(net.netName);
    if (name) map.set(net.key, name);
  }
  return map;
}

function buildNetAssignMap(db: AllegroDb, netNames: Map<number, string>): Map<number, string> {
  const map = new Map<number, string>();
  // Walk all 0x04 blocks in DB
  for (const block of db.blocks.values()) {
    if (block.blockType !== 0x04) continue;
    const na = block as Blk0x04NetAssign;
    const netName = netNames.get(na.net) ?? '';
    if (netName) {
      map.set(na.key, netName);
      // Also map the connected item to this net
      map.set(na.connItem, netName);
    }
  }
  return map;
}

function extractComponents(
  db: AllegroDb, div: number, netAssignMap: Map<number, string>,
): { parts: Part[]; allPins: number } {
  const parts: Part[] = [];
  let allPins = 0;
  const toMils = (v: number) => v / div;

  // Walk 0x2B footprint def chain
  const fpDefs = db.walkLinkedList(db.header.LL_0x2B, getNext);

  for (const fpDef of fpDefs) {
    if (fpDef.blockType !== 0x2B) continue;
    const def = fpDef as Blk0x2BFootprintDef;

    // Walk 0x2D instance chain for this def
    let instKey = def.firstInstPtr;
    let instIter = 0;
    while (instKey && instIter < 100_000) {
      const inst = db.getBlockAs<Blk0x2DFootprintInst>(instKey, 0x2D);
      if (!inst) break;

      // Resolve refdes via 0x07
      const instRefKey = inst.instRef ?? inst.instRef16x;
      const compInst = instRefKey ? db.getBlockAs<Blk0x07ComponentInst>(instRefKey, 0x07) : undefined;
      const refdes = compInst ? db.getString(compInst.refDesStrPtr) : '';

      const side: 'top' | 'bottom' = inst.layer === 0 ? 'top' : 'bottom';
      const origin: Point = {
        x: toMils(inst.coordX),
        y: toMils(inst.coordY),
      };

      // Extract pins from 0x32 pad chain (follow nextInFp)
      const pins = extractPins(db, inst, div, netAssignMap);
      allPins += pins.length;

      // Determine type from pins (if any have through-hole pads)
      const type: 'smd' | 'throughhole' = 'smd'; // default, could check padstack

      const part: Part = {
        name: refdes || `FP_${inst.key.toString(16)}`,
        side,
        type,
        origin,
        pins,
        bounds: computePartBounds(origin, pins),
      };

      parts.push(part);
      instKey = inst.next;
      instIter++;
    }
  }

  return { parts, allPins };
}

function extractPins(
  db: AllegroDb, fpInst: Blk0x2DFootprintInst, div: number, netAssignMap: Map<number, string>,
): Pin[] {
  const pins: Pin[] = [];
  const toMils = (v: number) => v / div;
  const side: 'top' | 'bottom' = fpInst.layer === 0 ? 'top' : 'bottom';

  let padKey = fpInst.firstPadPtr;
  let iter = 0;
  const visited = new Set<number>();

  while (padKey && iter < 50_000) {
    if (visited.has(padKey)) break;
    visited.add(padKey);

    const pad = db.getBlockAs<Blk0x32PlacedPad>(padKey, 0x32);
    if (!pad) break;

    // Get pin position from 0x0D PAD block (board-absolute coords)
    let x: number, y: number;
    const padDef = pad.padPtr ? db.getBlockAs<Blk0x0DPad>(pad.padPtr, 0x0D) : undefined;
    if (padDef) {
      x = toMils(padDef.coordsX);
      y = toMils(padDef.coordsY);
    } else {
      // Fallback: bbox midpoint
      x = toMils((pad.coords[0] + pad.coords[2]) / 2);
      y = toMils((pad.coords[1] + pad.coords[3]) / 2);
    }

    // Get pin name/number
    let pinName = '';
    let pinNumber = '';
    if (pad.ptrPinNumber) {
      const pinNum = db.getBlockAs<Blk0x08PinNumber>(pad.ptrPinNumber, 0x08);
      if (pinNum) {
        // Pin number string
        const strKey = pinNum.strPtr ?? pinNum.strPtr16x;
        if (strKey) pinNumber = db.getString(strKey);
        // Pin name via 0x11
        if (pinNum.pinNamePtr) {
          const pn = db.getBlockAs<Blk0x11PinName>(pinNum.pinNamePtr, 0x11);
          if (pn) pinName = db.getString(pn.pinNameStrPtr);
        }
      }
    }

    // Net assignment
    const netName = netAssignMap.get(pad.netPtr) ?? netAssignMap.get(pad.key) ?? '';

    // Pin radius from bbox
    const pw = Math.abs(pad.coords[2] - pad.coords[0]) * (1 / div);
    const ph = Math.abs(pad.coords[3] - pad.coords[1]) * (1 / div);
    const radius = Math.max(Math.min(Math.max(pw, ph) / 2, 30), 3);

    pins.push({
      name: pinName || pinNumber,
      number: pinNumber || pinName,
      position: { x, y },
      radius,
      side,
      net: netName,
    });

    padKey = pad.nextInFp; // Follow footprint pad chain
    iter++;
  }

  return pins;
}

function extractTraces(db: AllegroDb, div: number, netAssignMap: Map<number, string>): Trace[] {
  const traces: Trace[] = [];
  const toMils = (v: number) => v / div;

  for (const block of db.blocks.values()) {
    if (block.blockType !== 0x05) continue;
    const track = block as Blk0x05Track;

    // Only ETCH class tracks
    if (track.layer.classCode !== LayerClass.ETCH) continue;

    const netName = netAssignMap.get(track.netAssignment) ?? '';
    const layerIdx = track.layer.subclass;

    // Walk segment chain
    let segKey = track.firstSegPtr;
    let iter = 0;
    const visited = new Set<number>();

    while (segKey && iter < 100_000) {
      if (visited.has(segKey)) break;
      visited.add(segKey);

      const seg = db.getBlock(segKey);
      if (!seg) break;

      if (seg.blockType === 0x15 || seg.blockType === 0x16 || seg.blockType === 0x17) {
        const s = seg as Blk0x15_16_17Segment;
        const width = toMils(s.width);
        if (width > 0) {
          traces.push({
            start: { x: toMils(s.startX), y: toMils(s.startY) },
            end: { x: toMils(s.endX), y: toMils(s.endY) },
            width,
            net: netName,
            layer: layerIdx,
          });
        }
        segKey = s.next;
      } else if (seg.blockType === 0x01) {
        const arc = seg as Blk0x01Arc;
        // Linearize arc into line segments
        const arcTraces = linearizeArc(arc, div, netName, layerIdx);
        traces.push(...arcTraces);
        segKey = arc.next;
      } else {
        break;
      }
      iter++;
    }
  }

  return traces;
}

function linearizeArc(
  arc: Blk0x01Arc, div: number, net: string, layer: number,
): Trace[] {
  const toMils = (v: number) => v / div;
  const cx = arc.centerX / div; // AllegroFloat already in internal units
  const cy = arc.centerY / div;
  const r = arc.radius / div;
  const width = toMils(arc.width);

  if (r <= 0 || width <= 0) return [];

  const sx = toMils(arc.startX);
  const sy = toMils(arc.startY);
  const ex = toMils(arc.endX);
  const ey = toMils(arc.endY);

  // Calculate angles
  const startAngle = Math.atan2(sy - cy, sx - cx);
  const endAngle = Math.atan2(ey - cy, ex - cx);

  // Determine sweep direction from subType bit 6
  const clockwise = (arc.subType & 0x40) !== 0;

  let sweep = endAngle - startAngle;
  if (clockwise) {
    if (sweep > 0) sweep -= 2 * Math.PI;
  } else {
    if (sweep < 0) sweep += 2 * Math.PI;
  }

  const segments = Math.max(Math.ceil(Math.abs(sweep) / (Math.PI / 18)), 2); // ~10° per segment
  const traces: Trace[] = [];

  for (let i = 0; i < segments; i++) {
    const a1 = startAngle + (sweep * i) / segments;
    const a2 = startAngle + (sweep * (i + 1)) / segments;
    traces.push({
      start: { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) },
      end: { x: cx + r * Math.cos(a2), y: cy + r * Math.sin(a2) },
      width,
      net,
      layer,
    });
  }

  return traces;
}

function extractVias(db: AllegroDb, div: number, netAssignMap: Map<number, string>): Via[] {
  const vias: Via[] = [];
  const toMils = (v: number) => v / div;

  for (const block of db.blocks.values()) {
    if (block.blockType !== 0x33) continue;
    const via = block as Blk0x33Via;

    const x = toMils(via.coordsX);
    const y = toMils(via.coordsY);
    const netName = netAssignMap.get(via.netPtr) ?? '';

    // Diameter from bbox
    const bw = Math.abs(via.bbox[2] - via.bbox[0]) * (1 / div);
    const bh = Math.abs(via.bbox[3] - via.bbox[1]) * (1 / div);
    const diameter = Math.max(bw, bh);

    vias.push({
      position: { x, y },
      diameter: diameter || 10, // fallback
      net: netName,
      layers: [], // through-hole (all layers)
    });
  }

  return vias;
}

function extractOutline(db: AllegroDb, div: number): Point[] {
  const toMils = (v: number) => v / div;
  const points: Point[] = [];

  // Walk 0x28 shapes on Shapes linked list
  const shapes = db.walkLinkedList(db.header.LL_Shapes, getNext);

  for (const block of shapes) {
    if (block.blockType !== 0x28) continue;
    const shape = block as Blk0x28Shape;

    // Check for outline: BOUNDARY class, or BOARD_GEOMETRY/DRAWING_FORMAT with outline subclass
    const isOutline =
      shape.layer.classCode === LayerClass.BOUNDARY ||
      ((shape.layer.classCode === LayerClass.BOARD_GEOMETRY || shape.layer.classCode === LayerClass.DRAWING_FORMAT) &&
        (shape.layer.subclass === 0xEA || shape.layer.subclass === 0xFD));

    if (!isOutline) continue;

    // Walk segment chain to build outline
    let segKey = shape.firstSegmentPtr;
    let iter = 0;
    const visited = new Set<number>();

    while (segKey && iter < 100_000) {
      if (visited.has(segKey)) break;
      visited.add(segKey);

      const seg = db.getBlock(segKey);
      if (!seg) break;

      if (seg.blockType === 0x15 || seg.blockType === 0x16 || seg.blockType === 0x17) {
        const s = seg as Blk0x15_16_17Segment;
        if (points.length === 0) {
          points.push({ x: toMils(s.startX), y: toMils(s.startY) });
        }
        points.push({ x: toMils(s.endX), y: toMils(s.endY) });
        segKey = s.next;
      } else if (seg.blockType === 0x01) {
        const arc = seg as Blk0x01Arc;
        // Linearize arc points for outline
        const cx = arc.centerX / div;
        const cy = arc.centerY / div;
        const r = arc.radius / div;
        const sx = toMils(arc.startX);
        const sy = toMils(arc.startY);
        const ex = toMils(arc.endX);
        const ey = toMils(arc.endY);

        if (r > 0) {
          const startAngle = Math.atan2(sy - cy, sx - cx);
          const endAngle = Math.atan2(ey - cy, ex - cx);
          const clockwise = (arc.subType & 0x40) !== 0;
          let sweep = endAngle - startAngle;
          if (clockwise) { if (sweep > 0) sweep -= 2 * Math.PI; }
          else { if (sweep < 0) sweep += 2 * Math.PI; }

          const segments = Math.max(Math.ceil(Math.abs(sweep) / (Math.PI / 18)), 2);
          for (let i = 1; i <= segments; i++) {
            const a = startAngle + (sweep * i) / segments;
            points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
          }
        }
        segKey = arc.next;
      } else {
        break;
      }
      iter++;
    }

    if (points.length > 0) break; // Use first outline found
  }

  return points;
}

function extractLayerNames(db: AllegroDb): string[] {
  const names: string[] = [];
  // Find ETCH class layer list from header layer map
  const etchEntry = db.header.layerMap[LayerClass.ETCH];
  if (!etchEntry?.layerList0x2A) return names;

  const layerList = db.getBlockAs<Blk0x2ALayerList>(etchEntry.layerList0x2A, 0x2A);
  if (!layerList) return names;

  if (layerList.nonRefEntries) {
    for (const entry of layerList.nonRefEntries) {
      names.push(entry.name);
    }
  } else if (layerList.refEntries) {
    for (const entry of layerList.refEntries) {
      names.push(db.getString(entry.layerNameId));
    }
  }

  return names;
}

function computePartBounds(origin: Point, pins: Pin[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (pins.length === 0) {
    return { minX: origin.x - 10, minY: origin.y - 10, maxX: origin.x + 10, maxY: origin.y + 10 };
  }
  let minX = origin.x, minY = origin.y, maxX = origin.x, maxY = origin.y;
  for (const pin of pins) {
    minX = Math.min(minX, pin.position.x - pin.radius);
    minY = Math.min(minY, pin.position.y - pin.radius);
    maxX = Math.max(maxX, pin.position.x + pin.radius);
    maxY = Math.max(maxY, pin.position.y + pin.radius);
  }
  return { minX, minY, maxX, maxY };
}
```

- [ ] **Step 2: Verify assembler compiles**

Run: `cd src/frontend && npx tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-assembler.ts
git commit -m "feat(allegro): implement assembler (DB → BoardData)"
```

---

### Task 7: Entry Point & Integration

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-brd-parser.ts`
- Modify: `src/frontend/src/parsers/allegro-brd-format.ts`

- [ ] **Step 1: Wire up the entry point**

Replace the stub in `allegro-brd-parser.ts`:

```typescript
/**
 * Cadence Allegro BRD Binary Parser — v2
 *
 * Field-by-field Object DB architecture derived from KiCad 10's
 * open-source Allegro importer (GPL-3.0). Supports versions 16.0–18.0+.
 *
 * Reference: https://gitlab.com/kicad/code/kicad — pcbnew/pcb_io/allegro/
 */

import type { BoardData } from '../types';
import { AllegroDb } from './allegro-db';
import { assembleBoard } from './allegro-assembler';

export function parseAllegroBRD(buffer: ArrayBuffer): BoardData {
  const db = new AllegroDb(buffer);
  return assembleBoard(db);
}
```

- [ ] **Step 2: Update allegro-brd-format.ts**

Ensure the import path and detect function are correct (from Task 1 Step 3). Also add `hasLayers: false` (layers off by default):

The `detect()` function should accept 0x0015 (v18):
```typescript
detect(header: Uint8Array): boolean {
  if (header.length < 12) return false;
  const magic = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
  const family = (magic >>> 16) & 0xFFFF;
  if (family !== 0x0013 && family !== 0x0014 && family !== 0x0015) return false;
  const check = header[8] | (header[9] << 8) | (header[10] << 16) | (header[11] << 24);
  return check === 1;
},
```

- [ ] **Step 3: Verify full project compiles**

Run: `cd src/frontend && npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/parsers/allegro/
git add src/frontend/src/parsers/allegro-brd-format.ts
git commit -m "feat(allegro): wire up new parser entry point"
```

---

### Task 8: Tests — Run Existing, Add New

**Files:**
- Modify: `src/frontend/tests/allegro-brd-parser.spec.ts`

- [ ] **Step 1: Run existing tests to establish baseline**

Run: `cd src/frontend && npx playwright test tests/allegro-brd-parser.spec.ts --reporter=list`

Expected: Tests should run. Some may fail initially if the new parser extracts different data than the old one. Record the results.

- [ ] **Step 2: Update test imports if needed**

The tests import `parseAllegroBRD` from `../src/parsers/allegro-brd-parser` — this path no longer exists. Update to:

```typescript
const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
```

Also update the format import if tests reference `allegro-brd-format`:
```typescript
const { AllegroBRDFormat } = await import('../src/parsers/allegro-brd-format');
```

- [ ] **Step 3: Add new test assertions**

Add to the existing test file:

```typescript
test('Allegro Y0D (v16.5) — pins have valid positions and net assignments', async () => {
  const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
  const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const board = parseAllegroBRD(ab);

  // Should extract significantly more pins than old parser
  const totalPins = board.parts.reduce((sum, p) => sum + p.pins.length, 0);
  expect(totalPins).toBeGreaterThan(500);

  // All pin positions should be finite
  for (const part of board.parts) {
    for (const pin of part.pins) {
      expect(Number.isFinite(pin.position.x)).toBe(true);
      expect(Number.isFinite(pin.position.y)).toBe(true);
      expect(pin.radius).toBeGreaterThan(0);
    }
  }

  // Should have some net assignments
  const assignedPins = board.parts.flatMap(p => p.pins).filter(p => p.net !== '');
  expect(assignedPins.length).toBeGreaterThan(100);
});

test('Allegro Y0D — traces extracted', async () => {
  const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
  const filePath = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
  const buf = fs.readFileSync(filePath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const board = parseAllegroBRD(ab);

  expect(board.traces).toBeDefined();
  expect(board.traces!.length).toBeGreaterThan(100);

  // All traces should have valid geometry
  for (const trace of board.traces!.slice(0, 100)) {
    expect(Number.isFinite(trace.start.x)).toBe(true);
    expect(Number.isFinite(trace.end.x)).toBe(true);
    expect(trace.width).toBeGreaterThan(0);
  }
});

test('Allegro BRD format detection — v17.5 and v18.0 magic accepted', async () => {
  const { AllegroBRDFormat } = await import('../src/parsers/allegro-brd-format');

  // v17.5
  const h175 = new Uint8Array(512);
  const dv175 = new DataView(h175.buffer);
  dv175.setUint32(0, 0x00141500, true);
  dv175.setUint32(8, 1, true);
  expect(AllegroBRDFormat.detect(h175)).toBe(true);

  // v18.0
  const h180 = new Uint8Array(512);
  const dv180 = new DataView(h180.buffer);
  dv180.setUint32(0, 0x00150000, true);
  dv180.setUint32(8, 1, true);
  expect(AllegroBRDFormat.detect(h180)).toBe(true);
});
```

- [ ] **Step 4: Run all tests**

Run: `cd src/frontend && npx playwright test tests/allegro-brd-parser.spec.ts --reporter=list`

Fix any failures. Common issues:
- Import paths
- Property access on undefined blocks (add null checks)
- Coordinate scale differences (old parser used hardcoded ÷100)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/tests/allegro-brd-parser.spec.ts
git commit -m "test(allegro): update tests for new parser, add pin/trace/detection tests"
```

---

### Task 9: Replace Format Spec Doc

**Files:**
- Replace: `docs/formats/ALLEGRO_BRD_FORMAT.md`

- [ ] **Step 1: Write new format spec**

Replace `docs/formats/ALLEGRO_BRD_FORMAT.md` with a comprehensive spec based on KiCad's FORMAT.md, adapted for BoardRipper. Include:

1. Attribution (KiCad GPL-3.0 reverse engineering)
2. File layout (header, strings, blocks)
3. Version detection table
4. Coordinate system (unitsDivisor, Y-flip, AllegroFloat for arcs)
5. Block type reference table (all 35 types)
6. Layer encoding (class + subclass)
7. Header linked lists
8. Key data extraction chains (components, pins, nets, traces)
9. Board outline detection

- [ ] **Step 2: Commit**

```bash
git add docs/formats/ALLEGRO_BRD_FORMAT.md
git commit -m "docs: replace Allegro BRD format spec with KiCad-derived documentation"
```

---

### Task 10: Final Validation & Cleanup

- [ ] **Step 1: Run full test suite**

Run: `cd src/frontend && npx playwright test --reporter=list`

All tests should pass including existing visual/browser tests.

- [ ] **Step 2: Run TypeScript strict mode check**

Run: `cd src/frontend && npx tsc --noEmit`

No errors.

- [ ] **Step 3: Test with all sample files manually (dev server)**

```bash
cd src/frontend && npm run dev
```

Open browser, upload each sample file from `samples/allegroBRD/`:
- Quanta Y0D (v16.5)
- Acer Z8IA (v17.2)
- Quanta Z8I (v17.2)

Verify: components render, pins visible, net highlighting works, traces visible.

- [ ] **Step 4: Delete archived old parser**

```bash
rm -rf src/frontend/src/parsers/_archive
```

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Allegro BRD parser rewrite — KiCad-derived Object DB architecture

Replaces heuristic fixed-size-table parser with field-by-field parsing
of all 35 block types. Supports versions 16.0–18.0+. Uses Object DB
pattern: parse all blocks into key→object Map, then walk linked lists
to assemble BoardData.

Key improvements:
- Correct coordinate scaling via unitsDivisor from header
- Complete pin/net extraction via 0x32 pad chains
- Via extraction (0x33 blocks)
- Arc support in traces and outlines
- Board outline from 0x28 BOUNDARY shapes
- Version-conditional field parsing (no fixed-size table)

Based on KiCad 10 Allegro importer reverse engineering (GPL-3.0).
TypeScript implementation is original code."
```
