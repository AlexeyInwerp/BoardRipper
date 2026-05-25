import type { FormatDescriptor } from './registry';
import { parseBRD } from './brd-parser';

// BRD magic: first 4 bytes of every obfuscated boardview file.
const BRD_MAGIC = [0x23, 0xE2, 0x63, 0x28];
// "BRD_V1.0" — a proprietary .brd container with an encrypted body (origin
// tool unconfirmed). Recognised here so content-detection routes it to
// parseBRD, which rejects it with a clear "proprietary, encoded format"
// message. Without this, detection finds no match and the .brd extension
// fallback hands the encrypted bytes to the BDV parser, which fails with a
// misleading "file may be corrupt" error.
const BRD_V1_MAGIC = [0x42, 0x52, 0x44, 0x5F, 0x56, 0x31, 0x2E, 0x30]; // "BRD_V1.0"

export const BRDFormat: FormatDescriptor = {
  id: 'BRD',
  name: 'BRD (Binary Obfuscated Boardview)',
  extensions: ['.brd'],
  description: 'Binary-obfuscated boardview format used in Apple/Mac board repair. Bit-rotation encoding, 6 named sections.',
  docUrl: 'docs/formats/BRD_FORMAT.md',
  flipY: false,
  swapSides: false,

  detect(header) {
    if (header.length >= 4 && BRD_MAGIC.every((b, i) => header[i] === b)) return true;
    if (header.length >= 8 && BRD_V1_MAGIC.every((b, i) => header[i] === b)) return true;
    return false;
  },

  parse(buffer) {
    return parseBRD(buffer);
  },
};
