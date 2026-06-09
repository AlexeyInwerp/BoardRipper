import type { DatabankFile } from './databank-store';

/**
 * IndexedDB cache for the full /api/databank/files payload. Keyed by a stats
 * signature (`${last_file_scan_at}:${boards+pdfs}`); a cache hit means the
 * list is byte-identical to what the backend would return now, so we can
 * skip the multi-MB JSON download/parse on warm loads.
 *
 * Lives in its own database so DB version bumps for the file list cache
 * never wipe the parsed-board cache (`boardripper-cache`) and vice-versa.
 *
 * Two storage shapes coexist:
 *   - legacy `snapshot` record (one fat row with the entire file array) —
 *     written by getRaw/put, read by getRaw. Kept for backwards compat
 *     during the migration window.
 *   - chunked `meta` + `chunk:NNN` records — written by writeChunked, read
 *     by streamChunks. The streaming consumer in databank-store produces
 *     this shape and a cursor walk yields ~2k files per chunk, so the
 *     main-thread freeze on warm load disappears.
 */
const DB_NAME = 'boardripper-library-cache';
const DB_VERSION = 2;
const FILES_STORE = 'files';
const SNAPSHOT_KEY = 'snapshot';
const META_KEY = 'meta';
const CHUNK_PREFIX = 'chunk:';

interface CachedSnapshot {
  key: string;
  signature: string;
  files: DatabankFile[];
  timestamp: number;
}

interface CachedMeta {
  key: string;            // META_KEY
  signature: string;
  total: number;
  chunkSize: number;
  chunkCount: number;
  timestamp: number;
}

interface CachedChunk {
  key: string;            // CHUNK_PREFIX + zero-padded index
  index: number;
  files: DatabankFile[];
}

function chunkKey(i: number): string {
  // Pad so cursor walks in lexical order line up with numeric order — IDB
  // strings sort lexically and we don't want chunk:10 before chunk:2.
  return `${CHUNK_PREFIX}${String(i).padStart(6, '0')}`;
}

class LibraryCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (ev) => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: 'key' });
        }
        // v1 → v2: drop the legacy `snapshot` row inside this same upgrade tx
        // so warm reloads on the new schema can't hand back stale data.
        // The next streaming load will repopulate via writeChunked.
        if ((ev.oldVersion ?? 0) < 2 && req.transaction) {
          try {
            const store = req.transaction.objectStore(FILES_STORE);
            store.delete(SNAPSHOT_KEY);
          } catch { /* upgrade is best-effort */ }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { this.dbPromise = null; reject(req.error); };
      req.onblocked = () => {
        indexedDB.deleteDatabase(DB_NAME);
        this.dbPromise = null;
        reject(new Error('Library cache upgrade blocked'));
      };
    });
    return this.dbPromise;
  }

  /** Build a signature that changes whenever the indexed file set changes. */
  signatureFor(stats: { last_file_scan_at: number; boards: number; pdfs: number }): string {
    return `${stats.last_file_scan_at}:${stats.boards + stats.pdfs}`;
  }

  async get(signature: string): Promise<DatabankFile[] | null> {
    const snap = await this.getRaw();
    return snap && snap.signature === signature ? snap.files : null;
  }

  /** Read the cached snapshot without verifying its signature. Useful when
   *  the caller wants to fire IDB read in parallel with `/api/databank/stats`
   *  and validate after — instead of paying both round-trips serially. */
  async getRaw(): Promise<{ signature: string; files: DatabankFile[] } | null> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readonly');
        const req = tx.objectStore(FILES_STORE).get(SNAPSHOT_KEY);
        req.onsuccess = () => {
          const result = req.result as CachedSnapshot | undefined;
          resolve(result ? { signature: result.signature, files: result.files } : null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async put(signature: string, files: DatabankFile[]): Promise<void> {
    try {
      const db = await this.openDB();
      const entry: CachedSnapshot = {
        key: SNAPSHOT_KEY,
        signature,
        files,
        timestamp: Date.now(),
      };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readwrite');
        const req = tx.objectStore(FILES_STORE).put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // Cache failure is non-critical
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readwrite');
        const req = tx.objectStore(FILES_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // non-critical
    }
  }

  // ── Chunked storage (v2) ─────────────────────────────────────────────

  /** Read the chunked cache meta record, or null if the cache is empty /
   *  still on legacy snapshot shape. The streaming consumer pairs this with
   *  streamChunks() to walk chunks cursor-style. */
  async getMeta(): Promise<CachedMeta | null> {
    try {
      const db = await this.openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readonly');
        const req = tx.objectStore(FILES_STORE).get(META_KEY);
        req.onsuccess = () => resolve((req.result as CachedMeta | undefined) ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  /** Walk every cached chunk in order, handing each batch to `onChunk`. The
   *  caller awaits between chunks to yield the main thread (the whole point
   *  of chunking). Returns the count actually delivered. */
  async streamChunks(
    expectedSig: string,
    onChunk: (files: DatabankFile[], index: number, count: number) => void | Promise<void>,
  ): Promise<{ ok: boolean; delivered: number; total: number }> {
    const meta = await this.getMeta();
    if (!meta || meta.signature !== expectedSig) {
      return { ok: false, delivered: 0, total: meta?.total ?? 0 };
    }
    let delivered = 0;
    for (let i = 0; i < meta.chunkCount; i++) {
      try {
        const db = await this.openDB();
        const chunk = await new Promise<CachedChunk | null>((resolve, reject) => {
          const tx = db.transaction(FILES_STORE, 'readonly');
          const req = tx.objectStore(FILES_STORE).get(chunkKey(i));
          req.onsuccess = () => resolve((req.result as CachedChunk | undefined) ?? null);
          req.onerror = () => reject(req.error);
        });
        if (!chunk) {
          // Missing chunk — cache is torn, treat as miss so caller refetches.
          return { ok: false, delivered, total: meta.total };
        }
        await onChunk(chunk.files, i, meta.chunkCount);
        delivered += chunk.files.length;
      } catch {
        return { ok: false, delivered, total: meta.total };
      }
    }
    return { ok: true, delivered, total: meta.total };
  }

  /** Replace the cached snapshot with a new chunked write. Old chunks +
   *  legacy `snapshot` row are dropped in the same tx so partial state
   *  isn't observable. */
  async writeChunked(signature: string, files: DatabankFile[], chunkSize = 2048): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readwrite');
        const store = tx.objectStore(FILES_STORE);
        // Clear out the previous cache state — easier than incrementally
        // replacing N old chunks with M new ones.
        store.clear();

        const chunkCount = Math.max(1, Math.ceil(files.length / chunkSize));
        const meta: CachedMeta = {
          key: META_KEY,
          signature,
          total: files.length,
          chunkSize,
          chunkCount,
          timestamp: Date.now(),
        };
        store.put(meta);

        for (let i = 0; i < chunkCount; i++) {
          const start = i * chunkSize;
          const end = Math.min(start + chunkSize, files.length);
          const chunk: CachedChunk = {
            key: chunkKey(i),
            index: i,
            files: files.slice(start, end),
          };
          store.put(chunk);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
      });
    } catch {
      // non-critical
    }
  }

  /** Patch a single file inside the cached snapshot in place. Used after a
   *  PATCH/preview update so the warm cache survives the local edit — the
   *  alternative was `clear()`, which forced the next reload to re-download
   *  the full multi-MB list to recover one changed row.
   *
   *  No-op if the snapshot is missing or doesn't contain the id. The
   *  signature is preserved (the backend's `last_file_scan_at` doesn't move
   *  on metadata edits, so a stats match still validates the cache). */
  async patchFile(id: number, patch: Partial<DatabankFile>): Promise<void> {
    try {
      const db = await this.openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(FILES_STORE, 'readwrite');
        const store = tx.objectStore(FILES_STORE);

        // Legacy snapshot path — drained once the v1 → v2 upgrade has cleared
        // it. Keep it working so a user mid-upgrade doesn't lose patches.
        const legacyReq = store.get(SNAPSHOT_KEY);
        legacyReq.onsuccess = () => {
          const snap = legacyReq.result as CachedSnapshot | undefined;
          if (snap) {
            const idx = snap.files.findIndex(f => f.id === id);
            if (idx >= 0) {
              snap.files[idx] = { ...snap.files[idx], ...patch };
              snap.timestamp = Date.now();
              store.put(snap);
            }
          }
        };
        legacyReq.onerror = () => { /* legacy may not exist on v2 */ };

        // Chunked path — cursor through chunks until we find the file id.
        // Most patches hit at most one chunk; abort the cursor once found.
        const cursorReq = store.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const key = cursor.key as string;
          if (typeof key === 'string' && key.startsWith(CHUNK_PREFIX)) {
            const chunk = cursor.value as CachedChunk;
            const idx = chunk.files.findIndex(f => f.id === id);
            if (idx >= 0) {
              chunk.files[idx] = { ...chunk.files[idx], ...patch };
              cursor.update(chunk);
              return;
            }
          }
          cursor.continue();
        };
        cursorReq.onerror = () => { /* non-critical */ };

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('aborted'));
      });
    } catch {
      // non-critical
    }
  }
}

export const libraryCache = new LibraryCache();
