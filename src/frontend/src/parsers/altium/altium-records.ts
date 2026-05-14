/**
 * Altium record-stream decoders.
 *
 *   Lookup tables (consumed by every other decoder):
 *     - Nets6/Data         — net index → net name (text property-bag)
 *     - Classes6/Data      — class name + kind + member list (text property-bag)
 *     - WideStrings6/Data  — non-ASCII string pool (binary, version-dependent)
 *
 *   Geometry/metadata (P1 subset):
 *     - Board6/Data        — origin + layer stackup + board name (text property-bag)
 *     - Components6/Data   — component instances (text property-bag)
 *     - Pads6/Data         — pin pads + through-hole pads (binary records)
 *
 * Port from KiCad: pcbnew/pcb_io/altium/altium_parser_pcb.cpp ::
 *   ParseNets6Data, ParseClasses6Data, ParseWideStrings6Data,
 *   ParseBoard6Data, ParseComponents6Data, ParsePads6Data
 */

import type {
  ABoard6,
  AComponent6,
  ANet6,
  AClass6,
  APad6,
  ATrack6,
  AVia6,
  AArc6,
  AFill6,
  AWideStringTable,
} from './altium-types';
import { AltiumStream } from './altium-stream';
import { ALTIUM_LAYER } from './altium-layers';
import { log } from '../../store/log-store';
import {
  iterateRecords,
  parsePropBagText,
  readPropBool,
  readPropFloat,
  readPropInt,
  readPropString,
} from './altium-props';
import { parseAltiumLayerName } from './altium-layers';

/**
 * Nets6/Data — property-bag text. Net index = record order (0-based);
 * the bare NAME field is the only thing P1 needs.
 */
export function parseNets6(buf: Uint8Array): ANet6[] {
  const out: ANet6[] = [];
  for (const props of iterateRecords(buf)) {
    out.push({ name: readPropString(props, 'NAME', '') });
  }
  return out;
}

/**
 * Classes6/Data — property-bag text. KIND values: 0=NET, 1=PAD, 2=COMPONENT.
 * Member names live under M0, M1, M2 ... keys (contiguous from 0).
 */
export function parseClasses6(buf: Uint8Array): AClass6[] {
  const out: AClass6[] = [];
  for (const props of iterateRecords(buf)) {
    const kindRaw = readPropString(props, 'KIND', '0');
    let kind: AClass6['kind'] = 'OTHER';
    switch (kindRaw) {
      case '0':
        kind = 'NET';
        break;
      case '1':
        kind = 'PAD';
        break;
      case '2':
        kind = 'COMPONENT';
        break;
    }
    const memberNames: string[] = [];
    let i = 0;
    while (true) {
      const key = `M${i}`;
      if (!props.has(key)) break;
      memberNames.push(props.get(key) ?? '');
      i++;
    }
    out.push({
      name: readPropString(props, 'NAME', ''),
      kind,
      memberNames,
    });
  }
  return out;
}

/**
 * Board6/Data is property-bag text. Unlike other text streams it is *not*
 * length-prefixed by record — the whole stream is one big property bag.
 * Some files prepend a uint32 length wrapper; detect by checking whether
 * the first 4 bytes form a length matching the rest of the stream.
 *
 * Port from: altium_parser_pcb.cpp :: ParseBoard6Data
 */
export function parseBoard6(buf: Uint8Array): ABoard6 {
  let offset = 0;
  if (buf.length >= 4) {
    const len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
    if (len > 0 && len + 4 === buf.length) offset = 4;
  }
  const text = new TextDecoder('utf-8').decode(buf.subarray(offset));
  const props = parsePropBagText(text);

  const layerNames: string[] = [];
  for (let i = 1; i <= 82; i++) {
    layerNames.push(readPropString(props, `LAYER${i}NAME`, ''));
  }
  while (layerNames.length > 0 && layerNames[layerNames.length - 1] === '') layerNames.pop();

  return {
    name: readPropString(props, 'BOARDDESCRIPTION', ''),
    originX: readPropInt(props, 'ORIGINX', 0),
    originY: readPropInt(props, 'ORIGINY', 0),
    layerNames,
    formatVersion: readPropString(props, 'VERSION', ''),
  };
}

/**
 * WideStrings6/Data — binary string pool. KiCad reads it as a sequence of
 * (uint32 index, uint32 byteLength, utf16le bytes) tuples; layout has minor
 * version drift across Altium releases. We accept a malformed tail by
 * stopping early — the P1 assembler only needs lookup-not-found tolerance.
 */
export function parseWideStrings6(buf: Uint8Array): AWideStringTable {
  const s = new AltiumStream(buf);
  const map = new Map<number, string>();
  const utf16 = new TextDecoder('utf-16le');
  while (s.remaining() >= 8) {
    const idx = s.readUint32();
    const len = s.readUint32();
    if (len > s.remaining()) break;
    const bytes = s.slice(len);
    map.set(idx, utf16.decode(bytes));
  }
  return {
    byIndex(idx: number): string {
      return map.get(idx) ?? '';
    },
  };
}

/**
 * Components6/Data is property-bag text. Each record (one per component) has:
 *   RECORD=1
 *   LAYER=TOP|BOTTOM|…
 *   X=<altium-units>, Y=<altium-units>
 *   ROTATION=<deg>
 *   SOURCEDESIGNATOR=<refdes>
 *   PATTERN=<footprint>, COMPONENT=<lib-name>
 *   COMPONENTDESCRIPTION=<free-text>, LOCKED=TRUE|FALSE
 *
 * Port from: altium_parser_pcb.cpp :: ParseComponents6Data
 */
export function parseComponents6(buf: Uint8Array): AComponent6[] {
  const out: AComponent6[] = [];
  for (const props of iterateRecords(buf)) {
    out.push({
      designator: readPropString(props, 'SOURCEDESIGNATOR', readPropString(props, 'NAME', '')),
      pattern: readPropString(props, 'PATTERN', ''),
      componentName: readPropString(props, 'COMPONENT', ''),
      description: readPropString(props, 'COMPONENTDESCRIPTION', ''),
      layer: parseAltiumLayerName(readPropString(props, 'LAYER', 'TOP')),
      x: readPropInt(props, 'X', 0),
      y: readPropInt(props, 'Y', 0),
      rotation: readPropFloat(props, 'ROTATION', 0),
      locked: readPropBool(props, 'LOCKED', false),
    });
  }
  return out;
}

/**
 * Pads6/Data is a binary stream of length-prefixed records. Each record is:
 *
 *   uint8  recordType (must be 2 = PAD)
 *   --- Subrecord 1 (name) ---
 *   uint32 len1
 *   uint8  nameLen, name[nameLen]                           // ReadWxString = short-pascal
 *   (any trailing bytes inside len1 are skipped)
 *   --- Subrecord 2,3,4 (each: uint32 length + body, all skipped) ---
 *   --- Subrecord 5 (pad geometry, ≥110 bytes) ---
 *   uint32 len5  (≥110; layout has version-conditional tail)
 *   uint8  layer_v6
 *   uint8  flags1, uint8 flags2
 *   uint16 net,  skip(2)
 *   uint16 component, skip(4)                               // pos 13 within body
 *   int32  posX,  int32 posY                                // raw Altium units (no Y-flip; assembler does it)
 *   int32  topX,  int32 topY                                // size
 *   int32  midX,  int32 midY                                // unused in P1
 *   int32  botX,  int32 botY                                // unused in P1
 *   int32  holeSize                                         // pos 49
 *   uint8  topShape, uint8 midShape, uint8 botShape
 *   f64    direction (degrees)
 *   uint8  plated, skip(1)
 *   uint8  padmode, skip(23)
 *   int32  pastemaskManual, int32 soldermaskManual
 *   skip(7)
 *   uint8  pastemaskMode, uint8 soldermaskMode, skip(3)     // pos 106
 *   (version tail: holerotation, tolayer/fromlayer, pad-to-die …
 *    — we skip to end of subrecord via len5)
 *   --- Subrecord 6 (optional size+shape table, ≥596 bytes, skipped) ---
 *   uint32 len6 + body
 *
 * Port from: altium_parser_pcb.cpp :: APAD6::APAD6 (lines 920-1089).
 */
export function parsePads6(buf: Uint8Array): APad6[] {
  const s = new AltiumStream(buf);
  const out: APad6[] = [];
  const PAD_RECORD = 2;

  while (!s.eof()) {
    const recordType = s.readUint8();
    if (recordType !== PAD_RECORD) {
      log.parser.warn(`Pads6: unexpected record type ${recordType} at pos ${s.pos - 1}, stopping`);
      break;
    }

    // Subrecord 1 — name (ReadWxString = uint8 length + bytes), wrapped in uint32.
    const len1 = s.readUint32();
    const sub1End = s.pos + len1;
    let name = '';
    if (len1 >= 1 && len1 <= s.remaining()) {
      const nameByteLen = s.readUint8();
      if (nameByteLen <= s.remaining()) {
        name = new TextDecoder('latin1').decode(s.slice(nameByteLen));
      }
    }
    s.pos = sub1End;

    // Subrecords 2, 3, 4 — skipped entirely.
    for (let i = 0; i < 3; i++) {
      if (s.remaining() < 4) break;
      const subLen = s.readUint32();
      s.pos += subLen;
    }

    // Subrecord 5 — pad geometry (≥110 bytes).
    if (s.remaining() < 4) break;
    const len5 = s.readUint32();
    const sub5End = s.pos + len5;
    if (len5 < 110 || sub5End > buf.byteLength) {
      log.parser.warn(`Pads6: subrecord5 length ${len5} too small or out of bounds at pos ${s.pos}`);
      break;
    }

    const layer = s.readUint8();                                  // +1
    s.skip(2);                                                    // +2  flags1, flags2
    const netIndex = s.readInt16();                               // +2
    s.skip(2);                                                    // +2  padding
    const componentIndex = s.readInt16();                         // +2
    s.skip(4);                                                    // +4  padding  -> pos 13 within sub5
    const x = s.readInt32();                                      // +4
    const y = s.readInt32();                                      // +4  raw Altium Y (assembler flips)
    const xsize = s.readInt32();                                  // +4
    const ysize = s.readInt32();                                  // +4
    s.skip(4 * 4);                                                // +16 mid + bot sizes (4 int32)
    const holeSize = s.readInt32();                               // +4  -> pos 49
    const topShape = s.readUint8();                               // +1
    s.skip(2);                                                    // +2  mid + bot shape
    const rotation = s.readFloat64();                             // +8  pad rotation (degrees)
    // remainder of subrecord 5 (plated, padmode, masks, version tail) — skip.
    s.pos = sub5End;

    // Subrecord 6 — optional size-and-shape table, skipped.
    if (s.remaining() >= 4) {
      const len6 = s.readUint32();
      s.pos += len6;
    }

    out.push({
      name,
      componentIndex,
      netIndex,
      layer,
      x,
      y,
      xsize: Math.max(0, xsize),
      ysize: Math.max(0, ysize),
      topShape,
      holeSize,
      rotation,
      isThroughHole: layer === ALTIUM_LAYER.MULTI_LAYER,
    });
  }

  return out;
}

/**
 * Generic walker for single-subrecord binary streams (tracks, vias, arcs, fills).
 * Each record is `u8 recordType + u32 subrecordLen + body`. Caller validates
 * the expected recordType and reads from the body via a sub-cursor.
 */
function* iterateSingleSubrecord(
  buf: Uint8Array,
  expectedRecordType: number,
): Generator<{ body: AltiumStream; bodyLen: number }> {
  const s = new AltiumStream(buf);
  while (!s.eof()) {
    const recordType = s.readUint8();
    if (recordType !== expectedRecordType) {
      log.parser.warn(`altium: unexpected record type ${recordType} (expected ${expectedRecordType}); halting walk`);
      return;
    }
    const bodyLen = s.readUint32();
    if (bodyLen > s.remaining()) return;
    const bodyBytes = s.slice(bodyLen);
    yield { body: new AltiumStream(bodyBytes), bodyLen };
  }
}

/**
 * Tracks6/Data — line segments on a copper or non-copper layer.
 * recordType = 4. KiCad ParseTracks6Data.
 */
export function parseTracks6(buf: Uint8Array): ATrack6[] {
  const out: ATrack6[] = [];
  for (const { body } of iterateSingleSubrecord(buf, 4)) {
    const layer = body.readUint8();
    body.skip(2); // flags1, flags2
    const netIndex = body.readInt16();
    body.skip(2); // polygon index
    const componentIndex = body.readInt16();
    body.skip(4);
    const startX = body.readInt32();
    const startY = body.readInt32();
    const endX = body.readInt32();
    const endY = body.readInt32();
    const width = body.readInt32();
    out.push({ layer, netIndex, componentIndex, startX, startY, endX, endY, width });
  }
  return out;
}

/**
 * Vias6/Data — drilled connections. recordType = 3. KiCad ParseVias6Data.
 */
export function parseVias6(buf: Uint8Array): AVia6[] {
  const out: AVia6[] = [];
  for (const { body } of iterateSingleSubrecord(buf, 3)) {
    body.skip(1);
    body.skip(2); // flags1 + flags2
    const netIndex = body.readInt16();
    body.skip(8);
    const x = body.readInt32();
    const y = body.readInt32();
    const diameter = body.readInt32();
    const holeSize = body.readInt32();
    const layerStart = body.readUint8();
    const layerEnd = body.readUint8();
    out.push({ netIndex, x, y, diameter, holeSize, layerStart, layerEnd });
  }
  return out;
}

/**
 * Arcs6/Data — arc segments. recordType = 1. KiCad ParseArcs6Data.
 * Caller tessellates to line segments (see altium-assembler).
 */
export function parseArcs6(buf: Uint8Array): AArc6[] {
  const out: AArc6[] = [];
  for (const { body } of iterateSingleSubrecord(buf, 1)) {
    const layer = body.readUint8();
    body.skip(2); // flags1, flags2
    const netIndex = body.readInt16();
    body.skip(2); // polygon
    const componentIndex = body.readInt16();
    body.skip(4);
    const centerX = body.readInt32();
    const centerY = body.readInt32();
    const radius = body.readInt32();
    const startAngle = body.readFloat64();
    const endAngle = body.readFloat64();
    const width = body.readInt32();
    out.push({ layer, netIndex, componentIndex, centerX, centerY, radius, startAngle, endAngle, width });
  }
  return out;
}

/**
 * Fills6/Data — rotatable copper fill rectangles. recordType = 6.
 * KiCad ParseFills6Data. Two corner points + rotation angle.
 */
export function parseFills6(buf: Uint8Array): AFill6[] {
  const out: AFill6[] = [];
  for (const { body } of iterateSingleSubrecord(buf, 6)) {
    const layer = body.readUint8();
    body.skip(2); // flags1, flags2
    const netIndex = body.readInt16();
    body.skip(2);
    const componentIndex = body.readInt16();
    body.skip(4);
    const x1 = body.readInt32();
    const y1 = body.readInt32();
    const x2 = body.readInt32();
    const y2 = body.readInt32();
    const rotation = body.readFloat64();
    out.push({ layer, netIndex, componentIndex, x1, y1, x2, y2, rotation });
  }
  return out;
}
