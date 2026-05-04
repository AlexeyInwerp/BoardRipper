// src/frontend/src/components/overlay/natural-sort.ts
/**
 * Natural-order string comparator: split each input into runs of digits
 * and runs of non-digits, compare runs pairwise (digits as numbers,
 * non-digits as case-insensitive strings). Yields R1 < R2 < R10.
 *
 * Locale-agnostic. Stable for inputs that differ only in case (uses
 * lowercased compare). For long inputs the regex split runs once per
 * call — caller is responsible for memoizing if hot.
 */
export function naturalCompare(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  const re = /(\d+)|(\D+)/g;
  const aTokens = al.match(re) ?? [];
  const bTokens = bl.match(re) ?? [];
  const len = Math.min(aTokens.length, bTokens.length);
  for (let i = 0; i < len; i++) {
    const ai = aTokens[i];
    const bi = bTokens[i];
    const aNum = /^\d+$/.test(ai);
    const bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const an = parseInt(ai, 10);
      const bn = parseInt(bi, 10);
      if (an !== bn) return an - bn;
      // equal numbers but different padding — fall back to string compare
      if (ai !== bi) return ai < bi ? -1 : 1;
    } else if (aNum !== bNum) {
      // digit run sorts before alpha run
      return aNum ? -1 : 1;
    } else {
      if (ai !== bi) return ai < bi ? -1 : 1;
    }
  }
  return aTokens.length - bTokens.length;
}
