import type { FormatDescriptor } from './registry';
import { parseKiCadPCB } from './kicad-parser';

const decoder = new TextDecoder('utf-8');

/**
 * KiCad board file (`.kicad_pcb`) — the native, uncompressed S-expression
 * design database written by pcbnew (KiCad 4 through 9).
 *
 * Detection: the document's first expression is `(kicad_pcb`. The keyword is
 * unique to the format and the extension is unshared, so there is no
 * ambiguity with any other registered format.
 *
 * Coordinates are millimetres with Y pointing down (screen orientation), so
 * `flipY` stays false — see docs/formats/KICAD_PCB_FORMAT.md.
 *
 * Original implementation from the public KiCad file-format documentation;
 * no code derived from KiCad itself. Part of BoardRipper
 * (AGPL-3.0-or-later, see ../../../../LICENSE).
 */
export const KiCadPcbFormat: FormatDescriptor = {
  id: 'KICAD',
  name: 'KiCad Board',
  extensions: ['.kicad_pcb'],
  description: 'KiCad pcbnew board file (S-expression): footprints, pads, nets, Edge.Cuts outline, tracks and vias.',
  docUrl: 'docs/formats/KICAD_PCB_FORMAT.md',
  hasTraces: true,
  hasPads: true,

  detect(header: Uint8Array): boolean {
    return /^[\s\0]*\(\s*kicad_pcb\b/.test(decoder.decode(header));
  },

  parse(buffer: ArrayBuffer) {
    return parseKiCadPCB(buffer);
  },
};
