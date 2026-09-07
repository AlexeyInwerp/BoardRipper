import { useEffect, useSyncExternalStore } from 'react';
import { Emitter } from '../store/emitter';
import { logStore } from '../store/log-store';
import { fmtVersion } from '../store/update-store';
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
// "Since you last looked" is the signal that means something. The store is
// module-level so it survives the hook unmounting (tab switches, rail ↔ strip
// toggles) but resets on reload, which is the right lifetime: a fresh session
// has nothing you have already seen.
//
// The count is maintained incrementally from the log store's appended tail —
// never by rescanning the 600-entry buffer on every log line — and while the
// Debug panel is visible the watermark advances inside the same callback, so
// the rail never renders a badge it would immediately clear.

class UnseenErrorsStore extends Emitter {
  private _lastSeenId = 0;
  private _count = 0;
  /** True while the Debug panel is on screen: new errors are seen as they arrive. */
  private _watching = false;

  constructor() {
    super();
    logStore.subscribe(() => this._absorb());
  }

  private _absorb(): void {
    const entries = logStore.getSnapshot();
    if (entries.length === 0) {                       // logStore.clear()
      if (this._count !== 0) { this._count = 0; this.notify(); }
      return;
    }
    let added = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.id <= this._lastSeenId) break;
      if (e.level === 'error') added++;
    }
    const top = entries[entries.length - 1].id;
    if (this._watching) {
      this._lastSeenId = top;
      if (this._count !== 0) { this._count = 0; this.notify(); }
      return;
    }
    // Only entries above the watermark are new; the watermark moves with the
    // top so the next notify counts only what arrived after this one.
    this._lastSeenId = top;
    if (added > 0) { this._count += added; this.notify(); }
  }

  get count(): number { return this._count; }

  setWatching(v: boolean): void {
    if (this._watching === v) return;
    this._watching = v;
    if (v) this.markSeen();
  }

  markSeen(): void {
    const entries = logStore.getSnapshot();
    if (entries.length) this._lastSeenId = entries[entries.length - 1].id;
    if (this._count !== 0) { this._count = 0; this.notify(); }
  }
}

const unseenErrors = new UnseenErrorsStore();
const subscribeUnseen = (cb: () => void) => unseenErrors.subscribe(cb);
const readUnseen = () => unseenErrors.count;

/**
 * Badge state for the activity rail. Badges are pure signals: they never call
 * showSidebarTab — nothing may take canvas width away from the user.
 */
export function useRailBadges(): RailBadges {
  const { activeTab, stage } = useSidebarState();
  const update = useUpdateStore();
  const sync = useLibrarySync();
  const count = useSyncExternalStore(subscribeUnseen, readUnseen);

  // Debug is "visible" only when it is the active tab AND the panel is open.
  // Active-but-hidden is not looking at it, so new errors still badge.
  const debugVisible = activeTab === 'debug' && stage === 'open';
  useEffect(() => {
    unseenErrors.setWatching(debugVisible);
    return () => unseenErrors.setWatching(false);
  }, [debugVisible]);

  const badges: RailBadges = {};

  if (update.state.has_update) {
    const v = fmtVersion(update.state.latest_version);
    badges.settings = update.state.manifest?.important === true
      ? { kind: 'err', title: `Important update: ${v}`.trim() }
      : { kind: 'info', title: `Update available: ${v}`.trim() };
  }

  if (count > 0 && !debugVisible) {
    badges.debug = {
      kind: 'warn',
      count,
      title: count === 1 ? '1 new error in the log' : `${count} new errors in the log`,
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
