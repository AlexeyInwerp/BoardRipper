/**
 * Minimap history trail — which recent visits the minimap marks.
 *
 * Read-only over the navigation history: nothing is recorded for the map, so
 * the History list is not clogged by it (docs/specs/2026-09-29-navigation-
 * history-design.md). A visit on this board contributes its part and the
 * camera it was left with — `push` writes the departure pose into the entry,
 * so a click carries a view without the (off by default) view layer.
 *
 * Rules:
 *  - this running session only, and this board tab only (tab ids are
 *    stripped from entries restored after a reload, so those never match);
 *  - newest first, at most `limit` distinct places — one per part, and one
 *    per view for visits without a part; a revisit copy is the same place;
 *  - `rank` 0 is the newest, `limit - 1` the oldest shown.
 */
import type { NavEntry, BoardCamera } from './nav-history';

/** Default number of places marked (setting `minimapHistorySteps`). */
export const MINIMAP_TRAIL_LIMIT = 8;
/** When this module loaded: the start of the running session. */
export const SESSION_START = Date.now();

export interface TrailItem {
  id: number;
  rank: number;
  part?: string;
  camera?: BoardCamera;
  /** The entry under the history cursor (where Back/Forward left you). */
  current: boolean;
}

const camKey = (c: BoardCamera) => `${Math.round(c.x / 8)}:${Math.round(c.y / 8)}:${c.scaleX.toFixed(2)}`;

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
    if (!p || p.kind !== 'board' || p.tabId !== tabId || e.at < since) continue;
    if (!p.part && !p.camera) continue;
    const key = p.part ? `p:${p.part.toUpperCase()}` : `v:${camKey(p.camera!)}`;
    const had = seen.get(key);
    if (had) { if (i === cursor) had.current = true; continue; }
    const item: TrailItem = { id: e.id, rank: out.length, part: p.part, camera: p.camera, current: i === cursor };
    seen.set(key, item);
    out.push(item);
  }
  return out;
}
