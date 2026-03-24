import type { FormatDescriptor } from './registry';
import { parseBDV } from './bdv-parser';

/**
 * BDV — Plain-text boardview format (also distributed with .brd extension).
 *
 * Unlike the binary-obfuscated BRD (Apple/Mac), this is readable ASCII with
 * keyword-prefixed sections: BRDOUT, NETS, PARTS, PINS, NAILS.
 *
 * Detection: look for "BRDOUT:" within the first 512 bytes.
 */
export const BDVFormat: FormatDescriptor = {
  id: 'BDV',
  name: 'BDV (Plain-Text Boardview)',
  extensions: ['.brd', '.bdv'],
  description: 'Plain-text boardview format with BRDOUT/NETS/PARTS/PINS/NAILS sections.',
  flipY: true,

  detect(header: Uint8Array): boolean {
    // Decode as ASCII and look for "BRDOUT:" within the first 512 bytes.
    // This distinguishes it from binary-obfuscated BRD and Allegro BRD.
    const text = new TextDecoder('ascii').decode(header);
    return /BRDOUT:/i.test(text);
  },

  parse(buffer: ArrayBuffer) {
    return parseBDV(buffer);
  },
};
