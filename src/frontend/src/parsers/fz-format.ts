import type { FormatDescriptor } from './registry';
import { parseFZ } from './fz-parser';

/**
 * FZ format detection: first 4 bytes are a header, bytes 4-5 should be
 * a zlib signature (0x78 0x9C/0xDA) if unencrypted. For encrypted files,
 * we detect by file extension (.fz) since the header looks like random bytes.
 *
 * Detection heuristic: if bytes 4-5 are zlib, it's definitely FZ.
 * Otherwise, we can't distinguish encrypted FZ from random data by content
 * alone — the format descriptor relies on the file extension fallback in
 * the upload flow.
 */
export const FZFormat: FormatDescriptor = {
  id: 'FZ',
  name: 'FZ (ASUS Boardview)',
  extensions: ['.fz'],
  description: 'RC6-encrypted, zlib-compressed boardview format used by ASUS motherboards.',

  detect(header) {
    if (header.length < 6) return false;
    // Unencrypted: bytes 4-5 are zlib signature
    if (header[4] === 0x78 && (header[5] === 0x9C || header[5] === 0xDA || header[5] === 0x01)) {
      return true;
    }
    // Encrypted FZ files have no reliable magic — fall through to extension-based detection
    return false;
  },

  parse(buffer) {
    return parseFZ(buffer);
  },
};
