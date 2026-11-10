/**
 * Where worklist documents live, behind one interface:
 *
 *  - **HTTP** — the Go backend's `/api/worklists` (Docker/NAS install, and the
 *    desktop app with its MCP sidecar running).
 *  - **IPC** — the desktop app's Electron main writing `<userData>/worklists/`
 *    when no backend runs. Same directory the sidecar serves.
 *  - **none** — the lite/offline web builds: the local cache (below) is the
 *    only copy.
 *
 * Every mode also keeps a **local cache** in IndexedDB: the UI starts from it
 * at once, and an edit made while the server is unreachable is kept there,
 * marked unsent, until it can be put.
 * Spec: docs/specs/2026-11-10-worklist-storage-redesign.md.
 */
import { hasHttpBackend } from './build-mode';
import { normalizeDoc, type WorklistDoc } from './worklist-doc';

export type PutResult =
  | { ok: true; doc: WorklistDoc }
  | { conflict: true; doc: WorklistDoc }
  | { error: string };

export interface WorklistRemote {
  readonly kind: 'http' | 'ipc' | 'none';
  /** Every document changed after `since` (ms; 0 = all), tombstones included,
   *  and the time to ask from next. null = unreachable. */
  list(since: number): Promise<{ docs: WorklistDoc[]; now: number } | null>;
  put(doc: WorklistDoc): Promise<PutResult>;
}

class HttpRemote implements WorklistRemote {
  readonly kind = 'http' as const;
  async list(since: number) {
    try {
      const r = await fetch(`/api/worklists?since=${since}`, { cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json() as { docs?: unknown[]; now?: number };
      return {
        docs: (j.docs ?? []).map(normalizeDoc).filter((d): d is WorklistDoc => !!d),
        now: j.now ?? Date.now(),
      };
    } catch { return null; }
  }
  async put(doc: WorklistDoc): Promise<PutResult> {
    try {
      const r = await fetch(`/api/worklists/${encodeURIComponent(doc.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(doc),
      });
      if (r.status === 409) {
        const d = normalizeDoc(await r.json());
        return d ? { conflict: true, doc: d } : { error: 'bad conflict body' };
      }
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const d = normalizeDoc(await r.json());
      return d ? { ok: true, doc: d } : { error: 'bad response' };
    } catch (e) { return { error: String(e) }; }
  }
}

interface IpcApi {
  list(since: number): Promise<{ docs: unknown[]; now: number }>;
  put(doc: unknown): Promise<{ ok?: boolean; conflict?: boolean; doc?: unknown; error?: string }>;
}

class IpcRemote implements WorklistRemote {
  readonly kind = 'ipc' as const;
  private api: IpcApi;
  constructor(api: IpcApi) { this.api = api; }
  async list(since: number) {
    try {
      const j = await this.api.list(since);
      return { docs: j.docs.map(normalizeDoc).filter((d): d is WorklistDoc => !!d), now: j.now };
    } catch { return null; }
  }
  async put(doc: WorklistDoc): Promise<PutResult> {
    try {
      const r = await this.api.put(doc);
      const d = normalizeDoc(r.doc);
      if (r.conflict && d) return { conflict: true, doc: d };
      if (r.ok && d) return { ok: true, doc: d };
      return { error: r.error ?? 'ipc put failed' };
    } catch (e) { return { error: String(e) }; }
  }
}

/** Lite/offline: no remote. A put "succeeds" locally with the next rev, so
 *  the store runs the same code path in every mode. */
class NoRemote implements WorklistRemote {
  readonly kind = 'none' as const;
  async list() { return { docs: [], now: Date.now() }; }
  async put(doc: WorklistDoc): Promise<PutResult> {
    return { ok: true, doc: { ...doc, rev: doc.rev + 1, updatedAt: Math.max(Date.now(), doc.updatedAt + 1) } };
  }
}

export function pickRemote(): WorklistRemote {
  if (hasHttpBackend()) return new HttpRemote();
  const ipc = typeof window !== 'undefined'
    ? (window as unknown as { electronAPI?: { worklists?: IpcApi } }).electronAPI?.worklists
    : undefined;
  if (ipc) return new IpcRemote(ipc);
  return new NoRemote();
}

// ── Local cache ────────────────────────────────────────────────────────────

/** A cached document, plus whether it still has edits the remote has not
 *  accepted. */
export interface CachedDoc { doc: WorklistDoc; dirty: boolean }

const CACHE_DB = 'boardripper-worklists';
const CACHE_STORE = 'docs';

let dbp: Promise<IDBDatabase> | null = null;
function cacheDb(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(CACHE_STORE)) req.result.createObjectStore(CACHE_STORE, { keyPath: 'doc.id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

export async function cacheLoadAll(): Promise<CachedDoc[]> {
  try {
    const db = await cacheDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).getAll();
      req.onsuccess = () => resolve(((req.result ?? []) as CachedDoc[])
        .map(c => { const d = normalizeDoc(c?.doc); return d ? { doc: d, dirty: !!c.dirty } : null; })
        .filter((c): c is CachedDoc => !!c));
      req.onerror = () => reject(req.error);
    });
  } catch { return []; }
}

export async function cachePut(items: CachedDoc[]): Promise<void> {
  if (!items.length) return;
  try {
    const db = await cacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE, 'readwrite');
      const st = tx.objectStore(CACHE_STORE);
      for (const it of items) st.put(it);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* cache is best effort */ }
}
