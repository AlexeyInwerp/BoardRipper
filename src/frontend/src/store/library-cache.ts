import type { DatabankFile } from './databank-store';

/**
 * IndexedDB cache for the full /api/databank/files payload. Keyed by a stats
 * signature (`${last_file_scan_at}:${boards+pdfs}`); a cache hit means the
 * list is byte-identical to what the backend would return now, so we can
 * skip the multi-MB JSON download/parse on warm loads.
 *
 * Lives in its own database so DB version bumps for the file list cache
 * never wipe the parsed-board cache (`boardripper-cache`) and vice-versa.
 */
const DB_NAME = 'boardripper-library-cache';
const DB_VERSION = 1;
const FILES_STORE = 'files';
const SNAPSHOT_KEY = 'snapshot';

interface CachedSnapshot {
  key: string;
  signature: string;
  files: DatabankFile[];
  timestamp: number;
}

class LibraryCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: 'key' });
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
}

export const libraryCache = new LibraryCache();
