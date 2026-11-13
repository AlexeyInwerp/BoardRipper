/**
 * Which parts the minimap draws on a root — the same parts the board draws.
 *
 * The two kinds of root read sides in two different frames, because the
 * renderer does:
 *
 * - Butterfly roots ('top' / 'bottom') are the user's sides. On a board whose
 *   primary side is the bottom (`primarySide: 'bottom'`, the IC-heavy side
 *   tagged bottom in the file) the top root holds the file's bottom parts.
 * - The single root ('all') follows the tab's `showTop` / `showBottom`, which
 *   are the FILE's flags: the store maps the user's "Top" onto raw
 *   `showBottom` for such a board, and the renderer draws raw sides from
 *   them. Comparing those raw flags with user sides drew the hidden side's
 *   parts on the map (2026-11-13, "minimap does not follow" on a flipped CAD).
 */
export function partOnRootSide(
  partSide: string,
  root: 'top' | 'bottom' | 'all',
  primaryBottom: boolean,
  showTop: boolean,
  showBottom: boolean,
): boolean {
  if (partSide === 'both') return root !== 'all' || showTop || showBottom;
  if (root === 'all') return partSide === 'top' ? showTop : showBottom;
  const userTop = (partSide === 'top') !== primaryBottom;
  return root === 'top' ? userTop : !userTop;
}
