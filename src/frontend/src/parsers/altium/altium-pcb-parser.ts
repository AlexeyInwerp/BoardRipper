/**
 * Altium PCB parser entry point.
 *
 * Dispatches between CFB (binary) and ASCII variants based on content,
 * then walks the streams via altium-records and hands off to the assembler.
 */

import type { BoardData } from '../types';
import { openAltiumCfb } from './altium-cfb';
import {
  parseBoard6,
  parseComponents6,
  parsePads6,
  parseTracks6,
  parseVias6,
  parseArcs6,
  parseFills6,
  parseRegions6,
  parseNets6,
  parseClasses6,
  parseWideStrings6,
  parseTexts6Comments,
} from './altium-records';
import { log } from '../../store/log-store';
import { assembleBoardData } from './altium-assembler';
import type { AltiumPcbDb } from './altium-types';
import { parseAltiumAscii } from './altium-ascii';

const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0];

function isCfb(buf: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  return u8.length === 4
      && u8[0] === CFB_MAGIC[0] && u8[1] === CFB_MAGIC[1]
      && u8[2] === CFB_MAGIC[2] && u8[3] === CFB_MAGIC[3];
}

export function parseAltiumPcb(buffer: ArrayBuffer): BoardData {
  if (!isCfb(buffer)) {
    return parseAltiumAscii(buffer);
  }
  const cfb = openAltiumCfb(buffer);
  const must = (name: string): Uint8Array => {
    const b = cfb.getStream(name);
    if (!b) throw new Error(`Altium PCB: missing required stream "${name}"`);
    return b;
  };
  const empty = new Uint8Array();
  const db: AltiumPcbDb = {
    board: parseBoard6(must('Board6/Data')),
    components: parseComponents6(must('Components6/Data')),
    pads: parsePads6(must('Pads6/Data')),
    tracks: parseTracks6(cfb.getStream('Tracks6/Data') ?? empty),
    vias: parseVias6(cfb.getStream('Vias6/Data') ?? empty),
    arcs: parseArcs6(cfb.getStream('Arcs6/Data') ?? empty),
    fills: parseFills6(cfb.getStream('Fills6/Data') ?? empty),
    regions: [
      ...parseRegions6(cfb.getStream('Regions6/Data') ?? empty, false),
      ...parseRegions6(cfb.getStream('ShapeBasedRegions6/Data') ?? empty, true),
    ],
    nets: parseNets6(must('Nets6/Data')),
    classes: parseClasses6(cfb.getStream('Classes6/Data') ?? empty),
    wideStrings: parseWideStrings6(cfb.getStream('WideStrings6/Data') ?? empty),
  };
  // The comment texts are each part's value. Optional: a malformed stream
  // costs the values, not the board.
  try {
    db.comments = parseTexts6Comments(cfb.getStream('Texts6/Data') ?? empty, db.wideStrings);
  } catch (e) {
    log.parser.warn(`altium: Texts6 comments not read — ${(e as Error).message}`);
  }
  return assembleBoardData(db);
}
