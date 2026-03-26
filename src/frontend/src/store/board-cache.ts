import type { BoardData, Net, Trace, Via } from '../parsers';

const DB_NAME = 'boardripper-cache';
const DB_VERSION = 28; // bumped: removed initialMirrorY (derived from butterflyFoldAxis)
const BOARD_STORE = 'boards';
const PDF_TEXT_STORE = 'pdf-text';

interface CachedBoard {
  key: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  timestamp: number;
  data: SerializedBoardData;
}

// BoardData uses Map which can't be stored in IndexedDB directly
interface SerializedBoardData {
  format: string;
  outline: BoardData['outline'];
  parts: BoardData['parts'];
  nails: BoardData['nails'];
  nets: Array<[string, Net]>;
  bounds: BoardData['bounds'];
  traces?: Trace[];
  vias?: Via[];
  layerNames?: string[];
  butterflyFoldAxis?: 'x' | 'y';
}

function makeCacheKey(name: string, size: number, modified: number): string {
  return `${name}:${size}:${modified}`;
}


function serialize(board: BoardData): SerializedBoardData {
  return {
    format: board.format,
    outline: board.outline,
    parts: board.parts,
    nails: board.nails,
    nets: Array.from(board.nets.entries()),
    bounds: board.bounds,
    traces: board.traces,
    vias: board.vias,
    layerNames: board.layerNames,
    butterflyFoldAxis: board.butterflyFoldAxis,
  };
}

function deserialize(data: SerializedBoardData): BoardData | null {
  if (!data || typeof data !== 'object' || !Array.isArray(data.parts)) {
    return null;
  }
  try {
    return {
      format: data.format,
      outline: data.outline,
      parts: data.parts,
      nails: data.nails,
      nets: new Map(data.nets),
      bounds: data.bounds,
      traces: data.traces,
      vias: data.vias,
      layerNames: data.layerNames,
      butterflyFoldAxis: data.butterflyFoldAxis,
    };
  } catch {
    return null;
  }
}

class BoardCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  /** Expose key construction for use by the board store */
  makeCacheKey(name: string, size: number, modified: number): string {
    return makeCacheKey(name, size, modified);
  }

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        // Delete existing stores on version upgrade to evict stale cached data.
        if (event.oldVersion > 0 && db.objectStoreNames.contains(BOARD_STORE)) {
          db.deleteObjectStore(BOARD_STORE);
        }
        if (event.oldVersion > 0 && db.objectStoreNames.contains(PDF_TEXT_STORE)) {
          db.deleteObjectStore(PDF_TEXT_STORE);
        }
        db.createObjectStore(BOARD_STORE, { keyPath: 'key' });
        db.createObjectStore(PDF_TEXT_STORE, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => {
        // Another tab holds the old DB version — delete and retry without cache
        indexedDB.deleteDatabase(DB_NAME);
        reject(new Error('IndexedDB upgrade blocked — cache cleared, please reload'));
      };
    });
    return this.dbPromise;
  }

  async get(fileName: string, fileSize: number, lastModified: number): Promise<BoardData | null> {
    try {
      const db = await this.openDB();
      const key = makeCacheKey(fileName, fileSize, lastModified);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORE, 'readonly');
        const store = tx.objectStore(BOARD_STORE);
        const req = store.get(key);
        req.onsuccess = () => {
          const result = req.result as CachedBoard | undefined;
          resolve(result ? deserialize(result.data) : null);
          // deserialize returns null on schema mismatch — caller falls back to re-parsing
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  async deleteEntry(key: string): Promise<void> {
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORE, 'readwrite');
        const req = tx.objectStore(BOARD_STORE).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // non-critical
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORE, 'readwrite');
        const req = tx.objectStore(BOARD_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // non-critical
    }
  }

  async put(fileName: string, fileSize: number, lastModified: number, board: BoardData): Promise<void> {
    try {
      const db = await this.openDB();
      const key = makeCacheKey(fileName, fileSize, lastModified);
      const entry: CachedBoard = {
        key,
        fileName,
        fileSize,
        lastModified,
        timestamp: Date.now(),
        data: serialize(board),
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORE, 'readwrite');
        const store = tx.objectStore(BOARD_STORE);
        const req = store.put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // Cache failure is non-critical
    }
  }

  // ── PDF text cache ─────────────────────────────────────────────────

  async getPdfText(fileName: string, fileSize: number, lastModified: number): Promise<{ str: string; transform: number[]; width: number; height: number }[][] | null> {
    try {
      const db = await this.openDB();
      const key = makeCacheKey(fileName, fileSize, lastModified);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_TEXT_STORE, 'readonly');
        const req = tx.objectStore(PDF_TEXT_STORE).get(key);
        req.onsuccess = () => {
          const result = req.result as { key: string; textPages: { str: string; transform: number[]; width: number; height: number }[][] } | undefined;
          resolve(result?.textPages ?? null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch { return null; }
  }

  async putPdfText(fileName: string, fileSize: number, lastModified: number, textPages: { str: string; transform: number[]; width: number; height: number }[][]): Promise<void> {
    try {
      const db = await this.openDB();
      const key = makeCacheKey(fileName, fileSize, lastModified);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_TEXT_STORE, 'readwrite');
        const req = tx.objectStore(PDF_TEXT_STORE).put({ key, textPages });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch { /* non-critical */ }
  }
}

export const boardCache = new BoardCache();
