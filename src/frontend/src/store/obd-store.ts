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
/** One note within a section. `body` keeps inline references like
 *  `[n:NET_NAME]` and `[p:PART_NAME:PIN]` verbatim; the renderer turns
 *  them into clickable chips. */
export interface ObdNote {
  title: string;
  body: string;
}
/** Top-level section of the structured DIAGNOSIS_DATA block. */
export interface ObdSection {
  title: string;
  notes: ObdNote[];
}
export interface ObdData {
  bpath: string;
  source_url: string;
  fetched_at: string;
  header: ObdHeader;
  diagnosis: string;        // legacy raw text fallback; prefer `sections` for display
  sections?: ObdSection[];  // optional — older cached payloads will be missing it
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
      // Auto-load already-fetched payloads from disk so the BoardViewer's
      // tooltip + ComponentInfoPanel surfaces have data without forcing
      // the user back to the Library detail panel to click "Fetch".
      // Fire-and-forget; the bump on each cached load triggers re-renders.
      for (const m of json.matches) {
        if (m.fetched && !this._data.has(m.bpath)) {
          this.loadCachedData(m.bpath).catch(e => log.obd.warn('cache load failed', m.bpath, e));
        }
      }
      return json.matches;
    } catch (e) {
      log.obd.error('match fetch error', e);
      this._matchesByBn.set(boardNumber, []);
      this._bump();
      return [];
    }
  }

  /** GET /api/obd/data?bpath=… — read parsed JSON from disk cache without
   *  hitting openboarddata.org. 404 means "not cached"; we treat that as a
   *  no-op rather than an error. */
  async loadCachedData(bpath: string): Promise<ObdData | null> {
    if (this._data.has(bpath)) return this._data.get(bpath)!;
    try {
      const res = await fetch(`/api/obd/data?bpath=${encodeURIComponent(bpath)}`);
      if (res.status === 404) return null;
      if (!res.ok) {
        log.obd.warn('loadCachedData failed', res.status);
        return null;
      }
      const data = await res.json() as ObdData;
      this._data.set(bpath, data);
      this._bump();
      return data;
    } catch (e) {
      log.obd.warn('loadCachedData error', e);
      return null;
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

// Dev-only window handle so e2e and console debugging can inspect store
// state without going through React. Mirrors the boardStore convention.
if (typeof window !== 'undefined') {
  (window as { __obdStore?: ObdStore }).__obdStore = obdStore;
}

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

/** Build a (netName) → ObdNet[] lookup map from all variants currently loaded
 *  for the given board number. Keys are net names (case-sensitive — OBD's
 *  net names are upper-snake_case and bvr/brd nets typically match exactly).
 *  Returns an empty map if no data is loaded for the board. */
function buildNetIndex(snap: ReturnType<ObdStore['getSnapshot']>, boardNumber: string | undefined): Map<string, ObdNet[]> {
  const out = new Map<string, ObdNet[]>();
  if (!boardNumber) return out;
  const matches = snap.matchesByBn.get(boardNumber) ?? [];
  for (const m of matches) {
    const data = snap.data.get(m.bpath);
    if (!data) continue;
    for (const net of data.nets) {
      const arr = out.get(net.name);
      if (arr) arr.push(net);
      else out.set(net.name, [net]);
    }
  }
  return out;
}

/** React hook: net-keyed lookup for the active board. Returns a function
 *  `(netName) => ObdNet[]` plus the count of fetched variants (useful for
 *  showing a small badge). Used by ComponentInfoPanel and BoardRenderer.
 *  Also returns `loadedVariants` so callers that want the full ObdData
 *  payload (e.g. to render the DIAGNOSIS sections) can read it without a
 *  second snapshot subscription. */
export function useObdNetLookup(boardNumber: string | undefined) {
  const snap = useSyncExternalStore(
    (cb) => obdStore.subscribe(cb),
    () => obdStore.getSnapshot(),
  );
  const index = buildNetIndex(snap, boardNumber);
  const matches = boardNumber ? (snap.matchesByBn.get(boardNumber) ?? []) : [];
  const loadedVariants: ObdData[] = matches
    .map(m => snap.data.get(m.bpath))
    .filter((d): d is ObdData => !!d);
  return {
    variantCount: loadedVariants.length,
    lookup: (netName: string): ObdNet[] => netName ? (index.get(netName) ?? []) : [],
    hasData: loadedVariants.length > 0,
    loadedVariants,
  };
}

/** Snapshot-scoped index cache. Keyed by snapshot identity (replaced on
 *  every _bump, so the WeakMap drops stale entries automatically). Each
 *  snapshot's bucket holds Map<boardNumber, Map<netName, ObdNet[]>> so a
 *  multi-board session pays one buildNetIndex pass per board per data
 *  update — not one per pointermove (R-3 in 2026-05-07-renderer.md). */
const _netIndexCache = new WeakMap<
  ReturnType<ObdStore['getSnapshot']>,
  Map<string, Map<string, ObdNet[]>>
>();
const EMPTY_NET_INDEX: ReadonlyMap<string, ObdNet[]> = new Map();

/** Imperative companion for non-React consumers (e.g. BoardRenderer). Returns
 *  a per-(boardNumber, snapshot) cached Map<netName, ObdNet[]>. Lookup is
 *  O(1); the first call after a snapshot change pays one buildNetIndex pass
 *  to populate the cache. Returned Map is treated as read-only by callers. */
export function obdNetIndex(boardNumber: string | undefined): ReadonlyMap<string, ObdNet[]> {
  if (!boardNumber) return EMPTY_NET_INDEX;
  const snap = obdStore.getSnapshot();
  let perSnap = _netIndexCache.get(snap);
  if (!perSnap) {
    perSnap = new Map();
    _netIndexCache.set(snap, perSnap);
  }
  let idx = perSnap.get(boardNumber);
  if (!idx) {
    idx = buildNetIndex(snap, boardNumber);
    perSnap.set(boardNumber, idx);
  }
  return idx;
}

/** Imperative single-net lookup for non-React consumers. Backed by the
 *  snapshot-scoped index cache built by obdNetIndex(); use that directly
 *  if you'll do many lookups against the same board. */
export function obdNetLookup(boardNumber: string | undefined, netName: string): ObdNet[] {
  if (!netName) return [];
  return obdNetIndex(boardNumber).get(netName) ?? [];
}

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
