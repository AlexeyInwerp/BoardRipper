import { boardStore } from './board-store';
import { selectionSetStore } from './selection-set-store';
import { log } from './log-store';
import type { BoardData } from '../parsers/types';
import { formatWorklist, parseWorklistText as parseClipboard, type ClipWorklist } from './worklist-clipboard';

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
export interface NetMeasurement {
  kind: 'voltage' | 'diode' | 'resistance';
  value?: string;
  unit?: string;
  status: 'requested' | 'recorded';
  prompt?: string;
  expected?: string;
  source: 'agent' | 'user';
  at: number;
}

export const NET_MEASUREMENT_UNITS: Record<NetMeasurement['kind'], string> = {
  voltage: 'V',
  diode: 'V',
  resistance: 'Ω',
};

/** Fixed display/serialization order for the three measurement kinds. */
export const MEAS_KINDS: readonly NetMeasurement['kind'][] = ['voltage', 'diode', 'resistance'];

/** Up to three independent readings per net, one per kind (V + diode + Ω can
 *  all be recorded at once — no switch-of-type). */
export type NetMeasurements = Partial<Record<NetMeasurement['kind'], NetMeasurement>>;

export interface NetWorklistEntry {
  netName: string;
  mark: NetWorklistMark;
  note: string;
  /** True if the netName couldn't be found in the current board on hydration.
   *  Row is rendered greyed-out, same as the part-entry counterpart. */
  unresolved?: boolean;
  /** Lightning-bolt surge / over-current flag. Omitted when false. */
  surge?: boolean;
  /** Up to three readings (V / diode / Ω), keyed by kind, recorded
   *  independently. Omitted when none. (Replaced the single `measurement`.) */
  measurements?: NetMeasurements;
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
  updatedAt: number;
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
  schemaVersion: number;
}

const DB_NAME = 'boardripper-worklist';
const DB_VERSION = 1;
const STORE = 'boards';

class WorklistStore {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private byKey = new Map<string, BoardWorklistes>();
  private hydrating = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  /** Test-only fallback active key — set by TEST_NEW_WORKLIST when no board is loaded. */
  private _testActiveKey: string | null = null;

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
  private migrateLegacyMeasurements(w: Worklist, _board: BoardData | null): void {
    // v0.31.x → multi: a persisted single `measurement` becomes a one-entry
    // `measurements` map keyed by kind.
    for (const n of w.netEntries) {
      const single = (n as NetWorklistEntry & { measurement?: NetMeasurement }).measurement;
      if (single) {
        (n.measurements ??= {})[single.kind] = single;
        delete (n as { measurement?: unknown }).measurement;
      }
    }
    const legacy = (w as Worklist & { measurements?: MeasurementEntry[] }).measurements;
    if (!Array.isArray(legacy) || legacy.length === 0) {
      delete (w as { measurements?: unknown }).measurements;
      if (w.updatedAt == null) w.updatedAt = w.createdAt ?? Date.now();
      return;
    }
    const netByName = new Map<string, NetWorklistEntry>();
    for (const e of w.netEntries) netByName.set(e.netName.toLowerCase(), e);
    for (const m of legacy) {
      if (m.status === 'skipped') continue;
      const net = netByName.get(m.target.toLowerCase());
      const kind = (m.kind === 'voltage' || m.kind === 'diode' || m.kind === 'resistance') ? m.kind : null;
      if (net && kind) {
        const next: NetMeasurement = {
          kind,
          value: m.value,
          unit: m.unit ?? NET_MEASUREMENT_UNITS[kind],
          status: m.status === 'answered' ? 'recorded' : 'requested',
          prompt: m.prompt || undefined,
          expected: m.expected,
          source: m.source ?? 'agent',
          at: m.answeredAt ?? m.requestedAt ?? Date.now(),
        };
        // Keep the most recent per kind if the net already got one.
        const slot = (net.measurements ??= {});
        if (!slot[kind] || (slot[kind]!.at ?? 0) < next.at) slot[kind] = next;
      } else {
        // Part/pin/unknown-net or unsupported kind → preserve as a relay message.
        (w.messages ??= []).push({
          id: `mig_${m.id}`, role: 'agent',
          text: `Measurement (${m.kind}) on ${m.target}: ${m.value ? `${m.value} ${m.unit ?? ''}`.trim() : m.prompt}`,
          at: m.requestedAt ?? Date.now(),
        });
      }
    }
    delete (w as { measurements?: unknown }).measurements;
    if (w.updatedAt == null) w.updatedAt = w.createdAt ?? Date.now();
  }

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
      // Migrate any persisted legacy measurements[] array onto net rows / relay.
      this.migrateLegacyMeasurements(s, board);
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
        schemaVersion: 1,
      };
      // Stamp schemaVersion for records persisted before it was introduced.
      if (value.schemaVersion == null) value.schemaVersion = 1;
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
    if (tab) {
      if (tab.cacheKey) return tab.cacheKey;
      if (tab.fileName) return `noCache:${tab.fileName}`;
    }
    // Fall back to test key when no board tab is active (TEST_NEW_WORKLIST).
    return this._testActiveKey;
  }

  get activeWorklist(): Worklist | null {
    const cur = this.current;
    if (!cur || cur.activeWorklistId == null) return null;
    return cur.worklistes.find(s => s.id === cur.activeWorklistId) ?? null;
  }

  private getOrInit(): BoardWorklistes | null {
    const key = this.activeKey;
    if (!key) return null;
    let cur = this.byKey.get(key);
    if (!cur) {
      const tab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
      // Allow synthetic/test keys when no real board tab is active.
      cur = {
        key,
        fileName: tab?.fileName ?? key,
        activeWorklistId: null,
        worklistes: [],
        updatedAt: Date.now(),
        schemaVersion: 1,
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
    const now = Date.now();
    const worklist: Worklist = {
      id,
      name: trimmed || `Worklist ${cur.worklistes.length + 1}`,
      createdAt: now,
      updatedAt: now,
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
      if (board && !board.nets.has(name)) {
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
    // Allow test mode (TEST_NEW_WORKLIST) to proceed without a real board.
    if (!boardStore.board && !this._testActiveKey) return null;
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

  /** Set a net measurement directly (user source, recorded status). Auto-adds the
   *  net to the worklist if it isn't there yet. */
  setNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind'], value: string, unit?: string): boolean {
    const cur = this.current; if (!cur) return false;
    const s = cur.worklistes.find(x => x.id === worklistId); if (!s) return false;
    if (!s.netEntries.some(n => n.netName === netName)) this.pushNets(worklistId, [netName]);
    const e = s.netEntries.find(n => n.netName === netName); if (!e) return false;
    (e.measurements ??= {})[kind] = { kind, value, unit: unit ?? NET_MEASUREMENT_UNITS[kind], status: 'recorded', source: 'user', at: Date.now() };
    s.updatedAt = Date.now();
    this.save(cur); return true;
  }

  /** Agent requests a net measurement (source 'agent', status 'requested').
   *  Auto-adds the net to the active worklist if absent. */
  requestNetMeasurement(netName: string, opts: { kind: NetMeasurement['kind']; prompt?: string; expected?: string }): boolean {
    const t = this.aiTarget(); if (!t) return false;
    if (!t.w.netEntries.some(n => n.netName === netName)) this.pushNets(t.w.id, [netName]);
    const e = t.w.netEntries.find(n => n.netName === netName); if (!e) return false;
    (e.measurements ??= {})[opts.kind] = { kind: opts.kind, status: 'requested', prompt: opts.prompt, expected: opts.expected,
      unit: NET_MEASUREMENT_UNITS[opts.kind], source: 'agent', at: Date.now() };
    (t.w.aiOrigin ??= {})[`n:${netName}`] = true;
    t.w.updatedAt = Date.now();
    this.save(t.cur); return true;
  }

  /** Fill a previously-requested net measurement with the user's reading. When
   *  `kind` is omitted, targets the net's sole requested reading (the AI flow
   *  requests one at a time); ambiguous if more than one is pending. */
  recordNetMeasurement(netName: string, value: string, unit?: string, kind?: NetMeasurement['kind']): boolean {
    const t = this.aiTarget(); if (!t) return false;
    const e = t.w.netEntries.find(n => n.netName === netName); if (!e || !e.measurements) return false;
    let k = kind;
    if (!k) {
      const pending = MEAS_KINDS.filter(kk => e.measurements![kk]?.status === 'requested');
      if (pending.length !== 1) return false;
      k = pending[0];
    }
    const prev = e.measurements[k]; if (!prev) return false;
    e.measurements[k] = { ...prev, value, unit: unit ?? prev.unit, status: 'recorded', at: Date.now() };
    t.w.updatedAt = Date.now();
    this.save(t.cur); return true;
  }

  /** Remove one reading (by kind) from a net entry; drops the map when empty. */
  clearNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind']): void {
    const cur = this.current; if (!cur) return;
    const s = cur.worklistes.find(x => x.id === worklistId); if (!s) return;
    const e = s.netEntries.find(n => n.netName === netName); if (!e || !e.measurements) return;
    delete e.measurements[kind];
    if (Object.keys(e.measurements).length === 0) delete e.measurements;
    s.updatedAt = Date.now(); this.save(cur);
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
      netEntries: w.netEntries.map(n => ({
        netName: n.netName, mark: n.mark, note: n.note, surge: !!n.surge, unresolved: !!n.unresolved,
        ai: !!w.aiOrigin?.[`n:${n.netName}`],
        measurements: MEAS_KINDS.map(k => n.measurements?.[k]).filter(Boolean),
      })),
      messages: (w.messages ?? []).map(m => ({ role: m.role, text: m.text, at: m.at })),
    };
  }

  formatWorklistForClipboard(worklistId: string): string {
    const cur = this.current;
    if (!cur) return '';
    const s = cur.worklistes.find(x => x.id === worklistId);
    if (!s) return '';
    return formatWorklist(WorklistStore.toClip(s));
  }

  /** Map a live Worklist onto the browser-free clipboard shape. Only nets with
   *  an actual recorded value carry a measurement (a still-pending agent
   *  request has no reading to serialize). */
  private static toClip(s: Worklist): ClipWorklist {
    return {
      name: s.name,
      note: s.note ?? '',
      parts: s.entries.map(e => ({
        refdes: e.refdes,
        mark: e.mark,
        note: e.note,
        waterdamage: !!e.waterdamage,
      })),
      nets: (s.netEntries ?? []).map(n => ({
        netName: n.netName,
        mark: n.mark,
        surge: !!n.surge,
        note: n.note,
        // All recorded readings (kind order V→diode→Ω); pending requests with
        // no value are skipped.
        measurements: MEAS_KINDS
          .map(k => n.measurements?.[k])
          .filter((m): m is NetMeasurement => !!m && !!m.value && !!m.value.trim())
          .map(m => ({ kind: m.kind, value: m.value!.trim() })),
      })),
    };
  }

  /** Parse clipboard text into a worklist. Safe against arbitrary input
   *  (size-capped, requires a `-[name]-` header, refdes/net shape filtering,
   *  rejects a coincidental header followed by prose). Delegates to the pure,
   *  unit-tested `worklist-clipboard` module — see it for the format + caps. */
  static parseWorklistText(text: string): ClipWorklist | null {
    return parseClipboard(text);
  }

  /** Test helper: create a fresh worklist under a throwaway board container,
   *  bypassing the board-tab requirement so store tests run without a real board. */
  TEST_NEW_WORKLIST(name: string): string {
    let cur = this.getOrInit();
    if (!cur) {
      // No active board tab — inject a synthetic in-memory container.
      this._testActiveKey = 'test:';
      cur = {
        key: 'test:',
        fileName: 'test:',
        activeWorklistId: null,
        worklistes: [],
        updatedAt: Date.now(),
        schemaVersion: 1,
      };
      this.byKey.set('test:', cur);
    }
    const w = this.createWorklist(name);
    return w!.id;
  }

  /** Probe method for tests: return the NET_MEASUREMENT_UNITS constant. */
  NET_MEASUREMENT_UNITS_PROBE(): Record<NetMeasurement['kind'], string> {
    return NET_MEASUREMENT_UNITS;
  }

  /** Probe method for tests: exercise migrateLegacyMeasurements against the
   *  supplied worklist object in-place, using the current board (if any). */
  MIGRATE_PROBE(w: Worklist): void { this.migrateLegacyMeasurements(w, boardStore.board); }

  /** Import a worklist from raw text (typically the clipboard). Returns
   *  - `{ created, total, resolved }` on success
   *  - `null` if the text isn't a valid worklist (no `-[name]-` header).
   *
   *  Entries whose refdes can't be found in the current board are still
   *  imported, but flagged `unresolved` — they render greyed-out in the
   *  panel and skip the canvas highlight, so the user sees what's missing
   *  without losing the marks/notes the sender attached. The name is
   *  reused as-is — duplicates are allowed (rename inline if you care). */
  importFromText(text: string): { created: string; parts: number; nets: number; resolved: number } | null {
    const parsed = WorklistStore.parseWorklistText(text);
    if (!parsed) return null;
    const board = boardStore.board;
    const cur = this.getOrInit();
    if (!cur) return null;
    const id = 'wl-' + Math.random().toString(36).slice(2, 10);
    const now = Date.now();
    const worklist: Worklist = {
      id,
      name: parsed.name,
      createdAt: now,
      updatedAt: now,
      entries: [],
      netEntries: [],
    };
    if (parsed.note) worklist.note = parsed.note;
    let resolved = 0;
    for (const p of parsed.parts) {
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
    for (const n of parsed.nets) {
      // Case-insensitive resolve to the board's canonical net name; flag
      // unresolved if the net isn't present (greyed-out, same as parts).
      let canonical = n.netName;
      let found = false;
      if (board) {
        if (board.nets.has(n.netName)) found = true;
        else {
          const upper = n.netName.toUpperCase();
          for (const k of board.nets.keys()) {
            if (k.toUpperCase() === upper) { canonical = k; found = true; break; }
          }
        }
      }
      const netEntry: NetWorklistEntry = { netName: canonical, mark: n.mark, note: n.note };
      if (n.surge) netEntry.surge = true;
      if (!found) netEntry.unresolved = true;
      for (const m of n.measurements) {
        (netEntry.measurements ??= {})[m.kind] = {
          kind: m.kind,
          value: m.value,
          unit: NET_MEASUREMENT_UNITS[m.kind],
          status: 'recorded',
          source: 'user',
          at: now,
        };
      }
      worklist.netEntries.push(netEntry);
    }
    cur.worklistes.push(worklist);
    cur.activeWorklistId = id;
    this.save(cur);
    return { created: parsed.name, parts: parsed.parts.length, nets: parsed.nets.length, resolved };
  }
}

export const worklistStore = new WorklistStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __worklistStore?: typeof worklistStore }).__worklistStore = worklistStore;
}
