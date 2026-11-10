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
  /** Steps from where the history cursor stands: 0 is the cursor's own
   *  place, 1 the one before it (or after it, for `ahead`), and so on. */
  rank: number;
  part: string;
  /** The entry under the history cursor (where Back/Forward left you). */
  current: boolean;
  /** A place Forward would go to — after the cursor in the timeline. */
  ahead: boolean;
}

/**
 * The trail follows the history cursor, not the newest entry: after a few
 * Backs the strongest mark is where Back took you, older places fade from
 * there, and the places Forward would return to are listed as `ahead`.
 * At the end of the history (no Back taken) that is simply the newest N.
 */
export function minimapTrail(
  entries: readonly NavEntry[], cursor: number, tabId: number | null,
  opts: { since?: number; limit?: number } = {},
): TrailItem[] {
  if (tabId === null || entries.length === 0) return [];
  const since = opts.since ?? SESSION_START;
  const limit = opts.limit ?? MINIMAP_TRAIL_LIMIT;
  const anchor = cursor >= 0 && cursor < entries.length ? cursor : entries.length - 1;
  const out: TrailItem[] = [];
  const seen = new Map<string, TrailItem>();
  const partOf = (e: NavEntry): string | null => {
    const p = e.place;
    return p && p.kind === 'board' && p.tabId === tabId && p.part ? p.part : null;
  };
  // Behind: the cursor and before it.
  let behind = 0;
  for (let i = anchor; i >= 0 && behind < limit; i--) {
    const e = entries[i];
    // Entries are in time order: everything before this one is older still.
    if (e.at < since) break;
    const part = partOf(e);
    if (!part) continue;
    const key = part.toUpperCase();
    const had = seen.get(key);
    if (had) { if (i === cursor) had.current = true; continue; }
    const item: TrailItem = { id: e.id, rank: behind++, part, current: i === cursor, ahead: false };
    seen.set(key, item);
    out.push(item);
  }
  // Ahead: where Forward goes, nearest first.
  let fwd = 0;
  for (let i = anchor + 1; i < entries.length && fwd < limit; i++) {
    const part = partOf(entries[i]);
    if (!part) continue;
    const key = part.toUpperCase();
    if (seen.has(key)) continue;
    const item: TrailItem = { id: entries[i].id, rank: ++fwd, part, current: false, ahead: true };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}
