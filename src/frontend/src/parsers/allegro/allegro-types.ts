/**
 * Allegro BRD binary format types.
 * Derived from KiCad 10's reverse-engineered Allegro importer (GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 *
 * Field ordering and version conditions are cross-verified against:
 *   kicad-source-mirror/pcbnew/pcb_io/allegro/convert/allegro_pcb_structs.h
 *   kicad-source-mirror/pcbnew/pcb_io/allegro/convert/allegro_parser.cpp
 */

// ── Version ─────────────────────────────────────────────────────────────────

/** Format version — determines struct field layouts */
export const enum FmtVer {
  V_PRE_V16 = -1, // Pre-v16 Allegro (unsupported binary format)
  V_UNKNOWN = 0,
  V_160 = 1,  // 0x00130000
  V_162 = 2,  // 0x00130400
  V_164 = 3,  // 0x00130C00
  V_165 = 4,  // 0x00131000
  V_166 = 5,  // 0x00131500
  V_172 = 6,  // 0x00140400–0x00140700
  V_174 = 7,  // 0x00140900, 0x00140E00
  V_175 = 8,  // 0x00141500
  V_180 = 9,  // 0x00150000
}

// ── Layer ────────────────────────────────────────────────────────────────────

/** 2-byte layer encoding: class + subclass */
export interface LayerInfo {
  classCode: number; // u8
  subclass: number;  // u8
}

/** Layer class codes */
export const enum LayerClass {
  BOARD_GEOMETRY   = 0x01,
  COMPONENT_VALUE  = 0x02,
  DEVICE_TYPE      = 0x03,
  DRAWING_FORMAT   = 0x04,
  DRC_ERROR        = 0x05,
  ETCH             = 0x06,
  MANUFACTURING    = 0x07,
  ANALYSIS         = 0x08,
  PACKAGE_GEOMETRY = 0x09,
  PACKAGE_KEEPIN   = 0x0A,
  PACKAGE_KEEPOUT  = 0x0B,
  PIN              = 0x0C,
  REF_DES          = 0x0D,
  ROUTE_KEEPIN     = 0x0E,
  ROUTE_KEEPOUT    = 0x0F,
  TOLERANCE        = 0x10,
  USER_PART_NUMBER = 0x11,
  VIA_CLASS        = 0x12,
  VIA_KEEPOUT      = 0x13,
  ANTI_ETCH        = 0x14,
  BOUNDARY         = 0x15,
}

// ── Header ───────────────────────────────────────────────────────────────────

/** Header linked list descriptor */
export interface LinkedList {
  head: number; // chain start key
  tail: number; // sentinel/end key
}

/** Board unit types */
export const enum BoardUnits {
  MILS         = 0x01,
  INCHES       = 0x02,
  MILLIMETERS  = 0x03,
  CENTIMETERS  = 0x04,
  MICROMETERS  = 0x05,
}

/** Parsed file header (version-conditional fields are optional) */
export interface FileHeader {
  magic: number;
  fmtVer: FmtVer;
  objectCount: number;
  allegroVersion: string; // 60-byte fixed string
  boardUnits: BoardUnits;
  unitsDivisor: number;
  maxKey: number;
  stringsCount: number;
  x27End: number;

  // Standard linked lists (all versions)
  LL_0x04:           LinkedList; // Net assignments
  LL_0x06:           LinkedList; // Component definitions
  LL_0x0C:           LinkedList; // Pin definitions
  LL_Shapes:         LinkedList; // Shapes (0x0E, 0x28)
  LL_0x14:           LinkedList; // Graphics
  LL_0x1B_Nets:      LinkedList; // Nets
  LL_0x1C:           LinkedList; // Padstacks
  LL_0x24_0x28:      LinkedList; // Rects and shapes
  LL_Unknown1:       LinkedList;
  LL_0x2B:           LinkedList; // Footprint definitions
  LL_0x03_0x30:      LinkedList; // Fields and string wrappers
  LL_0x0A:           LinkedList; // DRC elements
  LL_0x1D_0x1E_0x1F: LinkedList; // Constraint sets, SI models, padstack dims
  LL_Unknown2:       LinkedList;
  LL_0x38:           LinkedList; // Films
  LL_0x2C:           LinkedList; // Tables
  LL_0x0C_2:         LinkedList; // Secondary pin definitions
  LL_Unknown3:       LinkedList;
  LL_0x36:           LinkedList;
  LL_Unknown6:       LinkedList;
  LL_0x0A_2:         LinkedList;

  // V180-only extra linked lists (at start of LL section)
  LL_V18_1?: LinkedList;
  LL_V18_2?: LinkedList;
  LL_V18_3?: LinkedList;
  LL_V18_4?: LinkedList;
  LL_V18_5?: LinkedList;
  LL_V18_6?: LinkedList; // after the main 18 LL block

  // x35 file-ref range
  x35Start: number;
  x35End: number;

  // Layer map: 25 entries of (a, layerList0x2A) u32 pairs
  layerMap: Array<{ a: number; layerList0x2A: number }>;
}

// ── Version-conditional helper ───────────────────────────────────────────────

/**
 * Read a version-conditional field.
 * Returns the reader result if the version satisfies the condition, undefined otherwise.
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

// ── Block base ───────────────────────────────────────────────────────────────

/** Base block fields present in every parsed block */
export interface BlockBase {
  blockType: number; // 0x01–0x3C
  offset: number;    // file position (bytes)
  key: number;       // unique object key in the DB
}

// ── Block data interfaces ────────────────────────────────────────────────────
// Field order matches KiCad's ParseBlock_* functions exactly.
// Optional fields (?) are present only in the indicated version range.

// --- 0x01 ARC ---
/** Arc segment. Bit 6 of subType (0x40) = clockwise sweep. */
export interface Blk0x01Arc extends BlockBase {
  blockType: 0x01;
  unknownByte: number; // u8 (skip 1 before this in parser)
  subType: number;     // u8; bit 6 = CW direction
  next: number;        // u32
  parent: number;      // u32
  unknown1: number;    // u32
  unknown6?: number;   // u32; >= V172
  width: number;       // u32
  startX: number;      // s32
  startY: number;      // s32
  endX: number;        // s32
  endY: number;        // s32
  centerX: number;     // f64 (allegroFloat)
  centerY: number;     // f64 (allegroFloat)
  radius: number;      // f64 (allegroFloat)
  bbox: [number, number, number, number]; // 4 × s32
}

// --- 0x03 FIELD ---
/** Field/property reference with variable-typed substruct. */
export interface Blk0x03Field extends BlockBase {
  blockType: 0x03;
  hdr1: number;       // u16
  next: number;       // u32
  unknown1?: number;  // u32; >= V172
  subType: number;    // u8
  hdr2: number;       // u8
  size: number;       // u16
  unknown2?: number;  // u32; >= V172
  substruct: Blk0x03Substruct;
}

export type Blk0x03Substruct =
  | { kind: 'u32'; value: number }
  | { kind: 'u32x2'; values: [number, number] }
  | { kind: 'string'; value: string }
  | { kind: '0x6C'; numEntries: number; entries: number[] }
  | { kind: '0x70_0x74'; x0: number; x1: number; entries: number[] }
  | { kind: '0xF6'; entries: number[] /* 20 × u32 */ }
  | { kind: 'empty' };

// --- 0x04 NET_ASSIGN ---
/** Net assignment linking a net (0x1B) to a connected item. */
export interface Blk0x04NetAssign extends BlockBase {
  blockType: 0x04;
  type: number;        // u8
  r: number;           // u16
  next: number;        // u32
  net: number;         // u32; key → 0x1B NET
  connItem: number;    // u32; key → 0x05/0x32/0x33/0x28
  unknown?: number;    // u32; >= V174
}

// --- 0x05 TRACK ---
/** Track segment container with layer, net, and segment chain. */
export interface Blk0x05Track extends BlockBase {
  blockType: 0x05;
  layer: LayerInfo;
  next: number;
  netAssignment: number;  // u32; → 0x04
  unknownPtr1: number;    // u32
  unknown2: number;       // u32
  unknown3: number;       // u32
  unknownPtr2a: number;   // u32
  unknownPtr2b: number;   // u32
  unknown4: number;       // u32
  unknownPtr3a: number;   // u32
  unknownPtr3b: number;   // u32
  unknown5a?: number;     // u32; >= V172
  unknown5b?: number;     // u32; >= V172
  firstSegPtr: number;    // u32; → 0x15/0x16/0x17/0x01 chain
  unknownPtr5: number;    // u32
  unknown6: number;       // u32
}

// --- 0x06 COMPONENT ---
/** Component/symbol definition. */
export interface Blk0x06Component extends BlockBase {
  blockType: 0x06;
  next: number;
  compDeviceType: number; // u32; str ref
  symbolName: number;     // u32; str ref
  firstInstPtr: number;   // u32; → 0x07 chain
  ptrFunctionSlot: number; // u32; → 0x0F
  ptrPinNumber: number;   // u32; → 0x08
  fields: number;         // u32; → 0x03 chain
  unknown1?: number;      // u32; >= V172
}

// --- 0x07 COMPONENT_INST ---
/** Component instance reference. */
export interface Blk0x07ComponentInst extends BlockBase {
  blockType: 0x07;
  next: number;
  unknownPtr1?: number; // u32; >= V172
  unknown2?: number;    // u32; >= V172
  unknown3?: number;    // u32; >= V172
  fpInstPtr: number;    // u32; → 0x2D
  unknown4?: number;    // u32; < V172
  refDesStrPtr: number; // u32; str ref → refdes
  functionInstPtr: number; // u32; → 0x10
  x03Ptr: number;       // u32; → 0x03 or null
  unknown5: number;     // u32
  firstPadPtr: number;  // u32; → 0x32 chain
}

// --- 0x08 PIN_NUMBER ---
/** Pin number within a component. */
export interface Blk0x08PinNumber extends BlockBase {
  blockType: 0x08;
  type: number;          // u8
  r: number;             // u16
  previous?: number;     // u32; >= V172
  strPtr16x?: number;    // u32; < V172 (str ref for pin number string)
  next: number;          // u32
  strPtr?: number;       // u32; >= V172 (str ref for pin number string)
  pinNamePtr: number;    // u32; → 0x11 PIN_NAME
  unknown1?: number;     // u32; >= V172
  ptr4: number;          // u32
}

// --- 0x09 FILL_LINK ---
/** Intermediate link between copper fills and parent shapes. */
export interface Blk0x09FillLink extends BlockBase {
  blockType: 0x09;
  unknownArray: [number, number, number, number]; // 4 × u32
  unknown1?: number;   // u32; >= V172
  unknownPtr1: number; // u32
  unknownPtr2: number; // u32
  unknown2: number;    // u32
  unknownPtr3: number; // u32
  unknownPtr4: number; // u32
  unknown3?: number;   // u32; >= V174
}

// --- 0x0A DRC ---
/** DRC design rule check element. */
export interface Blk0x0ADrc extends BlockBase {
  blockType: 0x0A;
  t: number;
  layer: LayerInfo;
  next: number;
  unknown1: number;   // u32
  unknown2?: number;  // u32; >= V172
  coords: [number, number, number, number]; // 4 × s32
  unknown4: [number, number, number, number]; // 4 × u32
  unknown5: [number, number, number, number, number]; // 5 × u32
  unknown6?: number;  // u32; >= V174
}

// --- 0x0C PIN_DEF ---
/** Pin definition with shape, drill, and coordinate data. */
export interface Blk0x0CPinDef extends BlockBase {
  blockType: 0x0C;
  t: number;
  layer: LayerInfo;
  next: number;
  unknown1: number;      // u32
  unknown2: number;      // u32
  // Pre-V172 packed format
  shape?: number;        // u8; < V172
  drillChar?: number;    // u8; < V172
  unknownPadding?: number; // u16; < V172
  // V172+ expanded format
  shape16x?: number;     // u32; >= V172
  drillChars?: number;   // u32; >= V172
  unknown_16x?: number;  // u32; >= V172
  unknown4: number;      // u32
  unknown5?: number;     // u32; >= V180
  coords: [number, number]; // 2 × s32
  size: [number, number];   // 2 × s32
  groupPtr: number;      // u32
  unknown6: number;      // u32
  unknown7: number;      // u32
  unknown8?: number;     // u32; >= V174, < V180
}

// --- 0x0D PAD ---
/** Pad geometry and placement (board-absolute coordinates). */
export interface Blk0x0DPad extends BlockBase {
  blockType: 0x0D;
  nameStrId: number;  // u32; str ref → pad name
  next: number;       // u32
  unknown1?: number;  // u32; >= V174
  coordsX: number;    // s32; board-absolute
  coordsY: number;    // s32; board-absolute
  padStack: number;   // u32; → 0x1C PADSTACK
  unknown2: number;   // u32
  unknown3?: number;  // u32; >= V172
  flags: number;      // u32
  rotation: number;   // u32; millidegrees, board-absolute
}

// --- 0x0E RECT ---
/** Rectangular shape. */
export interface Blk0x0ERect extends BlockBase {
  blockType: 0x0E;
  t: number;
  layer: LayerInfo;
  next: number;
  fpPtr: number;      // u32
  unknown1: number;   // u32
  unknown2: number;   // u32
  unknown3: number;   // u32
  unknown4?: number;  // u32; >= V172
  unknown5?: number;  // u32; >= V172
  coords: [number, number, number, number]; // 4 × s32
  unknownArr: [number, number, number]; // 3 × u32
  rotation: number;   // u32; millidegrees
}

// --- 0x0F FUNCTION_SLOT ---
/** Function slot in a multi-slot component. */
export interface Blk0x0FFunctionSlot extends BlockBase {
  blockType: 0x0F;
  slotName: number;       // u32; str ref
  compDeviceType: Uint8Array; // 32 raw bytes
  ptr0x06: number;        // u32; → 0x06
  ptr0x11: number;        // u32; → 0x11
  unknown1: number;       // u32
  unknown2?: number;      // u32; >= V172
  unknown3?: number;      // u32; >= V174
}

// --- 0x10 FUNCTION_INST ---
/** Function instance. */
export interface Blk0x10FunctionInst extends BlockBase {
  blockType: 0x10;
  unknown1?: number;      // u32; >= V172
  componentInstPtr: number; // u32; → 0x07
  unknown2?: number;      // u32; >= V174
  ptrX12: number;         // u32; → 0x12
  unknown3: number;       // u32
  functionName: number;   // u32; str ref
  slots: number;          // u32; → 0x0F
  fields: number;         // u32
}

// --- 0x11 PIN_NAME ---
/** Pin name within a component. */
export interface Blk0x11PinName extends BlockBase {
  blockType: 0x11;
  type: number;           // u8
  r: number;              // u16
  pinNameStrPtr: number;  // u32; str ref
  next: number;           // u32; → next 0x11 or 0x0F
  pinNumberPtr: number;   // u32; → 0x08 PIN_NUMBER
  unknown1: number;       // u32
  unknown2?: number;      // u32; >= V174
}

// --- 0x12 XREF ---
/** Cross-reference between objects. */
export interface Blk0x12Xref extends BlockBase {
  blockType: 0x12;
  type: number;     // u8
  r: number;        // u16
  ptr1: number;     // u32
  ptr2: number;     // u32
  ptr3: number;     // u32
  unknown1: number; // u32
  unknown2?: number; // u32; >= V165
  unknown3?: number; // u32; >= V174
}

// --- 0x14 GRAPHIC ---
/** Graphics container holding segment/arc chains. */
export interface Blk0x14Graphic extends BlockBase {
  blockType: 0x14;
  type: number;
  layer: LayerInfo;
  next: number;
  parent: number;
  flags: number;
  unknown2?: number;  // u32; >= V172
  segmentPtr: number; // u32; → 0x15/0x16/0x17/0x01 chain head
  ptr0x03: number;    // u32
  ptr0x26: number;    // u32
}

// --- 0x15 / 0x16 / 0x17 SEGMENT ---
/** Line segment (0x15=horizontal, 0x16=diagonal, 0x17=vertical). */
export interface Blk0x15_16_17Segment extends BlockBase {
  blockType: 0x15 | 0x16 | 0x17;
  next: number;
  parent: number;
  flags: number;
  unknown2?: number; // u32; >= V172
  width: number;     // u32
  startX: number;    // s32
  startY: number;    // s32
  endX: number;      // s32
  endY: number;      // s32
}

// --- 0x1B NET ---
/** Net definition. */
export interface Blk0x1BNet extends BlockBase {
  blockType: 0x1B;
  next: number;
  netName: number;        // u32; str ref
  unknown1: number;       // u32
  unknown2?: number;      // u32; >= V172
  type: number;           // u32
  assignment: number;     // u32; → 0x04 chain head
  ratline: number;        // u32
  fieldsPtr: number;      // u32; → 0x03 FIELD chain
  matchGroupPtr: number;  // u32; → 0x26 or 0x2C
  modelPtr: number;       // u32
  unknownPtr4: number;    // u32
  unknownPtr5: number;    // u32
  unknownPtr6: number;    // u32
}

// --- 0x1C PADSTACK (variable-size) ---
/** Padstack definition with per-layer component table. */
export interface Blk0x1CPadstack extends BlockBase {
  blockType: 0x1C;
  unknownByte1: number;   // u8
  n: number;              // u8; drives unknownArrN size
  unknownByte2: number;   // u8
  next: number;           // u32
  padStr: number;         // u32; str ref → padstack name
  drill: number;          // u32; drill diameter (pre-V172) or still present
  unknown2: number;       // u32
  padPath: number;        // u32
  // Pre-V172 extras
  unknown3?: number;      // u32; < V172
  unknown4?: number;      // u32; < V172
  unknown5?: number;      // u32; < V172
  unknown6?: number;      // u32; < V172
  padType: number;        // extracted from high nibble of type byte
  a: number;              // low nibble of type byte
  b: number;              // u8
  flags: number;          // u8; PAD_FLAGS bitmask
  d: number;              // u8
  // V172+
  unknown7?: number;      // u32; >= V172
  unknown8?: number;      // u32; >= V172
  unknown9?: number;      // u32; >= V172
  // < V172
  unknown10?: number;     // u16; < V172
  layerCount: number;     // u16
  unknown11?: number;     // u16; >= V172
  drillArr: [number, number, number, number, number, number, number, number]; // 8 × u32
  slotAndUnknownArr?: [
    number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number,
    number, number, number, number, number, number, number, number,
    number, number, number, number,
  ]; // 28 × u32; >= V172
  unknown12?: number;     // u32; >= V165, < V172
  v180Trailer?: [number, number, number, number, number, number, number, number]; // 8 × u32; >= V180
  numFixedCompEntries: number;
  numCompsPerLayer: number;
  components: PadstackComponent[];
  unknownArrN: number[];  // n * (8 or 10) × u32
}

/** Padstack component — one slot in the padstack component table. */
export interface PadstackComponent {
  type: number;          // u8; PAD_TYPE
  unknownByte1: number;  // u8
  unknownByte2: number;  // u8
  unknownByte3: number;  // u8
  unknown1?: number;     // u32; >= V172
  w: number;             // s32
  h: number;             // s32
  z1?: number;           // s16; >= V172
  x3: number;            // s32
  x4: number;            // s32
  z?: number;            // s16; >= V172
  strPtr: number;        // u32
  z2?: number;           // u32; present unless last entry in < V172
}

// --- 0x1D CONSTRAINT_SET (variable-size) ---
/** Physical constraint set with trace width and clearance rules. */
export interface Blk0x1DConstraintSet extends BlockBase {
  blockType: 0x1D;
  next: number;         // u32
  nameStrKey: number;   // u32; str table key
  fieldPtr: number;     // u32; → 0x03 FIELD
  sizeA: number;        // u16
  sizeB: number;        // u16
  dataB: Uint8Array[];  // sizeB × 56 bytes
  dataA: Uint8Array[];  // sizeA × 256 bytes
  unknown4?: number;    // u32; >= V172
}

// --- 0x1E SI_MODEL (variable-size) ---
/** Signal integrity IBIS model data. */
export interface Blk0x1ESiModel extends BlockBase {
  blockType: 0x1E;
  type: number;      // u8
  t2: number;        // u16
  next: number;      // u32
  unknown2?: number; // u16; >= V164
  unknown3?: number; // u16; >= V164
  strPtr: number;    // u32; str ref
  size: number;      // u32
  string: string;    // fixed-size string of `size` bytes
  unknown4?: number; // u32; >= V172
}

// --- 0x1F PADSTACK_DIM (variable-size) ---
/** Per-padstack dimension records. */
export interface Blk0x1FPadstackDim extends BlockBase {
  blockType: 0x1F;
  next: number;      // u32
  unknown2: number;  // u32
  unknown3: number;  // u32
  unknown4: number;  // u32
  unknown5: number;  // u16
  size: number;      // u16
  substruct: Uint8Array; // variable-length blob
}

// --- 0x20 UNKNOWN ---
/** Unknown purpose block. */
export interface Blk0x20Unknown extends BlockBase {
  blockType: 0x20;
  type: number; // u8
  r: number;    // u16
  next: number; // u32
  unknownArray1: [number, number, number, number, number, number, number]; // 7 × u32
  unknownArray2?: [
    number, number, number, number, number, number, number, number, number, number,
  ]; // 10 × u32; >= V174
}

// --- 0x21 BLOB (variable-size) ---
/** Headered data blob (layer stackup, material props, DRC tables, etc.). */
export interface Blk0x21Blob extends BlockBase {
  blockType: 0x21;
  type: number;  // u8
  r: number;     // u16
  size: number;  // u32; total size including 12-byte header
  data: Uint8Array; // size - 12 bytes
}

// --- 0x22 UNKNOWN ---
/** Unknown block with an 8-element u32 array. */
export interface Blk0x22Unknown extends BlockBase {
  blockType: 0x22;
  type: number;   // u8
  t2: number;     // u16
  unknown1?: number; // u32; >= V172
  unknownArray: [number, number, number, number, number, number, number, number]; // 8 × u32
}

// --- 0x23 RATLINE ---
/** Ratline (unrouted connection). */
export interface Blk0x23Ratline extends BlockBase {
  blockType: 0x23;
  type: number;
  layer: LayerInfo;
  next: number;
  flags: [number, number]; // 2 × u32
  ptr1: number;
  ptr2: number;
  ptr3: number;
  coords: [number, number, number, number, number]; // 5 × s32
  unknown1: [number, number, number, number]; // 4 × u32
  unknown2?: [number, number, number, number]; // 4 × u32; >= V164
  unknown3?: number; // u32; >= V174
}

// --- 0x24 RECT ---
/** Rectangle (keepout/other area). */
export interface Blk0x24Rect extends BlockBase {
  blockType: 0x24;
  type: number;
  layer: LayerInfo;
  next: number;
  parent: number;
  unknown1: number;
  unknown2?: number; // u32; >= V172
  coords: [number, number, number, number]; // 4 × s32
  ptr2: number;
  unknown3: number;
  unknown4: number;
  rotation: number; // u32; millidegrees
}

// --- 0x26 MATCH_GROUP ---
/** Match group indirection for diff pairs. */
export interface Blk0x26MatchGroup extends BlockBase {
  blockType: 0x26;
  type: number;     // u8
  r: number;        // u16
  memberPtr: number;
  unknown1?: number; // u32; >= V172
  groupPtr: number;
  constPtr: number;
  unknown2?: number; // u32; >= V174
}

// --- 0x27 CSTRMGR_XREF (blob) ---
/** Serialized Constraint Manager cross-reference blob. */
export interface Blk0x27CstrMgrXref extends BlockBase {
  blockType: 0x27;
  refs: number[]; // variable number of u32 values
}

// --- 0x28 SHAPE ---
/** Polygon shape (zone outline, copper fill, keepout, custom pad). */
export interface Blk0x28Shape extends BlockBase {
  blockType: 0x28;
  type: number;
  layer: LayerInfo;
  next: number;
  ptr1: number;
  unknown1: number;
  unknown2?: number; // u32; >= V172
  unknown3?: number; // u32; >= V172
  ptr2: number;
  ptr3: number;
  firstKeepoutPtr: number;
  firstSegmentPtr: number; // → 0x15/0x16/0x17/0x01 chain
  unknown4: number;
  unknown5: number;
  tablePtr?: number;      // u32; >= V172 (→ 0x2C TABLE)
  ptr6: number;
  tablePtr_16x?: number;  // u32; < V172 (→ 0x2C TABLE)
  coords: [number, number, number, number]; // 4 × s32 (bounding box)
}

// --- 0x29 PIN (.dra only) ---
/** Pin object (appears in .dra symbol files). */
export interface Blk0x29Pin extends BlockBase {
  blockType: 0x29;
  type: number;  // u8
  t: number;     // u16
  ptr1: number;
  ptr2: number;
  null_: number; // u32; always zero
  ptr3: number;
  coord1: number; // s32
  coord2: number; // s32
  ptrPadstack: number;
  unknown1: number;
  ptrX30: number;
  unknown2: number;
  unknown3: number;
  unknown4: number;
}

// --- 0x2A LAYER_LIST (variable-size) ---
/** List of layers used in films or signal layers. */
export interface Blk0x2ALayerList extends BlockBase {
  blockType: 0x2A;
  numEntries: number; // u16
  unknown?: number;   // u32; >= V174
  // Pre-V165: inline 36-byte fixed strings
  nonRefEntries?: Array<{ name: string }>;
  // V165+: string table references with properties
  refEntries?: Array<{ layerNameId: number; properties: number; unknown: number }>;
  // key is read after entries
}

// --- 0x2B FOOTPRINT_DEF ---
/** Footprint definition (template). */
export interface Blk0x2BFootprintDef extends BlockBase {
  blockType: 0x2B;
  fpStrRef: number;      // u32; str ref → footprint name
  unknown1: number;      // u32
  coords: [number, number, number, number]; // 4 × u32 (bounding box)
  next: number;          // u32
  firstInstPtr: number;  // u32; → 0x2D chain
  unknownPtr3: number;   // u32
  unknownPtr4: number;   // u32
  unknownPtr5: number;   // u32
  symLibPathPtr: number; // u32; str ref → library path
  unknownPtr6: number;   // u32
  unknownPtr7: number;   // u32
  unknownPtr8: number;   // u32
  unknown2?: number;     // u32; >= V164
  unknown3?: number;     // u32; >= V172
}

// --- 0x2C TABLE ---
/** Lookup table for named associations. */
export interface Blk0x2CTable extends BlockBase {
  blockType: 0x2C;
  type: number;      // u8
  subType: number;   // u16
  next: number;      // u32
  unknown1?: number; // u32; >= V172
  unknown2?: number; // u32; >= V172
  unknown3?: number; // u32; >= V172
  stringPtr: number; // u32; str ref
  unknown4?: number; // u32; < V172
  ptr1: number;      // u32
  ptr2: number;      // u32
  ptr3: number;      // u32
  flags: number;     // u32
}

// --- 0x2D FOOTPRINT_INST ---
/** Placed footprint instance on the board. */
export interface Blk0x2DFootprintInst extends BlockBase {
  blockType: 0x2D;
  unknownByte1: number;  // u8
  layer: number;         // u8; 0=top (F_Cu), 1=bottom (B_Cu)
  unknownByte2: number;  // u8
  next: number;          // u32
  unknown1?: number;     // u32; >= V172
  instRef16x?: number;   // u32; < V172 → 0x07
  unknown2: number;      // u16
  unknown3: number;      // u16
  unknown4?: number;     // u32; >= V172
  flags: number;         // u32
  rotation: number;      // u32; millidegrees
  coordX: number;        // s32
  coordY: number;        // s32
  instRef?: number;      // u32; >= V172 → 0x07
  graphicPtr: number;    // u32; → 0x14 chain
  firstPadPtr: number;   // u32; → 0x32 chain
  textPtr: number;       // u32; → 0x30 chain
  assemblyPtr: number;   // u32
  areasPtr: number;      // u32
  unknownPtr1: number;   // u32
  unknownPtr2: number;   // u32
}

// --- 0x2E CONNECTION ---
/** Connection point at a track junction or pad-to-track transition. */
export interface Blk0x2EConnection extends BlockBase {
  blockType: 0x2E;
  type: number;           // u8
  t2: number;             // u16
  next: number;           // u32
  netAssignment: number;  // u32; → 0x04
  unknown1: number;       // u32
  coordX: number;         // u32 (parsed as u32 in KiCad, sign implicit)
  coordY: number;         // u32
  connection: number;     // u32
  unknown2: number;       // u32
  unknown3?: number;      // u32; >= V172
}

// --- 0x2F UNKNOWN ---
/** Unknown block with a 6-element u32 array. */
export interface Blk0x2FUnknown extends BlockBase {
  blockType: 0x2F;
  type: number; // u8
  t2: number;   // u16
  unknownArray: [number, number, number, number, number, number]; // 6 × u32
}

// --- 0x30 STR_WRAPPER ---
/** Text object with position, rotation, and font properties. */
export interface Blk0x30StrWrapper extends BlockBase {
  blockType: 0x30;
  type: number;
  layer: LayerInfo;
  next: number;
  // V172+ fields (at start)
  unknown1?: number;       // u32; >= V172
  unknown2?: number;       // u32; >= V172
  font?: {                  // TEXT_PROPERTIES; >= V172
    key: number;
    flags: number;
    alignment: number;     // 1=left, 2=right, 3=center
    reversal: number;      // 0=straight, 1=reversed
  };
  ptr1?: number;           // u32; >= V172
  unknown3?: number;       // u32; >= V174
  strGraphicPtr: number;   // u32; → 0x31 SGRAPHIC
  ptrGroup_17x?: number;   // u32; >= V172
  unknown4?: number;       // u32; < V172
  font16x?: {              // TEXT_PROPERTIES; < V172
    key: number;
    flags: number;
    alignment: number;
    reversal: number;
  };
  ptr2?: number;           // u32; >= V172
  coordsX: number;         // u32
  coordsY: number;         // u32
  unknown5: number;        // u32
  rotation: number;        // u32; millidegrees
  ptrGroup_16x?: number;   // u32; < V172
}

// --- 0x31 SGRAPHIC (variable-size) ---
/** String graphic content holding actual text value. */
export interface Blk0x31Sgraphic extends BlockBase {
  blockType: 0x31;
  t: number;                      // u8
  layerCode: number;              // u16 raw encoding (0xF001, 0xF101, etc.)
  strGraphicWrapperPtr: number;   // u32; → 0x30
  coordsX: number;                // u32
  coordsY: number;                // u32
  unknown: number;                // u16
  len: number;                    // u16
  un2?: number;                   // u32; >= V174
  value: string;                  // fixed-size string of `len` bytes
}

// --- 0x32 PLACED_PAD ---
/** Placed pad instance within a footprint. */
export interface Blk0x32PlacedPad extends BlockBase {
  blockType: 0x32;
  type: number;
  layer: LayerInfo;
  next: number;
  netPtr: number;          // u32; → 0x04 NET_ASSIGN
  flags: number;           // u32
  prev?: number;           // u32; >= V172
  nextInFp: number;        // u32; follow for footprint pad chain
  parentFp: number;        // u32; → 0x2D FOOTPRINT_INST
  track: number;           // u32
  padPtr: number;          // u32; → 0x0D PAD
  ptr6: number;            // u32
  ratline: number;         // u32
  ptrPinNumber: number;    // u32; → 0x08 PIN_NUMBER
  nextInCompInst: number;  // u32
  unknown2?: number;       // u32; >= V172
  nameText: number;        // u32
  ptr11: number;           // u32
  coords: [number, number, number, number]; // 4 × s32 (bounding box)
}

// --- 0x33 VIA ---
/** Via instance. */
export interface Blk0x33Via extends BlockBase {
  blockType: 0x33;
  layerInfo: LayerInfo;
  next: number;
  netPtr: number;          // u32; → 0x04 NET_ASSIGN
  unknown2: number;        // u32
  unknown3?: number;       // u32; >= V172
  unknownPtr1: number;     // u32
  unknownPtr2?: number;    // u32; >= V172
  coordsX: number;         // s32
  coordsY: number;         // s32
  connection: number;      // u32
  padstack: number;        // u32; → 0x1C PADSTACK
  unknownPtr5: number;     // u32
  unknownPtr6: number;     // u32
  unknown4: number;        // u32
  unknown5: number;        // u32
  bbox: [number, number, number, number]; // 4 × s32
}

// --- 0x34 KEEPOUT ---
/** Keepout area. */
export interface Blk0x34Keepout extends BlockBase {
  blockType: 0x34;
  t: number;
  layer: LayerInfo;
  next: number;
  ptr1: number;
  unknown1?: number;       // u32; >= V172
  flags: number;
  firstSegmentPtr: number; // u32; → 0x15/0x16/0x17 chain
  ptr3: number;
  unknown2: number;
}

// --- 0x35 FILE_REF ---
/** File path references (Allegro log/report files). 120-byte content buffer. */
export interface Blk0x35FileRef extends BlockBase {
  blockType: 0x35;
  t2: number;           // u8
  t3: number;           // u16
  content: Uint8Array;  // 120 raw bytes
}

// --- 0x36 DEF_TABLE (variable-size) ---
/** Heterogeneous definition table (fonts, layer names, film defs). */
export interface Blk0x36DefTable extends BlockBase {
  blockType: 0x36;
  code: number;       // u16; determines item substruct type
  next: number;       // u32
  unknown1?: number;  // u32; >= V172
  numItems: number;   // u32; total slot count
  count: number;      // u32; filled slot count
  lastIdx: number;    // u32
  unknown2: number;   // u32
  unknown3?: number;  // u32; >= V174
  items: Blk0x36Item[];
}

export type Blk0x36Item =
  | { kind: 'x02'; string: string; xs: number[] /* 14 */; ys?: number[] /* 3, >= V164 */; zs?: number[] /* 2, >= V172 */ }
  | { kind: 'x03'; str: string /* 64 bytes >= V172, 32 bytes < V172 */; unknown1?: number /* u32, >= V174 */ }
  | { kind: 'x05'; unknown: Uint8Array /* 28 bytes */; unknown2?: number /* u32, >= V174 */ }
  | { kind: 'x06'; n: number; r: number; s: number; unknown1: number; unknown2?: number[] /* 50 × u32, < V172 */ }
  | { kind: 'x08_font'; a: number; b: number; charHeight: number; charWidth: number; unknown2?: number /* u32, >= V174 */; characterSpace: number; lineSpace: number; unknown3: number; strokeWidth: number; ys?: number[] /* 8 × u32, >= V172 */ }
  | { kind: 'x0B'; unknown: Uint8Array /* 1016 bytes */ }
  | { kind: 'x0C'; unknown: Uint8Array /* 232 bytes */ }
  | { kind: 'x0D'; unknown: Uint8Array /* 200 bytes */ }
  | { kind: 'x0F'; key: number; ptrs: [number, number, number]; ptr2: number }
  | { kind: 'x10'; unknown: Uint8Array /* 108 bytes */; unknown2?: number /* u32, >= V180 */ }
  | { kind: 'x12' /* 1052 bytes, skipped */ };

// --- 0x37 PTR_ARRAY (fixed-capacity 100 entries) ---
/** Fixed-capacity pointer array for zone net resolution. */
export interface Blk0x37PtrArray extends BlockBase {
  blockType: 0x37;
  t: number;          // u8
  t2: number;         // u16
  groupPtr: number;   // u32
  next: number;       // u32
  capacity: number;   // u32
  count: number;      // u32; how many of ptrs are valid
  unknown2: number;   // u32
  unknown3?: number;  // u32; >= V174
  ptrs: number[];     // 100 × u32 (fixed array, count indicates valid count)
}

// --- 0x38 FILM ---
/** Film definition. */
export interface Blk0x38Film extends BlockBase {
  blockType: 0x38;
  next: number;              // u32
  layerList: number;         // u32
  filmName?: string;         // 20-byte fixed string; < V166
  layerNameStr?: number;     // u32; >= V166 (str ref)
  unknown2?: number;         // u32; >= V166
  unknownArray1: [number, number, number, number, number, number, number]; // 7 × u32
  unknown3?: number;         // u32; >= V174
}

// --- 0x39 FILM_LAYER_LIST ---
/** Film layer list header. */
export interface Blk0x39FilmLayerList extends BlockBase {
  blockType: 0x39;
  parent: number; // u32
  head: number;   // u32
  x: number[];    // 22 × u16
}

// --- 0x3A FILM_LIST_NODE ---
/** Film layer list node. */
export interface Blk0x3AFilmListNode extends BlockBase {
  blockType: 0x3A;
  layer: LayerInfo;
  next: number;
  unknown: number;    // u32
  unknown1?: number;  // u32; >= V174
}

// --- 0x3B PROPERTY (variable-size) ---
/** Named property with type and value strings. */
export interface Blk0x3BProperty extends BlockBase {
  blockType: 0x3B;
  t: number;           // u8
  subType: number;     // u16
  len: number;         // u32; length of value string
  name: string;        // fixed 128 bytes
  type: string;        // fixed 32 bytes
  unknown1: number;    // u32
  unknown2: number;    // u32
  unknown3?: number;   // u32; >= V172
  value: string;       // fixed `len` bytes
}

// --- 0x3C KEY_LIST (variable-size) ---
/** Ordered list of block keys. */
export interface Blk0x3CKeyList extends BlockBase {
  blockType: 0x3C;
  t: number;          // u8
  t2: number;         // u16
  unknown?: number;   // u32; >= V174
  numEntries: number; // u32
  entries: number[];  // numEntries × u32
}

// ── Union of all block types ─────────────────────────────────────────────────

export type AllegroBlock =
  | Blk0x01Arc
  | Blk0x03Field
  | Blk0x04NetAssign
  | Blk0x05Track
  | Blk0x06Component
  | Blk0x07ComponentInst
  | Blk0x08PinNumber
  | Blk0x09FillLink
  | Blk0x0ADrc
  | Blk0x0CPinDef
  | Blk0x0DPad
  | Blk0x0ERect
  | Blk0x0FFunctionSlot
  | Blk0x10FunctionInst
  | Blk0x11PinName
  | Blk0x12Xref
  | Blk0x14Graphic
  | Blk0x15_16_17Segment
  | Blk0x1BNet
  | Blk0x1CPadstack
  | Blk0x1DConstraintSet
  | Blk0x1ESiModel
  | Blk0x1FPadstackDim
  | Blk0x20Unknown
  | Blk0x21Blob
  | Blk0x22Unknown
  | Blk0x23Ratline
  | Blk0x24Rect
  | Blk0x26MatchGroup
  | Blk0x27CstrMgrXref
  | Blk0x28Shape
  | Blk0x29Pin
  | Blk0x2ALayerList
  | Blk0x2BFootprintDef
  | Blk0x2CTable
  | Blk0x2DFootprintInst
  | Blk0x2EConnection
  | Blk0x2FUnknown
  | Blk0x30StrWrapper
  | Blk0x31Sgraphic
  | Blk0x32PlacedPad
  | Blk0x33Via
  | Blk0x34Keepout
  | Blk0x35FileRef
  | Blk0x36DefTable
  | Blk0x37PtrArray
  | Blk0x38Film
  | Blk0x39FilmLayerList
  | Blk0x3AFilmListNode
  | Blk0x3BProperty
  | Blk0x3CKeyList;
