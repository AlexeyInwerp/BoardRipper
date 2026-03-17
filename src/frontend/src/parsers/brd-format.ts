import type { FormatDescriptor } from './registry';
import { parseBRD } from './brd-parser';

// BRD magic: first 4 bytes of every obfuscated boardview file.
const BRD_MAGIC = [0x23, 0xE2, 0x63, 0x28];

export const BRDFormat: FormatDescriptor = {
  id: 'BRD',
  name: 'BRD (Binary Obfuscated Boardview)',
  extensions: ['.brd'],
  description: 'Binary-obfuscated boardview format used in Apple/Mac board repair. Bit-rotation encoding, 6 named sections.',
  docUrl: 'docs/formats/BRD_FORMAT.md',
  flipY: true,

  detect(header) {
    if (header.length < 4) return false;
    return BRD_MAGIC.every((b, i) => header[i] === b);
  },

  parse(buffer) {
    return parseBRD(buffer);
  },
};
