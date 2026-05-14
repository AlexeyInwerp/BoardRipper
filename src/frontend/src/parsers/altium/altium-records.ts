/**
 * Altium lookup-table decoders — Nets6, Classes6, WideStrings6.
 *
 * These three streams are consumed by every other Altium decoder:
 *   - Nets6/Data         — net index → net name (text property-bag)
 *   - Classes6/Data      — class name + kind + member list (text property-bag)
 *   - WideStrings6/Data  — non-ASCII string pool (binary, version-dependent)
 *
 * Port from KiCad: pcbnew/pcb_io/altium/altium_parser_pcb.cpp ::
 *   ParseNets6Data, ParseClasses6Data, ParseWideStrings6Data
 */

import type { ABoard6, ANet6, AClass6, AWideStringTable } from './altium-types';
import { AltiumStream } from './altium-stream';
import { iterateRecords, parsePropBagText, readPropInt, readPropString } from './altium-props';

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
 * WideStrings6/Data — binary string pool. KiCad reads it as a sequence of
 * (uint32 index, uint32 byteLength, utf16le bytes) tuples; layout has minor
 * version drift across Altium releases. We accept a malformed tail by
 * stopping early — the P1 assembler only needs lookup-not-found tolerance.
 */
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
