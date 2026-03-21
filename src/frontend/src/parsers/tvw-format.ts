import type { FormatDescriptor } from './registry';
import { parseTVW } from './tvw-parser';

/**
 * TVW (Teboview) — binary PCB boardview format from Tebo-ICT.
 *
 * Supports multi-layer copper, drill holes, traces, arcs, surfaces.
 * Uses Fixed32 coordinates (raw / 100 = mils) and string obfuscation.
 * Commonly found for Lenovo laptop boards (LCFC/LianBao ODM).
 *
 * Reference: eagleview by Pavel Kovalenko (MIT), inflex/teboviewformat.
 * Spec: docs/formats/TVW_FORMAT.md
 */
export const TVWFormat: FormatDescriptor = {
  id: 'TVW',
  name: 'Teboview TVW',
  extensions: ['.tvw'],
  description: 'Tebo-ICT binary boardview (multi-layer, copper geometry, drill data)',
  docUrl: 'docs/formats/TVW_FORMAT.md',
  flipY: true,
  hasLayers: true,
  hasTraces: true,

  detect(header: Uint8Array): boolean {
    // TVW files start with a Pascal string (u8 length + data), then u32 = 1,
    // then another Pascal string whose decoded value is the version identifier.
    // The first byte is the length of the file_type string (typically 19).
    // After that string + u32(1), the next 7 bytes are "G34vS4z" (the version).
    if (header.length < 32) return false;

    const nameLen = header[0];
    if (nameLen === 0 || nameLen > 64) return false;

    // Check u32 = 1 after the first Pascal string
    const u32Offset = 1 + nameLen;
    if (u32Offset + 4 > header.length) return false;
    const val = header[u32Offset] | (header[u32Offset + 1] << 8) |
                (header[u32Offset + 2] << 16) | (header[u32Offset + 3] << 24);
    if (val !== 1) return false;

    // Check for "G34vS4z" version string after the u32
    // There's a Pascal string (customer) between, but the version "G34vS4z"
    // should appear somewhere in the first 64 bytes. Let's search for it.
    const searchRange = Math.min(header.length, 128);
    const target = [0x47, 0x33, 0x34, 0x76, 0x53, 0x34, 0x7A]; // "G34vS4z"
    for (let i = u32Offset + 4; i <= searchRange - target.length; i++) {
      let match = true;
      for (let j = 0; j < target.length; j++) {
        if (header[i + j] !== target[j]) { match = false; break; }
      }
      if (match) return true;
    }

    // Extension-based fallback (.tvw) handles files without the G34vS4z marker
    return false;
  },

  parse(buffer: ArrayBuffer) {
    return parseTVW(buffer);
  },
};
