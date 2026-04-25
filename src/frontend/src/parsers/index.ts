import type { BoardData } from './types';
import { registerFormat, detectFormat, detectByExtension, getAllFormats } from './registry';
import { BVR1Format } from './bvr1-format';
import { BVR3Format } from './bvr3-format';
import { BRDFormat } from './brd-format';
import { FZFormat } from './fz-format';
import { CADFormat } from './cad-format';
import { XZZFormat } from './xzz-format';
import { TVWFormat } from './tvw-format';
import { AllegroBRDFormat } from './allegro-brd-format';
import { BDVFormat } from './bdv-format';
import { BDVAscFormat } from './bdv-asc-format';

// Register all known formats in detection-priority order.
// Content-based detection runs in this order; the first match wins.
registerFormat(BVR1Format);
registerFormat(BVR3Format);
registerFormat(BDVAscFormat);       // Before BDV — obfuscated signature is exact, safe to test first
registerFormat(BDVFormat);          // Before Allegro/BRD — plain-text "BRDOUT:" detection is unambiguous
registerFormat(AllegroBRDFormat);  // Before BRD — both use .brd, content detection differentiates
registerFormat(BRDFormat);
registerFormat(FZFormat);
registerFormat(CADFormat);
registerFormat(XZZFormat);
registerFormat(TVWFormat);

export type { BoardData, BoardRevision, GhostComponent, Part, Pin, Net, Point, BBox, SilkscreenPath, Trace, Via } from './types';
export { computeBBox, buildNets } from './types';
export type { FormatDescriptor, FormatId } from './registry';
export { getFormat, getAllFormats, getAllExtensions, getFileExtension } from './registry';
export { exportToBVR3 } from './export-bvr3';

export async function parseBoardFile(buffer: ArrayBuffer, fileName?: string): Promise<BoardData> {
  const header = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength));
  let fmt = detectFormat(header);

  // Fallback: match by file extension (needed for encrypted formats with no detectable magic)
  if (!fmt && fileName) {
    fmt = detectByExtension(fileName);
  }

  if (!fmt) {
    const ids = getAllFormats().map(f => f.id).join(', ');
    throw new Error(`Unknown board file format. Supported: ${ids}`);
  }
  return fmt.parse(buffer);
}
