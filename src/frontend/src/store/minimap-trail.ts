/**
 * Minimap history trail — which recent visits the minimap marks.
 *
 * Read-only over the navigation history: nothing is recorded for the map, so
 * the History list is not clogged by it (docs/specs/2026-09-29-navigation-
 * history-design.md). A visit on this board contributes its part.
 *
 * Rules:
 *  - this running session only, and this board tab only (tab ids are
 *    stripped from entries restored after a reload, so those never match);
 *  - parts only: a visit without a part (a net lookup, a settled view) has
 *    no place on the map worth marking — its departure camera is the view
 *    the user left, not the net, and goes stale with any turn or resize;
 *  - newest first, at most `limit` distinct parts; a revisit is the same part;
 *  - `rank` 0 is the newest, `limit - 1` the oldest shown.
 */
import type { NavEntry } from './nav-history';

/** Default number of places marked (setting `minimapHistorySteps`). */
export const MINIMAP_TRAIL_LIMIT = 8;
/** When this module loaded: the start of the running session. */
export const SESSION_START = Date.now();

export interface TrailItem {
  id: number;
  rank: number;
  part: string;
  /** The entry under the history cursor (where Back/Forward left you). */
  current: boolean;
}

export function minimapTrail(
  entries: readonly NavEntry[], cursor: number, tabId: number | null,
  opts: { since?: number; limit?: number } = {},
): TrailItem[] {
  if (tabId === null) return [];
  const since = opts.since ?? SESSION_START;
  const limit = opts.limit ?? MINIMAP_TRAIL_LIMIT;
  const out: TrailItem[] = [];
  const seen = new Map<string, TrailItem>();
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    const p = e.place;
    // Entries are in time order: everything before this one is older still.
    if (e.at < since) break;
    if (!p || p.kind !== 'board' || p.tabId !== tabId || !p.part) continue;
    const key = p.part.toUpperCase();
    const had = seen.get(key);
    if (had) { if (i === cursor) had.current = true; continue; }
    const item: TrailItem = { id: e.id, rank: out.length, part: p.part, current: i === cursor };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}
