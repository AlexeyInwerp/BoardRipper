/**
 * Per-file view-preference persistence.
 *
 * Auto-rotation + auto-mirror heuristics work for most boards but fail on
 * specific files where the underlying format stores geometry in an
 * unconventional frame (e.g. XZZ X-fold variants where the bottom-half
 * coordinate winding doesn't match the dominant Apple-MLB convention).
 * Chasing the heuristic regresses other files. Instead, the user can
 * correct the orientation once via the rotate / flip toolbar buttons; we
 * persist their choice keyed by the file's identity (name + size +
 * lastModified) so the same file always re-opens correctly on this
 * machine.
 *
 * Decoupled from `board-cache`:
 *   - board-cache persists parsed BoardData (heavy, can be rebuilt by
 *     re-parsing the file). Versioned via PARSER_VERSION.
 *   - file-view-prefs persists USER intent (tiny, must NEVER be lost on a
 *     parser bump). Schema-versioned via DB_VERSION below; should rarely
 *     change.
 *
 * The override fields are nullable, with the convention:
 *   undefined → no user override; auto-detected value wins
 *   number    → user-set rotation in degrees; overrides auto-rotation
 *   boolean   → user-set mirror state; overrides auto-mirror
 */

const DB_NAME = 'boardripper-file-view-prefs';
const STORE_NAME = 'prefs';
const DB_VERSION = 1;

export interface FileViewPrefs {
  /** Composite key: `${name}:${size}:${lastModified}`. */
  fileKey: string;
  /** Absolute rotation in degrees (0/90/180/270 or freely set). */
  rotation?: number;
  /** Mirror around screen X axis. */
  mirrorX?: boolean;
  /** Mirror around screen Y axis. */
  mirrorY?: boolean;
  /** Flip axis ('x'/'y') for the renderer's side-flip handler. Saved
   *  alongside rotation since rotateCW updates both — keeps them in sync
   *  on next open. Optional; if absent, the load path leaves the
   *  auto-derived value. */
  flipAxis?: 'x' | 'y';
  /** Wall-clock ms of last update — for debugging / future cleanup. */
  updatedAt: number;
}

function makeFileKey(name: string, size: number, modified: number): string {
  return `${name}:${size}:${modified}`;
}

class FileViewPrefsStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDb(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'fileKey' });
        }
      };
    });
    return this.dbPromise;
  }

  /** Read the saved overrides for a file. Returns `null` when no entry
   *  exists. Resolves to `null` (not rejects) on any IDB failure so the
   *  load path always continues. */
  async get(name: string, size: number, modified: number): Promise<FileViewPrefs | null> {
    try {
      const db = await this.openDb();
      const key = makeFileKey(name, size, modified);
      return await new Promise<FileViewPrefs | null>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
      });
    } catch {
      return null;
    }
  }

  /** Upsert overrides. Pass `undefined` for any field the caller doesn't
   *  want to change; the existing value (if any) is preserved by being
   *  re-read from disk first. Resolves silently on IDB failure. */
  async put(
    name: string,
    size: number,
    modified: number,
    patch: Partial<Omit<FileViewPrefs, 'fileKey' | 'updatedAt'>>,
  ): Promise<void> {
    try {
      const db = await this.openDb();
      const key = makeFileKey(name, size, modified);
      // Merge with existing record so a single-field update doesn't wipe
      // unrelated overrides.
      const existing = await this.get(name, size, modified);
      const merged: FileViewPrefs = {
        ...(existing ?? { fileKey: key, updatedAt: 0 }),
        ...patch,
        fileKey: key,
        updatedAt: Date.now(),
      };
      // Drop undefined fields so they don't shadow the existing values on
      // a subsequent merge (JSON IDB stores undefined as missing anyway,
      // but explicit `undefined` in JS is annoying to reason about).
      (Object.keys(merged) as Array<keyof FileViewPrefs>).forEach((k) => {
        if (merged[k] === undefined) delete merged[k];
      });
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(merged);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* swallow — overrides are a convenience, not a correctness gate */
    }
  }

  /** Remove all saved overrides for a file (used by a hypothetical "reset
   *  orientation" UI). Resolves silently on IDB failure. */
  async clear(name: string, size: number, modified: number): Promise<void> {
    try {
      const db = await this.openDb();
      const key = makeFileKey(name, size, modified);
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      });
    } catch {
      /* swallow */
    }
  }
}

export const fileViewPrefsStore = new FileViewPrefsStore();
