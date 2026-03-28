import type { FormatDescriptor } from './registry';
import { parseAllegroBRD } from './allegro/allegro-brd-parser';

/**
 * Cadence Allegro BRD — binary PCB design format.
 *
 * Supports multi-layer boards with components, nets, and traces.
 * The first 4 bytes (uint32 LE) encode the Allegro version as a magic number.
 * Known version families: 16.x (0x0013xxxx) and 17.x (0x0014xxxx).
 *
 * Spec: docs/formats/ALLEGRO_BRD_FORMAT.md
 */
export const AllegroBRDFormat: FormatDescriptor = {
  id: 'ALLEGRO_BRD',
  name: 'Cadence Allegro BRD',
  extensions: ['.brd'],
  description: 'Cadence Allegro PCB binary format (multi-layer, components, nets, traces)',
  docUrl: 'docs/formats/ALLEGRO_BRD_FORMAT.md',
  flipY: true,
  hasTraces: true,

  detect(header: Uint8Array): boolean {
    if (header.length < 12) return false;

    // Read first 4 bytes as uint32 LE — Allegro version magic
    const magic = header[0] | (header[1] << 8) | (header[2] << 16) | (header[3] << 24);
    const family = (magic >>> 16) & 0xFFFF;

    // General Allegro pattern: high word is 0x0013 (v16.x) or 0x0014 (v17.x)
    if (family !== 0x0013 && family !== 0x0014 && family !== 0x0015) return false;

    // Additionally verify bytes[8..11] as uint32 LE == 1
    // This distinguishes Allegro BRD from other formats sharing .brd
    const check = header[8] | (header[9] << 8) | (header[10] << 16) | (header[11] << 24);
    return check === 1;
  },

  parse(buffer: ArrayBuffer) {
    return parseAllegroBRD(buffer);
  },
};
