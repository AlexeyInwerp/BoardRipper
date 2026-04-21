import type { FormatDescriptor } from './registry';
import { parseBDVAsc } from './bdv-asc-parser';

/**
 * BDV ASC — Honhan / Tebo-ICT obfuscated boardview.
 *
 * Also distributed with the `.bdv` extension. Files open with the literal
 * byte sequence `dd:1.3?,r?-=bb` which, after applying the line-key cipher
 * starting at count = 0xA0, decodes to `<<format.asc>>` — the first of
 * three embedded ASC sections (format / nails / pins).
 *
 * See docs/formats/BDV_ASC_FORMAT.md for the full specification.
 */
const SIGNATURE = 'dd:1.3?,r?-=bb';

export const BDVAscFormat: FormatDescriptor = {
  id: 'BDV_ASC',
  name: 'BDV ASC (Honhan / Tebo-ICT)',
  extensions: ['.bdv'],
  description: 'Obfuscated multi-section ASC boardview produced by Honhan / Tebo-ICT tools.',
  docUrl: 'docs/formats/BDV_ASC_FORMAT.md',
  flipY: true,

  detect(header: Uint8Array): boolean {
    if (header.length < SIGNATURE.length) return false;
    for (let i = 0; i < SIGNATURE.length; i++) {
      if (header[i] !== SIGNATURE.charCodeAt(i)) return false;
    }
    return true;
  },

  parse(buffer: ArrayBuffer) {
    return parseBDVAsc(buffer);
  },
};
