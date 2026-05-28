import type { FormatDescriptor } from './registry';
import { parseXZZ, isPadsBinaryHeader } from './xzz-parser';

/** XZZ magic string */
const XZZ_MAGIC = 'XZZPCB';

export const XZZFormat: FormatDescriptor = {
  id: 'XZZ',
  name: 'XZZ PCB (Encrypted Boardview)',
  extensions: ['.pcb'],
  description: 'XZZ encrypted boardview format. Main data blocks are DES-encrypted (key: 0xdcfc12ac). Header may be XOR-obfuscated.',
  docUrl: 'docs/formats/XZZ_FORMAT.md',
  flipY: true,

  detect(header) {
    if (header.length < 6) return false;
    // Check plain magic
    const plain = String.fromCharCode(header[0], header[1], header[2], header[3], header[4], header[5]);
    if (plain === XZZ_MAGIC) return true;
    // Check XOR-obfuscated magic: XOR key is at offset 0x10
    if (header.length > 0x10 && header[0x10] !== 0) {
      const xk = header[0x10];
      const decoded = String.fromCharCode(
        header[0] ^ xk, header[1] ^ xk, header[2] ^ xk,
        header[3] ^ xk, header[4] ^ xk, header[5] ^ xk,
      );
      if (decoded === XZZ_MAGIC) return true;
    }
    // Mentor PADS Layout binary files also use `.pcb`. Claim them here so the
    // parser can reject them with a clear message (see parseXZZ) instead of the
    // extension fallback handing them to XZZ and dying on "invalid header offsets".
    if (isPadsBinaryHeader(header)) return true;
    return false;
  },

  parse(buffer) {
    return parseXZZ(buffer);
  },
};
