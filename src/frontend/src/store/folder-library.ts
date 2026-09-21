/**
 * Local-folder library — a third producer for `databankStore._files`,
 * alongside the Go backend (`/api/databank/files`) and Electron IPC
 * (`scanLibrary`). It exists for the builds that have neither: the lite web
 * build and the offline single-file build.
 *
 * Two browser APIs, feature-detected, never both:
 *
 * - **`showDirectoryPicker()`** (Chromium) hands back a live
 *   `FileSystemDirectoryHandle`. It survives a reload — the handle is
 *   structured-cloneable, so it goes into IndexedDB and comes back with its
 *   permission intact (or one click away from it), and every open reads the
 *   bytes that are on disk *now*.
 * - **`<input type="file" webkitdirectory>`** (everything else, including
 *   Firefox, Safari, iOS Safari 18.4+ and `file://`) hands back a one-shot
 *   `FileList` of the whole tree. The `File` objects are readable for the
 *   life of the page but cannot be revived after a reload.
 *
 * What survives a reload in *both* cases is the **index** (this module
 * persists the scanned `DatabankFile[]` + folder tree in IndexedDB), so the
 * library still lists on the next visit. In `input` mode the entry is then
 * `detached`: you can browse and search it, and opening a file asks for the
 * folder again. That split — an index that persists separately from the
 * bytes — is what keeps the library usable on a tablet, where the page is
 * discarded from memory constantly.
 *
 * Scanning is deliberately cheap: extension sniff + filename board number,
 * no board parsing. That is what the Electron producer does too, and it is
 * what makes a few thousand files a sub-second job instead of a minute.
 */

import type { DatabankFile, FolderNode } from './databank-store';
import { detectByExtension, detectFormat, getAllExtensions, getAllFormats, getFileExtension } from '../parsers/registry';
import { extractBoardNumberFromFilename } from './board-number';
import { log } from './log-store';

// ── File System Access typings ───────────────────────────────────────────
// Declared structurally rather than relying on lib.dom: `showDirectoryPicker`
// and the permission methods are not in TypeScript's DOM library, and
// `FileSystemDirectoryHandle.values()` needs the separate DOM.AsyncIterable
// lib this project does not enable.

interface FsFileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
}

interface FsDirectoryHandle {
  kind: 'directory';
  name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirectoryHandle>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

/** The pre-File-System-Access drag-and-drop tree API. Still the only way to
 *  read a dropped folder in Firefox and Safari, and lib.dom's own
 *  `FileSystemDirectoryEntry` types are awkward enough (callback-based,
 *  `readEntries` batching) that a local shape is clearer. */
interface DropFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file(onSuccess: (f: File) => void, onError?: (e: unknown) => void): void;
}

interface DropDirectoryEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader(): { readEntries(cb: (entries: DropEntry[]) => void, onError?: (e: unknown) => void): void };
}

type DropEntry = DropFileEntry | DropDirectoryEntry;

/** What a drop hands over, captured synchronously — `DataTransferItem`s are
 *  neutered the moment the drop handler yields. */
export interface CapturedDrop {
  handle: Promise<FsDirectoryHandle | null> | null;
  entry: DropDirectoryEntry | null;
}

/** Must be called INSIDE the drop handler, before any `await`. Returns null
 *  when the drop contains no folder. */
export function captureDroppedFolder(dt: DataTransfer): CapturedDrop | null {
  const items = dt.items;
  if (!items) return null;
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue;
    const withHandle = item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FsDirectoryHandle | FsFileHandle | null> };
    // Cast through unknown: lib.dom types this as FileSystemEntry, whose
    // directory branch does not carry createReader.
    const legacy = (item.webkitGetAsEntry?.() ?? null) as unknown as DropEntry | null;
    // webkitGetAsEntry is the only synchronous way to know it IS a directory;
    // the handle (Chromium) is what makes it persist, so take both.
    if (!legacy || !legacy.isDirectory) continue;
    const handle = typeof withHandle.getAsFileSystemHandle === 'function'
      ? withHandle.getAsFileSystemHandle().then(h => (h && h.kind === 'directory' ? h : null)).catch(() => null)
      : null;
    return { handle, entry: legacy };
  }
  return null;
}

type DirectoryPicker = (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FsDirectoryHandle>;

function directoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const fn = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  // A cross-origin iframe or an insecure context exposes the name but throws
  // on call; treat only a secure top-level context as supported.
  if (typeof fn !== 'function' || !window.isSecureContext) return null;
  return fn;
}

// ── Public state ─────────────────────────────────────────────────────────

export type FolderPickMode = 'handle' | 'input' | 'none';

/** `active` = files can be read. `detached` = the index is loaded but the
 *  bytes are not reachable until the user re-grants (handle mode) or
 *  re-picks (input mode). */
export type FolderLibraryState =
  | { kind: 'none' }
  | { kind: 'active'; rootName: string; mode: 'handle' | 'input' }
  | { kind: 'detached'; rootName: string; reason: 'permission' | 'repick' };

/** Why a pick produced no library. `cancelled` is the user's own doing (and
 *  also how the browser reports a folder it refuses to open); `fallback`
 *  means: use the `webkitdirectory` input instead. */
export type PickResult =
  | { ok: true; scan: FolderScan }
  | { ok: false; reason: 'cancelled' | 'blocked' | 'fallback' | 'unsupported' | 'error'; error?: unknown };

export interface FolderScan {
  rootName: string;
  files: DatabankFile[];
  tree: FolderNode;
  durationMs: number;
}

export interface ScanProgress {
  /** Directory entries visited so far (files of every kind). */
  scanned: number;
  /** Board + PDF files kept. */
  matched: number;
  /** Most recent path, for the progress strip. */
  current: string;
}

/** How the user can hand over a folder in this browser. */
export function folderPickMode(): FolderPickMode {
  if (typeof document === 'undefined') return 'none';
  if (directoryPicker()) return 'handle';
  return 'webkitdirectory' in document.createElement('input') ? 'input' : 'none';
}

// ── Scanning ─────────────────────────────────────────────────────────────

/** Guard against someone handing us their home directory. */
const MAX_ENTRIES = 200_000;
/** Yield to the event loop at least this often so the UI keeps painting. */
const YIELD_MS = 50;

const PDF_EXT = '.pdf';

function boardExtensions(): Set<string> {
  return new Set(getAllExtensions().map(e => e.toLowerCase()));
}

function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i).toLowerCase() : '';
}

function classify(name: string, boardExts: Set<string>): 'board' | 'pdf' | null {
  const ext = fileExt(name);
  if (ext === PDF_EXT) return 'pdf';
  return boardExts.has(ext) ? 'board' : null;
}

/** File ids must survive a rescan: recent-files entries, worklist rows and
 *  session restore all persist them. Position in the walk does not survive
 *  (one added file renumbers everything after it), so the id is a hash of
 *  the relative path, probed forward on the rare collision. */
function allocId(relPath: string, used: Set<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < relPath.length; i++) {
    h ^= relPath.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let id = (h >>> 0) % 0x7fffffff;
  if (id === 0) id = 1;
  while (used.has(id)) id = id === 0x7ffffffe ? 1 : id + 1;
  used.add(id);
  return id;
}

/** Extensions more than one registered format claims — `.brd` alone is
 *  Apple BRD, Allegro and EAGLE. For these the extension says nothing, so the
 *  scan reads a header and asks the same content detector a real open uses;
 *  every other file is named by its extension for free. Without this the
 *  Library labelled all 29 Allegro/Apple boards in the sample corpus "BDV",
 *  because that format is simply registered first. */
function ambiguousExtensions(): Set<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const fmt of getAllFormats()) {
    for (const ext of fmt.extensions) {
      if (seen.has(ext)) dupes.add(ext);
      seen.add(ext);
    }
  }
  return dupes;
}

/** Enough for every registered detector: the magics sit at offset 0 and the
 *  text sniffs (EAGLE's XML, GenCAD vs Mentor) look at the first lines. */
const SNIFF_BYTES = 8192;

async function resolveFormatId(file: File, ambiguous: Set<string>): Promise<string> {
  if (!ambiguous.has(getFileExtension(file.name))) {
    return detectByExtension(file.name)?.id ?? '';
  }
  try {
    const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
    const byContent = detectFormat(head);
    if (byContent) return byContent.id;
  } catch {
    // Unreadable header (a cloud placeholder, a permission blip) — fall back
    // to the extension rather than dropping the row.
  }
  return detectByExtension(file.name)?.id ?? '';
}

/** One index row. `fullPath` is Electron-only and deliberately absent here —
 *  a browser never sees an absolute path. */
function makeRow(id: number, relPath: string, name: string, size: number, lastModified: number, type: 'board' | 'pdf', formatId?: string): DatabankFile {
  const boardNumber = type === 'board' ? (extractBoardNumberFromFilename(name) ?? '') : '';
  return {
    id,
    path: relPath,
    filename: name,
    extension: fileExt(name),
    file_type: type,
    size,
    mod_time: Math.floor(lastModified / 1000),
    mod_time_ms: lastModified,
    scan_time: Math.floor(Date.now() / 1000),
    board_number: boardNumber,
    manufacturer: '',
    model: '',
    format_id: type === 'board' ? (formatId ?? detectByExtension(name)?.id ?? '') : '',
    part_count: null,
    net_count: null,
    donor_pool: false,
    has_preview: false,
    board_manufacturer: '',
    resolution_status: '',
  };
}

/** Folder tree in the shape `FolderView` already renders for Electron:
 *  full records embedded, no id indirection. */
function buildTree(rows: DatabankFile[], rootName: string): FolderNode {
  const root: FolderNode = { name: rootName || '/', path: '', children: [], files: [] };
  const dirs = new Map<string, FolderNode>([['', root]]);

  const ensureDir = (dirPath: string): FolderNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf('/');
    const parent = slash < 0 ? root : ensureDir(dirPath.slice(0, slash));
    const node: FolderNode = { name: dirPath.slice(slash + 1), path: dirPath, children: [], files: [] };
    parent.children!.push(node);
    dirs.set(dirPath, node);
    return node;
  };

  for (const row of rows) {
    const slash = row.path.lastIndexOf('/');
    const node = slash < 0 ? root : ensureDir(row.path.slice(0, slash));
    node.files!.push(row);
  }

  const sortNode = (n: FolderNode) => {
    n.children?.sort((a, b) => a.name.localeCompare(b.name));
    n.files?.sort((a, b) => a.filename.localeCompare(b.filename));
    n.children?.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

// ── Persistence ──────────────────────────────────────────────────────────

const DB_NAME = 'boardripper-folder-library';
const DB_VERSION = 1;
const STORE = 'root';
const RECORD_KEY = 'current';

interface StoredLibrary {
  key: string;
  /** Present only for the Chromium handle path. */
  handle?: FsDirectoryHandle;
  rootName: string;
  mode: 'handle' | 'input';
  files: DatabankFile[];
  tree: FolderNode;
  savedAt: number;
}

/** Persistence is best-effort: a `file://` page in some browsers, private
 *  mode, and storage-blocked contexts simply have no IndexedDB. The library
 *  works for the session either way — only the reload survives it. */
function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readStored(): Promise<StoredLibrary | null> {
  if (!idbAvailable()) return null;
  try {
    const db = await openDB();
    return await new Promise<StoredLibrary | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD_KEY);
      req.onsuccess = () => resolve((req.result as StoredLibrary | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    log.scan.warn('folder library: cannot read stored index:', err);
    return null;
  }
}

async function writeStored(rec: StoredLibrary): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // A handle that fails to structured-clone (Safari, private mode) must not
    // take the scan down with it — the library still works for this session.
    log.scan.warn('folder library: cannot persist index:', err);
  }
}

async function clearStored(): Promise<void> {
  if (!idbAvailable()) return;
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(RECORD_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch { /* nothing to clear */ }
}

// ── The library ──────────────────────────────────────────────────────────

interface Entry {
  path: string;
  /** Input mode: the `File` handed over by the picker, live for this page. */
  file?: File;
  /** Handle mode: re-read on every open so the bytes are current. */
  handle?: FsFileHandle;
}

class FolderLibrary {
  private _state: FolderLibraryState = { kind: 'none' };
  private _entries = new Map<number, Entry>();
  private _rootHandle: FsDirectoryHandle | null = null;

  get state(): FolderLibraryState { return this._state; }
  get rootName(): string { return this._state.kind === 'none' ? '' : this._state.rootName; }
  /** True while file bytes are reachable. */
  get readable(): boolean { return this._state.kind === 'active'; }
  /** True when a rescan of the same folder is possible without a new pick. */
  get rescannable(): boolean { return this._state.kind === 'active' && this._state.mode === 'handle'; }
  /** True when a live handle is held but its grant is not: one
   *  `requestPermission()` in a user gesture brings the folder back, with no
   *  second trip through the picker. */
  get canReconnect(): boolean { return this._state.kind === 'detached' && this._rootHandle !== null; }
  /** True when the folder can only come back through the picker: it was read
   *  with the `webkitdirectory` input, whose `File`s cannot be revived and
   *  which leaves no handle to ask permission for. */
  get needsRepick(): boolean { return this._state.kind === 'detached' && this._rootHandle === null; }

  // ── Picking ──

  /** Chromium: open the directory picker. Must run in a user gesture.
   *
   *  Every way this ends is named, because a picker that hands nothing back
   *  is indistinguishable from a broken app: the browser **refuses whole
   *  folders** (your home directory, Desktop, Documents, `/` and the system
   *  tree are on Chromium's block list) and the refusal arrives as the same
   *  `AbortError` a cancel does, so the outcome has to be reported rather
   *  than swallowed. `fallback` means the method exists but this context may
   *  not call it — a `file://` page — and the caller should use the
   *  `webkitdirectory` input instead. */
  async pickDirectory(onProgress?: (p: ScanProgress) => void): Promise<PickResult> {
    const picker = directoryPicker();
    if (!picker) return { ok: false, reason: 'unsupported' };
    let handle: FsDirectoryHandle;
    try {
      handle = await picker({ id: 'boardripper-library', mode: 'read' });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'AbortError') {
        log.scan.log('directory picker: dismissed (a cancel, or a folder the browser will not open)');
        return { ok: false, reason: 'cancelled' };
      }
      if (name === 'SecurityError' || name === 'NotAllowedError') {
        log.scan.warn('directory picker: refused by the browser:', err);
        return { ok: false, reason: 'fallback', error: err };
      }
      log.scan.warn('directory picker failed:', err);
      return { ok: false, reason: 'error', error: err };
    }
    try {
      const scan = await this.scanHandle(handle, onProgress);
      await writeStored({
        key: RECORD_KEY, handle, rootName: scan.rootName, mode: 'handle',
        files: scan.files, tree: scan.tree, savedAt: Date.now(),
      });
      return { ok: true, scan };
    } catch (err) {
      // A folder that cannot be walked (permission withdrawn mid-scan, an
      // unreadable mount) is a failure of ours to report, not of the pick.
      log.scan.error('reading the picked folder failed:', err);
      return { ok: false, reason: 'error', error: err };
    }
  }

  /** Everything else: adopt the `FileList` from a `webkitdirectory` input. */
  async adoptFileList(list: FileList | File[], onProgress?: (p: ScanProgress) => void): Promise<FolderScan | null> {
    const all = Array.from(list);
    if (all.length === 0) return null;
    const started = performance.now();
    const boardExts = boardExtensions();
    // webkitRelativePath is "<root>/sub/file.ext"; the index stores paths
    // relative to the root, matching the backend and Electron producers.
    const rootName = all[0].webkitRelativePath?.split('/')[0] || 'Library';

    const rows: DatabankFile[] = [];
    const entries = new Map<number, Entry>();
    const used = new Set<number>();
    const ambiguous = ambiguousExtensions();
    let scanned = 0;
    let lastYield = performance.now();

    for (const file of all) {
      scanned++;
      const rel = file.webkitRelativePath
        ? file.webkitRelativePath.split('/').slice(1).join('/')
        : file.name;
      if (!rel || rel.split('/').some(seg => seg.startsWith('.'))) continue;
      const type = classify(file.name, boardExts);
      if (type) {
        const id = allocId(rel, used);
        const fmt = type === 'board' ? await resolveFormatId(file, ambiguous) : '';
        rows.push(makeRow(id, rel, file.name, file.size, file.lastModified, type, fmt));
        entries.set(id, { path: rel, file });
      }
      if (performance.now() - lastYield > YIELD_MS) {
        onProgress?.({ scanned, matched: rows.length, current: rel });
        await new Promise(r => setTimeout(r, 0));
        lastYield = performance.now();
      }
    }

    const scan = this.commit(rows, entries, rootName, 'input', started);
    await writeStored({
      key: RECORD_KEY, rootName, mode: 'input',
      files: scan.files, tree: scan.tree, savedAt: Date.now(),
    });
    return scan;
  }

  /** A folder dropped on the window. Chromium's handle is preferred when the
   *  drop carried one — it persists and can be rescanned; otherwise the
   *  entry tree is walked, which every browser supports. */
  async adoptDrop(captured: CapturedDrop, onProgress?: (p: ScanProgress) => void): Promise<FolderScan | null> {
    const handle = captured.handle ? await captured.handle : null;
    if (handle) {
      const scan = await this.scanHandle(handle, onProgress);
      await writeStored({
        key: RECORD_KEY, handle, rootName: scan.rootName, mode: 'handle',
        files: scan.files, tree: scan.tree, savedAt: Date.now(),
      });
      return scan;
    }
    if (!captured.entry) return null;
    const scan = await this.scanEntryTree(captured.entry, onProgress);
    await writeStored({
      key: RECORD_KEY, rootName: scan.rootName, mode: 'input',
      files: scan.files, tree: scan.tree, savedAt: Date.now(),
    });
    return scan;
  }

  /** Re-walk the folder behind a live handle (Chromium only). */
  async rescan(onProgress?: (p: ScanProgress) => void): Promise<FolderScan | null> {
    if (!this._rootHandle) return null;
    const scan = await this.scanHandle(this._rootHandle, onProgress);
    await writeStored({
      key: RECORD_KEY, handle: this._rootHandle, rootName: scan.rootName, mode: 'handle',
      files: scan.files, tree: scan.tree, savedAt: Date.now(),
    });
    return scan;
  }

  // ── Restore across reloads ──

  /** Read the persisted index and bring back as much of the library as the
   *  browser allows. `onIndex` fires first with the stored index so the panel
   *  fills immediately; on Chromium with permission still granted a fresh
   *  walk follows and replaces it. Never prompts — `queryPermission` is
   *  silent and re-granting needs a user gesture (see `reconnect`). */
  async restore(opts?: { onIndex?: (scan: FolderScan) => void; onProgress?: (p: ScanProgress) => void }): Promise<FolderScan | null> {
    const rec = await readStored();
    if (!rec || !rec.files?.length) return null;

    const stored: FolderScan = { rootName: rec.rootName, files: rec.files, tree: rec.tree, durationMs: 0 };
    this._entries = new Map();
    this._state = {
      kind: 'detached',
      rootName: rec.rootName,
      reason: rec.mode === 'handle' ? 'permission' : 'repick',
    };
    opts?.onIndex?.(stored);

    if (rec.mode !== 'handle' || !rec.handle) {
      log.scan.log(`folder library: restored "${rec.rootName}" (${rec.files.length} files, mode=input) — no handle was stored, so the folder has to be chosen again before anything opens`);
      return stored;
    }

    this._rootHandle = rec.handle;
    const perm = (await rec.handle.queryPermission?.({ mode: 'read' })) ?? 'prompt';
    log.scan.log(`folder library: restored "${rec.rootName}" (${rec.files.length} files, mode=handle, permission=${perm})`);
    if (perm !== 'granted') return stored;

    // Permission survived. Walk it again — the folder may have changed while
    // we were away, and only a walk rebuilds the id → handle map that reads
    // go through.
    try {
      const fresh = await this.scanHandle(rec.handle, opts?.onProgress);
      await writeStored({
        key: RECORD_KEY, handle: rec.handle, rootName: fresh.rootName, mode: 'handle',
        files: fresh.files, tree: fresh.tree, savedAt: Date.now(),
      });
      return fresh;
    } catch (err) {
      log.scan.warn('folder library: rescan on restore failed:', err);
      return stored;
    }
  }

  /** Chromium re-grant. Must run in a user gesture. */
  async reconnect(onProgress?: (p: ScanProgress) => void): Promise<FolderScan | null> {
    if (!this._rootHandle) {
      log.scan.warn('reconnect: no stored handle — this library came from the folder input');
      return null;
    }
    let perm: PermissionState | 'denied';
    try {
      perm = (await this._rootHandle.requestPermission?.({ mode: 'read' })) ?? 'denied';
    } catch (err) {
      // Chromium throws here when there is no transient activation left, and
      // that is a bug on our side, not the user's — say which it was.
      log.scan.error('reconnect: requestPermission threw:', err);
      return null;
    }
    log.scan.log(`reconnect: the browser answered "${perm}"`);
    if (perm !== 'granted') return null;
    return this.rescan(onProgress);
  }

  async forget(): Promise<void> {
    this._entries.clear();
    this._rootHandle = null;
    this._state = { kind: 'none' };
    await clearStored();
  }

  // ── Reading ──

  /** The bytes behind an index row. Handle mode re-reads from disk; input
   *  mode returns the `File` the picker handed over. */
  async getFile(row: DatabankFile): Promise<File> {
    const entry = this._entries.get(row.id);
    if (!entry) {
      if (this._state.kind === 'detached') {
        // Two different dead ends, and telling the user the wrong one is
        // worse than saying nothing: only a handle can be re-granted.
        throw new Error(this._rootHandle
          ? `"${row.filename}" needs access to the library folder again — use Reconnect`
          : `"${row.filename}" needs the folder again. It was read with the file picker, which the browser cannot reopen by itself — choose the folder once more.`);
      }
      throw new Error(`"${row.filename}" is not in the local folder index`);
    }
    if (entry.file) return entry.file;
    if (entry.handle) return entry.handle.getFile();
    throw new Error(`"${row.filename}" has no readable source`);
  }

  // ── Internals ──

  private async scanHandle(root: FsDirectoryHandle, onProgress?: (p: ScanProgress) => void): Promise<FolderScan> {
    const started = performance.now();
    const boardExts = boardExtensions();
    const rows: DatabankFile[] = [];
    const entries = new Map<number, Entry>();
    const used = new Set<number>();
    const ambiguous = ambiguousExtensions();
    let scanned = 0;
    let lastYield = performance.now();

    const walk = async (dir: FsDirectoryHandle, prefix: string): Promise<void> => {
      for await (const child of dir.values()) {
        if (scanned >= MAX_ENTRIES) return;
        if (child.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.kind === 'directory') {
          await walk(child, rel);
          continue;
        }
        scanned++;
        const type = classify(child.name, boardExts);
        if (type) {
          let meta: File;
          try {
            meta = await child.getFile();
          } catch (err) {
            log.scan.warn(`folder scan: cannot stat ${rel}:`, err);
            continue;
          }
          const id = allocId(rel, used);
          const fmt = type === 'board' ? await resolveFormatId(meta, ambiguous) : '';
          rows.push(makeRow(id, rel, child.name, meta.size, meta.lastModified, type, fmt));
          entries.set(id, { path: rel, handle: child });
        }
        if (performance.now() - lastYield > YIELD_MS) {
          onProgress?.({ scanned, matched: rows.length, current: rel });
          await new Promise(r => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }
    };

    await walk(root, '');
    this._rootHandle = root;
    return this.commit(rows, entries, root.name, 'handle', started);
  }

  private async scanEntryTree(root: DropDirectoryEntry, onProgress?: (p: ScanProgress) => void): Promise<FolderScan> {
    const started = performance.now();
    const boardExts = boardExtensions();
    const rows: DatabankFile[] = [];
    const entries = new Map<number, Entry>();
    const used = new Set<number>();
    const ambiguous = ambiguousExtensions();
    let scanned = 0;
    let lastYield = performance.now();

    /** readEntries returns a BATCH (100 in Chromium), not the directory —
     *  it has to be called until it answers with an empty array. */
    const readAll = (dir: DropDirectoryEntry): Promise<DropEntry[]> => new Promise((resolve) => {
      const reader = dir.createReader();
      const all: DropEntry[] = [];
      const next = () => reader.readEntries(
        (batch) => { if (batch.length === 0) resolve(all); else { all.push(...batch); next(); } },
        () => resolve(all),
      );
      next();
    });

    const getFile = (e: DropFileEntry): Promise<File | null> =>
      new Promise(resolve => e.file(resolve, () => resolve(null)));

    const walk = async (dir: DropDirectoryEntry, prefix: string): Promise<void> => {
      for (const child of await readAll(dir)) {
        if (scanned >= MAX_ENTRIES) return;
        if (child.name.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${child.name}` : child.name;
        if (child.isDirectory) { await walk(child, rel); continue; }
        scanned++;
        const type = classify(child.name, boardExts);
        if (type) {
          const file = await getFile(child);
          if (!file) { log.scan.warn(`folder scan: cannot read ${rel}`); continue; }
          const id = allocId(rel, used);
          const fmt = type === 'board' ? await resolveFormatId(file, ambiguous) : '';
          rows.push(makeRow(id, rel, child.name, file.size, file.lastModified, type, fmt));
          entries.set(id, { path: rel, file });
        }
        if (performance.now() - lastYield > YIELD_MS) {
          onProgress?.({ scanned, matched: rows.length, current: rel });
          await new Promise(r => setTimeout(r, 0));
          lastYield = performance.now();
        }
      }
    };

    await walk(root, '');
    this._rootHandle = null;
    return this.commit(rows, entries, root.name, 'input', started);
  }

  private commit(rows: DatabankFile[], entries: Map<number, Entry>, rootName: string, mode: 'handle' | 'input', started: number): FolderScan {
    this._entries = entries;
    this._state = { kind: 'active', rootName, mode };
    const tree = buildTree(rows, rootName);
    const durationMs = Math.round(performance.now() - started);
    log.scan.log(`folder library: ${rows.length} files under "${rootName}" in ${durationMs} ms (${mode})`);
    return { rootName, files: rows, tree, durationMs };
  }

}

export const folderLibrary = new FolderLibrary();

// Test hook (DEV only — tree-shaken from production).
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __folderLibrary?: FolderLibrary }).__folderLibrary = folderLibrary;
}

export { buildTree as buildFolderTreeForTest, makeRow as makeFolderRowForTest, allocId as allocFolderIdForTest };
