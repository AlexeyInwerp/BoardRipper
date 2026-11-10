import { boardStore } from './board-store';
import { selectionSetStore } from './selection-set-store';
import { log } from './log-store';
import type { BoardData } from '../parsers/types';
import { formatWorklist, parseWorklistText as parseClipboard, type ClipWorklist } from './worklist-clipboard';
import {
  newDoc, mergeDocs, normalizeDoc, docsFromLegacy, defaultBoardName, partKey, netKey,
  type WorklistDoc, type StoredPart, type StoredNet, type LegacyBoardRecord, type WorklistOrigin,
} from './worklist-doc';
import { pickRemote, cacheLoadAll, cachePut, cacheDelete, legacyLoadAll, type WorklistRemote } from './worklist-remote';
import { obdBoardNumberFor } from './obd-store';
import { extractBoardNumberFromFilename } from './board-number';

/**
 * Worklists — named collections of parts and nets a repair technician is
 * tracking, with marks, notes and readings.
 *
 * Since 2026-11-10 a worklist is a document of its own (store/worklist-doc.ts),
 * stored on the server, in the desktop app's worklists folder, or in the lite
 * build's IndexedDB (store/worklist-remote.ts), and attributed to a board
 * NAME that can be edited. A board tab *loads* a worklist for the session —
 * any worklist onto any tab, the same one onto two tabs — without binding it;
 * nothing loads by itself. Spec: docs/specs/2026-11-10-worklist-storage-redesign.md.
 *
 * The rows a panel shows (`Worklist`, below) are built per board: `partIndex`
 * and `unresolved` say where a refdes is on THAT board and are never stored.
 */

export type WorklistMark = 'none' | 'replaced' | 'reworked' | 'cleaned';

/** Mark vocabulary for **net** worklist entries — the failure mode: shorted,
 *  missing, or resolved. Physical part actions don't map onto a trace. */
export type NetWorklistMark = 'none' | 'short' | 'solved' | 'absent';

/** Mark → display colour. CSS strings for the panel UI, matching numeric
 *  values for the canvas overlay. */
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

export const NET_MARK_COLOR_CSS: Record<NetWorklistMark, string> = {
  none: '#ffaa00',
  short: '#ff5566',
  solved: '#33cc88',
  absent: '#8899aa',
};

/** Runtime-checkable mark vocabularies: agent writes arrive as untyped
 *  strings over MCP and are clamped to 'none'. */
const VALID_PART_MARKS: ReadonlySet<WorklistMark> = new Set<WorklistMark>(['none', 'replaced', 'reworked', 'cleaned']);
const VALID_NET_MARKS: ReadonlySet<NetWorklistMark> = new Set<NetWorklistMark>(['none', 'short', 'solved', 'absent']);

/** A part row as shown on one board. */
export interface WorklistEntry {
  /** Index of the part on the board this row is shown on (-1 when absent). */
  partIndex: number;
  refdes: string;
  mark: WorklistMark;
  note: string;
  waterdamage?: boolean;
  /** The refdes is not on the board this row is shown on. */
  unresolved?: boolean;
}

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

/** Up to three independent readings per net, one per kind. */
export type NetMeasurements = Partial<Record<NetMeasurement['kind'], NetMeasurement>>;

/** A net row as shown on one board. */
export interface NetWorklistEntry {
  netName: string;
  mark: NetWorklistMark;
  note: string;
  unresolved?: boolean;
  surge?: boolean;
  measurements?: NetMeasurements;
}

/** A measurement the agent asked for (legacy shape, kept for imports). */
export interface MeasurementEntry {
  id: string;
  target: string;
  kind: 'diode' | 'voltage' | 'resistance' | 'continuity' | 'other';
  prompt: string;
  expected?: string;
  value?: string;
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
  unread?: boolean;
}

/** A worklist as shown on one board (or with no board): the document's
 *  fields plus per-board row resolution. Rebuilt when the document or the
 *  board changes; never stored. */
export interface Worklist {
  id: string;
  name: string;
  /** The board name the worklist is attributed to. */
  board: string;
  tags: string[];
  origin?: WorklistOrigin;
  createdAt: number;
  updatedAt: number;
  entries: WorklistEntry[];
  netEntries: NetWorklistEntry[];
  note?: string;
  messages?: WorklistMessage[];
  aiOrigin?: Record<string, true>;
}

/** One row of the worklist navigator / finder. */
export interface WorklistSummary {
  id: string;
  name: string;
  board: string;
  tags: string[];
  parts: number;
  nets: number;
  updatedAt: number;
  origin?: WorklistOrigin;
}

const LOADED_KEY = 'boardripper-worklist-loaded';
const MIGRATED_KEY = 'boardripper-worklists-migrated-v2';
const POLL_MS = 10_000;

/** What a tab's file is called for remembering what it had loaded. Two keys:
 *  the exact file and its bare name, so a tab whose cache key changes (a
 *  re-parse, a cache eviction) still finds its worklist again. */
function fileKeys(tab: { cacheKey?: string; fileName: string }): string[] {
  const keys = [`name:${tab.fileName}`];
  if (tab.cacheKey) keys.unshift(tab.cacheKey);
  return keys;
}

class WorklistStore {
  private remote: WorklistRemote | null = null;
  private docs = new Map<string, WorklistDoc>();
  private dirty = new Set<string>();
  /** Local edit counter per document — keys the per-board view cache. */
  private ver = new Map<string, number>();
  private listeners = new Set<() => void>();
  /** Board tab → loaded worklist id. */
  private loaded = new Map<number, string>();
  /** Tabs the user explicitly unloaded this session (no restore for them). */
  private unloaded = new Set<number>();
  /** Tabs whose remembered worklist has been looked up once. */
  private restored = new Set<number>();
  private since = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private channel: BroadcastChannel | null = null;
  private started: Promise<void> | null = null;
  private _ready = false;
  /** Test-only: the worklist "the active tab" has when no board tab exists. */
  private _testActiveId: string | null = null;
  private views = new WeakMap<object, Map<string, { ver: number; view: Worklist }>>();
  private readonly noBoardKey = {};

  constructor() {
    if (typeof window === 'undefined') return;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel('boardripper-worklist-v2');
        this.channel.onmessage = () => { void this.pull(); };
      } catch { this.channel = null; }
    }
    // Tabs come and go: restore a remembered worklist on a new tab, forget
    // closed ones.
    boardStore.subscribe(() => this.onBoardChange());
    void this.start();
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Load the local cache, migrate old per-file records once, then sync with
   *  the remote. Idempotent. */
  start(): Promise<void> {
    if (this.started) return this.started;
    this.started = (async () => {
      this.remote = pickRemote();
      for (const c of await cacheLoadAll()) {
        this.docs.set(c.doc.id, c.doc);
        if (c.dirty) this.dirty.add(c.doc.id);
      }
      await this.migrateLegacy();
      const full = await this.remote.list(0);
      if (full) {
        this.applyIncoming(full.docs);
        this.since = full.now;
        if (this.remote.kind !== 'none') {
          // A cached copy the remote no longer has, with nothing unsent, was
          // purged there (old tombstone) — drop it here too.
          const live = new Set(full.docs.map(d => d.id));
          const gone = [...this.docs.keys()].filter(id => !live.has(id) && !this.dirty.has(id));
          for (const id of gone) this.docs.delete(id);
          void cacheDelete(gone);
        }
      }
      this._ready = true;
      this.onBoardChange();
      this.notify();
      if (this.dirty.size) this.scheduleFlush(0);
      if (this.remote.kind === 'http') this.startPolling();
    })();
    return this.started;
  }

  get ready(): boolean { return this._ready; }

  /** One-time import of the old per-file IndexedDB records of this origin. */
  private async migrateLegacy(): Promise<void> {
    try { if (localStorage.getItem(MIGRATED_KEY)) return; } catch { return; }
    const recs = (await legacyLoadAll()) as LegacyBoardRecord[];
    const loaded = this.readLoaded();
    let n = 0;
    for (const rec of recs) {
      if (!rec || typeof rec.fileName !== 'string') continue;
      const docs = docsFromLegacy(rec, f => defaultBoardName(f, extractBoardNumberFromFilename(f)));
      for (const d of docs) {
        if (this.docs.has(d.id)) continue;
        this.docs.set(d.id, d);
        this.dirty.add(d.id);
        n++;
      }
      // What each file had open becomes what it loads next time.
      if (rec.activeWorklistId && docs.some(d => d.id === rec.activeWorklistId)) {
        if (rec.key) loaded[rec.key] = rec.activeWorklistId;
        loaded[`name:${rec.fileName}`] = rec.activeWorklistId;
      }
    }
    this.writeLoaded(loaded);
    if (n) {
      log.cache?.log(`worklists: imported ${n} from the old per-board store`);
      await cachePut([...this.dirty].map(id => ({ doc: this.docs.get(id)!, dirty: true })));
    }
    try { localStorage.setItem(MIGRATED_KEY, String(Date.now())); } catch { /* */ }
  }

  private startPolling(): void {
    const tick = () => { if (document.visibilityState === 'visible') void this.pull(); };
    setInterval(tick, POLL_MS);
    window.addEventListener('focus', tick);
    document.addEventListener('visibilitychange', tick);
  }

  /** Fetch what changed on the remote since the last look and apply it. */
  private async pull(): Promise<void> {
    if (!this.remote) return;
    if (this.remote.kind === 'none') {
      // Lite: another tab of this site wrote the shared cache.
      for (const c of await cacheLoadAll()) {
        if (!this.dirty.has(c.doc.id)) this.applyIncoming([c.doc]);
      }
      return;
    }
    const r = await this.remote.list(Math.max(0, this.since - 2000));
    if (!r) return;
    this.since = r.now;
    this.applyIncoming(r.docs);
    if (this.dirty.size) this.scheduleFlush(0);
  }

  /** Take documents from the remote: new ones as they are; for one with
   *  unsent local edits, merge; otherwise the newer revision wins. */
  private applyIncoming(incoming: WorklistDoc[]): void {
    const changed: WorklistDoc[] = [];
    for (const d of incoming) {
      const local = this.docs.get(d.id);
      let next: WorklistDoc | null = null;
      if (!local) next = d;
      else if (this.dirty.has(d.id)) next = d.rev > local.rev ? mergeDocs(local, d) : null;
      else if (d.rev > local.rev || (d.rev === local.rev && d.updatedAt > local.updatedAt)) next = d;
      if (!next) continue;
      this.docs.set(d.id, next);
      this.bump(d.id);
      changed.push(next);
    }
    if (!changed.length) return;
    void cachePut(changed.map(doc => ({ doc, dirty: this.dirty.has(doc.id) })));
    // A worklist deleted elsewhere leaves every tab it was on.
    for (const [tab, id] of this.loaded) if (this.docs.get(id)?.deleted) this.loaded.delete(tab);
    this.notify();
  }

  private scheduleFlush(ms = 300): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => { this.flushTimer = null; void this.flush(); }, ms);
  }

  /** Put every document with unsent edits. A conflict merges with the
   *  server's copy and tries again; an unreachable remote keeps the edits
   *  (in the cache, too) and retries later. */
  private async flush(): Promise<void> {
    if (this.flushing || !this.remote) { if (this.flushing) this.scheduleFlush(); return; }
    this.flushing = true;
    let failed = false;
    try {
      for (const id of [...this.dirty]) {
        for (let attempt = 0; attempt < 4; attempt++) {
          const doc = this.docs.get(id);
          if (!doc) { this.dirty.delete(id); break; }
          const sentVer = this.ver.get(id) ?? 0;
          const res = await this.remote.put(doc);
          if ('ok' in res) {
            if ((this.ver.get(id) ?? 0) === sentVer) {
              this.docs.set(id, res.doc);
              this.dirty.delete(id);
            } else {
              // Edited while in flight: keep the edits, adopt the new rev.
              const cur = this.docs.get(id)!;
              this.docs.set(id, { ...cur, rev: res.doc.rev, updatedAt: res.doc.updatedAt });
            }
            this.bump(id);
            break;
          }
          if ('conflict' in res) {
            this.docs.set(id, mergeDocs(this.docs.get(id)!, res.doc));
            this.bump(id);
            continue;
          }
          failed = true;
          log.cache?.warn(`worklists: could not store ${id}: ${res.error}`);
          break;
        }
        if (failed) break;
      }
    } finally {
      this.flushing = false;
    }
    void cachePut([...this.docs.values()].map(doc => ({ doc, dirty: this.dirty.has(doc.id) })));
    try { this.channel?.postMessage({ t: Date.now() }); } catch { /* */ }
    this.notify();
    if (failed) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.flush(); }, 15_000);
    } else if (this.dirty.size) {
      this.scheduleFlush();
    }
  }

  // ── change plumbing ──────────────────────────────────────────────────────

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify(): void {
    this.listeners.forEach(fn => fn());
  }

  private bump(id: string): void {
    this.ver.set(id, (this.ver.get(id) ?? 0) + 1);
  }

  /** Apply `fn` to a live document; a `false` return means "nothing changed". */
  private edit(id: string | null | undefined, fn: (d: WorklistDoc) => boolean | void): boolean {
    if (!id) return false;
    const d = this.docs.get(id);
    if (!d || d.deleted) return false;
    if (fn(d) === false) return false;
    d.updatedAt = Math.max(Date.now(), d.updatedAt);
    this.bump(id);
    this.dirty.add(id);
    void cachePut([{ doc: d, dirty: true }]);
    this.notify();
    this.scheduleFlush();
    return true;
  }

  // ── tabs ─────────────────────────────────────────────────────────────────

  // What each file had loaded lives in sessionStorage: a reload or a session
  // restore brings a tab back with its worklist, but opening the file again
  // in a new session starts with suggestions only — loading never binds.
  private readLoaded(): Record<string, string> {
    try { return JSON.parse(sessionStorage.getItem(LOADED_KEY) ?? '{}') ?? {}; } catch { return {}; }
  }
  private writeLoaded(m: Record<string, string>): void {
    try { sessionStorage.setItem(LOADED_KEY, JSON.stringify(m)); } catch { /* */ }
  }

  private onBoardChange(): void {
    const tabs = boardStore.tabs;
    const open = new Set(tabs.map(t => t.id));
    let changed = false;
    for (const id of [...this.loaded.keys()]) if (!open.has(id)) { this.loaded.delete(id); changed = true; }
    for (const id of [...this.unloaded]) if (!open.has(id)) this.unloaded.delete(id);
    for (const id of [...this.restored]) if (!open.has(id)) this.restored.delete(id);
    if (this._ready) {
      const remembered = this.readLoaded();
      for (const t of tabs) {
        if (this.restored.has(t.id) || this.loaded.has(t.id) || this.unloaded.has(t.id)) continue;
        this.restored.add(t.id);
        const id = fileKeys(t).map(k => remembered[k]).find(x => x && this.docs.has(x) && !this.docs.get(x)!.deleted);
        if (id) { this.loaded.set(t.id, id); changed = true; }
      }
    }
    if (changed) this.notify();
  }

  /** Load a worklist onto a tab for this session (a reload brings the tab
   *  back with it). Does not touch the worklist's board name. */
  loadOnTab(tabId: number | null, worklistId: string | null): void {
    if (tabId == null) { this._testActiveId = worklistId; this.notify(); return; }
    const tab = boardStore.tabs.find(t => t.id === tabId);
    const prev = this.loaded.get(tabId) ?? null;
    if (prev === worklistId) return;
    if (worklistId) { this.loaded.set(tabId, worklistId); this.unloaded.delete(tabId); }
    else { this.loaded.delete(tabId); this.unloaded.add(tabId); }
    if (tab) {
      const m = this.readLoaded();
      for (const k of fileKeys(tab)) { if (worklistId) m[k] = worklistId; else delete m[k]; }
      this.writeLoaded(m);
    }
    // The cyan selection + shared-net glow came from the previous worklist;
    // loading the first one onto a tab (a Shift+click creating it) has
    // nothing to clear and must not drop a selection the user is building.
    if (prev && tabId === boardStore.activeTabId) this.clearCanvasHighlight();
    this.notify();
  }

  /** The worklist id loaded on a tab, or null. */
  tabWorklistId(tabId: number | null | undefined): string | null {
    if (tabId == null) return this._testActiveId;
    const id = this.loaded.get(tabId);
    return id && this.docs.has(id) && !this.docs.get(id)!.deleted ? id : null;
  }

  /** Other open tabs showing the same worklist (for "also on …"). */
  tabsShowing(worklistId: string): number[] {
    return [...this.loaded.entries()].filter(([, id]) => id === worklistId).map(([t]) => t);
  }

  private clearCanvasHighlight(): void {
    const tabId = boardStore.activeTabId;
    if (tabId != null) selectionSetStore.clear(tabId);
    boardStore.setConnectionHighlight(false);
  }

  // ── views ────────────────────────────────────────────────────────────────

  private viewOf(doc: WorklistDoc, board: BoardData | null): Worklist {
    const key = board ?? this.noBoardKey;
    let m = this.views.get(key);
    if (!m) { m = new Map(); this.views.set(key, m); }
    const v = this.ver.get(doc.id) ?? 0;
    const hit = m.get(doc.id);
    if (hit && hit.ver === v) return hit.view;
    let byRefdes: Map<string, number> | null = null;
    let netUpper: Map<string, string> | null = null;
    if (board) {
      byRefdes = new Map();
      for (let i = 0; i < board.parts.length; i++) {
        const n = board.parts[i]?.name;
        if (n) { const k = n.toUpperCase(); if (!byRefdes.has(k)) byRefdes.set(k, i); }
      }
      netUpper = new Map();
      for (const k of board.nets.keys()) { const u = k.toUpperCase(); if (!netUpper.has(u)) netUpper.set(u, k); }
    }
    const view: Worklist = {
      id: doc.id, name: doc.name, board: doc.board, tags: doc.tags, origin: doc.origin,
      createdAt: doc.createdAt, updatedAt: doc.updatedAt,
      note: doc.note, messages: doc.messages, aiOrigin: doc.aiOrigin,
      entries: doc.entries.filter(e => !e.removed).map(e => {
        const idx = byRefdes?.get(e.refdes.toUpperCase());
        const row: WorklistEntry = {
          partIndex: idx ?? -1,
          refdes: idx != null ? board!.parts[idx].name : e.refdes,
          mark: VALID_PART_MARKS.has(e.mark) ? e.mark : 'none',
          note: e.note,
        };
        if (e.waterdamage) row.waterdamage = true;
        if (idx == null) row.unresolved = true;
        return row;
      }),
      netEntries: doc.netEntries.filter(n => !n.removed).map(n => {
        const canon = netUpper?.get(n.netName.toUpperCase());
        const row: NetWorklistEntry = {
          netName: canon ?? n.netName,
          mark: VALID_NET_MARKS.has(n.mark) ? n.mark : 'none',
          note: n.note,
        };
        if (n.surge) row.surge = true;
        if (n.measurements && Object.keys(n.measurements).length) row.measurements = n.measurements;
        if (!canon) row.unresolved = true;
        return row;
      }),
    };
    m.set(doc.id, { ver: v, view });
    return view;
  }

  /** A worklist as shown on `board` (rows resolved there), or with no board. */
  view(worklistId: string, board: BoardData | null = null): Worklist | null {
    const d = this.docs.get(worklistId);
    return d && !d.deleted ? this.viewOf(d, board) : null;
  }

  /** The worklist loaded on a tab, resolved against that tab's board. */
  worklistForTab(tabId: number | null | undefined): Worklist | null {
    const id = this.tabWorklistId(tabId);
    if (!id) return null;
    const tab = tabId == null ? null : boardStore.tabs.find(t => t.id === tabId);
    return this.view(id, tab?.board ?? null);
  }

  /** The active tab's loaded worklist (the panel, the context menu, MCP). */
  get activeWorklist(): Worklist | null {
    return this.worklistForTab(boardStore.activeTabId);
  }

  /** Every live worklist, newest first. */
  summaries(): WorklistSummary[] {
    return [...this.docs.values()].filter(d => !d.deleted)
      .map(d => ({
        id: d.id, name: d.name, board: d.board, tags: d.tags, origin: d.origin, updatedAt: d.updatedAt,
        parts: d.entries.filter(e => !e.removed).length, nets: d.netEntries.filter(n => !n.removed).length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Back-compat for the navigator's older callers. */
  async listAllStored(): Promise<WorklistSummary[]> {
    await this.start();
    return this.summaries();
  }

  /** Kept for callers that ran it on tab change; restoring is automatic now. */
  async syncToActiveTab(): Promise<void> {
    await this.start();
    this.onBoardChange();
  }

  // ── worklists ────────────────────────────────────────────────────────────

  /** The board name and origin a new worklist takes from a tab. */
  private identityOf(tabId: number | null): { board: string; origin?: WorklistOrigin } {
    const tab = tabId == null ? null : boardStore.tabs.find(t => t.id === tabId);
    if (!tab) return { board: '' };
    const bn = obdBoardNumberFor(tab);
    return {
      board: defaultBoardName(tab.fileName, bn),
      origin: { fileName: tab.fileName, ...(bn ? { boardNumber: bn } : {}), ...(tab.fileId != null ? { fileId: tab.fileId } : {}) },
    };
  }

  /** New worklist attributed to the active tab's board, loaded onto it.
   *  `onTab: false` creates it without loading (the navigator). */
  createWorklist(name?: string, opts: { onTab?: boolean; board?: string } = {}): Worklist | null {
    const tabId = boardStore.activeTabId;
    const id0 = this.identityOf(tabId);
    const count = this.summaries().filter(s => s.board === (opts.board ?? id0.board)).length;
    const doc = newDoc((name ?? '').trim() || `Worklist ${count + 1}`, opts.board ?? id0.board, id0.origin);
    this.docs.set(doc.id, doc);
    this.bump(doc.id);
    this.dirty.add(doc.id);
    void cachePut([{ doc, dirty: true }]);
    if (opts.onTab !== false) this.loadOnTab(tabId, doc.id);
    this.notify();
    this.scheduleFlush();
    return this.view(doc.id, tabId == null ? null : boardStore.tabs.find(t => t.id === tabId)?.board ?? null);
  }

  renameWorklist(id: string, name: string): void {
    const n = name.trim();
    this.edit(id, d => { if (!n || d.name === n) return false; d.name = n; d.metaAt = Date.now(); });
  }

  /** Change the board name a worklist is attributed to. */
  setBoardName(id: string, board: string): void {
    const b = board.trim();
    this.edit(id, d => { if (d.board === b) return false; d.board = b; d.metaAt = Date.now(); });
  }

  setTags(id: string, tags: readonly string[]): void {
    const clean = [...new Set(tags.map(t => t.trim()).filter(Boolean))];
    this.edit(id, d => {
      if (clean.length === d.tags.length && clean.every((t, i) => t === d.tags[i])) return false;
      d.tags = clean; d.metaAt = Date.now();
    });
  }

  /** Attribute to the active tab's board (the explicit binding). */
  attributeToActiveBoard(id: string): void {
    const ident = this.identityOf(boardStore.activeTabId);
    if (ident.board) this.setBoardName(id, ident.board);
  }

  /** A fresh copy (new id, same rows, marks and notes reset to none / kept). */
  duplicateWorklist(id: string): Worklist | null {
    const src = this.docs.get(id);
    if (!src) return null;
    const doc = newDoc(`${src.name} (copy)`, src.board, src.origin);
    const now = Date.now();
    doc.tags = [...src.tags];
    doc.entries = src.entries.filter(e => !e.removed).map(e => ({ ...e, at: now }));
    doc.netEntries = src.netEntries.filter(n => !n.removed).map(n => ({ ...n, at: now }));
    if (src.note) doc.note = src.note;
    this.docs.set(doc.id, doc);
    this.bump(doc.id);
    this.dirty.add(doc.id);
    void cachePut([{ doc, dirty: true }]);
    this.notify();
    this.scheduleFlush();
    return this.view(doc.id);
  }

  deleteWorklist(id: string): void {
    const wasOn = this.tabsShowing(id);
    this.edit(id, d => { d.deleted = Date.now(); });
    for (const t of wasOn) this.loaded.delete(t);
    if (wasOn.includes(boardStore.activeTabId ?? -1)) this.clearCanvasHighlight();
    this.notify();
  }

  /** Back-compat: make `id` the active tab's worklist. */
  setActiveWorklist(id: string | null): void {
    this.loadOnTab(boardStore.activeTabId, id);
  }

  /** Clear every row, parts AND nets (with their readings). */
  wipeWorklist(id: string): void {
    const now = Date.now();
    this.edit(id, d => {
      let n = 0;
      for (const e of d.entries) if (!e.removed) { e.removed = now; n++; }
      for (const e of d.netEntries) if (!e.removed) { e.removed = now; n++; }
      if (!n) return false;
    });
    if (this.tabsShowing(id).includes(boardStore.activeTabId ?? -1)) this.clearCanvasHighlight();
  }

  setWorklistNote(worklistId: string, note: string): void {
    const trimmed = note.replace(/\r\n/g, '\n').slice(0, 4000);
    this.edit(worklistId, d => {
      if ((d.note ?? '') === trimmed) return false;
      if (trimmed === '') delete d.note; else d.note = trimmed;
      d.metaAt = Date.now();
    });
  }

  // ── rows ─────────────────────────────────────────────────────────────────

  private part(d: WorklistDoc, refdes: string): StoredPart | undefined {
    const k = refdes.toUpperCase();
    return d.entries.find(e => partKey(e) === k);
  }
  private net(d: WorklistDoc, name: string): StoredNet | undefined {
    const k = name.toUpperCase();
    return d.netEntries.find(e => netKey(e) === k);
  }

  /** Add a part row (or bring a removed one back). Returns whether it was new. */
  private addPart(d: WorklistDoc, refdes: string): boolean {
    const now = Date.now();
    const e = this.part(d, refdes);
    if (e && !e.removed) return false;
    if (e) { delete e.removed; e.mark = 'none'; e.note = ''; delete e.waterdamage; e.refdes = refdes; e.at = now; return true; }
    d.entries.push({ refdes, mark: 'none', note: '', at: now });
    return true;
  }
  private addNet(d: WorklistDoc, netName: string): boolean {
    const now = Date.now();
    const e = this.net(d, netName);
    if (e && !e.removed) return false;
    if (e) { delete e.removed; e.mark = 'none'; e.note = ''; delete e.surge; delete e.measurements; e.netName = netName; e.at = now; return true; }
    d.netEntries.push({ netName, mark: 'none', note: '', at: now });
    return true;
  }

  /** The worklist an add goes to: `worklistId`, else the active tab's, else a
   *  new one on the active tab. */
  private targetId(worklistId: string | null): string | null {
    if (worklistId && this.docs.has(worklistId) && !this.docs.get(worklistId)!.deleted) return worklistId;
    return this.tabWorklistId(boardStore.activeTabId) ?? this.createWorklist()?.id ?? null;
  }

  /** Push parts of the active board into a worklist (created if none).
   *  Skips duplicates. Returns the count actually added. */
  pushParts(worklistId: string | null, partIndices: readonly number[]): number {
    const board = boardStore.board;
    if (!board) return 0;
    const id = this.targetId(worklistId);
    let added = 0;
    this.edit(id, d => {
      for (const idx of partIndices) {
        const refdes = board.parts[idx]?.name;
        if (refdes && this.addPart(d, refdes)) added++;
      }
      if (!added) return false;
    });
    return added;
  }

  pushRefdesToActive(refdes: string): { worklistId: string; added: number } | null {
    const board = boardStore.board;
    if (!board) return null;
    const idx = board.parts.findIndex(p => p?.name === refdes);
    if (idx < 0) return null;
    const id = this.targetId(null);
    if (!id) return null;
    return { worklistId: id, added: this.pushParts(id, [idx]) };
  }

  removeEntry(worklistId: string, refdes: string): void {
    this.edit(worklistId, d => {
      const e = this.part(d, refdes);
      if (!e || e.removed) return false;
      e.removed = Date.now();
    });
  }

  private editPart(worklistId: string, refdes: string, fn: (e: StoredPart) => boolean | void): void {
    this.edit(worklistId, d => {
      const e = this.part(d, refdes);
      if (!e || e.removed || fn(e) === false) return false;
      e.at = Date.now();
    });
  }
  private editNet(worklistId: string, netName: string, fn: (e: StoredNet) => boolean | void): void {
    this.edit(worklistId, d => {
      const e = this.net(d, netName);
      if (!e || e.removed || fn(e) === false) return false;
      e.at = Date.now();
    });
  }

  setMark(worklistId: string, refdes: string, mark: WorklistMark): void {
    this.editPart(worklistId, refdes, e => { if (e.mark === mark) return false; e.mark = mark; });
  }

  setNote(worklistId: string, refdes: string, note: string): void {
    this.editPart(worklistId, refdes, e => { if (e.note === note) return false; e.note = note; });
  }

  toggleWaterdamage(worklistId: string, refdes: string): void {
    this.editPart(worklistId, refdes, e => { if (e.waterdamage) delete e.waterdamage; else e.waterdamage = true; });
  }

  /** Cycle the per-row mark: none → replaced → reworked → cleaned → none. */
  cycleMark(worklistId: string, refdes: string, reverse = false): void {
    const order: WorklistMark[] = ['none', 'replaced', 'reworked', 'cleaned'];
    this.editPart(worklistId, refdes, e => {
      const i = Math.max(0, order.indexOf(e.mark));
      e.mark = order[reverse ? (i - 1 + order.length) % order.length : (i + 1) % order.length];
    });
  }

  /** Push net names into a worklist (created if none). Skips duplicates. */
  pushNets(worklistId: string | null, netNames: readonly string[]): number {
    const board = boardStore.board;
    const id = this.targetId(worklistId);
    let added = 0;
    this.edit(id, d => {
      for (const name of netNames) {
        if (name && this.addNet(d, canonicalNetName(board, name))) added++;
      }
      if (!added) return false;
    });
    return added;
  }

  pushNetToActive(netName: string): { worklistId: string; added: number } | null {
    if (!boardStore.board) return null;
    const id = this.targetId(null);
    if (!id) return null;
    return { worklistId: id, added: this.pushNets(id, [netName]) };
  }

  removeNetEntry(worklistId: string, netName: string): void {
    this.edit(worklistId, d => {
      const e = this.net(d, netName);
      if (!e || e.removed) return false;
      e.removed = Date.now();
    });
  }

  setNetMark(worklistId: string, netName: string, mark: NetWorklistMark): void {
    this.editNet(worklistId, netName, e => { if (e.mark === mark) return false; e.mark = mark; });
  }

  setNetNote(worklistId: string, netName: string, note: string): void {
    this.editNet(worklistId, netName, e => { if (e.note === note) return false; e.note = note; });
  }

  toggleSurge(worklistId: string, netName: string): void {
    this.editNet(worklistId, netName, e => { if (e.surge) delete e.surge; else e.surge = true; });
  }

  cycleNetMark(worklistId: string, netName: string, reverse = false): void {
    const order: NetWorklistMark[] = ['none', 'short', 'solved', 'absent'];
    this.editNet(worklistId, netName, e => {
      const i = order.indexOf(e.mark);
      e.mark = order[reverse
        ? (i < 0 ? order.length - 1 : (i - 1 + order.length) % order.length)
        : (i < 0 ? 1 : (i + 1) % order.length)];
    });
  }

  // ── readings ─────────────────────────────────────────────────────────────

  /** Set a net reading directly (user, recorded). Adds the net if absent. */
  setNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind'], value: string, unit?: string): boolean {
    if (!this.docs.has(worklistId)) return false;
    return this.edit(worklistId, d => {
      this.addNet(d, netName);
      const e = this.net(d, netName)!;
      const now = Date.now();
      (e.measurements ??= {})[kind] = { kind, value, unit: unit ?? NET_MEASUREMENT_UNITS[kind], status: 'recorded', source: 'user', at: now };
      e.at = now;
    });
  }

  clearNetMeasurement(worklistId: string, netName: string, kind: NetMeasurement['kind']): void {
    this.editNet(worklistId, netName, e => {
      if (!e.measurements?.[kind]) return false;
      delete e.measurements[kind];
      if (!Object.keys(e.measurements).length) delete e.measurements;
    });
  }

  // ── AI mode (MCP): the active tab's worklist, created on demand ─────────

  private aiTargetId(): string | null {
    if (!boardStore.board && this._testActiveId === null) return null;
    return this.tabWorklistId(boardStore.activeTabId) ?? (boardStore.activeTabId == null ? this._testActiveId : null)
      ?? this.createWorklist()?.id ?? null;
  }

  private static newMsgId(): string {
    return `msg${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  aiAddPart(refdes: string, mark?: WorklistMark, note?: string): boolean {
    const id = this.aiTargetId();
    if (!id) return false;
    const board = boardStore.board;
    const upper = refdes.toUpperCase();
    const found = board?.parts.find(p => p?.name?.toUpperCase() === upper)?.name;
    const canonical = found ?? refdes;
    return this.edit(id, d => {
      this.addPart(d, canonical);
      const e = this.part(d, canonical)!;
      if (mark) e.mark = VALID_PART_MARKS.has(mark) ? mark : 'none';
      if (note != null) e.note = note.slice(0, 4000);
      e.at = Date.now();
      (d.aiOrigin ??= {})[`p:${canonical}`] = true;
    });
  }

  aiAddNet(netName: string, mark?: NetWorklistMark, note?: string): boolean {
    const id = this.aiTargetId();
    if (!id) return false;
    const canonical = canonicalNetName(boardStore.board, netName);
    return this.edit(id, d => {
      this.addNet(d, canonical);
      const e = this.net(d, canonical)!;
      if (mark) e.mark = VALID_NET_MARKS.has(mark) ? mark : 'none';
      if (note != null) e.note = note.slice(0, 4000);
      e.at = Date.now();
      (d.aiOrigin ??= {})[`n:${canonical}`] = true;
    });
  }

  aiSetListNote(note: string): boolean {
    const id = this.aiTargetId();
    if (!id) return false;
    this.setWorklistNote(id, note);
    return true;
  }

  requestNetMeasurement(netName: string, opts: { kind: NetMeasurement['kind']; prompt?: string; expected?: string }): boolean {
    const id = this.aiTargetId();
    if (!id) return false;
    return this.edit(id, d => {
      this.addNet(d, netName);
      const e = this.net(d, netName)!;
      const now = Date.now();
      (e.measurements ??= {})[opts.kind] = {
        kind: opts.kind, status: 'requested', prompt: opts.prompt, expected: opts.expected,
        unit: NET_MEASUREMENT_UNITS[opts.kind], source: 'agent', at: now,
      };
      e.at = now;
      (d.aiOrigin ??= {})[`n:${netName}`] = true;
    });
  }

  recordNetMeasurement(netName: string, value: string, unit?: string, kind?: NetMeasurement['kind']): boolean {
    const id = this.aiTargetId();
    if (!id) return false;
    return this.edit(id, d => {
      const e = this.net(d, netName);
      if (!e || e.removed || !e.measurements) return false;
      let k = kind;
      if (!k) {
        const pending = MEAS_KINDS.filter(kk => e.measurements![kk]?.status === 'requested');
        if (pending.length !== 1) return false;
        k = pending[0];
      }
      const prev = e.measurements[k];
      if (!prev) return false;
      const now = Date.now();
      e.measurements[k] = { ...prev, value, unit: unit ?? prev.unit, status: 'recorded', at: now };
      e.at = now;
    });
  }

  addMessage(role: WorklistMessage['role'], text: string): string | null {
    const id = this.aiTargetId();
    if (!id) return null;
    const mid = WorklistStore.newMsgId();
    this.edit(id, d => {
      (d.messages ??= []).push({ id: mid, role, text: text.slice(0, 4000), at: Date.now(), ...(role === 'user' ? { unread: true } : {}) });
    });
    return mid;
  }

  /** User messages (optionally only unread), marked read. Never creates a
   *  worklist just to read. */
  consumeUserMessages(onlyUnread = true): WorklistMessage[] {
    const id = this.tabWorklistId(boardStore.activeTabId);
    const d = id ? this.docs.get(id) : null;
    if (!d?.messages) return [];
    const out = d.messages.filter(m => m.role === 'user' && (!onlyUnread || m.unread)).map(m => ({ ...m }));
    if (out.some(m => m.unread)) this.edit(id, doc => { for (const m of doc.messages ?? []) if (m.role === 'user') delete m.unread; });
    return out;
  }

  peekUnreadUserMessages(): number {
    const w = this.activeWorklist;
    return w?.messages?.filter(m => m.role === 'user' && m.unread).length ?? 0;
  }

  aiSnapshot(): Record<string, unknown> | null {
    const w = this.activeWorklist;
    if (!w) return null;
    return {
      name: w.name,
      board: w.board,
      tags: w.tags,
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

  // ── clipboard ────────────────────────────────────────────────────────────

  formatWorklistForClipboard(worklistId: string): string {
    const w = this.view(worklistId);
    return w ? formatWorklist(WorklistStore.toClip(w)) : '';
  }

  private static toClip(s: Worklist): ClipWorklist {
    return {
      name: s.name,
      note: s.note ?? '',
      parts: s.entries.map(e => ({ refdes: e.refdes, mark: e.mark, note: e.note, waterdamage: !!e.waterdamage })),
      nets: s.netEntries.map(n => ({
        netName: n.netName,
        mark: n.mark,
        surge: !!n.surge,
        note: n.note,
        measurements: MEAS_KINDS
          .map(k => n.measurements?.[k])
          .filter((m): m is NetMeasurement => !!m && !!m.value && !!m.value.trim())
          .map(m => ({ kind: m.kind, value: m.value!.trim() })),
      })),
    };
  }

  static parseWorklistText(text: string): ClipWorklist | null {
    return parseClipboard(text);
  }

  /** Import a worklist from clipboard text as a new worklist attributed to
   *  the active tab's board and loaded onto it. null if not a worklist. */
  importFromText(text: string): { created: string; parts: number; nets: number; resolved: number } | null {
    const parsed = WorklistStore.parseWorklistText(text);
    if (!parsed) return null;
    const board = boardStore.board;
    const w = this.createWorklist(parsed.name);
    if (!w) return null;
    const now = Date.now();
    let resolved = 0;
    this.edit(w.id, d => {
      if (parsed.note) d.note = parsed.note;
      for (const p of parsed.parts) {
        const found = board?.parts.some(x => x?.name === p.refdes);
        if (found) resolved++;
        d.entries.push({ refdes: p.refdes, mark: p.mark, note: p.note, at: now, ...(p.waterdamage ? { waterdamage: true } : {}) });
      }
      for (const n of parsed.nets) {
        const e: StoredNet = { netName: canonicalNetName(board, n.netName), mark: n.mark, note: n.note, at: now };
        if (n.surge) e.surge = true;
        for (const m of n.measurements) {
          (e.measurements ??= {})[m.kind] = { kind: m.kind, value: m.value, unit: NET_MEASUREMENT_UNITS[m.kind], status: 'recorded', source: 'user', at: now };
        }
        d.netEntries.push(e);
      }
    });
    return { created: parsed.name, parts: parsed.parts.length, nets: parsed.nets.length, resolved };
  }

  // ── tests ────────────────────────────────────────────────────────────────

  /** Test helper: a fresh worklist that "the active tab" has even with no
   *  board tab open. */
  TEST_NEW_WORKLIST(name: string): string {
    const w = this.createWorklist(name);
    if (boardStore.activeTabId == null && w) this._testActiveId = w.id;
    return w!.id;
  }

  NET_MEASUREMENT_UNITS_PROBE(): Record<NetMeasurement['kind'], string> {
    return NET_MEASUREMENT_UNITS;
  }

  /** Test helper: what the one-time migration makes of one old worklist. */
  LEGACY_PROBE(w: unknown): WorklistDoc | null {
    return docsFromLegacy({ key: 'probe', fileName: 'probe.bvr', activeWorklistId: null, worklistes: [w as never] }, f => f)[0] ?? null;
  }

  /** Test helper: the stored document (copy). */
  TEST_DOC(id: string): WorklistDoc | null {
    const d = this.docs.get(id);
    return d ? normalizeDoc(JSON.parse(JSON.stringify(d))) : null;
  }

  /** Test helper: resolve once every pending write has reached the remote. */
  async TEST_SETTLED(): Promise<void> {
    await this.start();
    for (let i = 0; i < 50 && (this.dirty.size || this.flushing || this.flushTimer); i++) {
      if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; await this.flush(); }
      else await new Promise(r => setTimeout(r, 50));
    }
  }

  /** Test helper: ask the remote for changes now. */
  TEST_PULL(): Promise<void> { return this.pull(); }
}

/** Resolve `name` to the board's net-name casing (case-insensitive); the name
 *  as given when the board has no such net. */
function canonicalNetName(board: BoardData | null, name: string): string {
  if (!board || board.nets.has(name)) return name;
  const upper = name.toUpperCase();
  for (const k of board.nets.keys()) if (k.toUpperCase() === upper) return k;
  return name;
}

export const worklistStore = new WorklistStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __worklistStore?: typeof worklistStore }).__worklistStore = worklistStore;
}
