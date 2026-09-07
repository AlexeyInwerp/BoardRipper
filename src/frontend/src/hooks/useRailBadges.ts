import { useEffect, useSyncExternalStore } from 'react';
import { logStore } from '../store/log-store';
import { useUpdateStore } from './useUpdateStore';
import { useLibrarySync } from './useLibrarySync';
import { useSidebarState } from './useSidebarState';
import type { SidebarTab } from '../components/Sidebar.utils';

export interface RailBadge {
  kind: 'err' | 'warn' | 'info';
  /** Omit for a plain dot. */
  count?: number;
  title: string;
}

export type RailBadges = Partial<Record<SidebarTab, RailBadge>>;

// ---- Debug: errors logged since the Debug panel was last visible -------------
//
// Total error count would be a permanent orange number on every session.
// "Since you last looked" is the signal that means something. The watermark
// lives at module level so it survives the hook unmounting (tab switches,
// rail ↔ strip toggles) but resets on reload, which is the right lifetime:
// a fresh session has nothing you have already seen.

let lastSeenErrorId = 0;
const seenListeners = new Set<() => void>();

function subscribeUnseenErrors(cb: () => void): () => void {
  const unsubLog = logStore.subscribe(cb);
  seenListeners.add(cb);
  return () => { unsubLog(); seenListeners.delete(cb); };
}

function countUnseenErrors(): number {
  const entries = logStore.getSnapshot();
  let n = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.id <= lastSeenErrorId) break;
    if (e.level === 'error') n++;
  }
  return n;
}

function markErrorsSeen(): void {
  const entries = logStore.getSnapshot();
  const top = entries.length ? entries[entries.length - 1].id : lastSeenErrorId;
  if (top === lastSeenErrorId) return;
  lastSeenErrorId = top;
  seenListeners.forEach(fn => fn());
}

/**
 * Badge state for the activity rail. Badges are pure signals: they never call
 * showSidebarTab — nothing may take canvas width away from the user.
 */
export function useRailBadges(): RailBadges {
  const { activeTab, collapsed } = useSidebarState();
  const update = useUpdateStore();
  const sync = useLibrarySync();
  const unseenErrors = useSyncExternalStore(subscribeUnseenErrors, countUnseenErrors);

  // Looking at Debug counts as having seen everything currently in it — including
  // errors that arrive while it is open.
  useEffect(() => {
    if (activeTab === 'debug' && !collapsed) markErrorsSeen();
  }, [activeTab, collapsed, unseenErrors]);

  const badges: RailBadges = {};

  if (update.state.has_update) {
    // `important` is a manifest flag (same source the toolbar badge reads).
    badges.settings = update.state.manifest?.important === true
      ? { kind: 'err', title: `Important update: ${update.state.latest_version ?? ''}`.trim() }
      : { kind: 'info', title: `Update available: ${update.state.latest_version ?? ''}`.trim() };
  }

  if (unseenErrors > 0 && activeTab !== 'debug') {
    badges.debug = {
      kind: 'warn',
      count: unseenErrors,
      title: unseenErrors === 1 ? '1 new error in the log' : `${unseenErrors} new errors in the log`,
    };
  }

  if (sync.backendAvailable && sync.configLoaded && sync.config.enabled) {
    const s = sync.status;
    if (s.phase === 'error') {
      badges.library = { kind: 'err', title: 'Library sync failed' };
    } else if (s.errors > 0) {
      badges.library = { kind: 'err', title: s.errors === 1 ? '1 file failed to sync' : `${s.errors} files failed to sync` };
    }
  }

  return badges;
}
