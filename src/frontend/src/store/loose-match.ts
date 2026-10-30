/**
 * Loose name matching for the board's search fields.
 *
 * A net called `PP1V25_AWAKE_NAND` is remembered as "the 1V25 nand rail", not
 * as its exact spelling. Plain substring search finds it from `pp1v25` or
 * `nand`, but not from `pp_1v25`, `1v25 nand` or `1v25nand`. The loose rule
 * closes that gap: case and separators (`_ - . /` and spaces) are ignored,
 * and a query of several words matches when every word appears somewhere in
 * the name, in any order.
 *
 * Loose hits never replace direct ones. Every caller keeps the substring
 * matches it always had, in the order it always showed them, and the loose
 * rule only ADDS names the substring test missed — which is why `classify`
 * reports which of the two tests a name passed.
 *
 * Idea from the 2R Tools fork (reparomac/boardripper-2r, `r2/loose-match.ts`).
 */

/** Lowercase and keep only letters, digits and `+` — any script, so a
 *  GB18030-decoded XZZ name keeps its characters. */
export function looseKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}+]/gu, '');
}

export type MatchKind = 'direct' | 'loose';

export interface LooseMatcher {
  /** The query as typed, lowercased. Empty means "no query". */
  readonly direct: string;
  /** `direct` when the lowercased name contains the query, `loose` when only
   *  the loose rule matches, null when neither does. */
  classify(name: string): MatchKind | null;
  /** classify(name) !== null */
  test(name: string): boolean;
}

/** Build a matcher once per query; call it per name. */
export function looseMatcher(query: string): LooseMatcher {
  const direct = query.toLowerCase();
  const tokens = direct.split(/\s+/).map(looseKey).filter(Boolean);
  const classify = (name: string): MatchKind | null => {
    if (!direct.trim()) return null;
    const lower = name.toLowerCase();
    if (lower.includes(direct)) return 'direct';
    if (tokens.length === 0) return null;
    const key = looseKey(name);
    for (const t of tokens) if (!key.includes(t)) return null;
    return 'loose';
  };
  return { direct, classify, test: (name) => classify(name) !== null };
}
