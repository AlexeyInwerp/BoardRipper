/**
 * allegro-brd-parser.ts — Entry point for the Allegro BRD parser.
 *
 * Parses a binary Allegro BRD buffer into BoardData via the three-phase pipeline:
 *   1. AllegroDb (header + strings + blocks)
 *   2. assembleBoard (DB → BoardData)
 */

import type { BoardData } from '../types';
import { AllegroDb } from './allegro-db';
import { assembleBoard } from './allegro-assembler';

export function parseAllegroBRD(buffer: ArrayBuffer): BoardData {
  const db = new AllegroDb(buffer);
  return assembleBoard(db);
}
