/**
 * Navigation history — the pure reducer.
 *
 * One timeline of *visits* across every board and PDF. A visit is where the
 * user ended up and how they got there; the cause is the layer the History
 * tab can switch off, the place is a facet. See
 * docs/specs/2026-09-29-navigation-history-design.md §2–§3 for the variants
 * that were considered and the rules below:
 *
 *  - **Jumplist, not browser truncation** (§3.1): a new visit while the
 *    cursor is not at the end first re-appends the entry under the cursor
 *    (`revisit`), then the new one. Back is always "where I just was" and no
 *    row is ever deleted by navigating.
 *  - **The camera is written at departure** (§3.2): `push` copies `camera`
 *    into the entry under the cursor before appending, so back restores the
 *    pose the user left. A `view` entry skips that write — it *is* the
 *    departure record.
 *  - **Collapsing** (§3.3): consecutive same place → replace; a growing
 *    query on one surface → replace; a result picked from a query completes
 *    that query's entry instead of adding one.
 *
 * Nothing here touches a store or the DOM: `nav-history-store.ts` owns the
 * state and the camera providers, `nav-history-actions.ts` the restore.
 */

export type NavCause = 'click' | 'lookup' | 'search' | 'view';

export const NAV_CAUSES: readonly NavCause[] = ['click', 'lookup', 'search', 'view'];

export interface BoardCamera { x: number; y: number; scaleX: number; scaleY: number }
export interface PdfCamera   { page: number; zoom: number; panX: number; panY: number }

export interface PdfMatchRef { pageIndex: number; itemIndex: number; charStart: number; charEnd: number }

export interface BoardPlace {
  kind: 'board';
  tabId: number;
  /** `name:size:lastModified` — how a tab is re-found after a reload. */
  fileKey: string;
  fileId?: number;
  fileName: string;
  /** Refdes — never a partIndex, which shifts under fold-mode / revision / BOM changes. */
  part?: string;
  /** Pin number as displayed; the index is re-resolved at restore time. */
  pin?: string;
  net?: string;
  side?: 'top' | 'bottom' | 'both';
  camera?: BoardCamera;
}

export interface PdfPlace {
  kind: 'pdf';
  fileName: string;
  fileId?: number;
  /** 1-based, like `PdfDocument.currentPage`. */
  page: number;
  match?: PdfMatchRef;
  camera?: PdfCamera;
}

export type NavPlace = BoardPlace | PdfPlace;

export type NavSurface = 'board' | 'global' | 'pdf' | 'ribbon-parts' | 'ribbon-nets';

export interface NavQuery {
  surface: NavSurface;
  text: string;
  results?: number;
}

export interface NavEntry {
  id: number;
  cause: NavCause;
  at: number;
  place: NavPlace | null;
  query?: NavQuery;
  /** Auto PDF-follow landed here — informational, never a stop of its own. */
  follow?: { fileName: string; page: number; matchIndex: number };
  /** Label of the place a lookup started from. */
  from?: string;
  /** Re-anchor copy made when a new visit happened with the cursor not at the end. */
  revisit?: boolean;
  /** Route the visit came in by (row glyph only). */
  via?: 'mcp' | 'worklist' | 'list';
  label: string;
}

export interface NavHistoryState {
  entries: NavEntry[];
  /** Index into `entries`; -1 when empty. */
  cursor: number;
  nextId: number;
}

export type NavLayers = Record<NavCause, boolean>;

export const DEFAULT_LAYERS: Readonly<NavLayers> = { click: true, lookup: true, search: true, view: false };

export const NAV_HISTORY_CAP = 300;

/** Two entries whose `at` differ by less than this are one editing run. */
const QUERY_RUN_MS = 2000;

export const EMPTY_STATE: Readonly<NavHistoryState> = { entries: [], cursor: -1, nextId: 1 };

export type NavCamera = BoardCamera | PdfCamera;

/** What a caller hands to `push`: an entry minus the bookkeeping. */
export type NavVisit = Omit<NavEntry, 'id' | 'at' | 'label' | 'revisit'> & { at?: number; label?: string };

// ---------------------------------------------------------------------------
// labels

export function placeLabel(place: NavPlace | null): string {
  if (!place) return '';
  if (place.kind === 'pdf') {
    return `p.${place.page}`;
  }
  const bits: string[] = [];
  if (place.part) bits.push(place.part);
  if (place.pin) bits.push(`pin ${place.pin}`);
  if (place.net) bits.push(place.net);
  return bits.join(' · ');
}

export function entryLabel(v: Omit<NavVisit, 'label'>): string {
  const place = placeLabel(v.place);
  if (v.query) {
    const q = `“${v.query.text}”`;
    if (place) return `${q} → ${place}`;
    return q;
  }
  if (place) return place;
  if (v.place?.kind === 'board') return v.place.fileName;
  return '';
}

// ---------------------------------------------------------------------------
// identity

/** Same *place* — the collapse key. Cameras and time are ignored. */
export function samePlace(a: NavPlace | null, b: NavPlace | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'board' && b.kind === 'board') {
    if (a.tabId !== b.tabId) return false;
    if ((a.part ?? null) !== (b.part ?? null) || (a.pin ?? null) !== (b.pin ?? null) || (a.net ?? null) !== (b.net ?? null)) return false;
    // A camera-only place (a viewpoint) is identified by its pose.
    if (!a.part && !a.net) {
      if (!a.camera || !b.camera) return !a.camera && !b.camera;
      return Math.abs(a.camera.x - b.camera.x) < 1 && Math.abs(a.camera.y - b.camera.y) < 1
        && Math.abs(a.camera.scaleX - b.camera.scaleX) < 1e-4;
    }
    return true;
  }
  if (a.kind === 'pdf' && b.kind === 'pdf') {
    if (a.fileName !== b.fileName) return false;
    if (a.match || b.match) {
      return a.match?.pageIndex === b.match?.pageIndex
        && a.match?.itemIndex === b.match?.itemIndex
        && a.match?.charStart === b.match?.charStart;
    }
    return a.page === b.page;
  }
  return false;
}

/** Same *part* on the same tab — pin-walking across a BGA collapses. */
function samePart(a: NavPlace | null, b: NavPlace | null): boolean {
  if (!a || !b || a.kind !== 'board' || b.kind !== 'board') return false;
  return a.tabId === b.tabId && !!a.part && a.part === b.part;
}

function sameQuery(a: NavQuery | undefined, b: NavQuery | undefined): boolean {
  return !!a && !!b && a.surface === b.surface && a.text.toLowerCase() === b.text.toLowerCase();
}

/** `PPB` → `PPBU` → `PPBUS`, or a backspace — one editing run. */
function queryGrowth(prev: NavQuery | undefined, next: NavQuery | undefined): boolean {
  if (!prev || !next || prev.surface !== next.surface) return false;
  const a = prev.text.toLowerCase(), b = next.text.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

// ---------------------------------------------------------------------------
// reducer

export function withCamera(place: NavPlace, camera: NavCamera | undefined): NavPlace {
  if (!camera) return place;
  if (place.kind === 'board') return { ...place, camera: camera as BoardCamera };
  return { ...place, camera: camera as PdfCamera, page: (camera as PdfCamera).page ?? place.page };
}

/** Write the current camera into the entry under the cursor (the departure rule). */
export function touchCamera(state: NavHistoryState, camera: NavCamera | undefined): NavHistoryState {
  if (!camera || state.cursor < 0) return state;
  const cur = state.entries[state.cursor];
  if (!cur.place) return state;
  const entries = state.entries.slice();
  entries[state.cursor] = { ...cur, place: withCamera(cur.place, camera) };
  return { ...state, entries };
}

/**
 * Append a visit.
 * @param departureCamera the camera of the entry under the cursor *now*,
 *   read by the caller from that entry's panel; written by the departure rule.
 */
export function push(state: NavHistoryState, visit: NavVisit, departureCamera?: NavCamera): NavHistoryState {
  const at = visit.at ?? Date.now();
  const label = visit.label ?? entryLabel(visit);
  const cur = state.cursor >= 0 ? state.entries[state.cursor] : null;

  // 1. Collapse into the entry under the cursor?
  if (cur) {
    // A query that completes: the user picked a result from the search whose
    // entry is under the cursor (place-less, same surface, one editing run).
    if (visit.cause === 'search' && visit.place && cur.cause === 'search' && !cur.place
        && (!visit.query || visit.query.surface === cur.query?.surface)) {
      return replaceCursor(state, { ...cur, place: visit.place, query: visit.query ?? cur.query, at, label: entryLabel({ ...cur, place: visit.place, query: visit.query ?? cur.query }) });
    }
    // A query attaching to a result already picked (global search: focusPart
    // first, then the sidebar mirrors the text — same text, another surface).
    if (visit.cause === 'search' && !visit.place && visit.query && cur.cause === 'search' && cur.place
        && at - cur.at < QUERY_RUN_MS
        && (!cur.query || cur.query.text.toLowerCase() === visit.query.text.toLowerCase())) {
      const next = { ...cur, query: cur.query ?? visit.query, at };
      return replaceCursor(state, { ...next, label: entryLabel(next) });
    }
    // Query growth on one surface within an editing run.
    if (visit.cause === 'search' && !visit.place && cur.cause === 'search' && !cur.place
        && queryGrowth(cur.query, visit.query) && at - cur.at < QUERY_RUN_MS) {
      const next = { ...cur, query: visit.query, at };
      return replaceCursor(state, { ...next, label: entryLabel(next) });
    }
    // Same query re-run on the same surface (PDF find stepping re-submits).
    if (visit.cause === 'search' && cur.cause === 'search' && sameQuery(cur.query, visit.query)
        && (!visit.place || !cur.place || visit.place.kind === cur.place.kind)) {
      const next = { ...cur, place: visit.place ?? cur.place, at };
      return replaceCursor(state, { ...next, label: entryLabel(next) });
    }
    // Consecutive same place / same part: replace, keep the older cause.
    if (visit.cause !== 'search' && cur.cause !== 'search' && visit.place
        && (samePlace(cur.place, visit.place) || samePart(cur.place, visit.place))) {
      const next = { ...cur, place: visit.place, at, follow: visit.follow ?? cur.follow };
      return replaceCursor(state, { ...next, label: entryLabel(next) });
    }
    // A view entry landing on the region the cursor entry already records.
    if (visit.cause === 'view' && cur.cause === 'view' && samePlace(cur.place, visit.place)) {
      const next = { ...cur, place: visit.place, at };
      return replaceCursor(state, next);
    }
  }

  let entries = state.entries.slice();
  let cursor = state.cursor;

  // 2. Departure rule — not for view entries (§3.2).
  if (visit.cause !== 'view' && cur && departureCamera && cur.place) {
    entries[cursor] = { ...cur, place: withCamera(cur.place, departureCamera) };
  }

  // 3. Re-anchor (jumplist): the cursor is not at the end.
  if (cur && cursor < entries.length - 1) {
    entries.push({ ...entries[cursor], id: state.nextId, at, revisit: true });
    state = { ...state, nextId: state.nextId + 1 };
  }

  // 4. Append.
  entries.push({ ...visit, id: state.nextId, at, label, revisit: undefined });
  cursor = entries.length - 1;

  // 5. Cap.
  if (entries.length > NAV_HISTORY_CAP) {
    const drop = entries.length - NAV_HISTORY_CAP;
    entries = entries.slice(drop);
    cursor -= drop;
  }

  return { entries, cursor, nextId: state.nextId + 1 };
}

function replaceCursor(state: NavHistoryState, entry: NavEntry): NavHistoryState {
  const entries = state.entries.slice();
  entries[state.cursor] = entry;
  return { ...state, entries };
}

/** Patch the entry under the cursor (follow facet, match index, results count). */
export function patchCursor(state: NavHistoryState, patch: Partial<NavEntry>): NavHistoryState {
  if (state.cursor < 0) return state;
  const cur = state.entries[state.cursor];
  const next = { ...cur, ...patch };
  return replaceCursor(state, { ...next, label: entryLabel(next) });
}

/** The index `back`/`forward` would land on, honouring the layers. -1 = none. */
export function stepIndex(
  state: NavHistoryState,
  dir: -1 | 1,
  layers: NavLayers,
  reachable: (e: NavEntry) => boolean = () => true,
): number {
  for (let i = state.cursor + dir; i >= 0 && i < state.entries.length; i += dir) {
    const e = state.entries[i];
    if (!layers[e.cause]) continue;
    if (!reachable(e)) continue;
    return i;
  }
  return -1;
}

export function moveCursor(state: NavHistoryState, index: number): NavHistoryState {
  if (index < 0 || index >= state.entries.length || index === state.cursor) return state;
  return { ...state, cursor: index };
}

export function indexOfId(state: NavHistoryState, id: number): number {
  return state.entries.findIndex(e => e.id === id);
}

export function removeEntry(state: NavHistoryState, id: number): NavHistoryState {
  const idx = indexOfId(state, id);
  if (idx < 0) return state;
  const entries = state.entries.slice();
  entries.splice(idx, 1);
  let cursor = state.cursor;
  if (idx < cursor) cursor -= 1;
  else if (idx === cursor) cursor = Math.min(cursor, entries.length - 1);
  return { ...state, entries, cursor };
}

export function clear(state: NavHistoryState): NavHistoryState {
  return { entries: [], cursor: -1, nextId: state.nextId };
}

/** Entries of switched-on layers, newest first — what the tab lists. */
export function listed(state: NavHistoryState, layers: NavLayers): NavEntry[] {
  const out: NavEntry[] = [];
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const e = state.entries[i];
    if (layers[e.cause]) out.push(e);
  }
  return out;
}

export function parseLayers(raw: unknown): NavLayers {
  const out: NavLayers = { ...DEFAULT_LAYERS };
  if (raw && typeof raw === 'object') {
    for (const c of NAV_CAUSES) {
      const v = (raw as Record<string, unknown>)[c];
      if (typeof v === 'boolean') out[c] = v;
    }
  }
  return out;
}
