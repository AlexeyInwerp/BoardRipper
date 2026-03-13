import type { BoardData } from './types';

/**
 * Export any BoardData as a BVRAW_FORMAT_3 text file.
 *
 * This allows any supported format (BRD, BVR1, etc.) to be saved as BVR3
 * for archival, compatibility, and long-term consistency. The output is a
 * valid BVR3 file that can be re-loaded by this viewer.
 *
 * Note: If net names were not decodable during parsing (e.g. BRD phase 1
 * outputs opaque "BRD:..." strings), they are written as-is. Re-run after
 * the format's phase 2 parser is available for clean net names.
 */
export function exportToBVR3(board: BoardData): string {
  const lines: string[] = ['BVRAW_FORMAT_3'];

  // Outline
  if (board.outline.length > 0) {
    const pts = board.outline.flatMap(p => [p.x, p.y]).join(' ');
    lines.push(`OUTLINE_POINTS ${pts}`);
  }

  // Parts and pins
  for (const part of board.parts) {
    lines.push(`PART_NAME ${part.name}`);
    lines.push(`PART_SIDE ${part.side === 'top' ? 'T' : part.side === 'bottom' ? 'B' : 'O'}`);
    lines.push(`PART_ORIGIN ${part.origin.x} ${part.origin.y}`);
    lines.push(`PART_MOUNT ${part.type === 'throughhole' ? 'ThroughHole' : 'SMD'}`);

    for (let i = 0; i < part.pins.length; i++) {
      const pin = part.pins[i];
      lines.push(`PIN_ID ${i + 1}`);
      lines.push(`PIN_NUMBER ${pin.number || String(i + 1)}`);
      lines.push(`PIN_NAME ${pin.name || ''}`);
      lines.push(`PIN_SIDE ${pin.side === 'top' ? 'T' : 'B'}`);
      // BVR3 stores pin coords relative to part origin
      lines.push(`PIN_ORIGIN ${pin.position.x - part.origin.x} ${pin.position.y - part.origin.y}`);
      lines.push(`PIN_RADIUS ${pin.radius}`);
      lines.push(`PIN_NET ${pin.net || ''}`);
      lines.push(`PIN_TYPE 2`);
      lines.push(`PIN_END`);
    }
    lines.push(`PART_END`);
  }

  return lines.join('\n') + '\n';
}
