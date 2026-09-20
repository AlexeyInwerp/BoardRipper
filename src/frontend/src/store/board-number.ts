/** Board-number extraction from a file name — dependency-free so both the
 *  OBD store and the local-folder library can use it without importing each
 *  other (the folder library is a producer for databank-store, which
 *  obd-store imports; a shared leaf module keeps that acyclic). */

/** Extract a recognisable board number from a board file's name. Covers the
 *  patterns OBD's catalogue actually uses (Apple 820-NNNNN/3-4-digit suffix,
 *  iP* iphone codes, generic alphanumerics with dashes). Returns the first
 *  match — multi-variant disambiguation happens upstream via the match
 *  endpoint's substring fuzz. */
export function extractBoardNumberFromFilename(fileName: string): string | null {
  if (!fileName) return null;
  const stem = fileName.replace(/\.[^.]+$/, '');
  const patterns = [
    /\b(820-\d{4,5})\b/i,
    /\b(LA-\w{4,6})\b/i,
    /\b(DA0?\w{4,8})\b/i,
    /\b(NM-\w{3,6})\b/i,
    /\b(60[A-Z0-9]{6,})\b/i,
    /\b(iP\d+[a-z_]+)\b/i,
  ];
  for (const re of patterns) {
    const m = stem.match(re);
    if (m) return m[1];
  }
  return null;
}
