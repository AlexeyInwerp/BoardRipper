/**
 * Grouping rule for the multi-file ASC delivery.
 *
 * The Tebo-ICT / eM-Test toolchain ships a boardview as a folder of plain
 * section files — `Format.asc`, `Nails.asc`, `Pins.asc`, `Parts.asc`,
 * `Nets.asc` — that only make one board when read together. Opening one on
 * its own gives a fragment (see BDV_ASC_FORMAT.md), so the app resolves the
 * rest from the same folder. This module is the name-side of that: pure,
 * synchronous, and unaware of where the files live.
 */

/** The five sections, in the order they are bundled. */
export const ASC_SECTIONS = ['format', 'nails', 'pins', 'parts', 'nets'] as const;
export type AscSection = (typeof ASC_SECTIONS)[number];

/** Which section a file name announces, or null when it announces none.
 *
 *  Matching is on the stem's word-ish boundaries so `LA-L031P_pins.asc`,
 *  `PINS.ASC` and `board.pins.asc` all resolve, while PADS Layout's
 *  `PART.ASC` / `CONN.ASC` (singular `PART`, a different tool entirely)
 *  resolve to null and are therefore never pulled into a group. */
export function ascSectionFromName(name: string): AscSection | null {
  if (!/\.asc$/i.test(name)) return null;
  const stem = name.slice(0, -4).toLowerCase();
  for (const section of ASC_SECTIONS) {
    // Bounded by anything that is not a letter — separators, digits, or the
    // ends of the stem. Prevents `pins` from matching inside `spinsheet`.
    if (new RegExp(`(?:^|[^a-z])${section}(?:[^a-z]|$)`).test(stem)) return section;
  }
  return null;
}

/** The stem with its section keyword and the separators around it removed.
 *  `LA-L031P_pins.asc` → `la-l031p`, a bare `Pins.asc` → `''`. Files of one
 *  delivery share this; two boards exported into one folder do not. */
function ascBase(name: string, section: AscSection): string {
  return name
    .slice(0, -4)
    .toLowerCase()
    .replace(new RegExp(`(?:^|[^a-z])${section}(?:[^a-z]|$)`), '-')
    .replace(/[\s._-]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The file names that belong to the same board as `clicked`, including
 * `clicked` itself, ordered by section.
 *
 * Returns just `[clicked]` when the click was not on a section file, or when
 * no sibling shares its base — the caller then opens the one file as before.
 * At most one file per section is taken; ties go to the shortest name, so a
 * `Pins.asc` beats a `Pins (copy).asc` sitting next to it.
 */
export function groupAscSiblings(clicked: string, candidates: string[]): string[] {
  const section = ascSectionFromName(clicked);
  if (!section) return [clicked];
  const base = ascBase(clicked, section);

  const bySection = new Map<AscSection, string>([[section, clicked]]);
  for (const name of candidates) {
    if (name === clicked) continue;
    const s = ascSectionFromName(name);
    if (!s || s === section) continue;
    if (ascBase(name, s) !== base) continue;
    const held = bySection.get(s);
    if (held === undefined || name.length < held.length) bySection.set(s, name);
  }
  if (bySection.size === 1) return [clicked];
  return ASC_SECTIONS.map(s => bySection.get(s)).filter((n): n is string => n !== undefined);
}
