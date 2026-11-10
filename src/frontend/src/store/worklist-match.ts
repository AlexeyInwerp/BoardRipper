/**
 * Which worklists to suggest for a board (docs/specs/2026-11-10-worklist-
 * storage-redesign.md §4). Pure: the board's keys come in, a ranked list of
 * suggestions goes out. Suggestions only — nothing is loaded by this.
 *
 * A board has keys of three weights:
 *   3  its board number, board-database aliases
 *   2  the file name (without extension), model number and model aliases
 *   1  model name, family, brand
 * A worklist is described by its board name and its tags. Both sides go
 * through `looseKey` (case and separators dropped), and a pair matches when
 * they are equal (3+ characters) or one contains the other with the shorter
 * at least 5 characters — so "02016" and "820-02016" reach
 * "820-02016-07_MacBook Air (M1, A2337)", while "M1" alone reaches nothing.
 */
import { looseKey } from './loose-match';

export type KeyWeight = 1 | 2 | 3;

export interface BoardKey {
  text: string;
  weight: KeyWeight;
  /** What the key is, for the "matched by" line: "board number", "family"… */
  what: string;
}

export interface Matchable { id: string; board: string; tags: readonly string[]; updatedAt: number }

export interface Suggestion<W extends Matchable = Matchable> {
  worklist: W;
  weight: KeyWeight;
  /** The board key that matched, and the worklist text it matched with. */
  key: BoardKey;
  via: string;
  /** True when the match came through a tag rather than the board name. */
  byTag: boolean;
}

const MIN_EQUAL = 3;
const MIN_CONTAIN = 5;

/** Whether two texts match under the loose rule. */
export function looseTextMatch(a: string, b: string): boolean {
  const x = looseKey(a), y = looseKey(b);
  if (!x || !y) return false;
  if (x === y) return x.length >= MIN_EQUAL;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= MIN_CONTAIN && long.includes(short);
}

/** The strongest match between a board's keys and one worklist, or null. */
export function matchWorklist<W extends Matchable>(keys: readonly BoardKey[], w: W): Suggestion<W> | null {
  let best: Suggestion<W> | null = null;
  const texts: Array<[string, boolean]> = [[w.board, false], ...w.tags.map(t => [t, true] as [string, boolean])];
  for (const key of keys) {
    if (best && key.weight <= best.weight) continue;
    for (const [text, byTag] of texts) {
      if (text && looseTextMatch(key.text, text)) { best = { worklist: w, weight: key.weight, key, via: text, byTag }; break; }
    }
  }
  return best;
}

/** Every worklist that matches, strongest first, most recent first within
 *  a weight. */
export function suggestWorklists<W extends Matchable>(keys: readonly BoardKey[], worklists: readonly W[]): Suggestion<W>[] {
  const out: Suggestion<W>[] = [];
  for (const w of worklists) { const m = matchWorklist(keys, w); if (m) out.push(m); }
  return out.sort((a, b) => b.weight - a.weight || b.worklist.updatedAt - a.worklist.updatedAt);
}

/** What the board database says about a board (GET /api/boards/resolve). */
export interface BoardFacts {
  board_number?: string; board_name?: string; brand?: string; family?: string;
  model?: string; model_number?: string; aliases?: string[]; model_aliases?: string[];
}

/** A board's keys from what is known about it. Duplicates (by loose key)
 *  keep their strongest weight. */
export function boardKeys(input: { fileName: string; boardNumber?: string | null; libraryModel?: string | null; libraryBrand?: string | null; facts?: BoardFacts | null }): BoardKey[] {
  const f = input.facts ?? {};
  const raw: BoardKey[] = [];
  const add = (text: string | null | undefined, weight: KeyWeight, what: string) => { if (text && text.trim()) raw.push({ text: text.trim(), weight, what }); };
  add(input.boardNumber, 3, 'board number');
  add(f.board_number, 3, 'board number');
  for (const a of f.aliases ?? []) add(a, 3, 'board alias');
  add(input.fileName.replace(/\.[^.]+$/, ''), 2, 'file name');
  add(f.model_number, 2, 'model number');
  for (const a of f.model_aliases ?? []) add(a, 2, 'model alias');
  add(f.board_name, 2, 'board name');
  add(f.model ?? input.libraryModel, 1, 'model');
  add(f.family, 1, 'family');
  add(f.brand ?? input.libraryBrand, 1, 'brand');
  const best = new Map<string, BoardKey>();
  for (const k of raw) {
    const lk = looseKey(k.text);
    if (!lk) continue;
    const cur = best.get(lk);
    if (!cur || k.weight > cur.weight) best.set(lk, k);
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}
