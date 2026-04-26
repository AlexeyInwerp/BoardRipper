import type { BoardData, BoardRevision, GhostComponent, Net, Pad, Point, SilkscreenPath, Trace, Via } from '../parsers';

const DB_NAME = 'boardripper-cache';
// DB_VERSION is ONLY bumped for schema changes (new/removed object stores,
// incompatible field renames). Parser output changes are handled by the
// per-entry PARSER_VERSION constant below — a mismatch on read returns
// a cache miss, triggering a fresh parse. This lets us fix parser bugs
// without wiping every cached board on every release.
const DB_VERSION = 35;
const BOARD_STORE = 'boards';
const PDF_TEXT_STORE = 'pdf-text';
const MAX_BOARD_ENTRIES = 20;
const MAX_PDF_TEXT_ENTRIES = 30;

/**
 * Parser output version. Bump this (not DB_VERSION) whenever a format
 * parser changes its output in a way that invalidates cached BoardData.
 * Entries cached with an older version are ignored on read; only the
 * freshly-parsed board is written back at the new version. Clean
 * separation from DB_VERSION means parser fixes don't nuke the
 * pdf-text cache or require any data migration.
 */
const PARSER_VERSION = 28;

interface CachedBoard {
  key: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  timestamp: number;
  /** PARSER_VERSION at which this entry was generated. Missing = legacy pre-v0.4.5 entry. */
  parserVersion?: number;
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
  silkscreen?: SilkscreenPath[];
  pads?: Pad[];
  layerNames?: string[];
  butterflyFoldAxis?: 'x' | 'y';
  rawOutline?: Point[];
  foldComponents?: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>;
  foldInfo?: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean; source: string; summary: string };
  boardGroups?: Array<{
    components: number[];
    fold?: { dim: 'x' | 'y'; axis: number; lowerIsBottom: boolean };
    name?: string;
  }>;
  revisions?: SerializedRevision[];
  activeRevision?: number;
  ghosts?: GhostComponent[];
  parserNotes?: string[];
}

interface SerializedRevision {
  index: number;
  label: string;
  componentCount: number;
  parts: BoardRevision['parts'];
  bounds: BoardRevision['bounds'];
  outline: BoardRevision['outline'];
  nets: Array<[string, Net]>;
  ghosts: GhostComponent[];
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
    silkscreen: board.silkscreen,
    pads: board.pads,
    layerNames: board.layerNames,
    butterflyFoldAxis: board.butterflyFoldAxis,
    rawOutline: board.rawOutline,
    foldComponents: board.foldComponents,
    foldInfo: board.foldInfo,
    boardGroups: board.boardGroups,
    revisions: board.revisions?.map(r => ({
      index: r.index,
      label: r.label,
      componentCount: r.componentCount,
      parts: r.parts,
      bounds: r.bounds,
      outline: r.outline,
      nets: Array.from(r.nets.entries()),
      ghosts: r.ghosts,
    })),
    activeRevision: board.activeRevision,
    ghosts: board.ghosts,
    parserNotes: board.parserNotes,
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
      silkscreen: data.silkscreen,
      pads: data.pads,
      layerNames: data.layerNames,
      butterflyFoldAxis: data.butterflyFoldAxis,
      rawOutline: data.rawOutline,
      foldComponents: data.foldComponents,
      foldInfo: data.foldInfo,
      boardGroups: data.boardGroups,
      revisions: data.revisions?.map(r => ({
        index: r.index,
        label: r.label,
        componentCount: r.componentCount,
        parts: r.parts,
        bounds: r.bounds,
        outline: r.outline,
        nets: new Map(r.nets),
        ghosts: r.ghosts ?? [],
      })),
      activeRevision: data.activeRevision,
      ghosts: data.ghosts,
      parserNotes: data.parserNotes,
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
      req.onerror = () => { this.dbPromise = null; reject(req.error); };
      req.onblocked = () => {
        // Another tab holds the old DB version — delete and retry without cache
        indexedDB.deleteDatabase(DB_NAME);
        this.dbPromise = null; // allow retry on next access
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
          if (!result) { resolve(null); return; }
          // Miss on parser-version mismatch so the caller re-parses
          // with the current parser. Legacy entries (undefined version)
          // from before PARSER_VERSION was introduced are also rejected.
          if (result.parserVersion !== PARSER_VERSION) {
            resolve(null);
            return;
          }
          resolve(deserialize(result.data));
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

  /** Wipe the pdf-text object store only (leaves parsed boards alone). */
  async clearPdfText(): Promise<void> {
    try {
      const db = await this.openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_TEXT_STORE, 'readwrite');
        const req = tx.objectStore(PDF_TEXT_STORE).clear();
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch {
      // non-critical
    }
  }

  /** Entry counts for UI surfaces that want to show "X boards / Y pdfs cached". */
  async stats(): Promise<{ boards: number; pdfTexts: number }> {
    try {
      const db = await this.openDB();
      const count = (storeName: string): Promise<number> =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const req = tx.objectStore(storeName).count();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      const [boards, pdfTexts] = await Promise.all([
        count(BOARD_STORE),
        count(PDF_TEXT_STORE),
      ]);
      return { boards, pdfTexts };
    } catch {
      return { boards: 0, pdfTexts: 0 };
    }
  }

  /** Evict oldest entries from an object store when count exceeds max.
   *  Uses count() first to avoid deserializing all entries when under limit.
   *  Entries must have a `timestamp` (number) and `key` (string) field. */
  private async evictOldest(storeName: string, max: number): Promise<void> {
    try {
      const db = await this.openDB();
      // Quick count check — avoids getAll() in the common case
      const count: number = await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (count <= max) return;
      // Only now fetch all entries to find oldest by timestamp
      const all: { key: string; timestamp: number }[] = await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      all.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
      const toDelete = all.slice(0, all.length - max);
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      for (const entry of toDelete) store.delete(entry.key);
    } catch { /* non-critical */ }
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
        parserVersion: PARSER_VERSION,
        data: serialize(board),
      };
      return new Promise((resolve, reject) => {
        const tx = db.transaction(BOARD_STORE, 'readwrite');
        const store = tx.objectStore(BOARD_STORE);
        const req = store.put(entry);
        req.onsuccess = () => {
          this.evictOldest(BOARD_STORE, MAX_BOARD_ENTRIES);
          resolve();
        };
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
        const req = tx.objectStore(PDF_TEXT_STORE).put({ key, textPages, timestamp: Date.now() });
        req.onsuccess = () => {
          this.evictOldest(PDF_TEXT_STORE, MAX_PDF_TEXT_ENTRIES);
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    } catch { /* non-critical */ }
  }
}

export const boardCache = new BoardCache();
