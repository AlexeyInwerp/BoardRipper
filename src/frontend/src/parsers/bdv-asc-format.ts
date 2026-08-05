import type { FormatDescriptor } from './registry';
import { parseBDVAsc, identifyAscSection } from './bdv-asc-parser';

/**
 * BDV ASC — Honhan / Tebo-ICT obfuscated boardview.
 *
 * Also distributed with the `.bdv` extension. Files open with the literal
 * byte sequence `dd:1.3?,r?-=bb` which, after applying the line-key cipher
 * starting at count = 0xA0, decodes to `<<format.asc>>` — the first of
 * three embedded ASC sections (format / nails / pins).
 *
 * The same document also ships **unencoded, split into the three files the
 * markers are named after** (issue #26). Those are accepted here too: the
 * markers inside the bundle are literally the file names, so a plain
 * `pins.asc` is the bundle's `<<pins.asc>>` body with nothing else around it.
 * Selecting several at once merges them into one board — see
 * `bundleAscFiles` and board-store's `loadFiles`.
 *
 * See docs/formats/BDV_ASC_FORMAT.md for the full specification.
 */
const SIGNATURE = 'dd:1.3?,r?-=bb';

export const BDVAscFormat: FormatDescriptor = {
  id: 'BDV_ASC',
  name: 'BDV ASC (Honhan / Tebo-ICT)',
  extensions: ['.bdv', '.asc'],
  description: 'Multi-section ASC boardview produced by Honhan / Tebo-ICT tools — obfuscated (.bdv) or plain (.asc).',
  docUrl: 'docs/formats/BDV_ASC_FORMAT.md',
  flipY: true,

  detect(header: Uint8Array): boolean {
    if (header.length >= SIGNATURE.length) {
      let sig = true;
      for (let i = 0; i < SIGNATURE.length; i++) {
        if (header[i] !== SIGNATURE.charCodeAt(i)) { sig = false; break; }
      }
      if (sig) return true;
    }
    // Plain (unencoded) delivery: recognised by the vendor header title the
    // tool prints at the top of each section file. 512 bytes is enough — the
    // title sits on the third line.
    const text = new TextDecoder('ascii').decode(header);
    if (text.includes('<<format.asc>>') || text.includes('<<pins.asc>>')) return true;
    return identifyAscSection(text) !== null;
  },

  parse(buffer: ArrayBuffer) {
    return parseBDVAsc(buffer);
  },
};
