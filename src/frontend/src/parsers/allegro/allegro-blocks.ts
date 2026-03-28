/**
 * allegro-blocks.ts — per-block-type parser functions for Cadence Allegro BRD.
 *
 * Each parseBlock0xNN() function reads exactly the fields described in the
 * corresponding interface in allegro-types.ts, in the same order as KiCad's
 * ParseBlock_* functions in allegro_parser.cpp.
 *
 * Derived from KiCad 10's Allegro importer (GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 */

import { AllegroStream } from './allegro-stream';
import {
  FmtVer,
  readCond,
  type LayerInfo,
  type AllegroBlock,
  type Blk0x01Arc,
  type Blk0x03Field,
  type Blk0x04NetAssign,
  type Blk0x05Track,
  type Blk0x06Component,
  type Blk0x07ComponentInst,
  type Blk0x08PinNumber,
  type Blk0x09FillLink,
  type Blk0x0ADrc,
  type Blk0x0CPinDef,
  type Blk0x0DPad,
  type Blk0x0ERect,
  type Blk0x0FFunctionSlot,
  type Blk0x10FunctionInst,
  type Blk0x11PinName,
  type Blk0x12Xref,
  type Blk0x14Graphic,
  type Blk0x15_16_17Segment,
  type Blk0x1BNet,
  type Blk0x1CPadstack,
  type PadstackComponent,
  type Blk0x1DConstraintSet,
  type Blk0x1ESiModel,
  type Blk0x1FPadstackDim,
  type Blk0x20Unknown,
  type Blk0x21Blob,
  type Blk0x22Unknown,
  type Blk0x23Ratline,
  type Blk0x24Rect,
  type Blk0x26MatchGroup,
  type Blk0x27CstrMgrXref,
  type Blk0x28Shape,
  type Blk0x29Pin,
  type Blk0x2ALayerList,
  type Blk0x2BFootprintDef,
  type Blk0x2CTable,
  type Blk0x2DFootprintInst,
  type Blk0x2EConnection,
  type Blk0x2FUnknown,
  type Blk0x30StrWrapper,
  type Blk0x31Sgraphic,
  type Blk0x32PlacedPad,
  type Blk0x33Via,
  type Blk0x34Keepout,
  type Blk0x35FileRef,
  type Blk0x36DefTable,
  type Blk0x36Item,
  type Blk0x37PtrArray,
  type Blk0x38Film,
  type Blk0x39FilmLayerList,
  type Blk0x3AFilmListNode,
  type Blk0x3BProperty,
  type Blk0x3CKeyList,
} from './allegro-types';

// ── Helper ───────────────────────────────────────────────────────────────────

function parseLayerInfo(s: AllegroStream): LayerInfo {
  return { classCode: s.u8(), subclass: s.u8() };
}

// ── Block parsers ────────────────────────────────────────────────────────────

function parseBlock0x01(s: AllegroStream, ver: FmtVer, offset: number): Blk0x01Arc {
  s.skip(1); // padding before unknownByte

  const unknownByte = s.u8();
  const subType = s.u8();
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const unknown1 = s.u32();
  const unknown6 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const width = s.u32();
  const startX = s.s32();
  const startY = s.s32();
  const endX = s.s32();
  const endY = s.s32();
  const centerX = s.allegroFloat();
  const centerY = s.allegroFloat();
  const radius = s.allegroFloat();
  const bbox: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];

  return {
    blockType: 0x01,
    offset,
    key,
    unknownByte,
    subType,
    next,
    parent,
    unknown1,
    unknown6,
    width,
    startX,
    startY,
    endX,
    endY,
    centerX,
    centerY,
    radius,
    bbox,
  };
}

function parseBlock0x03(s: AllegroStream, ver: FmtVer, offset: number): Blk0x03Field {
  s.skip(1); // padding

  const hdr1 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const subType = s.u8();
  const hdr2 = s.u8();
  const size = s.u16();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  // Parse the substruct based on subType
  let substruct: Blk0x03Field['substruct'];

  switch (subType) {
    case 0x65:
      // Nothing for this one
      substruct = { kind: 'empty' };
      break;

    case 0x64:
    case 0x66:
    case 0x67:
    case 0x6A:
      substruct = { kind: 'u32', value: s.u32() };
      break;

    case 0x69:
      substruct = { kind: 'u32x2', values: [s.u32(), s.u32()] };
      break;

    case 0x68:
    case 0x6B:
    case 0x6D:
    case 0x6E:
    case 0x6F:
    case 0x71:
    case 0x73:
    case 0x78:
      substruct = { kind: 'string', value: s.fixedString(size, true) };
      break;

    case 0x6C: {
      const numEntries = s.u32();
      const entries: number[] = [];
      for (let i = 0; i < numEntries; i++) {
        entries.push(s.u32());
      }
      substruct = { kind: '0x6C', numEntries, entries };
      break;
    }

    case 0x70:
    case 0x74: {
      const x0 = s.u16();
      const x1 = s.u16();
      const numEntries = x1 + 4 * x0;
      const entries: number[] = [];
      for (let i = 0; i < numEntries; i++) {
        entries.push(s.u8());
      }
      substruct = { kind: '0x70_0x74', x0, x1, entries };
      break;
    }

    case 0xF6: {
      const entries: number[] = [];
      for (let i = 0; i < 20; i++) {
        entries.push(s.u32());
      }
      substruct = { kind: '0xF6', entries };
      break;
    }

    default:
      if (size === 4) {
        substruct = { kind: 'u32', value: s.u32() };
      } else if (size === 8) {
        substruct = { kind: 'u32x2', values: [s.u32(), s.u32()] };
      } else if (size === 0) {
        substruct = { kind: 'empty' };
      } else {
        throw new Error(`Unknown block 0x03 substruct type 0x${subType.toString(16)} with size ${size}`);
      }
      break;
  }

  return { blockType: 0x03, offset, key, hdr1, next, unknown1, subType, hdr2, size, unknown2, substruct };
}

function parseBlock0x04(s: AllegroStream, ver: FmtVer, offset: number): Blk0x04NetAssign {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const next = s.u32();
  const net = s.u32();
  const connItem = s.u32();
  const unknown = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x04, offset, key, type, r, next, net, connItem, unknown };
}

function parseBlock0x05(s: AllegroStream, ver: FmtVer, offset: number): Blk0x05Track {
  s.skip(1);

  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netAssignment = s.u32();
  const unknownPtr1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknownPtr2a = s.u32();
  const unknownPtr2b = s.u32();
  const unknown4 = s.u32();
  const unknownPtr3a = s.u32();
  const unknownPtr3b = s.u32();
  const unknown5a = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown5b = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const firstSegPtr = s.u32();
  const unknownPtr5 = s.u32();
  const unknown6 = s.u32();

  return {
    blockType: 0x05,
    offset,
    key,
    layer,
    next,
    netAssignment,
    unknownPtr1,
    unknown2,
    unknown3,
    unknownPtr2a,
    unknownPtr2b,
    unknown4,
    unknownPtr3a,
    unknownPtr3b,
    unknown5a,
    unknown5b,
    firstSegPtr,
    unknownPtr5,
    unknown6,
  };
}

function parseBlock0x06(s: AllegroStream, ver: FmtVer, offset: number): Blk0x06Component {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const compDeviceType = s.u32();
  const symbolName = s.u32();
  const firstInstPtr = s.u32();
  const ptrFunctionSlot = s.u32();
  const ptrPinNumber = s.u32();
  const fields = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  return {
    blockType: 0x06,
    offset,
    key,
    next,
    compDeviceType,
    symbolName,
    firstInstPtr,
    ptrFunctionSlot,
    ptrPinNumber,
    fields,
    unknown1,
  };
}

function parseBlock0x07(s: AllegroStream, ver: FmtVer, offset: number): Blk0x07ComponentInst {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const unknownPtr1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const fpInstPtr = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const refDesStrPtr = s.u32();
  const functionInstPtr = s.u32();
  const x03Ptr = s.u32();
  const unknown5 = s.u32();
  const firstPadPtr = s.u32();

  return {
    blockType: 0x07,
    offset,
    key,
    next,
    unknownPtr1,
    unknown2,
    unknown3,
    fpInstPtr,
    unknown4,
    refDesStrPtr,
    functionInstPtr,
    x03Ptr,
    unknown5,
    firstPadPtr,
  };
}

function parseBlock0x08(s: AllegroStream, ver: FmtVer, offset: number): Blk0x08PinNumber {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const previous = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const strPtr16x = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const next = s.u32();
  const strPtr = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const pinNamePtr = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const ptr4 = s.u32();

  return { blockType: 0x08, offset, key, type, r, previous, strPtr16x, next, strPtr, pinNamePtr, unknown1, ptr4 };
}

function parseBlock0x09(s: AllegroStream, ver: FmtVer, offset: number): Blk0x09FillLink {
  s.skip(3);

  const key = s.u32();
  const unknownArray: [number, number, number, number] = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknownPtr1 = s.u32();
  const unknownPtr2 = s.u32();
  const unknown2 = s.u32();
  const unknownPtr3 = s.u32();
  const unknownPtr4 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return {
    blockType: 0x09,
    offset,
    key,
    unknownArray,
    unknown1,
    unknownPtr1,
    unknownPtr2,
    unknown2,
    unknownPtr3,
    unknownPtr4,
    unknown3,
  };
}

function parseBlock0x0A(s: AllegroStream, ver: FmtVer, offset: number): Blk0x0ADrc {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const coords: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];
  const unknown4: [number, number, number, number] = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown5: [number, number, number, number, number] = [s.u32(), s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown6 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x0A, offset, key, t, layer, next, unknown1, unknown2, coords, unknown4, unknown5, unknown6 };
}

function parseBlock0x0C(s: AllegroStream, ver: FmtVer, offset: number): Blk0x0CPinDef {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown1 = s.u32();
  const unknown2 = s.u32();

  // Pre-V172 packed format
  const shape = readCond(ver, FmtVer.V_172, '<', () => s.u8());
  const drillChar = readCond(ver, FmtVer.V_172, '<', () => s.u8());
  const unknownPadding = readCond(ver, FmtVer.V_172, '<', () => s.u16());

  // V172+ expanded format
  const shape16x = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const drillChars = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown_16x = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  const unknown4 = s.u32();
  const unknown5 = readCond(ver, FmtVer.V_180, '>=', () => s.u32());
  const coords: [number, number] = [s.s32(), s.s32()];
  const size: [number, number] = [s.s32(), s.s32()];
  const groupPtr = s.u32();
  const unknown6 = s.u32();
  const unknown7 = s.u32();
  const unknown8 = readCond(ver, FmtVer.V_174, '>=', () => {
    // >= V174, < V180
    if (ver < FmtVer.V_180) return s.u32();
    return undefined;
  });

  return {
    blockType: 0x0C,
    offset,
    key,
    t,
    layer,
    next,
    unknown1,
    unknown2,
    shape,
    drillChar,
    unknownPadding,
    shape16x,
    drillChars,
    unknown_16x,
    unknown4,
    unknown5,
    coords,
    size,
    groupPtr,
    unknown6,
    unknown7,
    unknown8,
  };
}

function parseBlock0x0D(s: AllegroStream, ver: FmtVer, offset: number): Blk0x0DPad {
  s.skip(3);

  const key = s.u32();
  const nameStrId = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
  const coordsX = s.s32();
  const coordsY = s.s32();
  const padStack = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const flags = s.u32();
  const rotation = s.u32();

  return {
    blockType: 0x0D,
    offset,
    key,
    nameStrId,
    next,
    unknown1,
    coordsX,
    coordsY,
    padStack,
    unknown2,
    unknown3,
    flags,
    rotation,
  };
}

function parseBlock0x0E(s: AllegroStream, ver: FmtVer, offset: number): Blk0x0ERect {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const fpPtr = s.u32();
  const unknown1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown5 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const coords: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];
  const unknownArr: [number, number, number] = [s.u32(), s.u32(), s.u32()];
  const rotation = s.u32();

  return {
    blockType: 0x0E,
    offset,
    key,
    t,
    layer,
    next,
    fpPtr,
    unknown1,
    unknown2,
    unknown3,
    unknown4,
    unknown5,
    coords,
    unknownArr,
    rotation,
  };
}

function parseBlock0x0F(s: AllegroStream, ver: FmtVer, offset: number): Blk0x0FFunctionSlot {
  s.skip(3);

  const key = s.u32();
  const slotName = s.u32();
  // compDeviceType is always 32 bytes (the struct has `std::array<char, 32>`)
  const compDeviceType = s.bytes(32).slice(); // copy
  const ptr0x06 = s.u32();
  const ptr0x11 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return {
    blockType: 0x0F,
    offset,
    key,
    slotName,
    compDeviceType,
    ptr0x06,
    ptr0x11,
    unknown1,
    unknown2,
    unknown3,
  };
}

function parseBlock0x10(s: AllegroStream, ver: FmtVer, offset: number): Blk0x10FunctionInst {
  s.skip(3);

  const key = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const componentInstPtr = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
  const ptrX12 = s.u32();
  const unknown3 = s.u32();
  const functionName = s.u32();
  const slots = s.u32();
  const fields = s.u32();

  return {
    blockType: 0x10,
    offset,
    key,
    unknown1,
    componentInstPtr,
    unknown2,
    ptrX12,
    unknown3,
    functionName,
    slots,
    fields,
  };
}

function parseBlock0x11(s: AllegroStream, ver: FmtVer, offset: number): Blk0x11PinName {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const pinNameStrPtr = s.u32();
  const next = s.u32();
  const pinNumberPtr = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x11, offset, key, type, r, pinNameStrPtr, next, pinNumberPtr, unknown1, unknown2 };
}

function parseBlock0x12(s: AllegroStream, ver: FmtVer, offset: number): Blk0x12Xref {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_165, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x12, offset, key, type, r, ptr1, ptr2, ptr3, unknown1, unknown2, unknown3 };
}

function parseBlock0x14(s: AllegroStream, ver: FmtVer, offset: number): Blk0x14Graphic {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const flags = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const segmentPtr = s.u32();
  const ptr0x03 = s.u32();
  const ptr0x26 = s.u32();

  return { blockType: 0x14, offset, key, type, layer, next, parent, flags, unknown2, segmentPtr, ptr0x03, ptr0x26 };
}

function parseBlock0x15_16_17(s: AllegroStream, ver: FmtVer, offset: number, blockType: 0x15 | 0x16 | 0x17): Blk0x15_16_17Segment {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const flags = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const width = s.u32();
  const startX = s.s32();
  const startY = s.s32();
  const endX = s.s32();
  const endY = s.s32();

  return { blockType, offset, key, next, parent, flags, unknown2, width, startX, startY, endX, endY };
}

function parseBlock0x1B(s: AllegroStream, ver: FmtVer, offset: number): Blk0x1BNet {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const netName = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const type = s.u32();
  const assignment = s.u32();
  const ratline = s.u32();
  const fieldsPtr = s.u32();
  const matchGroupPtr = s.u32();
  const modelPtr = s.u32();
  const unknownPtr4 = s.u32();
  const unknownPtr5 = s.u32();
  const unknownPtr6 = s.u32();

  return {
    blockType: 0x1B,
    offset,
    key,
    next,
    netName,
    unknown1,
    unknown2,
    type,
    assignment,
    ratline,
    fieldsPtr,
    matchGroupPtr,
    modelPtr,
    unknownPtr4,
    unknownPtr5,
    unknownPtr6,
  };
}

function parseBlock0x1C(s: AllegroStream, ver: FmtVer, offset: number): Blk0x1CPadstack {
  const unknownByte1 = s.u8();
  const n = s.u8();
  const unknownByte2 = s.u8();
  const key = s.u32();
  const next = s.u32();
  const padStr = s.u32();
  const drill = s.u32();
  const unknown2 = s.u32();
  const padPath = s.u32();

  // Pre-V172 extras
  const unknown3 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const unknown4 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const unknown5 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const unknown6 = readCond(ver, FmtVer.V_172, '<', () => s.u32());

  // Type byte: high nibble → padType, low nibble → a
  const typeByte = s.u8();
  const padType = (typeByte & 0xF0) >> 4;
  const a = typeByte & 0x0F;

  const b = s.u8();
  const flags = s.u8();
  const d = s.u8();

  // V172+ extras
  const unknown7 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown8 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown9 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  // Layer count section
  const unknown10 = readCond(ver, FmtVer.V_172, '<', () => s.u16());
  const layerCount = s.u16();
  const unknown11 = readCond(ver, FmtVer.V_172, '>=', () => s.u16());

  // Drill array: 8 × u32
  const drillArr: [number, number, number, number, number, number, number, number] = [
    s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(),
  ];

  // V172+ slot array: 28 × u32
  const slotAndUnknownArr = readCond(ver, FmtVer.V_172, '>=', () => {
    const arr: number[] = [];
    for (let i = 0; i < 28; i++) arr.push(s.u32());
    return arr as Blk0x1CPadstack['slotAndUnknownArr'];
  });

  // >= V165, < V172
  const unknown12 = (ver >= FmtVer.V_165 && ver < FmtVer.V_172) ? s.u32() : undefined;

  // V180 trailer: 8 × u32
  const v180Trailer = readCond(ver, FmtVer.V_180, '>=', () => {
    const arr: number[] = [];
    for (let i = 0; i < 8; i++) arr.push(s.u32());
    return arr as [number, number, number, number, number, number, number, number];
  });

  // Component count calculations
  let numFixedCompEntries: number;
  if (ver < FmtVer.V_165) {
    numFixedCompEntries = 10;
  } else if (ver < FmtVer.V_172) {
    numFixedCompEntries = 11;
  } else {
    numFixedCompEntries = 21;
  }
  const numCompsPerLayer = ver < FmtVer.V_172 ? 3 : 4;
  const nComps = numFixedCompEntries + layerCount * numCompsPerLayer;

  const components: PadstackComponent[] = [];
  for (let i = 0; i < nComps; i++) {
    const compType = s.u8();
    const unknownByte1c = s.u8();
    const unknownByte2c = s.u8();
    const unknownByte3c = s.u8();
    const unknown1c = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
    const w = s.s32();
    const h = s.s32();
    const z1 = readCond(ver, FmtVer.V_172, '>=', () => s.s16());
    const x3 = s.s32();
    const x4 = s.s32();
    const z = readCond(ver, FmtVer.V_172, '>=', () => s.s16());
    const strPtr = s.u32();
    // Last component in pre-V172 skips z2
    let z2: number | undefined;
    if (!(ver < FmtVer.V_172 && i === nComps - 1)) {
      z2 = s.u32();
    }

    components.push({
      type: compType,
      unknownByte1: unknownByte1c,
      unknownByte2: unknownByte2c,
      unknownByte3: unknownByte3c,
      unknown1: unknown1c,
      w,
      h,
      z1,
      x3,
      x4,
      z,
      strPtr,
      z2,
    });
  }

  // Trailing N-array
  const nElemsPerN = ver < FmtVer.V_172 ? 8 : 10;
  const nElems = n * nElemsPerN;
  const unknownArrN: number[] = [];
  for (let i = 0; i < nElems; i++) {
    unknownArrN.push(s.u32());
  }

  return {
    blockType: 0x1C,
    offset,
    key,
    unknownByte1,
    n,
    unknownByte2,
    next,
    padStr,
    drill,
    unknown2,
    padPath,
    unknown3,
    unknown4,
    unknown5,
    unknown6,
    padType,
    a,
    b,
    flags,
    d,
    unknown7,
    unknown8,
    unknown9,
    unknown10,
    layerCount,
    unknown11,
    drillArr,
    slotAndUnknownArr,
    unknown12,
    v180Trailer,
    numFixedCompEntries,
    numCompsPerLayer,
    components,
    unknownArrN,
  };
}

function parseBlock0x1D(s: AllegroStream, ver: FmtVer, offset: number): Blk0x1DConstraintSet {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const nameStrKey = s.u32();
  const fieldPtr = s.u32();
  const sizeA = s.u16();
  const sizeB = s.u16();

  const dataB: Uint8Array[] = [];
  for (let i = 0; i < sizeB; i++) {
    dataB.push(s.bytes(56).slice());
  }

  const dataA: Uint8Array[] = [];
  for (let i = 0; i < sizeA; i++) {
    dataA.push(s.bytes(256).slice());
  }

  const unknown4 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  return { blockType: 0x1D, offset, key, next, nameStrKey, fieldPtr, sizeA, sizeB, dataB, dataA, unknown4 };
}

function parseBlock0x1E(s: AllegroStream, ver: FmtVer, offset: number): Blk0x1ESiModel {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_164, '>=', () => s.u16());
  const unknown3 = readCond(ver, FmtVer.V_164, '>=', () => s.u16());
  const strPtr = s.u32();
  const size = s.u32();
  const string = s.fixedString(size, true);
  const unknown4 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  return { blockType: 0x1E, offset, key, type, t2, next, unknown2, unknown3, strPtr, size, string, unknown4 };
}

function parseBlock0x1F(s: AllegroStream, ver: FmtVer, offset: number): Blk0x1FPadstackDim {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u16();
  const size = s.u16();

  let substructSize: number;
  if (ver >= FmtVer.V_175) {
    substructSize = size * 384 + 8;
  } else if (ver >= FmtVer.V_172) {
    substructSize = size * 280 + 8;
  } else if (ver >= FmtVer.V_162) {
    substructSize = size * 280 + 4;
  } else {
    substructSize = size * 240 + 4;
  }

  const substruct = s.bytes(substructSize).slice();

  return { blockType: 0x1F, offset, key, next, unknown2, unknown3, unknown4, unknown5, size, substruct };
}

function parseBlock0x20(s: AllegroStream, ver: FmtVer, offset: number): Blk0x20Unknown {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const next = s.u32(); // KiCad calls this m_Next but it comes after m_Key+m_UnknownArray1

  // Wait, check KiCad: ReadArrayU32 for m_UnknownArray1 is called before ReadCond m_UnknownArray2
  // KiCad: m_Type, m_R, m_Key, m_Next, ReadArrayU32(m_UnknownArray1[7]), ReadCond(m_UnknownArray2[10])
  const unknownArray1: [number, number, number, number, number, number, number] = [
    s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(),
  ];
  const unknownArray2 = readCond(ver, FmtVer.V_174, '>=', () => {
    const arr: number[] = [];
    for (let i = 0; i < 10; i++) arr.push(s.u32());
    return arr as [number, number, number, number, number, number, number, number, number, number];
  });

  return { blockType: 0x20, offset, key, type, r, next, unknownArray1, unknownArray2 };
}

function parseBlock0x21(s: AllegroStream, _ver: FmtVer, offset: number): Blk0x21Blob {
  const type = s.u8();
  const r = s.u16();
  const size = s.u32();

  if (size < 12) {
    throw new Error(`Block 0x21 size ${size} too small (minimum 12) at offset 0x${offset.toString(16)}`);
  }

  const key = s.u32();
  const nBytes = size - 12;
  const data = s.bytes(nBytes).slice();

  return { blockType: 0x21, offset, key, type, r, size, data };
}

function parseBlock0x22(s: AllegroStream, ver: FmtVer, offset: number): Blk0x22Unknown {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknownArray: [number, number, number, number, number, number, number, number] = [
    s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(),
  ];

  return { blockType: 0x22, offset, key, type, t2, unknown1, unknownArray };
}

function parseBlock0x23(s: AllegroStream, ver: FmtVer, offset: number): Blk0x23Ratline {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const flags: [number, number] = [s.u32(), s.u32()];
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const coords: [number, number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32(), s.s32()];
  const unknown1: [number, number, number, number] = [s.u32(), s.u32(), s.u32(), s.u32()];
  const unknown2 = readCond(ver, FmtVer.V_164, '>=', () => {
    return [s.u32(), s.u32(), s.u32(), s.u32()] as [number, number, number, number];
  });
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x23, offset, key, type, layer, next, flags, ptr1, ptr2, ptr3, coords, unknown1, unknown2, unknown3 };
}

function parseBlock0x24(s: AllegroStream, ver: FmtVer, offset: number): Blk0x24Rect {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const parent = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const coords: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];
  const ptr2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();
  const rotation = s.u32();

  return { blockType: 0x24, offset, key, type, layer, next, parent, unknown1, unknown2, coords, ptr2, unknown3, unknown4, rotation };
}

function parseBlock0x26(s: AllegroStream, ver: FmtVer, offset: number): Blk0x26MatchGroup {
  const type = s.u8();
  const r = s.u16();
  const key = s.u32();
  const memberPtr = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const groupPtr = s.u32();
  const constPtr = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x26, offset, key, type, r, memberPtr, unknown1, groupPtr, constPtr, unknown2 };
}

function parseBlock0x27(s: AllegroStream, _ver: FmtVer, offset: number, x27End: number): Blk0x27CstrMgrXref {
  const totalBytes = x27End - 1 - s.position;
  const kPadding = 3;
  const refs: number[] = [];

  if (totalBytes <= kPadding) {
    s.skip(totalBytes);
    return { blockType: 0x27, offset, key: 0, refs };
  }

  s.skip(kPadding);

  const payloadBytes = totalBytes - kPadding;
  const numValues = Math.floor(payloadBytes / 4);
  const remainder = payloadBytes % 4;

  for (let i = 0; i < numValues; i++) {
    refs.push(s.u32());
  }

  if (remainder > 0) s.skip(remainder);

  return { blockType: 0x27, offset, key: 0, refs };
}

function parseBlock0x28(s: AllegroStream, ver: FmtVer, offset: number): Blk0x28Shape {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const ptr1 = s.u32();
  const unknown1 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const firstKeepoutPtr = s.u32();
  const firstSegmentPtr = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u32();
  const tablePtr = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const ptr6 = s.u32();
  const tablePtr_16x = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const coords: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];

  return {
    blockType: 0x28,
    offset,
    key,
    type,
    layer,
    next,
    ptr1,
    unknown1,
    unknown2,
    unknown3,
    ptr2,
    ptr3,
    firstKeepoutPtr,
    firstSegmentPtr,
    unknown4,
    unknown5,
    tablePtr,
    ptr6,
    tablePtr_16x,
    coords,
  };
}

function parseBlock0x29(s: AllegroStream, _ver: FmtVer, offset: number): Blk0x29Pin {
  const type = s.u8();
  const t = s.u16();
  const key = s.u32();
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const null_ = s.u32();
  const ptr3 = s.u32();
  const coord1 = s.s32();
  const coord2 = s.s32();
  const ptrPadstack = s.u32();
  const unknown1 = s.u32();
  const ptrX30 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = s.u32();
  const unknown4 = s.u32();

  return { blockType: 0x29, offset, key, type, t, ptr1, ptr2, null_, ptr3, coord1, coord2, ptrPadstack, unknown1, ptrX30, unknown2, unknown3, unknown4 };
}

function parseBlock0x2A(s: AllegroStream, ver: FmtVer, offset: number): Blk0x2ALayerList {
  s.skip(1);

  const numEntries = s.u16();
  const unknown = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  let nonRefEntries: Blk0x2ALayerList['nonRefEntries'];
  let refEntries: Blk0x2ALayerList['refEntries'];

  if (ver < FmtVer.V_165) {
    // Pre-V165: inline 36-byte fixed strings
    nonRefEntries = [];
    for (let i = 0; i < numEntries; i++) {
      nonRefEntries.push({ name: s.fixedString(36, true) });
    }
  } else {
    // V165+: ref entries (3 × u32 each)
    refEntries = [];
    for (let i = 0; i < numEntries; i++) {
      const layerNameId = s.u32();
      const properties = s.u32();
      const unkw = s.u32();
      refEntries.push({ layerNameId, properties, unknown: unkw });
    }
  }

  // Key is read after entries
  const key = s.u32();

  return { blockType: 0x2A, offset, key, numEntries, unknown, nonRefEntries, refEntries };
}

function parseBlock0x2B(s: AllegroStream, ver: FmtVer, offset: number): Blk0x2BFootprintDef {
  s.skip(3);

  const key = s.u32();
  const fpStrRef = s.u32();
  const unknown1 = s.u32();
  const coords: [number, number, number, number] = [s.u32(), s.u32(), s.u32(), s.u32()];
  const next = s.u32();
  const firstInstPtr = s.u32();
  const unknownPtr3 = s.u32();
  const unknownPtr4 = s.u32();
  const unknownPtr5 = s.u32();
  const symLibPathPtr = s.u32();
  const unknownPtr6 = s.u32();
  const unknownPtr7 = s.u32();
  const unknownPtr8 = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_164, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  return {
    blockType: 0x2B,
    offset,
    key,
    fpStrRef,
    unknown1,
    coords,
    next,
    firstInstPtr,
    unknownPtr3,
    unknownPtr4,
    unknownPtr5,
    symLibPathPtr,
    unknownPtr6,
    unknownPtr7,
    unknownPtr8,
    unknown2,
    unknown3,
  };
}

function parseBlock0x2C(s: AllegroStream, ver: FmtVer, offset: number): Blk0x2CTable {
  const type = s.u8();
  const subType = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const stringPtr = s.u32();
  const unknown4 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const ptr1 = s.u32();
  const ptr2 = s.u32();
  const ptr3 = s.u32();
  const flags = s.u32();

  return { blockType: 0x2C, offset, key, type, subType, next, unknown1, unknown2, unknown3, stringPtr, unknown4, ptr1, ptr2, ptr3, flags };
}

function parseBlock0x2D(s: AllegroStream, ver: FmtVer, offset: number): Blk0x2DFootprintInst {
  const unknownByte1 = s.u8();
  const layer = s.u8();
  const unknownByte2 = s.u8();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const instRef16x = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const unknown2 = s.u16();
  const unknown3 = s.u16();
  const unknown4 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const flags = s.u32();
  const rotation = s.u32();
  const coordX = s.s32();
  const coordY = s.s32();
  const instRef = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const graphicPtr = s.u32();
  const firstPadPtr = s.u32();
  const textPtr = s.u32();
  const assemblyPtr = s.u32();
  const areasPtr = s.u32();
  const unknownPtr1 = s.u32();
  const unknownPtr2 = s.u32();

  return {
    blockType: 0x2D,
    offset,
    key,
    unknownByte1,
    layer,
    unknownByte2,
    next,
    unknown1,
    instRef16x,
    unknown2,
    unknown3,
    unknown4,
    flags,
    rotation,
    coordX,
    coordY,
    instRef,
    graphicPtr,
    firstPadPtr,
    textPtr,
    assemblyPtr,
    areasPtr,
    unknownPtr1,
    unknownPtr2,
  };
}

function parseBlock0x2E(s: AllegroStream, ver: FmtVer, offset: number): Blk0x2EConnection {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const next = s.u32();
  const netAssignment = s.u32();
  const unknown1 = s.u32();
  const coordX = s.u32();
  const coordY = s.u32();
  const connection = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  return { blockType: 0x2E, offset, key, type, t2, next, netAssignment, unknown1, coordX, coordY, connection, unknown2, unknown3 };
}

function parseBlock0x2F(s: AllegroStream, _ver: FmtVer, offset: number): Blk0x2FUnknown {
  const type = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknownArray: [number, number, number, number, number, number] = [
    s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(),
  ];

  return { blockType: 0x2F, offset, key, type, t2, unknownArray };
}

function parseTextProps(s: AllegroStream): { key: number; flags: number; alignment: number; reversal: number } {
  return { key: s.u8(), flags: s.u8(), alignment: s.u8(), reversal: s.u8() };
}

function parseBlock0x30(s: AllegroStream, ver: FmtVer, offset: number): Blk0x30StrWrapper {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();

  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const font = readCond(ver, FmtVer.V_172, '>=', () => parseTextProps(s));
  const ptr1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  const strGraphicPtr = s.u32();

  const ptrGroup_17x = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknown4 = readCond(ver, FmtVer.V_172, '<', () => s.u32());
  const font16x = readCond(ver, FmtVer.V_172, '<', () => parseTextProps(s));
  const ptr2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());

  const coordsX = s.u32();
  const coordsY = s.u32();
  const unknown5 = s.u32();
  const rotation = s.u32();

  const ptrGroup_16x = readCond(ver, FmtVer.V_172, '<', () => s.u32());

  return {
    blockType: 0x30,
    offset,
    key,
    type,
    layer,
    next,
    unknown1,
    unknown2,
    font,
    ptr1,
    unknown3,
    strGraphicPtr,
    ptrGroup_17x,
    unknown4,
    font16x,
    ptr2,
    coordsX,
    coordsY,
    unknown5,
    rotation,
    ptrGroup_16x,
  };
}

function parseBlock0x31(s: AllegroStream, ver: FmtVer, offset: number): Blk0x31Sgraphic {
  const t = s.u8();
  const layerCode = s.u16();
  const key = s.u32();
  const strGraphicWrapperPtr = s.u32();
  const coordsX = s.u32();
  const coordsY = s.u32();
  const unknown = s.u16();
  const len = s.u16();
  const un2 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
  const value = s.fixedString(len, true);

  return { blockType: 0x31, offset, key, t, layerCode, strGraphicWrapperPtr, coordsX, coordsY, unknown, len, un2, value };
}

function parseBlock0x32(s: AllegroStream, ver: FmtVer, offset: number): Blk0x32PlacedPad {
  const type = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netPtr = s.u32();
  const flags = s.u32();
  const prev = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const nextInFp = s.u32();
  const parentFp = s.u32();
  const track = s.u32();
  const padPtr = s.u32();
  const ptr6 = s.u32();
  const ratline = s.u32();
  const ptrPinNumber = s.u32();
  const nextInCompInst = s.u32();
  const unknown2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const nameText = s.u32();
  const ptr11 = s.u32();
  const coords: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];

  return {
    blockType: 0x32,
    offset,
    key,
    type,
    layer,
    next,
    netPtr,
    flags,
    prev,
    nextInFp,
    parentFp,
    track,
    padPtr,
    ptr6,
    ratline,
    ptrPinNumber,
    nextInCompInst,
    unknown2,
    nameText,
    ptr11,
    coords,
  };
}

function parseBlock0x33(s: AllegroStream, ver: FmtVer, offset: number): Blk0x33Via {
  s.skip(1);

  const layerInfo = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const netPtr = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const unknownPtr1 = s.u32();
  const unknownPtr2 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const coordsX = s.s32();
  const coordsY = s.s32();
  const connection = s.u32();
  const padstack = s.u32();
  const unknownPtr5 = s.u32();
  const unknownPtr6 = s.u32();
  const unknown4 = s.u32();
  const unknown5 = s.u32();
  const bbox: [number, number, number, number] = [s.s32(), s.s32(), s.s32(), s.s32()];

  return {
    blockType: 0x33,
    offset,
    key,
    layerInfo,
    next,
    netPtr,
    unknown2,
    unknown3,
    unknownPtr1,
    unknownPtr2,
    coordsX,
    coordsY,
    connection,
    padstack,
    unknownPtr5,
    unknownPtr6,
    unknown4,
    unknown5,
    bbox,
  };
}

function parseBlock0x34(s: AllegroStream, ver: FmtVer, offset: number): Blk0x34Keepout {
  const t = s.u8();
  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const ptr1 = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const flags = s.u32();
  const firstSegmentPtr = s.u32();
  const ptr3 = s.u32();
  const unknown2 = s.u32();

  return { blockType: 0x34, offset, key, t, layer, next, ptr1, unknown1, flags, firstSegmentPtr, ptr3, unknown2 };
}

function parseBlock0x35(s: AllegroStream, _ver: FmtVer, offset: number): Blk0x35FileRef {
  // No key field — use offset as key per spec
  const t2 = s.u8();
  const t3 = s.u16();
  const content = s.bytes(120).slice();

  return { blockType: 0x35, offset, key: offset, t2, t3, content };
}

function parseBlock0x36(s: AllegroStream, ver: FmtVer, offset: number): Blk0x36DefTable {
  s.skip(1);

  const code = s.u16();
  const key = s.u32();
  const next = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const numItems = s.u32();
  const count = s.u32();
  const lastIdx = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  if (numItems > 1_000_000) {
    throw new Error(`Block 0x36 item count ${numItems} exceeds limit at offset 0x${offset.toString(16)}`);
  }

  const items: Blk0x36Item[] = [];

  for (let i = 0; i < numItems; i++) {
    const keep = i < count;

    switch (code) {
      case 0x02: {
        const string = s.fixedString(32, true);
        const xs: number[] = [];
        for (let j = 0; j < 14; j++) xs.push(s.u32());
        const ys = readCond(ver, FmtVer.V_164, '>=', () => {
          const arr: number[] = [];
          for (let j = 0; j < 3; j++) arr.push(s.u32());
          return arr;
        });
        const zs = readCond(ver, FmtVer.V_172, '>=', () => {
          const arr: number[] = [];
          for (let j = 0; j < 2; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: 'x02', string, xs, ys, zs });
        break;
      }
      case 0x03: {
        const str = ver >= FmtVer.V_172 ? s.fixedString(64, true) : s.fixedString(32, true);
        const unknown1c = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
        if (keep) items.push({ kind: 'x03', str, unknown1: unknown1c });
        break;
      }
      case 0x05: {
        const unknown = s.bytes(28).slice();
        const unknown2c = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
        if (keep) items.push({ kind: 'x05', unknown, unknown2: unknown2c });
        break;
      }
      case 0x06: {
        const n = s.u16();
        const r = s.u8();
        const sc = s.u8();
        const unknown1c = s.u32();
        const unknown2c = readCond(ver, FmtVer.V_172, '<', () => {
          const arr: number[] = [];
          for (let j = 0; j < 50; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: 'x06', n, r, s: sc, unknown1: unknown1c, unknown2: unknown2c });
        break;
      }
      case 0x08: {
        const a = s.u32();
        const b = s.u32();
        const charHeight = s.u32();
        const charWidth = s.u32();
        const unknown2c = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
        const characterSpace = s.u32();
        const lineSpace = s.u32();
        const unknown3c = s.u32();
        const strokeWidth = s.u32();
        const ys = readCond(ver, FmtVer.V_172, '>=', () => {
          const arr: number[] = [];
          for (let j = 0; j < 8; j++) arr.push(s.u32());
          return arr;
        });
        if (keep) items.push({ kind: 'x08_font', a, b, charHeight, charWidth, unknown2: unknown2c, characterSpace, lineSpace, unknown3: unknown3c, strokeWidth, ys });
        break;
      }
      case 0x0B: {
        const unknown = s.bytes(1016).slice();
        if (keep) items.push({ kind: 'x0B', unknown });
        break;
      }
      case 0x0C: {
        const unknown = s.bytes(232).slice();
        if (keep) items.push({ kind: 'x0C', unknown });
        break;
      }
      case 0x0D: {
        const unknown = s.bytes(200).slice();
        if (keep) items.push({ kind: 'x0D', unknown });
        break;
      }
      case 0x0F: {
        const itemKey = s.u32();
        const ptrs: [number, number, number] = [s.u32(), s.u32(), s.u32()];
        const ptr2 = s.u32();
        if (keep) items.push({ kind: 'x0F', key: itemKey, ptrs, ptr2 });
        break;
      }
      case 0x10: {
        const unknown = s.bytes(108).slice();
        const unknown2c = readCond(ver, FmtVer.V_180, '>=', () => s.u32());
        if (keep) items.push({ kind: 'x10', unknown, unknown2: unknown2c });
        break;
      }
      case 0x12: {
        s.skip(1052);
        if (keep) items.push({ kind: 'x12' });
        break;
      }
      default:
        throw new Error(`Unknown substruct type 0x${code.toString(16)} in block 0x36 at offset 0x${offset.toString(16)}`);
    }
  }

  return { blockType: 0x36, offset, key, code, next, unknown1, numItems, count, lastIdx, unknown2, unknown3, items };
}

function parseBlock0x37(s: AllegroStream, ver: FmtVer, offset: number): Blk0x37PtrArray {
  const t = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const groupPtr = s.u32();
  const next = s.u32();
  const capacity = s.u32();
  const count = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  // Fixed 100-element u32 array
  const ptrs: number[] = s.u32Array(100);

  return { blockType: 0x37, offset, key, t, t2, groupPtr, next, capacity, count, unknown2, unknown3, ptrs };
}

function parseBlock0x38(s: AllegroStream, ver: FmtVer, offset: number): Blk0x38Film {
  s.skip(3);

  const key = s.u32();
  const next = s.u32();
  const layerList = s.u32();

  // filmName is present only for < V166
  const filmName = readCond(ver, FmtVer.V_166, '<', () => s.fixedString(20, true));
  const layerNameStr = readCond(ver, FmtVer.V_166, '>=', () => s.u32());
  const unknown2 = readCond(ver, FmtVer.V_166, '>=', () => s.u32());

  const unknownArray1: [number, number, number, number, number, number, number] = [
    s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(), s.u32(),
  ];
  const unknown3 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x38, offset, key, next, layerList, filmName, layerNameStr, unknown2, unknownArray1, unknown3 };
}

function parseBlock0x39(s: AllegroStream, _ver: FmtVer, offset: number): Blk0x39FilmLayerList {
  s.skip(3);

  const key = s.u32();
  const parent = s.u32();
  const head = s.u32();

  // 22 × u16
  const x: number[] = [];
  for (let i = 0; i < 22; i++) {
    x.push(s.u16());
  }

  return { blockType: 0x39, offset, key, parent, head, x };
}

function parseBlock0x3A(s: AllegroStream, ver: FmtVer, offset: number): Blk0x3AFilmListNode {
  s.skip(1);

  const layer = parseLayerInfo(s);
  const key = s.u32();
  const next = s.u32();
  const unknown = s.u32();
  const unknown1 = readCond(ver, FmtVer.V_174, '>=', () => s.u32());

  return { blockType: 0x3A, offset, key, layer, next, unknown, unknown1 };
}

function parseBlock0x3B(s: AllegroStream, ver: FmtVer, offset: number): Blk0x3BProperty {
  // BLK_0x3B_PROPERTY has no m_Key field — use offset as key for BlockBase.
  const t = s.u8();
  const subType = s.u16();
  const len = s.u32(); // KiCad: m_Len (length of the value string)
  const name = s.fixedString(128, true);
  const type = s.fixedString(32, true);
  const unknown1 = s.u32();
  const unknown2 = s.u32();
  const unknown3 = readCond(ver, FmtVer.V_172, '>=', () => s.u32());
  const value = s.fixedString(len, true);

  return { blockType: 0x3B, offset, key: offset, t, subType, len, name, type, unknown1, unknown2, unknown3, value };
}

function parseBlock0x3C(s: AllegroStream, ver: FmtVer, offset: number): Blk0x3CKeyList {
  const t = s.u8();
  const t2 = s.u16();
  const key = s.u32();
  const unknown = readCond(ver, FmtVer.V_174, '>=', () => s.u32());
  const numEntries = s.u32();

  if (numEntries > 1_000_000) {
    throw new Error(`Block 0x3C entry count ${numEntries} exceeds limit at offset 0x${offset.toString(16)}`);
  }

  const entries: number[] = [];
  for (let i = 0; i < numEntries; i++) {
    entries.push(s.u32());
  }

  return { blockType: 0x3C, offset, key, t, t2, unknown, numEntries, entries };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

/**
 * Read one block from the stream.
 * Returns null on type 0x00 (end-of-objects marker).
 * Throws on unknown block types.
 *
 * @param stream  - positioned at the start of a block (type byte)
 * @param ver     - file format version
 * @param x27End  - byte offset of end of the 0x27 CSTRMGR_XREF blob (from header)
 */
export function parseBlock(stream: AllegroStream, ver: FmtVer, x27End: number): AllegroBlock | null {
  const offset = stream.position;
  const type = stream.u8();

  switch (type) {
    case 0x00:
      return null;
    case 0x01:
      return parseBlock0x01(stream, ver, offset);
    case 0x03:
      return parseBlock0x03(stream, ver, offset);
    case 0x04:
      return parseBlock0x04(stream, ver, offset);
    case 0x05:
      return parseBlock0x05(stream, ver, offset);
    case 0x06:
      return parseBlock0x06(stream, ver, offset);
    case 0x07:
      return parseBlock0x07(stream, ver, offset);
    case 0x08:
      return parseBlock0x08(stream, ver, offset);
    case 0x09:
      return parseBlock0x09(stream, ver, offset);
    case 0x0A:
      return parseBlock0x0A(stream, ver, offset);
    case 0x0C:
      return parseBlock0x0C(stream, ver, offset);
    case 0x0D:
      return parseBlock0x0D(stream, ver, offset);
    case 0x0E:
      return parseBlock0x0E(stream, ver, offset);
    case 0x0F:
      return parseBlock0x0F(stream, ver, offset);
    case 0x10:
      return parseBlock0x10(stream, ver, offset);
    case 0x11:
      return parseBlock0x11(stream, ver, offset);
    case 0x12:
      return parseBlock0x12(stream, ver, offset);
    case 0x14:
      return parseBlock0x14(stream, ver, offset);
    case 0x15:
      return parseBlock0x15_16_17(stream, ver, offset, 0x15);
    case 0x16:
      return parseBlock0x15_16_17(stream, ver, offset, 0x16);
    case 0x17:
      return parseBlock0x15_16_17(stream, ver, offset, 0x17);
    case 0x1B:
      return parseBlock0x1B(stream, ver, offset);
    case 0x1C:
      return parseBlock0x1C(stream, ver, offset);
    case 0x1D:
      return parseBlock0x1D(stream, ver, offset);
    case 0x1E:
      return parseBlock0x1E(stream, ver, offset);
    case 0x1F:
      return parseBlock0x1F(stream, ver, offset);
    case 0x20:
      return parseBlock0x20(stream, ver, offset);
    case 0x21:
      return parseBlock0x21(stream, ver, offset);
    case 0x22:
      return parseBlock0x22(stream, ver, offset);
    case 0x23:
      return parseBlock0x23(stream, ver, offset);
    case 0x24:
      return parseBlock0x24(stream, ver, offset);
    case 0x26:
      return parseBlock0x26(stream, ver, offset);
    case 0x27:
      return parseBlock0x27(stream, ver, offset, x27End);
    case 0x28:
      return parseBlock0x28(stream, ver, offset);
    case 0x29:
      return parseBlock0x29(stream, ver, offset);
    case 0x2A:
      return parseBlock0x2A(stream, ver, offset);
    case 0x2B:
      return parseBlock0x2B(stream, ver, offset);
    case 0x2C:
      return parseBlock0x2C(stream, ver, offset);
    case 0x2D:
      return parseBlock0x2D(stream, ver, offset);
    case 0x2E:
      return parseBlock0x2E(stream, ver, offset);
    case 0x2F:
      return parseBlock0x2F(stream, ver, offset);
    case 0x30:
      return parseBlock0x30(stream, ver, offset);
    case 0x31:
      return parseBlock0x31(stream, ver, offset);
    case 0x32:
      return parseBlock0x32(stream, ver, offset);
    case 0x33:
      return parseBlock0x33(stream, ver, offset);
    case 0x34:
      return parseBlock0x34(stream, ver, offset);
    case 0x35:
      return parseBlock0x35(stream, ver, offset);
    case 0x36:
      return parseBlock0x36(stream, ver, offset);
    case 0x37:
      return parseBlock0x37(stream, ver, offset);
    case 0x38:
      return parseBlock0x38(stream, ver, offset);
    case 0x39:
      return parseBlock0x39(stream, ver, offset);
    case 0x3A:
      return parseBlock0x3A(stream, ver, offset);
    case 0x3B:
      return parseBlock0x3B(stream, ver, offset);
    case 0x3C:
      return parseBlock0x3C(stream, ver, offset);
    default:
      throw new Error(`Unknown block type 0x${type.toString(16).padStart(2, '0')} at offset 0x${offset.toString(16)}`);
  }
}
