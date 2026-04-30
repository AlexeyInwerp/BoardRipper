import { useSyncExternalStore } from 'react';
import { Emitter } from './emitter';
import { log } from './log-store';

// Mirrors the backend Match shape.
export interface ObdMatch {
  bpath: string;
  brand: string;
  category: string;
  fetched: boolean;
  fetched_at?: string | null;
}

// Mirrors the backend ObdData shape.
export interface ObdComponent { refdes: string; attrs: Record<string, string>; }
export interface ObdNet {
  name: string;
  qualifier: string;
  diode: string | null;
  voltage: string | null;
  resistance: string | null;
  aliases: string[];
  comments: string[];
}
export interface ObdHeader {
  timestamp: string | null;
  id: string | null;
  brand: string | null;
  category: string | null;
  comment: string | null;
}
export interface ObdData {
  bpath: string;
  source_url: string;
  fetched_at: string;
  header: ObdHeader;
  diagnosis: string;
  components: ObdComponent[];
  nets: ObdNet[];
}

interface IndexStatus {
  synced: boolean;
  synced_at: string | null;  // null when never synced; string when synced
  board_count: number;
}

class ObdStore extends Emitter {
  private _matchesByBn: Map<string, ObdMatch[]> = new Map();
  private _data: Map<string, ObdData> = new Map();
  private _fetching: Set<string> = new Set();
  private _index: IndexStatus = { synced: false, synced_at: null, board_count: 0 };
  private _syncing = false;
  private _error: string | null = null;
  private _snapshot = this._buildSnapshot();

  getSnapshot() { return this._snapshot; }

  private _buildSnapshot() {
    return {
      matchesByBn: this._matchesByBn,
      data: this._data,
      fetching: this._fetching,
      index: this._index,
      syncing: this._syncing,
      error: this._error,
    };
  }

  private _bump() {
    this._snapshot = this._buildSnapshot();
    this.notify();
  }

  /** Fetch /api/obd/match for one board_number; cached by board_number.
   *  Also updates _index from the response — the backend always returns
   *  index status, so any match call doubles as a status refresh. */
  async loadMatches(boardNumber: string): Promise<ObdMatch[]> {
    if (!boardNumber) return [];
    if (this._matchesByBn.has(boardNumber)) return this._matchesByBn.get(boardNumber)!;
    try {
      const res = await fetch(`/api/obd/match?board_number=${encodeURIComponent(boardNumber)}`);
      if (!res.ok) {
        if (res.status !== 503) log.obd.warn('match failed', res.status);
        this._matchesByBn.set(boardNumber, []);
        this._bump();
        return [];
      }
      const json = await res.json() as { matches: ObdMatch[]; index?: { synced: boolean; synced_at?: string; board_count: number } };
      this._matchesByBn.set(boardNumber, json.matches);
      if (json.index) {
        this._index = {
          synced: json.index.synced,
          synced_at: json.index.synced_at ?? null,
          board_count: json.index.board_count,
        };
      }
      this._bump();
      return json.matches;
    } catch (e) {
      log.obd.error('match fetch error', e);
      this._matchesByBn.set(boardNumber, []);
      this._bump();
      return [];
    }
  }

  /** Probe /api/obd/match with empty board_number to refresh index status. */
  async refreshStatus(): Promise<void> {
    try {
      const res = await fetch('/api/obd/match?board_number=');
      if (!res.ok) return;
      const json = await res.json() as { index?: { synced: boolean; synced_at?: string; board_count: number } };
      if (json.index) {
        this._index = {
          synced: json.index.synced,
          synced_at: json.index.synced_at ?? null,
          board_count: json.index.board_count,
        };
        this._bump();
      }
    } catch (e) {
      log.obd.warn('refreshStatus error', e);
    }
  }

  /** POST /api/obd/fetch?bpath=… — downloads, parses, caches. */
  async fetchBoard(bpath: string): Promise<ObdData | null> {
    if (this._fetching.has(bpath)) return null;
    this._fetching.add(bpath);
    this._bump();
    try {
      const res = await fetch(`/api/obd/fetch?bpath=${encodeURIComponent(bpath)}`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        log.obd.error('fetch failed', res.status, body);
        this._error = `Fetch failed: ${body || res.statusText}`;
        return null;
      }
      const data = await res.json() as ObdData;
      this._data.set(bpath, data);
      // Mark the corresponding match as fetched in any cached match list.
      for (const list of this._matchesByBn.values()) {
        for (const m of list) {
          if (m.bpath === bpath) { m.fetched = true; m.fetched_at = data.fetched_at; }
        }
      }
      return data;
    } finally {
      this._fetching.delete(bpath);
      this._bump();
    }
  }

  /** POST /api/obd/index/sync — long running, blocks until complete. */
  async syncIndex(): Promise<void> {
    if (this._syncing) return;
    this._syncing = true;
    this._error = null;
    this._bump();
    try {
      const res = await fetch('/api/obd/index/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        this._error = `Sync failed: ${body || res.statusText}`;
        return;
      }
      const json = await res.json() as { synced_at: string; board_count: number };
      this._index = { synced: true, synced_at: json.synced_at, board_count: json.board_count };
      this._matchesByBn.clear(); // invalidate cached matches
    } finally {
      this._syncing = false;
      this._bump();
    }
  }

  /** DELETE /api/obd/cache — wipes everything. */
  async clearCache(): Promise<void> {
    const res = await fetch('/api/obd/cache', { method: 'DELETE' });
    if (!res.ok) {
      this._error = `Clear failed: ${res.statusText}`;
    } else {
      this._matchesByBn.clear();
      this._data.clear();
      this._index = { synced: false, synced_at: null, board_count: 0 };
    }
    this._bump();
  }

}

export const obdStore = new ObdStore();

/** React hook: returns { matches, fetched, fetch, update, isFetching } for one board. */
export function useObdForBoard(boardNumber: string | undefined) {
  const snap = useSyncExternalStore(
    (cb) => obdStore.subscribe(cb),
    () => obdStore.getSnapshot(),
  );
  const matches = boardNumber ? snap.matchesByBn.get(boardNumber) ?? null : null;
  const dataByBpath = snap.data;
  const fetching = snap.fetching;
  return {
    matches,
    dataByBpath,
    fetching,
    syncing: snap.syncing,
    indexSynced: snap.index.synced,
    indexBoardCount: snap.index.board_count,
    indexSyncedAt: snap.index.synced_at,
    error: snap.error,
    loadMatches: () => boardNumber ? obdStore.loadMatches(boardNumber) : Promise.resolve([]),
    fetchBoard: (bpath: string) => obdStore.fetchBoard(bpath),
    syncIndex: () => obdStore.syncIndex(),
    clearCache: () => obdStore.clearCache(),
    refreshStatus: () => obdStore.refreshStatus(),
  };
}
