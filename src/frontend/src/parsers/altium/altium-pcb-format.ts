/**
 * Altium PCB FormatDescriptor.
 *
 * Detects two flavours:
 *   1. Binary .PcbDoc — MS-CFB container (magic D0CF11E0...), with
 *      "PCB 5.0" inside FileHeader. We check CFB magic first; the inner
 *      "PCB 5.0" string verification happens lazily on parse.
 *   2. ASCII variant — first line "PCB ASCII Version 5.0".
 *
 * Sister extensions (Circuit Maker, Circuit Studio) share the same parser.
 * SolidWorks PCB Connector files also use .PcbDoc; routing is by content.
 */

import type { FormatDescriptor } from '../registry';
import type { BoardData } from '../types';
import { parseAltiumPcb } from './altium-pcb-parser';

const CFB_MAGIC = new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]);
const ASCII_MAGIC = 'PCB ASCII Version 5.0';

function startsWith(buf: Uint8Array, magic: Uint8Array): boolean {
  if (buf.byteLength < magic.byteLength) return false;
  for (let i = 0; i < magic.byteLength; i++) {
    if (buf[i] !== magic[i]) return false;
  }
  return true;
}

export const AltiumPcbFormat: FormatDescriptor = {
  id: 'ALTIUM_PCB',
  name: 'Altium PCB',
  extensions: ['.pcbdoc', '.cmpcbdoc', '.cspcbdoc'],
  description: 'Altium Designer / Circuit Maker / Circuit Studio PCB (binary or ASCII)',
  docUrl: 'docs/formats/ALTIUM_PCB_FORMAT.md',
  hasPads: true,
  hasTraces: true,
  // hasLayers stays false on purpose: setting it would hide the Top/Bottom +
  // Traces toolbar toggles (Toolbar.tsx:447 — TVW pattern assumes per-layer
  // visibility from the sidebar replaces those). The sidebar Layers tab is
  // driven by BoardData.layerNames being populated (board-store.ts:805) so
  // we still get per-layer visibility there — without sacrificing the
  // toolbar toggles users expect on a side-poled board view.
  detect(header: Uint8Array): boolean {
    if (startsWith(header, CFB_MAGIC)) return true;
    const probe = new TextDecoder('utf-8', { fatal: false }).decode(header.subarray(0, Math.min(64, header.byteLength)));
    return probe.startsWith(ASCII_MAGIC) || probe.trimStart().startsWith(ASCII_MAGIC);
  },
  async parse(buffer: ArrayBuffer): Promise<BoardData> {
    return parseAltiumPcb(buffer);
  },
};
