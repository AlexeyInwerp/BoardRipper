import { boardStore } from './board-store';
import { selectionSetStore } from './selection-set-store';
import { log } from './log-store';

/** Persistent per-board "worklist" — named collections of parts a repair-tech
 *  is tracking (water damage candidates, ticket worklists, etc). Survives
 *  reload and container upgrade via IndexedDB. */

export type WorklistMark = 'none' | 'replaced' | 'reworked' | 'cleaned';

/** Mark vocabulary for **net** worklist entries. Separate from `WorklistMark`
 *  because "replaced / reworked / cleaned" describe physical actions on a
 *  component and don't map onto a signal trace. The net analogue is the
 *  *failure mode*: shorted, missing, or resolved. */
export type NetWorklistMark = 'none' | 'short' | 'solved' | 'absent';

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

/** Mark colours for **net** entries. Matches the visual semantics from the
 *  part palette where it makes sense (red = problem, green = resolved). */
export const NET_MARK_COLOR_CSS: Record<NetWorklistMark, string> = {
  none: '#ffaa00',       // amber — "in a worklist, not yet acted on"
  short: '#ff5566',      // red — fault identified
  solved: '#33cc88',     // green — resolved
  absent: '#8899aa',     // muted slate — disconnected / not on this board
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
  /** Binary "water damage observed at this site" flag. Orthogonal to `mark`
   *  (a part can be both water-damaged AND replaced). Omitted when false to
   *  keep persisted records small; consumers must treat absence as false. */
  waterdamage?: boolean;
  /** True if `refdes` couldn't be found in the current board on hydration.
   *  Row is rendered greyed-out and excluded from canvas highlight. */
  unresolved?: boolean;
}

/** A net pinned to a worklist. Carries the same {mark, note} shape as a part
 *  entry so the row UI can reuse most of the rendering. `surge` replaces
 *  `waterdamage` — the analogue for a signal is "this net saw an over-current
 *  / ESD event", flagged with the lightning-bolt icon. Per-board key is the
 *  net name (case-preserved). */
export interface NetWorklistEntry {
  netName: string;
  mark: NetWorklistMark;
  note: string;
  /** True if the netName couldn't be found in the current board on hydration.
   *  Row is rendered greyed-out, same as the part-entry counterpart. */
  unresolved?: boolean;
  /** Lightning-bolt surge / over-current flag. Omitted when false. */
  surge?: boolean;
}

/** A measurement the agent asked the user to take, and the value they returned.
 *  Drives the AI-mode feedback loop: agent requests → user answers → agent reads. */
export interface MeasurementEntry {
  id: string;
  target: string;                 // "D4200" | "PPBUS_AON" | "U7000.12"
  kind: 'diode' | 'voltage' | 'resistance' | 'continuity' | 'other';
  prompt: string;                 // what the agent asked
  expected?: string;              // agent's spec/expected value
  value?: string;                 // user-entered result
  unit?: string;
  status: 'pending' | 'answered' | 'skipped';
  source: 'agent' | 'user';
  requestedAt: number;
  answeredAt?: number;
}

/** A line in the AI-mode relay transcript between the agent and the user. */
export interface WorklistMessage {
  id: string;
  role: 'agent' | 'user';
  text: string;
  at: number;
  /** True until the agent has read it (for user messages) — lets get_user_messages
   *  return only fresh ones without a cursor. */
  unread?: boolean;
}

export interface Worklist {
  id: string;
  name: string;
  createdAt: number;
  entries: WorklistEntry[];
  /** Pinned nets — independent from `entries` so the existing part API and
   *  persisted format stay byte-stable. Defaults to `[]` on hydration of
   *  records persisted before v0.31.6. */
  netEntries: NetWorklistEntry[];
  /** Free-form ticket / list note, shown under a spoiler at the top of the
   *  active worklist. Roundtrips through clipboard via `> `-prefixed lines
   *  immediately after the `-[name]-` header. */
  note?: string;
  /** AI-mode feedback-loop fields (v0.31.24+). All optional + default-empty so
   *  pre-existing persisted worklists hydrate unchanged. */
  measurements?: MeasurementEntry[];
  messages?: WorklistMessage[];
  /** Keys (`p:REFDES` / `n:NET`) the agent added, so the row can show an AI badge. */
  aiOrigin?: Record<string, true>;
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

  /** Re-resolve partIndex from refdes (and existence of net names) for the
   *  freshly-loaded board. Rows whose refdes / netName is gone are flagged
   *  unresolved. Also back-fills `netEntries: []` for records persisted
   *  before nets-in-worklist was added. */
  private resolveEntries(worklistes: Worklist[]): void {
    const board = boardStore.board;
    const validNetMarks: ReadonlySet<NetWorklistMark> = new Set(['none', 'short', 'solved', 'absent']);
    for (const s of worklistes) {
      if (!Array.isArray(s.netEntries)) s.netEntries = [];
      // Sanitise legacy net marks that briefly shipped with the part vocab
      // (replaced / reworked / cleaned) in v0.31.5 → reset to 'none'.
      for (const e of s.netEntries) {
        if (!validNetMarks.has(e.mark)) e.mark = 'none';
      }
    }
    if (!board) {
      for (const s of worklistes) {
        for (const e of s.entries) e.unresolved = true;
        for (const e of s.netEntries) e.unresolved = true;
      }
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
      for (const e of s.netEntries) {
        if (board.nets.has(e.netName)) delete e.unresolved;
        else e.unresolved = true;
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

  /** Drop the ephemeral cyan selection + "highlight connections" toggle for the
   *  active tab. Called whenever the worklist that fed the highlight changes
   *  underneath it (switch / wipe / delete) so the canvas never glows nets for
   *  parts that are no longer worklisted. The cyan set is index-only and can't
   *  be re-resolved, so the only honest move is to clear it. */
  private clearCanvasHighlight(): void {
    const tabId = boardStore.activeTabId;
    if (tabId != null) selectionSetStore.clear(tabId);
    boardStore.setConnectionHighlight(false);
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
      netEntries: [],
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
    // Deleting a worklist invalidates any highlight loaded from it.
    this.clearCanvasHighlight();
    this.save(cur);
  }

  setActiveWorklist(id: string | null): void {
    const cur = this.current;
    if (!cur) return;
    if (cur.activeWorklistId === id) return;
    cur.activeWorklistId = id;
    // The ephemeral cyan selection was loaded from the *previous* active
    // worklist via its "Connections" button (or shift-click stragglers). After
    // a switch those parts no longer match the new worklist's marks, and
    // the cyan overlay would visually swallow the new worklist's
    // mark-coloured ring. Clearing keeps the highlight model honest:
    // cyan = "I asked to look at this set right now", and on switch you
    // weren't asking.
    this.clearCanvasHighlight();
    this.save(cur);
  }

  wipeWorklist(id: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === id);
    if (!s) return;
    s.entries = [];
    // Wiping the entries leaves the highlight pointing at parts that are no
    // longer in the worklist — clear it.
    this.clearCanvasHighlight();
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

  toggleWaterdamage(worklistId: string, refdes: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.entries.find(x => x.refdes === refdes);
    if (!e) return;
    if (e.waterdamage) delete e.waterdamage;
    else e.waterdamage = true;
    this.save(cur);
  }

  setWorklistNote(worklistId: string, note: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const trimmed = note.replace(/\r\n/g, '\n').slice(0, 4000);
    const current = s.note ?? '';
    if (current === trimmed) return;
    if (trimmed === '') delete s.note;
    else s.note = trimmed;
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

  // ── Net entries ────────────────────────────────────────────────────────

  /** Push net names into worklistId, creating the worklist if needed. Skips
   *  duplicates. Returns the count actually added. */
  pushNets(worklistId: string | null, netNames: readonly string[]): number {
    const cur = this.getOrInit();
    if (!cur) return 0;
    const board = boardStore.board;
    if (!board) return 0;
    let worklist: Worklist | null = null;
    if (worklistId) {
      worklist = cur.worklistes.find(s => s.id === worklistId) ?? null;
    }
    if (!worklist) {
      worklist = this.createWorklist() ?? null;
      if (!worklist) return 0;
    }
    if (!Array.isArray(worklist.netEntries)) worklist.netEntries = [];
    const seen = new Set(worklist.netEntries.map(e => e.netName));
    let added = 0;
    for (const name of netNames) {
      if (!name || seen.has(name)) continue;
      // Case-insensitive resolve to the board's canonical net name so the
      // entry stays in sync with the board's casing.
      let canonical = name;
      if (!board.nets.has(name)) {
        const upper = name.toUpperCase();
        for (const k of board.nets.keys()) {
          if (k.toUpperCase() === upper) { canonical = k; break; }
        }
      }
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      worklist.netEntries.push({ netName: canonical, mark: 'none', note: '' });
      added++;
    }
    if (added > 0) this.save(cur);
    return added;
  }

  /** Push a single net into the active worklist (auto-creating one if none).
   *  Returns the worklist id + how many entries were added (0 if duplicate). */
  pushNetToActive(netName: string): { worklistId: string; added: number } | null {
    const board = boardStore.board;
    if (!board) return null;
    const cur = this.current ?? this.getOrInit();
    if (!cur) return null;
    const worklistId = cur.activeWorklistId ?? (this.createWorklist()?.id ?? null);
    if (!worklistId) return null;
    const added = this.pushNets(worklistId, [netName]);
    return { worklistId, added };
  }

  removeNetEntry(worklistId: string, netName: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const before = s.netEntries.length;
    s.netEntries = s.netEntries.filter(e => e.netName !== netName);
    if (s.netEntries.length !== before) this.save(cur);
  }

  setNetMark(worklistId: string, netName: string, mark: NetWorklistMark): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.netEntries.find(x => x.netName === netName);
    if (!e || e.mark === mark) return;
    e.mark = mark;
    this.save(cur);
  }

  setNetNote(worklistId: string, netName: string, note: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.netEntries.find(x => x.netName === netName);
    if (!e || e.note === note) return;
    e.note = note;
    this.save(cur);
  }

  /** Lightning-bolt analogue of `toggleWaterdamage` — for nets. */
  toggleSurge(worklistId: string, netName: string): void {
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.netEntries.find(x => x.netName === netName);
    if (!e) return;
    if (e.surge) delete e.surge;
    else e.surge = true;
    this.save(cur);
  }

  /** Cycle the per-row mark for a net entry. */
  cycleNetMark(worklistId: string, netName: string, reverse = false): void {
    const order: NetWorklistMark[] = ['none', 'short', 'solved', 'absent'];
    const cur = this.current;
    if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return;
    const e = s.netEntries.find(x => x.netName === netName);
    if (!e) return;
    const i = order.indexOf(e.mark);
    const next = reverse
      ? (i < 0 ? order.length - 1 : (i - 1 + order.length) % order.length)
      : (i < 0 ? 1 : (i + 1) % order.length);
    e.mark = order[next];
    this.save(cur);
  }

  /** Format a worklist for clipboard. First line is the marker
   *    `-[<name>]-`
   *  optionally followed by one or more `> note` lines (the worklist-level
   *  ticket note), then one entry per line:
   *    `REFDES[mark][water] (note)`
   *  `[mark]` is omitted when 'none', `[water]` is only present when the
   *  waterdamage flag is set, and ` (note)` is omitted when empty.
   *  The marker doubles as the import header — see `parseWorklistText`. */
  // ── AI mode: MCP-agent feedback loop ───────────────────────────────────
  // All of these target the ACTIVE board's ACTIVE worklist (created on demand),
  // so the agent operates on "the board the user has open" without an id.

  private aiTarget(): { cur: BoardWorklistes; w: Worklist } | null {
    if (!boardStore.board) return null;
    const cur = this.current ?? this.getOrInit();
    if (!cur) return null;
    if (!cur.activeWorklistId || !cur.worklistes.some(x => x.id === cur.activeWorklistId)) {
      const created = this.createWorklist();
      if (created) cur.activeWorklistId = created.id;
    }
    const w = cur.worklistes.find(x => x.id === cur.activeWorklistId);
    return w ? { cur, w } : null;
  }

  private static newId(prefix: string): string {
    return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /** Agent adds (or updates) a part entry; tags it as AI-originated. */
  aiAddPart(refdes: string, mark?: WorklistMark, note?: string): boolean {
    const t = this.aiTarget();
    if (!t) return false;
    const board = boardStore.board;
    const idx = board ? board.parts.findIndex(p => p?.name === refdes) : -1;
    if (idx >= 0) this.pushParts(t.w.id, [idx]);
    else if (!t.w.entries.some(e => e.refdes === refdes))
      t.w.entries.push({ partIndex: -1, refdes, mark: 'none', note: '', unresolved: true });
    const e = t.w.entries.find(x => x.refdes === refdes);
    if (e) {
      if (mark) e.mark = mark;
      if (note != null) e.note = note.slice(0, 4000);
    }
    (t.w.aiOrigin ??= {})[`p:${refdes}`] = true;
    this.save(t.cur);
    return true;
  }

  /** Agent adds (or updates) a net entry; tags it as AI-originated. */
  aiAddNet(netName: string, mark?: NetWorklistMark, note?: string): boolean {
    const t = this.aiTarget();
    if (!t) return false;
    if (!t.w.netEntries.some(n => n.netName === netName)) this.pushNets(t.w.id, [netName]);
    const e = t.w.netEntries.find(x => x.netName === netName);
    if (e) {
      if (mark) e.mark = mark;
      if (note != null) e.note = note.slice(0, 4000);
    } else if (!t.w.netEntries.some(n => n.netName === netName)) {
      t.w.netEntries.push({ netName, mark: mark ?? 'none', note: note ?? '', unresolved: true });
    }
    (t.w.aiOrigin ??= {})[`n:${netName}`] = true;
    this.save(t.cur);
    return true;
  }

  /** Agent sets the ticket/diagnosis note on the active worklist. */
  aiSetListNote(note: string): boolean {
    const t = this.aiTarget();
    if (!t) return false;
    this.setWorklistNote(t.w.id, note);
    return true;
  }

  /** Agent requests a measurement; returns the row id (read back later). */
  aiRequestMeasurement(m: { target: string; kind?: MeasurementEntry['kind']; prompt: string; expected?: string }): string | null {
    const t = this.aiTarget();
    if (!t) return null;
    const id = WorklistStore.newId('m');
    (t.w.measurements ??= []).push({
      id, target: m.target, kind: m.kind ?? 'other', prompt: m.prompt.slice(0, 1000),
      expected: m.expected, status: 'pending', source: 'agent', requestedAt: Date.now(),
    });
    this.save(t.cur);
    return id;
  }

  /** User (or UI) answers a measurement. */
  answerMeasurement(id: string, value: string, unit?: string): boolean {
    const t = this.aiTarget();
    if (!t?.w.measurements) return false;
    const m = t.w.measurements.find(x => x.id === id);
    if (!m) return false;
    m.value = String(value).slice(0, 200);
    if (unit != null) m.unit = unit.slice(0, 16);
    m.status = 'answered';
    m.answeredAt = Date.now();
    this.save(t.cur);
    return true;
  }

  skipMeasurement(id: string): boolean {
    const t = this.aiTarget();
    if (!t?.w.measurements) return false;
    const m = t.w.measurements.find(x => x.id === id);
    if (!m) return false;
    m.status = 'skipped';
    this.save(t.cur);
    return true;
  }

  /** Post a message into the relay transcript. User messages start unread so the
   *  agent's get_user_messages can return only fresh ones. */
  addMessage(role: WorklistMessage['role'], text: string): string | null {
    const t = this.aiTarget();
    if (!t) return null;
    const id = WorklistStore.newId('msg');
    (t.w.messages ??= []).push({ id, role, text: text.slice(0, 4000), at: Date.now(), unread: role === 'user' });
    this.save(t.cur);
    return id;
  }

  /** Return user messages (optionally only unread) and mark them read. */
  consumeUserMessages(onlyUnread = true): WorklistMessage[] {
    const t = this.aiTarget();
    if (!t?.w.messages) return [];
    const out = t.w.messages.filter(m => m.role === 'user' && (!onlyUnread || m.unread));
    let changed = false;
    for (const m of out) if (m.unread) { delete m.unread; changed = true; }
    if (changed) this.save(t.cur);
    return out;
  }

  /** Full active-worklist snapshot for the agent's worklist_get. */
  aiSnapshot(): Record<string, unknown> | null {
    const w = this.activeWorklist;
    if (!w) return null;
    return {
      name: w.name,
      note: w.note ?? '',
      parts: w.entries.map(e => ({ refdes: e.refdes, mark: e.mark, note: e.note, waterdamage: !!e.waterdamage, unresolved: !!e.unresolved, ai: !!w.aiOrigin?.[`p:${e.refdes}`] })),
      nets: w.netEntries.map(n => ({ net: n.netName, mark: n.mark, note: n.note, surge: !!n.surge, unresolved: !!n.unresolved, ai: !!w.aiOrigin?.[`n:${n.netName}`] })),
      measurements: (w.measurements ?? []).map(m => ({ id: m.id, target: m.target, kind: m.kind, prompt: m.prompt, expected: m.expected ?? null, value: m.value ?? null, unit: m.unit ?? null, status: m.status })),
      messages: (w.messages ?? []).map(m => ({ role: m.role, text: m.text, at: m.at })),
    };
  }

  formatWorklistForClipboard(worklistId: string): string {
    const cur = this.current;
    if (!cur) return '';
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return '';
    const lines: string[] = [`-[${s.name}]-`];
    if (s.note && s.note.trim()) {
      for (const noteLine of s.note.split('\n')) {
        lines.push(`> ${noteLine}`);
      }
    }
    for (const e of s.entries) {
      let line = e.refdes;
      if (e.mark !== 'none') line += `[${e.mark}]`;
      if (e.waterdamage) line += `[water]`;
      if (e.note.trim()) line += ` (${e.note.trim()})`;
      lines.push(line);
    }
    return lines.join('\n');
  }

  /** Try to parse text as a worklist. Designed to be safe against arbitrary
   *  clipboard contents — refuses oversize input, requires a proper
   *  `-[name]-` header, and only accepts refdes tokens that look like real
   *  PCB designators (`[A-Z][A-Z0-9_\-./]{0,31}`). When the header matches
   *  but none of the trailing non-empty lines parse as entries, returns
   *  null — so a coincidental `-[…]-` line at the top of an arbitrary log
   *  or source file doesn't get silently imported as a worklist of garbage.
   *
   *  Caps:
   *    text          ≤ 256 KiB
   *    lines scanned ≤ 2000
   *    entries kept  ≤ 1000
   *    name length   ≤ 200 chars
   *    note length   ≤ 500 chars (per entry, post-trim) */
  static parseWorklistText(text: string): {
    name: string;
    note: string;
    entries: Array<{ refdes: string; mark: WorklistMark; note: string; waterdamage: boolean }>;
  } | null {
    if (typeof text !== 'string' || text.length === 0) return null;
    if (text.length > 256 * 1024) return null;
    const lines = text.split(/\r?\n/, 2001); // hard cap on line scan
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return null;
    const headerMatch = lines[i].trim().match(/^-\[(.+)\]-$/);
    if (!headerMatch) return null;
    const name = headerMatch[1].trim().slice(0, 200);
    // Reject names containing control chars — those don't survive clipboard
    // roundtrips cleanly and usually signal binary garbage masquerading as
    // text.
    // eslint-disable-next-line no-control-regex
    if (!name || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(name)) return null;
    i++;
    // Worklist-level ticket note: contiguous `> ` lines immediately after
    // the header. Empty lines end the note block.
    const noteLines: string[] = [];
    while (i < lines.length) {
      const raw = lines[i];
      const m = raw.match(/^>\s?(.*)$/);
      if (!m) break;
      noteLines.push(m[1]);
      i++;
      if (noteLines.length > 200) break; // safety cap
    }
    const note = noteLines.join('\n').slice(0, 4000);
    // Refdes shape: starts with uppercase letter, then up to 31 chars of
    // [A-Z0-9_.\/-]. Filters out source-code identifiers like `function`,
    // `import`, `const` that would otherwise match the lenient row regex
    // and pollute the imported worklist with fake entries.
    const refdesRe = /^[A-Z][A-Z0-9_\-./]{0,31}$/;
    // Row shape: REFDES followed by 0+ `[token]` chunks (mark and/or water),
    // optional ` (note)`. Tokens parsed below.
    const rowRe = /^\s*(\S+?)((?:\[[a-z]+\])*)\s*(?:\(([^)]*)\))?\s*$/i;
    const tokenRe = /\[([a-z]+)\]/gi;
    const knownMarks = new Set<WorklistMark>(['none', 'replaced', 'reworked', 'cleaned']);
    const entries: Array<{ refdes: string; mark: WorklistMark; note: string; waterdamage: boolean }> = [];
    let trailingNonEmpty = 0;
    for (; i < lines.length && entries.length < 1000; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;
      trailingNonEmpty++;
      const m = raw.match(rowRe);
      if (!m) continue;
      const refdes = m[1];
      if (!refdesRe.test(refdes)) continue;
      let mark: WorklistMark = 'none';
      let waterdamage = false;
      const tokenBlock = m[2] ?? '';
      tokenRe.lastIndex = 0;
      let tm: RegExpExecArray | null;
      while ((tm = tokenRe.exec(tokenBlock)) !== null) {
        const tok = tm[1].toLowerCase();
        if (tok === 'water') waterdamage = true;
        else if (knownMarks.has(tok as WorklistMark)) mark = tok as WorklistMark;
      }
      const noteStr = (m[3] ?? '').trim().slice(0, 500);
      entries.push({ refdes, mark, note: noteStr, waterdamage });
    }
    // False-positive guard: header matched but no entries parsed AND there
    // was meaningful content after the header → likely a coincidence (e.g.
    // a markdown line that happens to be `-[heading]-` followed by prose).
    // Empty worklists (header + nothing, optionally with a ticket note) are
    // allowed through.
    if (entries.length === 0 && trailingNonEmpty >= 5) return null;
    return { name, note, entries };
  }

  /** Import a worklist from raw text (typically the clipboard). Returns
   *  - `{ created, total, resolved }` on success
   *  - `null` if the text isn't a valid worklist (no `-[name]-` header).
   *
   *  Entries whose refdes can't be found in the current board are still
   *  imported, but flagged `unresolved` — they render greyed-out in the
   *  panel and skip the canvas highlight, so the user sees what's missing
   *  without losing the marks/notes the sender attached. The name is
   *  reused as-is — duplicates are allowed (rename inline if you care). */
  importFromText(text: string): { created: string; total: number; resolved: number } | null {
    const parsed = WorklistStore.parseWorklistText(text);
    if (!parsed) return null;
    const board = boardStore.board;
    const cur = this.getOrInit();
    if (!cur) return null;
    const id = 'wl-' + Math.random().toString(36).slice(2, 10);
    const worklist: Worklist = {
      id,
      name: parsed.name,
      createdAt: Date.now(),
      entries: [],
      netEntries: [],
    };
    if (parsed.note) worklist.note = parsed.note;
    let resolved = 0;
    for (const p of parsed.entries) {
      const idx = board ? board.parts.findIndex(x => x?.name === p.refdes) : -1;
      const entry: WorklistEntry = {
        partIndex: idx >= 0 ? idx : 0,
        refdes: p.refdes,
        mark: p.mark,
        note: p.note,
      };
      if (p.waterdamage) entry.waterdamage = true;
      if (idx < 0) entry.unresolved = true;
      else resolved++;
      worklist.entries.push(entry);
    }
    cur.worklistes.push(worklist);
    cur.activeWorklistId = id;
    this.save(cur);
    return { created: parsed.name, total: parsed.entries.length, resolved };
  }
}

export const worklistStore = new WorklistStore();
