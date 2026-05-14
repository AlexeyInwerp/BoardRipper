import { boardStore } from './board-store';
import { log } from './log-store';

/** Persistent per-board "stash" — named collections of parts a repair-tech
 *  is tracking (water damage candidates, ticket worklists, etc). Survives
 *  reload and container upgrade via IndexedDB. */

export type StashMark = 'none' | 'replaced' | 'reworked' | 'cleaned';

export interface StashEntry {
  /** Resolved part index in the currently-loaded board. May go stale on
   *  re-parse — re-resolve from `refdes` on load. */
  partIndex: number;
  /** Stable reference designator, used to re-resolve `partIndex` after the
   *  board is re-parsed (PARSER_VERSION bump, file replacement). */
  refdes: string;
  mark: StashMark;
  note: string;
  /** True if `refdes` couldn't be found in the current board on hydration.
   *  Row is rendered greyed-out and excluded from canvas highlight. */
  unresolved?: boolean;
}

export interface Stash {
  id: string;
  name: string;
  createdAt: number;
  entries: StashEntry[];
}

export interface BoardStashes {
  /** Cache key from board-cache (`${fileName}:${fileSize}:${lastModified}`) */
  key: string;
  /** Human-readable file name — kept so future cross-board features can list
   *  stashes without forcing the matching board to be loaded. */
  fileName: string;
  activeStashId: string | null;
  stashes: Stash[];
  updatedAt: number;
}

const DB_NAME = 'boardripper-stash';
const DB_VERSION = 1;
const STORE = 'boards';

class StashStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private byKey = new Map<string, BoardStashes>();
  private hydrating = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    this.listeners.forEach(fn => fn());
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { this.dbPromise = null; reject(req.error); };
    });
    return this.dbPromise;
  }

  private async loadFromDb(key: string): Promise<BoardStashes | null> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as BoardStashes | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.cache?.warn('stash: load failed', e);
      return null;
    }
  }

  private async persist(value: BoardStashes): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.cache?.warn('stash: persist failed', e);
    }
  }

  /** Re-resolve partIndex from refdes for the freshly-loaded board.
   *  Rows whose refdes is gone are flagged unresolved. */
  private resolveEntries(stashes: Stash[]): void {
    const board = boardStore.board;
    if (!board) {
      for (const s of stashes) for (const e of s.entries) e.unresolved = true;
      return;
    }
    const byRefdes = new Map<string, number>();
    for (let i = 0; i < board.parts.length; i++) {
      const name = board.parts[i]?.name;
      if (name) byRefdes.set(name, i);
    }
    for (const s of stashes) {
      for (const e of s.entries) {
        const idx = byRefdes.get(e.refdes);
        if (idx == null) {
          e.unresolved = true;
        } else {
          e.partIndex = idx;
          delete e.unresolved;
        }
      }
    }
  }

  /** Hydrate the stash for the current active board tab (idempotent). Called
   *  from the panel when it mounts and from boardStore tab-change hooks. */
  async syncToActiveTab(): Promise<void> {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    if (!tab || !tab.cacheKey) return;
    const key = tab.cacheKey;
    if (this.byKey.has(key)) {
      // Re-resolve in case the board was re-parsed (parts re-indexed)
      const cur = this.byKey.get(key)!;
      this.resolveEntries(cur.stashes);
      this.notify();
      return;
    }
    if (this.hydrating.has(key)) {
      await this.hydrating.get(key);
      return;
    }
    const p = (async () => {
      const loaded = await this.loadFromDb(key);
      const value: BoardStashes = loaded ?? {
        key,
        fileName: tab.fileName,
        activeStashId: null,
        stashes: [],
        updatedAt: Date.now(),
      };
      this.resolveEntries(value.stashes);
      this.byKey.set(key, value);
      this.notify();
    })();
    this.hydrating.set(key, p);
    try { await p; } finally { this.hydrating.delete(key); }
  }

  /** Current board's stash record (or null if no board is active). */
  get current(): BoardStashes | null {
    const key = this.activeKey;
    return key ? this.byKey.get(key) ?? null : null;
  }

  get activeKey(): string | null {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    return tab?.cacheKey || null;
  }

  get activeStash(): Stash | null {
    const cur = this.current;
    if (!cur || cur.activeStashId == null) return null;
    return cur.stashes.find(s => s.id === cur.activeStashId) ?? null;
  }

  private getOrInit(): BoardStashes | null {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    if (!tab || !tab.cacheKey) return null;
    let cur = this.byKey.get(tab.cacheKey);
    if (!cur) {
      cur = {
        key: tab.cacheKey,
        fileName: tab.fileName,
        activeStashId: null,
        stashes: [],
        updatedAt: Date.now(),
      };
      this.byKey.set(tab.cacheKey, cur);
    }
    return cur;
  }

  private save(cur: BoardStashes): void {
    cur.updatedAt = Date.now();
    this.notify();
    void this.persist(cur);
  }

  createStash(name?: string): Stash | null {
    const cur = this.getOrInit();
    if (!cur) return null;
    const id = 'st-' + Math.random().toString(36).slice(2, 10);
    const trimmed = (name ?? '').trim();
    const stash: Stash = {
      id,
      name: trimmed || `Stash ${cur.stashes.length + 1}`,
      createdAt: Date.now(),
      entries: [],
    };
    cur.stashes.push(stash);
    cur.activeStashId = id;
    this.save(cur);
    return stash;
  }

  renameStash(id: string, name: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === id);
    if (!s) return;
    s.name = name.trim() || s.name;
    this.save(cur);
  }

  deleteStash(id: string): void {
    const cur = this.current;
    if (!cur) return;
    cur.stashes = cur.stashes.filter(s => s.id !== id);
    if (cur.activeStashId === id) {
      cur.activeStashId = cur.stashes[0]?.id ?? null;
    }
    this.save(cur);
  }

  setActiveStash(id: string | null): void {
    const cur = this.current;
    if (!cur) return;
    cur.activeStashId = id;
    this.save(cur);
  }

  wipeStash(id: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === id);
    if (!s) return;
    s.entries = [];
    this.save(cur);
  }

  /** Push the given partIndex array into stashId, creating one if needed.
   *  Skips duplicates (same refdes). Returns the count actually added. */
  pushParts(stashId: string | null, partIndices: readonly number[]): number {
    const cur = this.getOrInit();
    if (!cur) return 0;
    const board = boardStore.board;
    if (!board) return 0;
    let stash: Stash | null = null;
    if (stashId) {
      stash = cur.stashes.find(s => s.id === stashId) ?? null;
    }
    if (!stash) {
      // No active stash and none requested → auto-create
      stash = this.createStash() ?? null;
      if (!stash) return 0;
    }
    const seen = new Set(stash.entries.map(e => e.refdes));
    let added = 0;
    for (const idx of partIndices) {
      const part = board.parts[idx];
      const refdes = part?.name;
      if (!refdes) continue;
      if (seen.has(refdes)) continue;
      seen.add(refdes);
      stash.entries.push({
        partIndex: idx,
        refdes,
        mark: 'none',
        note: '',
      });
      added++;
    }
    if (added > 0) this.save(cur);
    return added;
  }

  /** Convenience for the right-click context menu — look up a part by refdes
   *  in the current board and push it into the (possibly auto-created) active
   *  stash. Returns the resolved stash id, or null on failure. */
  pushRefdesToActive(refdes: string): { stashId: string; added: number } | null {
    const board = boardStore.board;
    if (!board) return null;
    const idx = board.parts.findIndex(p => p?.name === refdes);
    if (idx < 0) return null;
    const cur = this.current ?? this.getOrInit();
    if (!cur) return null;
    const stashId = cur.activeStashId ?? (this.createStash()?.id ?? null);
    if (!stashId) return null;
    const added = this.pushParts(stashId, [idx]);
    return { stashId, added };
  }

  removeEntry(stashId: string, refdes: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === stashId);
    if (!s) return;
    const before = s.entries.length;
    s.entries = s.entries.filter(e => e.refdes !== refdes);
    if (s.entries.length !== before) this.save(cur);
  }

  setMark(stashId: string, refdes: string, mark: StashMark): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === stashId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e || e.mark === mark) return;
    e.mark = mark;
    this.save(cur);
  }

  setNote(stashId: string, refdes: string, note: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === stashId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e || e.note === note) return;
    e.note = note;
    this.save(cur);
  }

  /** Cycle the per-row mark: none → replaced → reworked → cleaned → none. */
  cycleMark(stashId: string, refdes: string, reverse = false): void {
    const order: StashMark[] = ['none', 'replaced', 'reworked', 'cleaned'];
    const cur = this.current;
    if (!cur) return;
    const s = cur.stashes.find(x => x.id === stashId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e) return;
    const i = order.indexOf(e.mark);
    const next = reverse ? (i - 1 + order.length) % order.length : (i + 1) % order.length;
    e.mark = order[next];
    this.save(cur);
  }

  /** Format the active stash for clipboard:
   *    REFDES[mark] (note)
   *  with [mark] omitted when 'none' and (note) omitted when empty. */
  formatStashForClipboard(stashId: string): string {
    const cur = this.current;
    if (!cur) return '';
    const s = cur.stashes.find(x => x.id === stashId);
    if (!s) return '';
    const lines: string[] = [];
    for (const e of s.entries) {
      let line = e.refdes;
      if (e.mark !== 'none') line += `[${e.mark}]`;
      if (e.note.trim()) line += ` (${e.note.trim()})`;
      lines.push(line);
    }
    return lines.join('\n');
  }
}

export const stashStore = new StashStore();
