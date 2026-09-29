/**
 * Navigation history — the store.
 *
 * Owns the timeline state (`nav-history.ts` is the pure reducer), the layer
 * toggles (persisted), and the **camera providers**: the board renderer and
 * the PDF panel each register a `{get, set}` pair for the panel they draw,
 * which is how the departure rule reads a pose and a restore writes one
 * without this module importing either viewer. It imports no other store,
 * so `board-store.ts` and `pdf-store.ts` can record into it freely; the
 * restore side, which needs both, lives in `nav-history-actions.ts`.
 *
 * Design: docs/specs/2026-09-29-navigation-history-design.md.
 */
import { Emitter } from './emitter';
import { log } from './log-store';
import {
  push, touchCamera, patchCursor, stepIndex, moveCursor, indexOfId, removeEntry, clear, listed, parseLayers, withCamera,
  EMPTY_STATE, DEFAULT_LAYERS, NAV_HISTORY_CAP,
  type NavHistoryState, type NavEntry, type NavVisit, type NavLayers, type NavCause, type NavPlace,
  type NavSurface, type BoardCamera, type PdfCamera, type NavCamera, type PdfMatchRef,
} from './nav-history';

const LAYERS_KEY = 'boardripper-history-layers';
/** The timeline itself (phase 4): entries keyed by file, never by tab id. */
const PERSIST_KEY = 'boardripper-nav-history';
const PERSIST_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 500;

/** A query is committed 1.5 s after the last keystroke (or sooner by a pick). */
const QUERY_COMMIT_MS = 1500;

export interface BoardCameraProvider { get(): BoardCamera; set(cam: BoardCamera): void }
export interface PdfCameraProvider   { get(): PdfCamera;   set(cam: PdfCamera): void }

function loadLayers(): NavLayers {
  try {
    const raw = localStorage.getItem(LAYERS_KEY);
    if (raw) return parseLayers(JSON.parse(raw));
  } catch { /* ignore */ }
  return { ...DEFAULT_LAYERS };
}

function loadTimeline(): NavHistoryState {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return { ...EMPTY_STATE, entries: [] };
    const j = JSON.parse(raw) as { version?: number; entries?: NavEntry[]; cursor?: number; nextId?: number };
    if (j.version !== PERSIST_VERSION || !Array.isArray(j.entries)) return { ...EMPTY_STATE, entries: [] };
    // Tab ids restart at 1 on every load, so a saved id would point at a
    // stranger's tab: strip them; the restore side re-finds tabs by fileKey.
    const entries = j.entries.slice(-NAV_HISTORY_CAP).map(e => e.place?.kind === 'board' ? { ...e, place: { ...e.place, tabId: -1 } } : e);
    const cursor = Math.min(Math.max(typeof j.cursor === 'number' ? j.cursor : entries.length - 1, -1), entries.length - 1);
    const nextId = Math.max(typeof j.nextId === 'number' ? j.nextId : 1, ...entries.map(e => e.id + 1));
    return { entries, cursor, nextId };
  } catch { return { ...EMPTY_STATE, entries: [] }; }
}

class NavHistoryStore extends Emitter {
  private _state: NavHistoryState = loadTimeline();
  private _layers: NavLayers = loadLayers();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  protected notify() {
    super.notify();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persist(); }, PERSIST_DEBOUNCE_MS);
  }

  private persist() {
    try {
      const { entries, cursor, nextId } = this._state;
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ version: PERSIST_VERSION, entries, cursor, nextId }));
    } catch { /* quota */ }
  }

  /** While a restore replays through the ordinary store methods, nothing is recorded. */
  isRestoring = false;

  /** Installed by `nav-history-actions.ts`: is this entry's file still open? */
  reachable: (e: NavEntry) => boolean = () => true;

  private boardCams = new Map<number, BoardCameraProvider>();
  private pdfCams = new Map<string, PdfCameraProvider>();
  /** Poses handed to a panel that has not mounted yet — consumed on register. */
  private pendingBoard = new Map<number, BoardCamera>();
  private pendingPdf = new Map<string, PdfCamera>();

  private pendingQuery: { visit: NavVisit; timer: ReturnType<typeof setTimeout> } | null = null;

  get state(): NavHistoryState { return this._state; }
  get layers(): NavLayers { return this._layers; }
  get entries(): NavEntry[] { return this._state.entries; }
  get cursor(): number { return this._state.cursor; }
  get current(): NavEntry | null { return this._state.cursor >= 0 ? this._state.entries[this._state.cursor] : null; }

  /** Entries of switched-on layers, newest first. */
  get listed(): NavEntry[] { return listed(this._state, this._layers); }

  get canBack(): boolean { return this.stepIndex(-1) >= 0; }
  get canForward(): boolean { return this.stepIndex(1) >= 0; }

  stepIndex(dir: -1 | 1): number { return stepIndex(this._state, dir, this._layers, this.reachable); }

  // ---- layers -------------------------------------------------------------

  setLayer(cause: NavCause, on: boolean) {
    if (this._layers[cause] === on) return;
    this._layers = { ...this._layers, [cause]: on };
    try { localStorage.setItem(LAYERS_KEY, JSON.stringify(this._layers)); } catch { /* quota */ }
    this.notify();
  }

  // ---- cameras ------------------------------------------------------------

  registerBoardCamera(tabId: number, p: BoardCameraProvider) {
    this.boardCams.set(tabId, p);
    const pending = this.pendingBoard.get(tabId);
    if (pending) { this.pendingBoard.delete(tabId); this.quietly(() => p.set(pending)); }
  }

  /** Run a pose write with recording suppressed — a restore that lands after
   *  `isRestoring` was cleared (a panel mounting late) must not read as a visit. */
  private quietly(fn: () => void) {
    const was = this.isRestoring;
    this.isRestoring = true;
    try { fn(); } finally { this.isRestoring = was; }
  }
  unregisterBoardCamera(tabId: number, p?: BoardCameraProvider) {
    if (!p || this.boardCams.get(tabId) === p) this.boardCams.delete(tabId);
  }
  registerPdfCamera(fileName: string, p: PdfCameraProvider) {
    this.pdfCams.set(fileName, p);
    const pending = this.pendingPdf.get(fileName);
    if (pending) { this.pendingPdf.delete(fileName); this.quietly(() => p.set(pending)); }
  }
  unregisterPdfCamera(fileName: string, p?: PdfCameraProvider) {
    if (!p || this.pdfCams.get(fileName) === p) this.pdfCams.delete(fileName);
  }

  applyBoardCamera(tabId: number, cam: BoardCamera) {
    const p = this.boardCams.get(tabId);
    if (p) this.quietly(() => p.set(cam)); else this.pendingBoard.set(tabId, cam);
  }
  applyPdfCamera(fileName: string, cam: PdfCamera) {
    const p = this.pdfCams.get(fileName);
    if (p) this.quietly(() => p.set(cam)); else this.pendingPdf.set(fileName, cam);
  }

  /** The live pose of the panel an entry's place belongs to, if that panel is up. */
  cameraOf(place: NavPlace | null): NavCamera | undefined {
    if (!place) return undefined;
    try {
      if (place.kind === 'board') return this.boardCams.get(place.tabId)?.get();
      return this.pdfCams.get(place.fileName)?.get();
    } catch (err) {
      log.ui.warn('history: camera provider threw', err);
      return undefined;
    }
  }

  /** Departure rule for back/forward and jumps: write the current pose into the cursor entry. */
  touchCurrentCamera() {
    const cur = this.current;
    if (!cur) return;
    const cam = this.cameraOf(cur.place);
    if (!cam) return;
    const next = touchCamera(this._state, cam);
    if (next === this._state) return;
    this._state = next;
    this.notify();
  }

  // ---- recording ----------------------------------------------------------

  /** Append a visit. The pending query (if any) lands first so a pick completes it. */
  record(visit: NavVisit) {
    if (this.isRestoring) return;
    if (visit.cause === 'view' && !this._layers.view) return;   // §3.4: views are a record gate
    this.flushQuery();
    const cur = this.current;
    const departure = visit.cause === 'view' ? undefined : this.cameraOf(cur?.place ?? null);
    // The arrival pose is the entry's own camera until the departure rule
    // overwrites it — a back right after a click needs no further capture.
    if (visit.place && !visit.place.camera) {
      const cam = this.cameraOf(visit.place);
      if (cam) visit = { ...visit, place: withCamera(visit.place, cam) };
    }
    const before = this._state.entries.length;
    this._state = push(this._state, visit, departure);
    const e = this.current!;
    log.ui.log(`history: ${before === this._state.entries.length ? 'update' : 'visit'} [${e.cause}] ${e.label}${e.from ? ` (from ${e.from})` : ''} #${this._state.cursor + 1}/${this._state.entries.length}`);
    this.notify();
  }

  /** A query typed on a surface; committed after a pause or by the next pick. */
  recordQuery(surface: NavSurface, text: string, extra: { results?: number; place?: NavPlace } = {}) {
    if (this.isRestoring) return;
    if (this.pendingQuery) { clearTimeout(this.pendingQuery.timer); this.pendingQuery = null; }
    const t = text.trim();
    if (!t) return;
    const visit: NavVisit = { cause: 'search', place: extra.place ?? null, query: { surface, text: t, results: extra.results } };
    if (extra.place) { this.record(visit); return; }
    this.pendingQuery = { visit, timer: setTimeout(() => { this.pendingQuery = null; this.record(visit); }, QUERY_COMMIT_MS) };
  }

  flushQuery() {
    if (!this.pendingQuery) return;
    const { visit, timer } = this.pendingQuery;
    clearTimeout(timer);
    this.pendingQuery = null;
    this.record(visit);
  }

  /** Auto PDF-follow landed somewhere: an informational facet on the cursor entry. */
  noteFollow(follow: { fileName: string; page: number; matchIndex: number }) {
    if (this.isRestoring || !this.current) return;
    this._state = patchCursor(this._state, { follow });
    this.notify();
  }

  /** The PDF match stepped within the query the cursor entry recorded. */
  touchPdfMatch(fileName: string, page: number, match: PdfMatchRef | undefined) {
    if (this.isRestoring) return;
    const cur = this.current;
    if (!cur?.place || cur.place.kind !== 'pdf' || cur.place.fileName !== fileName) return;
    this._state = patchCursor(this._state, { place: { ...cur.place, page, match } });
    this.notify();
  }

  // ---- cursor -------------------------------------------------------------

  moveCursor(index: number) {
    const next = moveCursor(this._state, index);
    if (next === this._state) return;
    this._state = next;
    this.notify();
  }

  indexOfId(id: number): number { return indexOfId(this._state, id); }

  remove(id: number) {
    const next = removeEntry(this._state, id);
    if (next === this._state) return;
    this._state = next;
    this.notify();
  }

  clear() {
    if (this.pendingQuery) { clearTimeout(this.pendingQuery.timer); this.pendingQuery = null; }
    this._state = clear(this._state);
    this.notify();
  }
}

export const navHistoryStore = new NavHistoryStore();
