import { createStoreHook } from '../hooks/createStoreHook';

/**
 * Library files the user dropped that the library already had. A dropped
 * file (or a board inside a dropped archive) that is byte-identical to a
 * library file is not stored again, so no new row appears and "Recently
 * added" — which lists new rows — would show nothing of the drop. These
 * entries put it there anyway, pointing at the existing copy and saying so.
 * Per browser (localStorage), newest first, capped.
 */
export interface RecentDrop {
  id: number;        // the existing library file
  at: number;        // when it was dropped, ms
  dropped: string;   // the name it was dropped under
}

const KEY = 'boardripper-recent-drops';
const MAX = 100;

let drops: RecentDrop[] = load();
const listeners = new Set<() => void>();

function load(): RecentDrop[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter(d => typeof d?.id === 'number' && typeof d?.at === 'number') : [];
  } catch {
    return [];
  }
}

export const recentDropsStore = {
  get drops(): readonly RecentDrop[] { return drops; },

  /** Record drops that matched existing files. The same file dropped again
   *  moves to the top instead of appearing twice. */
  record(entries: Array<{ id: number; dropped: string }>) {
    if (entries.length === 0) return;
    const now = Date.now();
    const ids = new Set(entries.map(e => e.id));
    drops = [...entries.map(e => ({ id: e.id, at: now, dropped: e.dropped })), ...drops.filter(d => !ids.has(d.id))].slice(0, MAX);
    try { localStorage.setItem(KEY, JSON.stringify(drops)); } catch { /* storage blocked */ }
    listeners.forEach(l => l());
  },

  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

export const useRecentDrops = createStoreHook(recentDropsStore, () => recentDropsStore.drops);
