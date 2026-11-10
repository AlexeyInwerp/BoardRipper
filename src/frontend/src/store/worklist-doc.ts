/**
 * The worklist as a document of its own — what is stored on the server, in
 * the desktop app's `worklists/` folder and in the lite build's IndexedDB
 * (docs/specs/2026-11-10-worklist-storage-redesign.md). Pure: no stores, no
 * DOM, so the merge and the migration are unit-tested directly.
 *
 * Only what the user wrote is stored. Whether a part or net is on a given
 * board is answered when the worklist is shown on that board, never saved —
 * so nothing in here goes stale when the same worklist is loaded onto
 * another board.
 */
import type { WorklistMark, NetWorklistMark, NetMeasurements, WorklistMessage } from './worklist-store';

export interface StoredPart {
  refdes: string;
  mark: WorklistMark;
  note: string;
  waterdamage?: boolean;
  /** Last change to this row (ms). The merge keeps the newer row. */
  at: number;
  /** Tombstone: removed at this time. Kept so a merge cannot bring it back. */
  removed?: number;
}

export interface StoredNet {
  netName: string;
  mark: NetWorklistMark;
  note: string;
  surge?: boolean;
  measurements?: NetMeasurements;
  at: number;
  removed?: number;
}

export interface WorklistOrigin {
  fileName: string;
  boardNumber?: string;
  fileId?: number;
}

export interface WorklistDoc {
  id: string;
  /** Server revision this copy is based on; 0 = never stored. */
  rev: number;
  createdAt: number;
  /** Server-stamped on store (local time until then). */
  updatedAt: number;
  name: string;
  /** The board name this worklist is attributed to ("820-02016"). Editable. */
  board: string;
  /** Free tags, set by hand ("A2337", "water"). */
  tags: string[];
  note?: string;
  entries: StoredPart[];
  netEntries: StoredNet[];
  messages?: WorklistMessage[];
  aiOrigin?: Record<string, true>;
  /** Where it was started. Shown; never matched on by itself. */
  origin?: WorklistOrigin;
  /** Last change to name / board / tags / note. */
  metaAt: number;
  /** Tombstone time. */
  deleted?: number;
}

export function newWorklistId(): string {
  return 'wl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function newDoc(name: string, board: string, origin?: WorklistOrigin, now = Date.now()): WorklistDoc {
  return {
    id: newWorklistId(), rev: 0, createdAt: now, updatedAt: now,
    name, board, tags: [], entries: [], netEntries: [], metaAt: now,
    ...(origin ? { origin } : {}),
  };
}

/** Case-insensitive row keys — refdes and net names compare without case. */
export const partKey = (p: { refdes: string }) => p.refdes.toUpperCase();
export const netKey = (n: { netName: string }) => n.netName.toUpperCase();

const rowAt = (r: { at: number; removed?: number }) => Math.max(r.at || 0, r.removed || 0);

function mergeRows<T extends { at: number; removed?: number }>(
  a: readonly T[], b: readonly T[], key: (r: T) => string, combine?: (win: T, lose: T) => T,
): T[] {
  const out = new Map<string, T>();
  const order: string[] = [];
  for (const list of [a, b]) {
    for (const r of list) {
      const k = key(r);
      const cur = out.get(k);
      if (!cur) { out.set(k, r); order.push(k); continue; }
      const [win, lose] = rowAt(r) > rowAt(cur) ? [r, cur] : [cur, r];
      out.set(k, combine ? combine(win, lose) : win);
    }
  }
  return order.map(k => out.get(k)!);
}

/** Readings merge per kind, newest `at` wins; the rest of a net row comes
 *  from whichever side changed it last. */
function combineNets(win: StoredNet, lose: StoredNet): StoredNet {
  if (!win.measurements && !lose.measurements) return win;
  const m: NetMeasurements = { ...(lose.measurements ?? {}) };
  for (const [k, v] of Object.entries(win.measurements ?? {})) {
    const kind = k as keyof NetMeasurements;
    if (v && (!m[kind] || (m[kind]!.at ?? 0) <= (v.at ?? 0))) m[kind] = v;
  }
  return { ...win, ...(Object.keys(m).length ? { measurements: m } : {}) };
}

/**
 * Merge two copies of one worklist — a local copy with unsent edits and the
 * server's newer one (a 409, or a poll while editing). Row by row the newer
 * change wins, removals included; readings merge per kind; name, board, tags
 * and note come from the side that changed them last; messages are a union.
 * The result carries the server's rev, ready to be put again.
 */
export function mergeDocs(local: WorklistDoc, server: WorklistDoc): WorklistDoc {
  const meta = (local.metaAt || 0) > (server.metaAt || 0) ? local : server;
  const msgs = new Map<string, WorklistMessage>();
  for (const m of [...(server.messages ?? []), ...(local.messages ?? [])]) {
    const cur = msgs.get(m.id);
    // A message read on either side stays read.
    msgs.set(m.id, cur ? { ...cur, ...(cur.unread && m.unread ? {} : { unread: undefined }) } : m);
  }
  const messages = [...msgs.values()].map(m => { const c = { ...m }; if (!c.unread) delete c.unread; return c; })
    .sort((a, b) => a.at - b.at);
  const deleted = Math.max(local.deleted ?? 0, server.deleted ?? 0);
  const out: WorklistDoc = {
    ...server,
    createdAt: Math.min(local.createdAt || Infinity, server.createdAt || Infinity),
    name: meta.name, board: meta.board, tags: [...meta.tags], metaAt: meta.metaAt,
    entries: mergeRows(server.entries, local.entries, partKey),
    netEntries: mergeRows(server.netEntries, local.netEntries, netKey, combineNets),
    rev: server.rev,
    updatedAt: Math.max(local.updatedAt, server.updatedAt),
  };
  if (meta.note) out.note = meta.note; else delete out.note;
  if (messages.length) out.messages = messages; else delete out.messages;
  const ai = { ...(server.aiOrigin ?? {}), ...(local.aiOrigin ?? {}) };
  if (Object.keys(ai).length) out.aiOrigin = ai; else delete out.aiOrigin;
  if (deleted) out.deleted = deleted; else delete out.deleted;
  if (!out.origin && local.origin) out.origin = local.origin;
  return out;
}

/** Fill in fields a document from another writer (or an older version) may
 *  lack, so readers can rely on them. Never throws on junk. */
export function normalizeDoc(raw: unknown): WorklistDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Partial<WorklistDoc>;
  if (typeof d.id !== 'string' || !d.id) return null;
  const now = Date.now();
  return {
    ...d,
    id: d.id,
    rev: typeof d.rev === 'number' ? d.rev : 0,
    createdAt: d.createdAt ?? now,
    updatedAt: d.updatedAt ?? now,
    name: typeof d.name === 'string' ? d.name : 'Worklist',
    board: typeof d.board === 'string' ? d.board : '',
    tags: Array.isArray(d.tags) ? d.tags.filter((t): t is string => typeof t === 'string') : [],
    entries: Array.isArray(d.entries) ? d.entries.map(e => ({ ...e, at: e.at ?? 0 })) : [],
    netEntries: Array.isArray(d.netEntries) ? d.netEntries.map(e => ({ ...e, at: e.at ?? 0 })) : [],
    metaAt: d.metaAt ?? 0,
  } as WorklistDoc;
}

/** The board name a new worklist starts with: the library's board number,
 *  else the number in the file name, else the file name without extension. */
export function defaultBoardName(fileName: string, boardNumber: string | null | undefined): string {
  if (boardNumber && boardNumber.trim()) return boardNumber.trim();
  return fileName.replace(/\.[^.]+$/, '').trim() || fileName;
}

/** Shape of one per-file record in the old (v1) IndexedDB store. */
export interface LegacyBoardRecord {
  key: string;
  fileName: string;
  activeWorklistId: string | null;
  worklistes?: Array<{
    id: string; name: string; createdAt?: number; updatedAt?: number; note?: string;
    entries?: Array<{ refdes: string; mark: WorklistMark; note: string; waterdamage?: boolean }>;
    netEntries?: Array<{ netName: string; mark: NetWorklistMark; note: string; surge?: boolean; measurements?: NetMeasurements }>;
    messages?: WorklistMessage[];
    aiOrigin?: Record<string, true>;
  }>;
}

/**
 * Turn one old per-file record into documents, keeping each worklist's id
 * (so a second import of the same record is recognisably the same worklist,
 * not a duplicate). `boardOf` names the board from the record's file.
 */
export function docsFromLegacy(rec: LegacyBoardRecord, boardOf: (fileName: string) => string): WorklistDoc[] {
  const board = boardOf(rec.fileName);
  return (rec.worklistes ?? []).map(w => {
    const t = w.updatedAt ?? w.createdAt ?? Date.now();
    const doc: WorklistDoc = {
      id: w.id, rev: 0,
      createdAt: w.createdAt ?? t, updatedAt: t,
      name: w.name || 'Worklist', board, tags: [], metaAt: t,
      origin: { fileName: rec.fileName },
      entries: (w.entries ?? []).map(e => ({
        refdes: e.refdes, mark: e.mark ?? 'none', note: e.note ?? '', at: t,
        ...(e.waterdamage ? { waterdamage: true } : {}),
      })),
      netEntries: (w.netEntries ?? []).map(n => {
        // v0.31-era records carry one `measurement` instead of the per-kind map.
        const single = (n as { measurement?: NetMeasurements[keyof NetMeasurements] }).measurement;
        const measurements = n.measurements ?? (single ? { [single.kind]: single } as NetMeasurements : undefined);
        return {
          netName: n.netName, mark: n.mark ?? 'none', note: n.note ?? '', at: t,
          ...(n.surge ? { surge: true } : {}),
          ...(measurements ? { measurements } : {}),
        };
      }),
    };
    if (w.note) doc.note = w.note;
    if (w.messages?.length) doc.messages = w.messages;
    if (w.aiOrigin) doc.aiOrigin = w.aiOrigin;
    return doc;
  });
}
