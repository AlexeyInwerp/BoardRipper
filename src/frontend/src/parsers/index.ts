import type { BoardData } from './types';
import { parseBVR1 } from './bvr1-parser';
import { parseBVR3 } from './bvr3-parser';

export type { BoardData, Part, Pin, Net, Point, BBox } from './types';
export { computeBBox, buildNets } from './types';

export function parseBoardFile(text: string): BoardData {
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();

  if (firstLine === 'BVRAW_FORMAT_1') {
    return parseBVR1(text);
  }
  if (firstLine === 'BVRAW_FORMAT_3') {
    return parseBVR3(text);
  }

  throw new Error(`Unknown board file format. First line: "${firstLine}"`);
}
