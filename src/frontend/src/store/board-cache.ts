import type { BoardData, BoardRevision, BomAlternateCluster, DiodeReferenceChannel, GhostComponent, Net, Pad, Point, SilkscreenPath, Trace, Via } from '../parsers';

const DB_NAME = 'boardripper-cache';
// DB_VERSION is ONLY bumped for schema changes (new/removed object stores,
// incompatible field renames). Parser output changes are handled by the
// per-entry PARSER_VERSION constant below — a mismatch on read returns
// a cache miss, triggering a fresh parse. This lets us fix parser bugs
// without wiping every cached board on every release.
// 36: pdf-bytes store added (session restore of locally-opened PDFs).
const DB_VERSION = 36;
const BOARD_STORE = 'boards';
const PDF_TEXT_STORE = 'pdf-text';
// Raw bytes of PDFs opened from the local picker / drop. Exists for one
// reason: `restoreSession` could bring a board back from the board cache but
// had nothing to bring a PDF back from ("local-drop PDF with no databank
// entry → no binary cache"), so on a tablet — where the OS discards background
// tabs routinely — the schematic vanished on every reload. Bounded by count
// AND bytes: schematics run 5–50 MB and Safari's storage budget is finite.
const PDF_BYTES_STORE = 'pdf-bytes';
const MAX_BOARD_ENTRIES = 20;
const MAX_PDF_TEXT_ENTRIES = 30;
const MAX_PDF_BYTES_ENTRIES = 6;
const MAX_PDF_BYTES_TOTAL = 256 * 1024 * 1024;

/**
 * Parser output version. Bump this (not DB_VERSION) whenever a format
 * parser changes its output in a way that invalidates cached BoardData.
 * Entries cached with an older version are ignored on read; only the
 * freshly-parsed board is written back at the new version. Clean
 * separation from DB_VERSION means parser fixes don't nuke the
 * pdf-text cache or require any data migration.
 */
// 73: XZZ diode-value channel — parser preserves real pad numbers and joins
//     the post-v6 diode reading table onto pins (Pin.diode + diodeReference).
// 74: cache serialize/deserialize now persist diodeReference (v73 stripped it,
//     so the on-pin overlay's UI vanished on cache hit) — bust those entries.
// 75: GenCAD parser collapses consecutive byte-identical COMPONENT records
//     (Mentor/CAMCAD per-device-record exports), fixing an N² pin explosion
//     that OOM'd on load (e.g. ASUS FA506QR_..._MB1501.cad → 9.1M pins).
// 76: GenCAD parser skips shape-recentering for world-coordinate-shape exports
//     (TESTCAD/IMPACT ASUS boards); recentering was crushing the board to a
//     fraction of its size and rendering components 5-50× oversized.
// 77: BDV parser derives part origin/bounds from pins when the file supplies
//     all-zero part corners (ASUS X540 60NB0HF0 writer stores `0 0 0 0` for
//     every part); previously every part's label collapsed to (0,0) and its
//     outline stretched from its pins to the origin, misaligning all silk
//     elements from the correctly-placed pins.
// 78: audit 2026-07-07 parser-output changes — CAD honours the GenCAD UNITS
//     directive (non-mils files rescaled to mils; M16); Part.angleDeg now
//     populated by TVW/Mentor/FZ for oriented selection boxes (M8); Part.type
//     widened to include 'unknown' and no-signal parsers stop claiming 'smd'
//     (L5); Allegro v16/17/18 derive through-hole part.type from padstacks (L7).
// 79: XZZ placeholder pad-geometry guard — M2-era exports write uniform
//     12×12 mil round geometry on every pin; parser now drops it (pins/pads
//     fall back to classic synthesized look) instead of drawing 12-mil dots
//     on 125-mil coil pads.
// 80: XZZ diode table `=0=` records reclassified 'none' → 'value' (mv=0):
//     a measured short is a real reading XZZ's viewer draws; on connector
//     diode maps zeros are the majority (776/1144 on 820-03097), so cached
//     boards from v79 hide most of the table.
// 81: XZZ oblong-pad plausibility guard (normalizeOblongPads) — shape 0x01
//     with w ≠ h is a round-capped stroke; implausible lengths (BGA
//     perimeter stubs on PL5TU1B CPU1, 15×300/350 covering neighbouring
//     balls) and degenerate strokes (h ≤ w) collapse to pen-width dots.
// 82: ALTIUM_PCB parser added — Altium Designer / Circuit Maker / Circuit
//     Studio .PcbDoc (binary CFB + PCB ASCII v5.0). Parts/pins/nets/outline
//     plus tracks/vias/arcs/fills; Regions6 copper pours surface through the
//     existing BoardData.surfaces channel.
// 83: CAD (GenCAD) pin radius now derived from the file's own $PADS/$PADSTACKS
//     geometry instead of a fixed 6-mil constant. Fixes exports with no
//     $HEADER UNITS record (TESTCAD/IMPACT family — GV302XI, X415JA), whose
//     native coordinate unit is finer than a mil, so 6-mil pins rendered far
//     smaller than their own labels. Padstacks pick the smallest outer-copper
//     pad, which also drops the oversized residue entries that concatenated
//     multi-pass exports (7523v10, V382_20) leak into a stack.
// 84: XZZ parser reads the part's 0x06 body label into Part.meta.value, so
//     exporters that write a component value there (MSI) show one in the Info
//     pane. Boards whose label channel is placeholder text (Apple's serialised
//     Device1/Device2/…) drop it board-wide and are unchanged.
// 85: XZZ through-hole drill decoded (Pin.drill / Pad.drill / Part.type), and
//     the oblong-pad guard is axis-symmetric — the pen is min(w, h), so
//     capsules with the pen on the W axis stop collapsing into fat round dots.
// 86: XZZ outline no longer loses its rounded corners in the butterfly fold —
//     the duplicate-edge guard was deleting every arc-sampled fillet, cutting
//     the outline loop open (18 open fragments on A2485-820-02100-A). Cached
//     boards hold the broken geometry and must re-parse.
// 87: BDV ASC reads the two sections only the plain-file delivery ships —
//     parts.asc (part rotation + package name) and nets.asc — and net names
//     that contain spaces ("3D VISION") are no longer truncated at the first
//     token on both pins and nails. Cached ASC boards hold the old, thinner
//     parts and the split net names.
// 88: FZ content splits on bare CR (classic-Mac) endings, not just LF/CRLF.
//     A CR-only export inflated fine but yielded one giant "line", so no record
//     was ever read and the board died on "contains no parts or pins" (canary:
//     XPS 15 9530 Compal HD055 LA-L663P). Those files never cached — they threw
//     — but a mixed-ending file could have cached a partial board, so re-parse.
// 93: Allegro — every change from the v0.39.1/v0.39.2 round invalidates a
//     cached board, and v0.39.1 shipped WITHOUT this bump, so any install that
//     had already opened an Allegro board kept serving the pre-fix parse and
//     never saw the fix at all. Covers: the ETCH subclass rebasing (top and
//     bottom copper were merged onto one layer index, and every layer above
//     them sat one name out of step); copper pours, which were not read at all;
//     and components recovered from dangling routing, which add parts that
//     simply are not present in an older cached BoardData.
const PARSER_VERSION = 93;

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
  formatVersion?: string;
  outline: BoardData['outline'];
  parts: BoardData['parts'];
  nails: BoardData['nails'];
  nets: Array<[string, Net]>;
  bounds: BoardData['bounds'];
  traces?: Trace[];
  vias?: Via[];
  silkscreen?: SilkscreenPath[];
  pads?: Pad[];
  /** Copper-fill polygons (ground planes, power pours) — added in PARSER_VERSION 69.
   *  Missing on cache entries serialised before that version, which is fine
   *  because PARSER_VERSION mismatch rejects them anyway and a re-parse re-
   *  emits surfaces. */
  surfaces?: BoardData['surfaces'];
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
  boards?: BoardData['boards'];
  revisions?: SerializedRevision[];
  activeRevision?: number;
  ghosts?: GhostComponent[];
  bomClusters?: BomAlternateCluster[];
  parserNotes?: string[];
  flipY?: boolean;
  flipAxis?: 'x' | 'y';
  primarySide?: 'top' | 'bottom';
  /** XZZ diode-value channel descriptor — added in PARSER_VERSION 74. Gates the
   *  on-pin diode overlay's UI; pin-level readings live inside `parts`. */
  diodeReference?: DiodeReferenceChannel;
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
  bomClusters?: BomAlternateCluster[];
}

function makeCacheKey(name: string, size: number, modified: number): string {
  return `${name}:${size}:${modified}`;
}


function serialize(board: BoardData): SerializedBoardData {
  return {
    format: board.format,
    formatVersion: board.formatVersion,
    outline: board.outline,
    parts: board.parts,
    nails: board.nails,
    nets: Array.from(board.nets.entries()),
    bounds: board.bounds,
    traces: board.traces,
    vias: board.vias,
    silkscreen: board.silkscreen,
    pads: board.pads,
    surfaces: board.surfaces,
    layerNames: board.layerNames,
    butterflyFoldAxis: board.butterflyFoldAxis,
    rawOutline: board.rawOutline,
    foldComponents: board.foldComponents,
    foldInfo: board.foldInfo,
    boardGroups: board.boardGroups,
    boards: board.boards,
    revisions: board.revisions?.map(r => ({
      index: r.index,
      label: r.label,
      componentCount: r.componentCount,
      parts: r.parts,
      bounds: r.bounds,
      outline: r.outline,
      nets: Array.from(r.nets.entries()),
      ghosts: r.ghosts,
      bomClusters: r.bomClusters,
    })),
    activeRevision: board.activeRevision,
    ghosts: board.ghosts,
    bomClusters: board.bomClusters,
    parserNotes: board.parserNotes,
    flipY: board.flipY,
    flipAxis: board.flipAxis,
    primarySide: board.primarySide,
    diodeReference: board.diodeReference,
  };
}

function deserialize(data: SerializedBoardData): BoardData | null {
  if (!data || typeof data !== 'object' || !Array.isArray(data.parts)) {
    return null;
  }
  try {
    return {
      format: data.format,
      formatVersion: data.formatVersion,
      outline: data.outline,
      parts: data.parts,
      nails: data.nails,
      nets: new Map(data.nets),
      bounds: data.bounds,
      traces: data.traces,
      vias: data.vias,
      silkscreen: data.silkscreen,
      pads: data.pads,
      surfaces: data.surfaces,
      layerNames: data.layerNames,
      butterflyFoldAxis: data.butterflyFoldAxis,
      rawOutline: data.rawOutline,
      foldComponents: data.foldComponents,
      foldInfo: data.foldInfo,
      boardGroups: data.boardGroups,
      boards: data.boards,
      revisions: data.revisions?.map(r => ({
        index: r.index,
        label: r.label,
        componentCount: r.componentCount,
        parts: r.parts,
        bounds: r.bounds,
        outline: r.outline,
        nets: new Map(r.nets),
        ghosts: r.ghosts ?? [],
        bomClusters: r.bomClusters,
      })),
      activeRevision: data.activeRevision,
      ghosts: data.ghosts,
      bomClusters: data.bomClusters,
      parserNotes: data.parserNotes,
      flipY: data.flipY,
      flipAxis: data.flipAxis,
      primarySide: data.primarySide,
      diodeReference: data.diodeReference,
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
        if (event.oldVersion > 0 && db.objectStoreNames.contains(PDF_BYTES_STORE)) {
          db.deleteObjectStore(PDF_BYTES_STORE);
        }
        db.createObjectStore(BOARD_STORE, { keyPath: 'key' });
        db.createObjectStore(PDF_TEXT_STORE, { keyPath: 'key' });
        db.createObjectStore(PDF_BYTES_STORE, { keyPath: 'key' });
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

  /** Raw bytes of a locally-opened PDF, or null. Same key scheme as the text
   *  cache so one (name, size, mtime) triple addresses both. */
  async getPdfBytes(fileName: string, fileSize: number, lastModified: number): Promise<ArrayBuffer | null> {
    try {
      const db = await this.openDB();
      const key = `${fileName}:${fileSize}:${lastModified}`;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(PDF_BYTES_STORE, 'readonly');
        const req = tx.objectStore(PDF_BYTES_STORE).get(key);
        req.onsuccess = () => resolve(req.result?.bytes ?? null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  }

  /** Store a locally-opened PDF's bytes for session restore. Refuses a single
   *  file over the total budget (it could never be kept anyway), then evicts
   *  oldest-first until both the count and the byte caps hold. */
  async putPdfBytes(fileName: string, fileSize: number, lastModified: number, bytes: ArrayBuffer): Promise<void> {
    if (bytes.byteLength > MAX_PDF_BYTES_TOTAL) return;
    try {
      const db = await this.openDB();
      const key = `${fileName}:${fileSize}:${lastModified}`;
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(PDF_BYTES_STORE, 'readwrite');
        const req = tx.objectStore(PDF_BYTES_STORE).put({ key, bytes, size: bytes.byteLength, timestamp: Date.now() });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      await this.evictPdfBytes();
    } catch {
      // Storage full / blocked — the PDF still opens, it just won't survive a reload.
    }
  }

  private async evictPdfBytes(): Promise<void> {
    const db = await this.openDB();
    const all: { key: string; size: number; timestamp: number }[] = await new Promise((resolve, reject) => {
      const tx = db.transaction(PDF_BYTES_STORE, 'readonly');
      const req = tx.objectStore(PDF_BYTES_STORE).getAll();
      // getAll() would also pull the bytes; a keyed cursor is cheaper but this
      // store never holds more than a handful of entries.
      req.onsuccess = () => resolve(req.result.map((r: { key: string; size?: number; bytes?: ArrayBuffer; timestamp?: number }) =>
        ({ key: r.key, size: r.size ?? r.bytes?.byteLength ?? 0, timestamp: r.timestamp ?? 0 })));
      req.onerror = () => reject(req.error);
    });
    all.sort((a, b) => a.timestamp - b.timestamp);
    let total = all.reduce((n, e) => n + e.size, 0);
    const doomed: string[] = [];
    while (all.length > 0 && (all.length > MAX_PDF_BYTES_ENTRIES || total > MAX_PDF_BYTES_TOTAL)) {
      const e = all.shift()!;
      doomed.push(e.key);
      total -= e.size;
    }
    if (doomed.length === 0) return;
    const tx = db.transaction(PDF_BYTES_STORE, 'readwrite');
    const store = tx.objectStore(PDF_BYTES_STORE);
    for (const k of doomed) store.delete(k);
  }
}

export const boardCache = new BoardCache();
