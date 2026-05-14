import { boardStore } from './board-store';
import { log } from './log-store';

/** Persistent per-board "worklist" — named collections of parts a repair-tech
 *  is tracking (water damage candidates, ticket worklists, etc). Survives
 *  reload and container upgrade via IndexedDB. */

export type WorklistMark = 'none' | 'replaced' | 'reworked' | 'cleaned';

/** Mark → display colour. CSS strings for the panel UI, matching numeric
 *  values for the canvas overlay. Kept here so the renderer and the panel
 *  agree visually on what state each mark represents. */
export const MARK_COLOR_CSS: Record<WorklistMark, string> = {
  none: '#ffaa00',       // amber — "in a worklist, not yet acted on"
  replaced: '#ff5566',   // red — heaviest action
  reworked: '#ffaa33',   // orange — touched but not replaced
  cleaned: '#33cc88',    // green — resolved
};
export const MARK_COLOR_HEX: Record<WorklistMark, number> = {
  none: 0xffaa00,
  replaced: 0xff5566,
  reworked: 0xffaa33,
  cleaned: 0x33cc88,
};

export interface WorklistEntry {
  /** Resolved part index in the currently-loaded board. May go stale on
   *  re-parse — re-resolve from `refdes` on load. */
  partIndex: number;
  /** Stable reference designator, used to re-resolve `partIndex` after the
   *  board is re-parsed (PARSER_VERSION bump, file replacement). */
  refdes: string;
  mark: WorklistMark;
  note: string;
  /** True if `refdes` couldn't be found in the current board on hydration.
   *  Row is rendered greyed-out and excluded from canvas highlight. */
  unresolved?: boolean;
}

export interface Worklist {
  id: string;
  name: string;
  createdAt: number;
  entries: WorklistEntry[];
}

export interface BoardWorklistes {
  /** Cache key from board-cache (`${fileName}:${fileSize}:${lastModified}`) */
  key: string;
  /** Human-readable file name — kept so future cross-board features can list
   *  worklistes without forcing the matching board to be loaded. */
  fileName: string;
  activeWorklistId: string | null;
  worklistes: Worklist[];
  updatedAt: number;
}

const DB_NAME = 'boardripper-worklist';
const DB_VERSION = 1;
const STORE = 'boards';

class WorklistStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private byKey = new Map<string, BoardWorklistes>();
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

  private async loadFromDb(key: string): Promise<BoardWorklistes | null> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve((req.result as BoardWorklistes | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.cache?.warn('worklist: load failed', e);
      return null;
    }
  }

  private async persist(value: BoardWorklistes): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const req = tx.objectStore(STORE).put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      log.cache?.warn('worklist: persist failed', e);
    }
  }

  /** Re-resolve partIndex from refdes for the freshly-loaded board.
   *  Rows whose refdes is gone are flagged unresolved. */
  private resolveEntries(worklistes: Worklist[]): void {
    const board = boardStore.board;
    if (!board) {
      for (const s of worklistes) for (const e of s.entries) e.unresolved = true;
      return;
    }
    const byRefdes = new Map<string, number>();
    for (let i = 0; i < board.parts.length; i++) {
      const name = board.parts[i]?.name;
      if (name) byRefdes.set(name, i);
    }
    for (const s of worklistes) {
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

  /** Hydrate the worklist for the current active board tab (idempotent). Called
   *  from the panel when it mounts and from boardStore tab-change hooks. */
  async syncToActiveTab(): Promise<void> {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    if (!tab) return;
    const key = this.activeKey;
    if (!key) return;
    if (this.byKey.has(key)) {
      // Re-resolve in case the board was re-parsed (parts re-indexed)
      const cur = this.byKey.get(key)!;
      this.resolveEntries(cur.worklistes);
      this.notify();
      return;
    }
    if (this.hydrating.has(key)) {
      await this.hydrating.get(key);
      return;
    }
    const p = (async () => {
      const loaded = await this.loadFromDb(key);
      const value: BoardWorklistes = loaded ?? {
        key,
        fileName: tab.fileName,
        activeWorklistId: null,
        worklistes: [],
        updatedAt: Date.now(),
      };
      this.resolveEntries(value.worklistes);
      this.byKey.set(key, value);
      this.notify();
    })();
    this.hydrating.set(key, p);
    try { await p; } finally { this.hydrating.delete(key); }
  }

  /** Current board's worklist record (or null if no board is active). */
  get current(): BoardWorklistes | null {
    const key = this.activeKey;
    return key ? this.byKey.get(key) ?? null : null;
  }

  /** Stable per-board key. Prefers the board-cache triple
   *  `${fileName}:${fileSize}:${lastModified}` when available — that's the
   *  same key board-cache uses, so worklists and parsed-board cache co-track.
   *  Falls back to `noCache:${fileName}` when the board was loaded by a path
   *  that didn't populate `cacheKey` (drag-drop, OpenBoardData, library nav
   *  — see board-store.ts loadFromBoard which sets `cacheKey: ''`). Without
   *  the fallback, `createWorklist` silently no-ops on those boards. */
  get activeKey(): string | null {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    if (!tab) return null;
    if (tab.cacheKey) return tab.cacheKey;
    if (tab.fileName) return `noCache:${tab.fileName}`;
    return null;
  }

  get activeWorklist(): Worklist | null {
    const cur = this.current;
    if (!cur || cur.activeWorklistId == null) return null;
    return cur.worklistes.find(s => s.id === cur.activeWorklistId) ?? null;
  }

  private getOrInit(): BoardWorklistes | null {
    const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
    if (!tab) return null;
    const key = this.activeKey;
    if (!key) return null;
    let cur = this.byKey.get(key);
    if (!cur) {
      cur = {
        key,
        fileName: tab.fileName,
        activeWorklistId: null,
        worklistes: [],
        updatedAt: Date.now(),
      };
      this.byKey.set(key, cur);
    }
    return cur;
  }

  private save(cur: BoardWorklistes): void {
    cur.updatedAt = Date.now();
    this.notify();
    void this.persist(cur);
  }

  createWorklist(name?: string): Worklist | null {
    const cur = this.getOrInit();
    if (!cur) return null;
    const id = 'st-' + Math.random().toString(36).slice(2, 10);
    const trimmed = (name ?? '').trim();
    const worklist: Worklist = {
      id,
      name: trimmed || `Worklist ${cur.worklistes.length + 1}`,
      createdAt: Date.now(),
      entries: [],
    };
    cur.worklistes.push(worklist);
    cur.activeWorklistId = id;
    this.save(cur);
    return worklist;
  }

  renameWorklist(id: string, name: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === id);
    if (!s) return;
    s.name = name.trim() || s.name;
    this.save(cur);
  }

  deleteWorklist(id: string): void {
    const cur = this.current;
    if (!cur) return;
    cur.worklistes = cur.worklistes.filter(s => s.id !== id);
    if (cur.activeWorklistId === id) {
      cur.activeWorklistId = cur.worklistes[0]?.id ?? null;
    }
    this.save(cur);
  }

  setActiveWorklist(id: string | null): void {
    const cur = this.current;
    if (!cur) return;
    cur.activeWorklistId = id;
    this.save(cur);
  }

  wipeWorklist(id: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === id);
    if (!s) return;
    s.entries = [];
    this.save(cur);
  }

  /** Push the given partIndex array into worklistId, creating one if needed.
   *  Skips duplicates (same refdes). Returns the count actually added. */
  pushParts(worklistId: string | null, partIndices: readonly number[]): number {
    const cur = this.getOrInit();
    if (!cur) return 0;
    const board = boardStore.board;
    if (!board) return 0;
    let worklist: Worklist | null = null;
    if (worklistId) {
      worklist = cur.worklistes.find(s => s.id === worklistId) ?? null;
    }
    if (!worklist) {
      // No active worklist and none requested → auto-create
      worklist = this.createWorklist() ?? null;
      if (!worklist) return 0;
    }
    const seen = new Set(worklist.entries.map(e => e.refdes));
    let added = 0;
    for (const idx of partIndices) {
      const part = board.parts[idx];
      const refdes = part?.name;
      if (!refdes) continue;
      if (seen.has(refdes)) continue;
      seen.add(refdes);
      worklist.entries.push({
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
   *  worklist. Returns the resolved worklist id, or null on failure. */
  pushRefdesToActive(refdes: string): { worklistId: string; added: number } | null {
    const board = boardStore.board;
    if (!board) return null;
    const idx = board.parts.findIndex(p => p?.name === refdes);
    if (idx < 0) return null;
    const cur = this.current ?? this.getOrInit();
    if (!cur) return null;
    const worklistId = cur.activeWorklistId ?? (this.createWorklist()?.id ?? null);
    if (!worklistId) return null;
    const added = this.pushParts(worklistId, [idx]);
    return { worklistId, added };
  }

  removeEntry(worklistId: string, refdes: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const before = s.entries.length;
    s.entries = s.entries.filter(e => e.refdes !== refdes);
    if (s.entries.length !== before) this.save(cur);
  }

  setMark(worklistId: string, refdes: string, mark: WorklistMark): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e || e.mark === mark) return;
    e.mark = mark;
    this.save(cur);
  }

  setNote(worklistId: string, refdes: string, note: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e || e.note === note) return;
    e.note = note;
    this.save(cur);
  }

  /** Cycle the per-row mark: none → replaced → reworked → cleaned → none. */
  cycleMark(worklistId: string, refdes: string, reverse = false): void {
    const order: WorklistMark[] = ['none', 'replaced', 'reworked', 'cleaned'];
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e) return;
    const i = order.indexOf(e.mark);
    const next = reverse ? (i - 1 + order.length) % order.length : (i + 1) % order.length;
    e.mark = order[next];
    this.save(cur);
  }

  /** Format the active worklist for clipboard:
   *    REFDES[mark] (note)
   *  with [mark] omitted when 'none' and (note) omitted when empty. */
  formatWorklistForClipboard(worklistId: string): string {
    const cur = this.current;
    if (!cur) return '';
    const s = cur.worklistes.find(x => x.id === worklistId);
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

export const worklistStore = new WorklistStore();
