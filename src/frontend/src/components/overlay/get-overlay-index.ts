import type { BoardData } from '../../parsers/types';
import { isNcNet } from '../../store/render-settings';
import { naturalCompare } from './natural-sort';

export interface OverlayIndexRow { name: string; nameLower: string }

export interface OverlayIndex {
  parts: OverlayIndexRow[];
  netsNormal: OverlayIndexRow[];
  netsNc: OverlayIndexRow[];
}

interface CacheEntry { ncSig: string; index: OverlayIndex }

/**
 * Cache keyed by the BoardData object identity. WeakMap so cache is
 * automatically reclaimed when boards are unloaded. Recomputes when
 * `ncPatterns` change (cheap stringify check) — the user can edit NC
 * patterns in Settings and the dropdown updates on next open.
 */
const cache = new WeakMap<BoardData, CacheEntry>();

function buildIndex(board: BoardData, ncPatterns: readonly string[]): OverlayIndex {
  const parts: OverlayIndexRow[] = board.parts.map(p => ({
    name: p.name,
    nameLower: p.name.toLowerCase(),
  }));
  parts.sort((a, b) => naturalCompare(a.name, b.name));

  const netsNormal: OverlayIndexRow[] = [];
  const netsNc: OverlayIndexRow[] = [];
  for (const name of board.nets.keys()) {
    const row = { name, nameLower: name.toLowerCase() };
    (isNcNet(name.toUpperCase(), ncPatterns as string[]) ? netsNc : netsNormal).push(row);
  }
  netsNormal.sort((a, b) => naturalCompare(a.name, b.name));
  netsNc.sort((a, b) => naturalCompare(a.name, b.name));

  return { parts, netsNormal, netsNc };
}

/**
 * Returns a pre-sorted, NC-partitioned, lowercase-paired index of the
 * board's parts and nets. Rebuilt only when the board reference changes
 * or the NC patterns differ from last call for that board.
 */
export function getOverlayIndex(board: BoardData, ncPatterns: readonly string[]): OverlayIndex {
  const sig = ncPatterns.join('');
  const hit = cache.get(board);
  if (hit && hit.ncSig === sig) return hit.index;
  const index = buildIndex(board, ncPatterns);
  cache.set(board, { ncSig: sig, index });
  return index;
}
