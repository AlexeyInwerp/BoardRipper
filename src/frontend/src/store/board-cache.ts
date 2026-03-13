import type { BoardData, Net } from '../parsers';

const DB_NAME = 'boardviewer-cache';
const DB_VERSION = 6; // bumped: fixed CAD coordinate scale, added FZ/CAD formats
const STORE_NAME = 'boards';

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
  };
}

function deserialize(data: SerializedBoardData): BoardData {
  return {
    format: data.format,
    outline: data.outline,
    parts: data.parts,
    nails: data.nails,
    nets: new Map(data.nets),
    bounds: data.bounds,
  };
}

class BoardCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        // Delete existing store on version upgrade to evict stale cached data.
        if (event.oldVersion > 0 && db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async get(fileName: string, fileSize: number, lastModified: number): Promise<BoardData | null> {
    try {
      const db = await this.openDB();
      const key = makeCacheKey(fileName, fileSize, lastModified);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => {
          const result = req.result as CachedBoard | undefined;
          resolve(result ? deserialize(result.data) : null);
        };
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
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
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(entry);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // Cache failure is non-critical
    }
  }
}

export const boardCache = new BoardCache();
