import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/pdf';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { PDFDocument, PDFName, PDFDict, PDFStream, PDFNumber, PDFRef, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { boardCache } from './board-cache';
import { Emitter } from './emitter';
import { PdfLinks } from './pdf-links';
import { log } from './log-store';
import { ensureIndexed } from '../pdf/pdf-index-client';
import { scoreLookupCandidates, type LookupCandidate, type LookupContextHit } from './pdf-lookup-score';

// Polyfills for Electron (Chrome 134) — pdfjs v5.5+ uses Chrome 136+ APIs.
// TS lib doesn't ship the Stage-3 prototype additions yet; declare them for the typechecker.
declare global {
  interface Uint8Array {
    toHex(): string;
  }
  interface Map<K, V> {
    getOrInsertComputed(key: K, cb: (key: K) => V): V;
  }
}

if (typeof Uint8Array.prototype.toHex !== 'function') {
  Uint8Array.prototype.toHex = function () {
    let hex = '';
    for (let i = 0; i < this.length; i++) hex += this[i].toString(16).padStart(2, '0');
    return hex;
  };
}
if (typeof Map.prototype.getOrInsertComputed !== 'function') {
  Map.prototype.getOrInsertComputed = function <K, V>(this: Map<K, V>, key: K, cb: (key: K) => V): V {
    if (this.has(key)) return this.get(key)!;
    const val = cb(key);
    this.set(key, val);
    return val;
  };
}

// Configure pdf.js worker.
// In Electron (file:// protocol), try dynamic import first (sets globalThis.pdfjsWorker
// for main-thread execution). If that fails, fall back to workerSrc with file:// URL.
// In normal web mode, use workerSrc for a real Web Worker.
//
// NOTE — we deliberately use the *unminified* `pdf.worker.mjs` (not `.min.mjs`)
// because BoardRipper patches the worker to support a parse-time watermark
// filter (`src/frontend/patches/pdfjs-dist+<version>.patch`, applied via the
// `postinstall` script). The patch targets readable source. Vite still minifies
// the worker chunk for production. See `src/frontend/patches/README.md`.
const _workerUrl = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url,
).toString();

// CMap + standard-font assets shipped with pdfjs-dist. Required when a PDF
// references a CJK / vendor CMap or relies on the standard 14 PDF fonts —
// without these, pdf.js's font loader fails with "Ensure that the cMapUrl
// and cMapPacked API parameters are provided", and the resulting glyphs
// arrive at the operator stream with no `.unicode`, so BoardRipper's
// watermark filter (which matches on reconstructed glyph strings) can't
// see them. cmaps in pdfjs-dist are pre-packed .bcmap files.
//
// `new URL('pdfjs-dist/cmaps/', import.meta.url)` doesn't work — vite only
// resolves bare module specifiers when the URL points at a file (e.g.
// 'pdfjs-dist/build/pdf.worker.mjs'), not a directory. So we derive the
// asset directory from `_workerUrl` by trimming `build/pdf.worker.mjs`.
const _pdfjsBase = _workerUrl.replace(/build\/pdf\.worker\.mjs$/, '');
const _cMapUrl = _pdfjsBase + 'cmaps/';
const _standardFontDataUrl = _pdfjsBase + 'standard_fonts/';
const _getDocOpts = { cMapUrl: _cMapUrl, cMapPacked: true, standardFontDataUrl: _standardFontDataUrl };

let _workerReady: Promise<void> = Promise.resolve();
if (window.location.protocol === 'file:') {
  _workerReady = import('pdfjs-dist/build/pdf.worker.mjs').then(() => {
    log.pdf.log('pdf.js worker loaded via dynamic import (main-thread mode)');
  }).catch((err) => {
    log.pdf.warn('pdf.js worker dynamic import failed, setting workerSrc fallback:', err);
    pdfjsLib.GlobalWorkerOptions.workerSrc = _workerUrl;
  });
} else {
  pdfjsLib.GlobalWorkerOptions.workerSrc = _workerUrl;
}

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
}

/** Extract font size from a PDF text transform matrix */
export function pdfFontSize(t: number[]): number {
  return Math.sqrt(t[2] * t[2] + t[3] * t[3]);
}

export interface PdfTextMatch {
  pageIndex: number;   // 0-based
  itemIndex: number;
  charStart: number;
  charEnd: number;
  item: PdfTextItem;
}

/** A merged text line — adjacent items concatenated for cross-item search */
interface MergedLine {
  text: string;
  /** For each character in `text`, which original item index produced it */
  charToItem: number[];
  /** For each character in `text`, offset within that item's str */
  charToOffset: number[];
  /** Dense text — same as `text` but with no synthetic gap-spaces inserted
   *  between items. Lets whitespace-free identifier searches like
   *  "-PWRSW_EC" match even when pdf.js splits the glyph run across items
   *  with wide reported gaps (e.g. "-" as its own item with an under-
   *  reported width). `denseCharToItem` / `denseCharToOffset` map back to
   *  the original items just like the whitespace-preserving maps. */
  denseText: string;
  denseCharToItem: number[];
  denseCharToOffset: number[];
  /** The item indices in this line (in order) */
  itemIndices: number[];
  /** Average Y position of the line (for multi-term spatial search) */
  y: number;
  /** X position of line start */
  x: number;
  /** Average font size */
  fontSize: number;
}

/**
 * Merge adjacent PdfTextItems into logical lines for cross-item search.
 * Items on the same row (similar Y within font-size tolerance) are concatenated.
 * A space is inserted between items that have a horizontal gap.
 */
function mergeItemsIntoLines(items: PdfTextItem[]): MergedLine[] {
  if (items.length === 0) return [];

  // Build indexed items with spatial info
  const indexed = items.map((item, idx) => {
    const fs = pdfFontSize(item.transform);
    return { item, idx, x: item.transform[4], y: item.transform[5], fontSize: fs || 10 };
  });

  // Sort by Y descending (PDF coords: top of page = high Y), then X ascending
  indexed.sort((a, b) => {
    const yDiff = b.y - a.y;
    if (Math.abs(yDiff) > Math.min(a.fontSize, b.fontSize) * 0.3) return yDiff;
    return a.x - b.x;
  });

  const lines: MergedLine[] = [];
  let lineItems = [indexed[0]];

  for (let i = 1; i < indexed.length; i++) {
    const cur = indexed[i];
    const prev = lineItems[lineItems.length - 1];
    const yTol = Math.min(cur.fontSize, prev.fontSize) * 0.5;

    if (Math.abs(cur.y - prev.y) <= yTol) {
      lineItems.push(cur);
    } else {
      lines.push(buildLine(lineItems));
      lineItems = [cur];
    }
  }
  lines.push(buildLine(lineItems));
  return lines;
}

function buildLine(lineItems: { item: PdfTextItem; idx: number; x: number; y: number; fontSize: number }[]): MergedLine {
  // Sort by X within line
  lineItems.sort((a, b) => a.x - b.x);

  let text = '';
  const charToItem: number[] = [];
  const charToOffset: number[] = [];
  let denseText = '';
  const denseCharToItem: number[] = [];
  const denseCharToOffset: number[] = [];
  const itemIndices: number[] = [];
  let totalY = 0;
  let totalFontSize = 0;

  for (let i = 0; i < lineItems.length; i++) {
    const li = lineItems[i];
    itemIndices.push(li.idx);
    totalY += li.y;
    totalFontSize += li.fontSize;

    // Insert space between items if there's a horizontal gap
    if (i > 0) {
      const prevLi = lineItems[i - 1];
      const prevEnd = prevLi.x + prevLi.item.width;
      const gap = li.x - prevEnd;
      if (gap > li.fontSize * 0.15) {
        // Significant gap — insert space in the whitespace-preserving text
        // but NOT in the dense text, so identifier searches like "-PWRSW_EC"
        // still match when pdf.js splits the glyph run.
        text += ' ';
        charToItem.push(-1); // space doesn't belong to any item
        charToOffset.push(-1);
      }
    }

    for (let c = 0; c < li.item.str.length; c++) {
      text += li.item.str[c];
      charToItem.push(li.idx);
      charToOffset.push(c);
      denseText += li.item.str[c];
      denseCharToItem.push(li.idx);
      denseCharToOffset.push(c);
    }
  }

  return {
    text,
    charToItem,
    charToOffset,
    denseText,
    denseCharToItem,
    denseCharToOffset,
    itemIndices,
    y: totalY / lineItems.length,
    x: lineItems[0].x,
    fontSize: totalFontSize / lineItems.length,
  };
}

export interface PdfBookmark {
  id: string;
  page: number;    // 1-based
  zoom: number;
  panX: number;
  panY: number;
  label: string;   // user-editable, defaults to "p{page}"
}

const BOOKMARKS_KEY_PREFIX = 'boardripper-pdf-bookmarks-';

/** UUID generator that works in insecure contexts (HTTP on LAN IPs).
 *  `crypto.randomUUID()` is only exposed on secure origins, so the NAS
 *  deploy over http://<ip>:8081 would throw on it. */
function bookmarkId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback: 16 random bytes formatted as a v4-style UUID.
  const buf = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(buf);
  else for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  buf[6] = (buf[6] & 0x0f) | 0x40;
  buf[8] = (buf[8] & 0x3f) | 0x80;
  const hex = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function loadBookmarks(fileName: string): PdfBookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY_PREFIX + fileName);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveBookmarks(fileName: string, bookmarks: PdfBookmark[]) {
  try {
    localStorage.setItem(BOOKMARKS_KEY_PREFIX + fileName, JSON.stringify(bookmarks));
  } catch { /* ignore quota */ }
}

/** A parsed q/Q block tree node */
interface QBlock { items: (string | QBlock)[]; }

/** Check if a q/Q block tree contains ONLY watermark-related operators */
function isWatermarkOnly(block: QBlock, names: Set<string>): boolean {
  for (const item of block.items) {
    if (typeof item !== 'string') {
      if (!isWatermarkOnly(item, names)) return false;
      continue;
    }
    const t = item.trim();
    if (!t) continue;
    // Watermark Do → allowed only if it's a known watermark image
    const doMatch = t.match(/^\/(\w+)\s+Do$/);
    if (doMatch) { if (!names.has(doMatch[1])) return false; continue; }
    // Transform, graphics state, clipping setup → neutral (allowed in watermark blocks)
    if (/^[\d.\s-]+cm$/.test(t)) continue;
    if (/^\/\w+\s+gs$/.test(t)) continue;
    if (/^[\d.\s-]+re$/.test(t)) continue;
    if (t === 'W n' || t === 'W' || t === 'n') continue;
    // Anything else (text, stroke, fill, non-watermark Do) → real content
    return false;
  }
  return true;
}

/** Emit non-watermark content from a parsed block tree */
function emitClean(block: QBlock, names: Set<string>, out: string[]): void {
  for (const item of block.items) {
    if (typeof item !== 'string') {
      if (!isWatermarkOnly(item, names)) {
        out.push('q');
        emitClean(item, names, out);
        out.push('Q');
      }
    } else {
      out.push(item);
    }
  }
}

/**
 * Strip small tiled watermark images from a PDF.
 * 1. Identifies image XObjects < maxDim px (the watermark letter tiles)
 * 2. Removes them from Resources/XObject
 * 3. Parses the content stream into a q/Q block tree and strips any subtree
 *    that contains only watermark Do/cm/gs/clip ops — eliminates ~96% of
 *    the stream for heavily watermarked files
 */
async function stripWatermarkImages(buffer: ArrayBuffer, maxDim = 50): Promise<Uint8Array> {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pages = doc.getPages();
  let totalRemoved = 0;

  for (const page of pages) {
    const resources = page.node.get(PDFName.of('Resources'));
    if (!(resources instanceof PDFDict)) continue;

    const xObjectRef = resources.get(PDFName.of('XObject'));
    const xObject = (xObjectRef instanceof PDFRef
      ? doc.context.lookup(xObjectRef)
      : xObjectRef) as PDFDict | undefined;
    if (!(xObject instanceof PDFDict)) continue;

    // 1. Find small watermark image names
    const watermarkNames = new Set<string>();
    for (const [name, ref] of xObject.entries()) {
      const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (!(obj instanceof PDFStream)) continue;
      const subtype = obj.dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;
      const w = obj.dict.get(PDFName.of('Width'));
      const h = obj.dict.get(PDFName.of('Height'));
      if (w instanceof PDFNumber && h instanceof PDFNumber &&
          w.asNumber() < maxDim && h.asNumber() < maxDim) {
        watermarkNames.add(name.toString().slice(1)); // "/Im0" → "Im0"
        xObject.delete(name);
      }
    }
    if (watermarkNames.size === 0) continue;
    totalRemoved += watermarkNames.size;

    // 2. Strip watermark operator blocks from content stream(s)
    const contentsRef = page.node.get(PDFName.of('Contents'));
    if (!contentsRef) continue;
    const contentsObj = contentsRef instanceof PDFRef
      ? doc.context.lookup(contentsRef)
      : contentsRef;

    const streamRefs: PDFRef[] = [];
    if (contentsObj instanceof PDFArray) {
      for (let i = 0; i < contentsObj.size(); i++) {
        const r = contentsObj.get(i);
        if (r instanceof PDFRef) streamRefs.push(r);
      }
    } else if (contentsRef instanceof PDFRef) {
      streamRefs.push(contentsRef);
    }

    for (const ref of streamRefs) {
      const stream = doc.context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;

      const decoded = decodePDFRawStream(stream);
      const bytes = decoded.decode();
      const text = new TextDecoder('latin1').decode(bytes);

      // Parse into q/Q block tree
      const root: QBlock = { items: [] };
      const stack: QBlock[] = [root];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (t === 'q') {
          const child: QBlock = { items: [] };
          stack[stack.length - 1].items.push(child);
          stack.push(child);
        } else if (t === 'Q') {
          if (stack.length > 1) stack.pop();
        } else {
          stack[stack.length - 1].items.push(line);
        }
      }

      // Emit only non-watermark blocks
      const out: string[] = [];
      emitClean(root, watermarkNames, out);
      const cleaned = out.join('\n');

      if (cleaned.length >= text.length) continue;

      const cleanedBytes = new TextEncoder().encode(cleaned);
      const newStream = doc.context.stream(cleanedBytes);
      doc.context.assign(ref, newStream);

      log.pdf.log(`Content stream: ${text.length} → ${cleaned.length} bytes (−${Math.round((1 - cleaned.length / text.length) * 100)}%)`);
    }
  }

  if (totalRemoved > 0) {
    log.pdf.log(`Stripped ${totalRemoved} watermark image XObject(s)`);
  }
  return doc.save();
}

/** Per-document state kept in memory for instant switching */
interface PdfDocument {
  doc: PDFDocumentProxy;
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  originalBuffer: ArrayBuffer;
  strippedDoc: PDFDocumentProxy | null;
  cleanMode: boolean;
  pageCount: number;
  currentPage: number;
  /** User rotation applied on top of each page's intrinsic rotation: 0/90/180/270 (CW degrees). */
  rotation: number;
  /** Page layout mode. 'continuous' = stacked scrollable pages (default);
   *  'single' = one page at a time, pan locked to it. Forced to 'single' while rotated. */
  pageMode: 'single' | 'continuous';
  /** Horizontal mirror (left↔right flip), for aligning a schematic with a
   *  bottom-side board view. Independent of rotation and page mode. */
  mirror: boolean;
  textPages: PdfTextItem[][];
  searchQuery: string;
  matches: PdfTextMatch[];
  activeMatchIndex: number;
  matchGroups: number[][];
  activeGroupIndex: number;
  activeMatchIndicesCache: Set<number>;
  matchesByPage: Map<number, PdfTextMatch[]>;
  bookmarks: PdfBookmark[];
  /** Who last filled the search field: 'user' (typed/word-click), 'lookup' (board follow), or null (empty). */
  searchSource: 'user' | 'lookup' | null;
  /** Component name pending double-click confirmation — shown as tooltip when user search would be overwritten. */
  lookupHint: string | null;
  /** Databank file ID when the PDF was opened from the library. Undefined for
   *  ad-hoc opens (drag-drop). Used to trigger the fast-path backend index. */
  fileId?: number;
  /** Transient cross-lookup status shown verbatim on the SOURCE doc (e.g. "No match…"). */
  crossProbeHint: string | null;
}

/** Follow target: a location to zoom to without highlighting */
export interface FollowTarget {
  pageIndex: number;     // 0-based page index
  items: PdfTextItem[];  // text items to zoom to (bounding box)
}

/** One disambiguating context term for a heuristic lookup — a net name on the
 *  component's pins, or a pin number/name (or, for a net lookup, a connected
 *  component designator). Used by `lookupEntity` to pick the occurrence with
 *  the most context AROUND it (the schematic symbol placement). */
export interface LookupContextTerm {
  text: string;
  kind: 'net' | 'pin';
}

class PdfStore extends Emitter {
  private _documents: Map<string, PdfDocument> = new Map();
  private _links = new PdfLinks();
  private _activeFileName: string | null = null;
  /** Vertical distance multiplier for multi-term search (fontSize × this) */
  private _multiTermYGap = 4;
  /** Horizontal tolerance multiplier for multi-term search (fontSize × this) */
  private _multiTermXGap = 3;
  /** Context-lookup proximity window (fontSize × this) — how far AROUND a
   *  designator/net occurrence to look for its context terms. Generous on
   *  purpose so a symbol's radiating net labels / pin numbers count; tunable
   *  against real schematics. */
  private _lookupXGap = 18;
  private _lookupYGap = 14;
  /** Max occurrences of one context term scanned per page (pathological-table guard). */
  private _lookupTermCap = 20;
  private _loading = false;
  /** Consumable follow target — PDF viewer zooms to this location without highlighting */
  private _followTarget: FollowTarget | null = null;
  /** Last word clicked in any PDF panel — read by Cmd+F handler when a PDF is focused */
  private _lastClickedWord: string | null = null;
  /** Location of the last clicked word — used by searchText to pick the exact
   *  match under the click rather than heuristic "nearest page". */
  private _lastClickedLocation: { fileName: string; pageIndex: number; itemIndex: number } | null = null;

  get lastClickedWord(): string | null { return this._lastClickedWord; }
  setLastClickedWord(word: string | null): void { this._lastClickedWord = word; }
  setLastClickedLocation(loc: { fileName: string; pageIndex: number; itemIndex: number } | null): void {
    this._lastClickedLocation = loc;
  }

  private get _active(): PdfDocument | null {
    return this._activeFileName ? this._documents.get(this._activeFileName) ?? null : null;
  }

  get fileName(): string { return this._active?.fileName ?? ''; }
  get pageCount(): number { return this._active?.pageCount ?? 0; }
  get currentPage(): number { return this._active?.currentPage ?? 1; }
  get rotation(): number { return this._active?.rotation ?? 0; }
  get pageMode(): 'single' | 'continuous' { return this._active?.pageMode ?? 'continuous'; }
  get mirror(): boolean { return this._active?.mirror ?? false; }
  get searchQuery(): string { return this._active?.searchQuery ?? ''; }
  get matches(): PdfTextMatch[] { return this._active?.matches ?? []; }
  get activeMatchIndex(): number { return this._active?.activeMatchIndex ?? -1; }
  get matchGroups(): number[][] { return this._active?.matchGroups ?? []; }
  get activeGroupIndex(): number { return this._active?.activeGroupIndex ?? -1; }
  get multiTermYGap(): number { return this._multiTermYGap; }
  get multiTermXGap(): number { return this._multiTermXGap; }
  get isMultiTerm(): boolean {
    const q = this._active?.searchQuery ?? '';
    return !q.includes('@') && q.split(/\s+/).filter(t => t.length > 0).length > 1;
  }
  /** True when query uses TERM1@TERM2 whole-page co-occurrence syntax */
  get isAtSyntax(): boolean {
    return (this._active?.searchQuery ?? '').includes('@');
  }
  get isLoaded(): boolean { return this._active?.doc != null; }
  get loading(): boolean { return this._loading; }
  /** True while background text extraction is still running (search may return partial results). */
  get textExtracting(): boolean {
    const d = this._active;
    return d != null && d.textPages.length < d.pageCount;
  }
  /** Text extraction progress 0–1 for the active document. */
  get textExtractProgress(): number {
    const d = this._active;
    if (!d || d.pageCount === 0) return 1;
    return d.textPages.length / d.pageCount;
  }
  get bookmarks(): PdfBookmark[] { return this._active?.bookmarks ?? []; }
  get activeMatchIndices(): Set<number> { return this._active?.activeMatchIndicesCache ?? new Set(); }

  /** All loaded PDF filenames */
  get loadedFileNames(): string[] { return [...this._documents.keys()]; }

  /** Per-document accessors — allow panels to render without being the "active" doc */
  getDocPageCount(fileName: string): number { return this._documents.get(fileName)?.pageCount ?? 0; }
  getDocCurrentPage(fileName: string): number { return this._documents.get(fileName)?.currentPage ?? 1; }
  getDocRotation(fileName: string): number { return this._documents.get(fileName)?.rotation ?? 0; }
  getDocPageMode(fileName: string): 'single' | 'continuous' { return this._documents.get(fileName)?.pageMode ?? 'continuous'; }
  getDocMirror(fileName: string): boolean { return this._documents.get(fileName)?.mirror ?? false; }
  /** Effective single-page: explicit single mode OR forced single while rotated. */
  isDocSinglePage(fileName: string): boolean {
    const d = this._documents.get(fileName);
    if (!d) return false;
    return d.pageMode === 'single' || d.rotation !== 0;
  }
  getDocSearchQuery(fileName: string): string { return this._documents.get(fileName)?.searchQuery ?? ''; }
  getDocMatches(fileName: string): PdfTextMatch[] { return this._documents.get(fileName)?.matches ?? []; }
  getDocActiveMatchIndex(fileName: string): number { return this._documents.get(fileName)?.activeMatchIndex ?? -1; }
  getDocMatchGroups(fileName: string): number[][] { return this._documents.get(fileName)?.matchGroups ?? []; }
  getDocActiveGroupIndex(fileName: string): number { return this._documents.get(fileName)?.activeGroupIndex ?? -1; }
  getDocBookmarks(fileName: string): PdfBookmark[] { return this._documents.get(fileName)?.bookmarks ?? []; }
  getDocActiveMatchIndices(fileName: string): Set<number> { return this._documents.get(fileName)?.activeMatchIndicesCache ?? new Set(); }
  isDocLoaded(fileName: string): boolean { return this._documents.has(fileName); }
  isDocMultiTerm(fileName: string): boolean {
    const q = this._documents.get(fileName)?.searchQuery ?? '';
    return !q.includes('@') && q.split(/\s+/).filter(t => t.length > 0).length > 1;
  }
  isDocAtSyntax(fileName: string): boolean {
    return (this._documents.get(fileName)?.searchQuery ?? '').includes('@');
  }
  getDocSearchSource(fileName: string): 'user' | 'lookup' | null { return this._documents.get(fileName)?.searchSource ?? null; }
  getDocLookupHint(fileName: string): string | null { return this._documents.get(fileName)?.lookupHint ?? null; }
  getDocCrossProbeHint(fileName: string): string | null { return this._documents.get(fileName)?.crossProbeHint ?? null; }
  getDocTextExtracting(fileName: string): boolean {
    const d = this._documents.get(fileName);
    return d != null && d.textPages.length < d.pageCount;
  }
  getDocTextExtractProgress(fileName: string): number {
    const d = this._documents.get(fileName);
    if (!d || d.pageCount === 0) return 1;
    return d.textPages.length / d.pageCount;
  }

  /** Resolve once the named document's text is searchable for the given page.
   *
   *  searchText() runs synchronously against the in-memory `textPages` array,
   *  which `_extractText` fills page-by-page in the background (or in one shot
   *  on an IndexedDB cache hit). A fixed timeout after loadFile() therefore
   *  races extraction and often searches an empty `textPages` on large PDFs.
   *
   *  Readiness predicate: the requested 1-based page's text slot exists
   *  (`textPages.length >= pageNum`), OR full extraction has completed
   *  (`textPages.length >= pageCount`). We poll because `_extractText` only
   *  notify()s every few pages, so subscribing to notify wouldn't be reliably
   *  finer-grained than a short poll — and polling also covers the
   *  cache-hit fast path. Resolves `false` if the doc unloads or the cap
   *  (~10 s) elapses; `true` once text is ready. */
  whenTextReady(fileName: string, pageNum = 1, timeoutMs = 10000): Promise<boolean> {
    const ready = (d: PdfDocument): boolean =>
      d.textPages.length >= pageNum || d.textPages.length >= d.pageCount;
    const d0 = this._documents.get(fileName);
    if (d0 && ready(d0)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const start = Date.now();
      const tick = () => {
        const d = this._documents.get(fileName);
        if (!d) { resolve(false); return; }          // doc closed/unloaded
        if (ready(d)) { resolve(true); return; }
        if (Date.now() - start >= timeoutMs) { resolve(false); return; }
        setTimeout(tick, 100);
      };
      setTimeout(tick, 100);
    });
  }

  /** Switch to an already-loaded PDF instantly (no I/O). */
  switchTo(fileName: string | null) {
    if (fileName === this._activeFileName) return;
    if (fileName && !this._documents.has(fileName)) return;
    this._activeFileName = fileName;
    this.notify();
  }

  /** Load a PDF into memory (or switch to it if already loaded).
   *  Pass `fileId` when the PDF originates from the databank library so the
   *  backend full-text index can be updated via the fast-path after extraction. */
  async loadFile(file: File, fileId?: number) {
    // Already loaded? Just switch.
    if (this._documents.has(file.name)) {
      this._activeFileName = file.name;
      this.notify();
      return;
    }

    this._loading = true;
    this._activeFileName = file.name;
    this.notify();

    try {
      // Ensure the worker module is loaded before first getDocument() call (Electron/file://)
      await _workerReady;
      const buffer = await file.arrayBuffer();
      // Copy buffer before passing to pdf.js — getDocument() transfers/detaches the original
      const bufferCopy = buffer.slice(0);
      const doc = await pdfjsLib.getDocument({ data: bufferCopy, ..._getDocOpts }).promise;

      // Make the document available immediately — text is extracted in the background.
      const pdfDoc: PdfDocument = {
        doc,
        fileName: file.name,
        fileSize: file.size,
        fileLastModified: file.lastModified,
        originalBuffer: buffer,
        strippedDoc: null,
        cleanMode: false,
        pageCount: doc.numPages,
        currentPage: 1,
        rotation: 0,
        pageMode: 'continuous',
        mirror: false,
        textPages: [],
        searchQuery: '',
        searchSource: null,
        lookupHint: null,
        crossProbeHint: null,
        matches: [],
        activeMatchIndex: -1,
        matchGroups: [],
        activeGroupIndex: -1,
        activeMatchIndicesCache: new Set(),
        matchesByPage: new Map(),
        bookmarks: loadBookmarks(file.name),
        fileId,
      };
      this._documents.set(file.name, pdfDoc);
      this._links.restore(file.name);
      this._activeFileName = file.name;
      this._loading = false;
      this.notify();

      // Extract text from all pages in the background so search becomes available.
      // The viewer can render pages immediately without waiting for this.
      this._extractText(pdfDoc);
    } catch (err) {
      log.pdf.error('loadFile failed:', err instanceof Error ? err.message : JSON.stringify(err));
      this._activeFileName = null;
      this._loading = false;
      this.notify();
      throw err;
    }
  }

  /** Background text extraction — tries IndexedDB cache first, then extracts from PDF. */
  private async _extractText(pdfDoc: PdfDocument) {
    // Try cache first.
    try {
      const cached = await boardCache.getPdfText(pdfDoc.fileName, pdfDoc.fileSize, pdfDoc.fileLastModified);
      if (cached && cached.length === pdfDoc.pageCount) {
        // Ensure cached items have fontName (may be missing from older caches)
        // Also filter degenerate whitespace items that slipped into older caches,
        // and fix pdf.js false word breaks from kerning artifacts
        pdfDoc.textPages = cached.map(page =>
          page
            .filter(item => item.str.trim() || item.width <= 100)
            .map(item => ({
              ...item,
              str: item.str.replace(/(?<=\w) (?=\w)/g, ''),
              // Older cached entries may predate the fontName field; widen
              // through unknown to read it tolerantly before re-asserting type.
              fontName: (item as unknown as { fontName?: string }).fontName ?? '',
            }))
        );
        this.notify();
        // Fast-path index even on a cache hit: ensureIndexed checks status
        // first and is a no-op if the backend already has this file indexed.
        if (pdfDoc.fileId != null) {
          void ensureIndexed(pdfDoc.fileId, () =>
            pdfDoc.textPages.map((page) => page.map((item) => item.str)),
          );
        }
        return;
      }
    } catch { /* cache miss — fall through to extraction */ }

    // Extract from PDF, notifying periodically for the progress bar.
    // We drive streamTextContent() with a reader instead of calling
    // page.getTextContent(): pdf.js v5 implements getTextContent() with
    // `for await (const v of readableStream)`, which needs the
    // ReadableStream async-iterator protocol — absent on Safari before 17.4
    // (March 2024). The reader-loop form works on every browser that
    // ships ReadableStream.
    try {
      const NOTIFY_INTERVAL = 5; // update UI every N pages
      for (let i = 1; i <= pdfDoc.pageCount; i++) {
        if (!this._documents.has(pdfDoc.fileName)) return; // closed
        const page = await pdfDoc.doc.getPage(i);
        const collected: TextItem[] = [];
        const reader = page.streamTextContent().getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const it of value.items) collected.push(it as TextItem);
          }
        } finally {
          reader.releaseLock();
        }
        const items: PdfTextItem[] = [];
        for (const ti of collected) {
          if (!ti.str) continue;
          // Skip degenerate whitespace-only items with absurd widths — pdf.js emits
          // these as inter-column spacers in some PDFs and they cover the entire page,
          // blocking click detection and polluting search results.
          if (!ti.str.trim() && ti.width > 100) continue;
          // Fix pdf.js false word breaks: large kerning adjustments (e.g. W→R, W→M)
          // trigger pdf.js's word-break heuristic, inserting spaces into single text
          // runs like "CPU_PWROK" → "CPU_PW ROK". Strip spaces between word chars
          // within a single item — real word boundaries are between separate items.
          // EXCEPTION: keep a space between two digits, so a designator immediately
          // followed by adjacent pin numbers ("R5960 1 3") is not fused into one
          // un-lookup-able token ("R596013"). Kerning false-breaks are alphabetic;
          // designator↔pin boundaries are digit↔digit.
          const str = ti.str.replace(/(\w) (?=(\w))/g, (m, l, r) =>
            /\d/.test(l) && /\d/.test(r) ? m : l);
          items.push({
            str,
            transform: ti.transform,
            width: ti.width,
            height: ti.height,
            // pdf.js TextItem from getTextContent({includeMarkedContent:false})
            // does not declare fontName in its public type, but the runtime
            // value is present (worker fills it). Narrow at this boundary.
            fontName: (ti as unknown as { fontName?: string }).fontName ?? '',
          });
        }
        pdfDoc.textPages.push(items);
        if (i % NOTIFY_INTERVAL === 0) this.notify(); // progress update
      }
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.pdf.error('text extraction failed:', detail, err);
    }

    this.notify();

    // Persist to IndexedDB for next time.
    if (pdfDoc.textPages.length === pdfDoc.pageCount) {
      boardCache.putPdfText(pdfDoc.fileName, pdfDoc.fileSize, pdfDoc.fileLastModified, pdfDoc.textPages).catch(() => {});

      // Trigger fast-path backend indexing when the doc has a databank file ID
      // (i.e. it was opened from the library). Ad-hoc opens (drag-drop) have no
      // fileId and are skipped — the backend never gets those files anyway.
      if (pdfDoc.fileId != null) {
        void ensureIndexed(pdfDoc.fileId, () =>
          pdfDoc.textPages.map((page) => page.map((item) => item.str)),
        );
      }
    }

    // Watermark sizes are computed lazily per page on first render — the
    // calculation is just an iteration over textPages[pageIndex], cheap
    // enough to do on demand without a background prewarm.
  }

  /** Return the effective PDFDocumentProxy (stripped if clean mode is on). */
  private _effectiveDoc(d: PdfDocument): PDFDocumentProxy {
    return (d.cleanMode && d.strippedDoc) ? d.strippedDoc : d.doc;
  }

  async getPage(pageNum: number): Promise<PDFPageProxy> {
    const active = this._active;
    if (!active) throw new Error('No PDF loaded');
    return this._effectiveDoc(active).getPage(pageNum);
  }

  /** Get a page from a specific document (does not require it to be active). */
  async getPageFor(fileName: string, pageNum: number): Promise<PDFPageProxy> {
    const d = this._documents.get(fileName);
    if (!d) throw new Error(`PDF not loaded: ${fileName}`);
    return this._effectiveDoc(d).getPage(pageNum);
  }

  /** Reload a PDF with fontExtraProperties enabled (for glyph debug). Returns the new doc proxy. */
  async reloadWithFontData(fileName: string): Promise<PDFDocumentProxy | null> {
    const pdfDoc = this._documents.get(fileName);
    if (!pdfDoc) return null;
    const buffer = pdfDoc.originalBuffer.slice(0);
    const oldDoc = pdfDoc.doc;
    const doc = await pdfjsLib.getDocument({
      data: buffer,
      fontExtraProperties: true,
      ..._getDocOpts,
    }).promise;
    pdfDoc.doc = doc;
    // Clean up old proxy (safe — only tears down worker connection)
    oldDoc.destroy().catch(() => {});
    this.notify();
    return doc;
  }

  /** Get the effective PDFDocumentProxy for a loaded document. */
  getDocProxy(fileName: string): PDFDocumentProxy | null {
    const d = this._documents.get(fileName);
    return d ? (d.cleanMode && d.strippedDoc ? d.strippedDoc : d.doc) : null;
  }

  /** Flush pdf.js's per-page `intentStates` so the next render re-parses
   *  the content stream. Needed when the watermark filter changes: pdf.js
   *  keys `intentStates` only on rendering intent + annotation hash, so a
   *  filter toggle alone doesn't invalidate the cached operator list.
   *  Called from the filter-change subscription in PdfViewerPanel. */
  flushOperatorListCache(fileName?: string): void {
    const docs = fileName
      ? ([this._documents.get(fileName)].filter(Boolean) as PdfDocument[])
      : Array.from(this._documents.values());
    for (const doc of docs) {
      // Keep loaded fonts — they're expensive to re-fetch and don't depend
      // on watermark filtering.
      doc.doc?.cleanup(true).catch(() => { /* in-flight render — fine */ });
      doc.strippedDoc?.cleanup(true).catch(() => { /* same */ });
    }
  }

  /** Toggle clean mode: strip small watermark images from the PDF data. */
  async toggleClean(fileName: string, enabled: boolean) {
    const d = this._documents.get(fileName);
    if (!d) return;
    d.cleanMode = enabled;

    if (enabled && !d.strippedDoc) {
      const t0 = performance.now();
      try {
        const stripped = await stripWatermarkImages(d.originalBuffer);
        const tStrip = performance.now();
        d.strippedDoc = await pdfjsLib.getDocument({ data: stripped, ..._getDocOpts }).promise;
        const tLoad = performance.now();
        const metrics = {
          file: fileName,
          stripMs: Math.round(tStrip - t0),
          reloadMs: Math.round(tLoad - tStrip),
          totalMs: Math.round(tLoad - t0),
          origSize: d.originalBuffer.byteLength,
          strippedSize: stripped.byteLength,
        };
        log.perf.log(JSON.stringify(metrics));
      } catch (err) {
        log.pdf.error('stripWatermarkImages failed:', err);
        d.cleanMode = false;
      }
    }

    this.notify();
  }

  isDocClean(fileName: string): boolean {
    return this._documents.get(fileName)?.cleanMode ?? false;
  }

  goToPage(n: number) {
    const active = this._active;
    if (!active) return;
    if (n < 1 || n > active.pageCount) return;
    if (n === active.currentPage) return;
    active.currentPage = n;
    this.notify();
  }

  /** Rotate the named doc 90° in the given direction. While rotated the layout
   *  is forced single-page (continuous can't stack rotated pages cleanly), but
   *  the user's chosen `pageMode` is preserved — see `isDocSinglePage` — so
   *  returning to 0° restores their continuous-scroll preference. */
  rotate(fileName: string, dir: 'cw' | 'ccw') {
    const d = this._documents.get(fileName);
    if (!d) return;
    const delta = dir === 'cw' ? 90 : -90;
    d.rotation = (((d.rotation + delta) % 360) + 360) % 360;
    this.notify();
  }

  /** Rotate the active doc (keyboard shortcuts). */
  rotateActive(dir: 'cw' | 'ccw') {
    if (this._activeFileName) this.rotate(this._activeFileName, dir);
  }

  /** Toggle the named doc's horizontal mirror. */
  toggleMirror(fileName: string) {
    const d = this._documents.get(fileName);
    if (!d) return;
    d.mirror = !d.mirror;
    this.notify();
  }

  /** Toggle the active doc's mirror (keyboard shortcut). */
  mirrorActive() {
    if (this._activeFileName) this.toggleMirror(this._activeFileName);
  }

  /** Reset the named doc to unrotated. */
  resetRotation(fileName: string) {
    const d = this._documents.get(fileName);
    if (!d || d.rotation === 0) return;
    d.rotation = 0;
    this.notify();
  }

  /** Set the page layout mode. Switching to 'continuous' is ignored while the
   *  doc is rotated — rotation pins the layout to single-page. */
  setPageMode(fileName: string, mode: 'single' | 'continuous') {
    const d = this._documents.get(fileName);
    if (!d) return;
    if (mode === 'continuous' && d.rotation !== 0) return;
    if (d.pageMode === mode) return;
    d.pageMode = mode;
    this.notify();
  }

  togglePageMode(fileName: string) {
    const d = this._documents.get(fileName);
    if (!d) return;
    this.setPageMode(fileName, d.pageMode === 'single' ? 'continuous' : 'single');
  }

  // INVARIANT: in-document search runs entirely on in-memory textPages and must
  // NEVER depend on the backend pdfindex state. See docs/PDF_VIEWER.md#ctrl-f.
  searchText(query: string, source: 'user' | 'lookup' = 'user') {
    if (!this._active) return;
    this._runSearch(this._active, query, source, true);
  }

  /**
   * Heuristic lookup of a component designator or net name into a specific PDF.
   * Searches `primary` (so EVERY occurrence is highlighted), then re-picks the
   * active occurrence by scoring how much of `context` (the entity's nets +
   * pin tokens, or a net's connected designators) sits around each occurrence —
   * the schematic symbol placement wins over BOM / cross-reference rows. Falls
   * back to the plain page-proximity pick when there is no context signal.
   */
  lookupEntity(fileName: string, primary: string, context: LookupContextTerm[], source: 'lookup' = 'lookup') {
    const doc = this._documents.get(fileName);
    if (!doc || !primary.trim()) return;
    this._runSearch(doc, primary, source, false);
    if (doc.matches.length > 1) {
      // Re-pick among occurrences by context proximity + biggest font (the
      // scorer falls back to font, then page-proximity, when context is sparse).
      this._applyContextScoring(doc, context);
    }
  }

  /**
   * Run a search against a specific document (not necessarily the active one).
   * useClickedLocation: when true, prefer the exact match at the last clicked
   * (pageIndex,itemIndex) IF that click was in this same doc — used by in-doc
   * search. Cross-probe passes false (the click was in the *other* doc).
   */
  private _runSearch(
    doc: PdfDocument,
    query: string,
    source: 'user' | 'lookup',
    useClickedLocation: boolean,
  ) {
    const prevPage = doc.currentPage;

    doc.searchQuery = query;
    doc.searchSource = query ? source : null;
    doc.lookupHint = null;
    doc.crossProbeHint = null;
    doc.matches = [];
    doc.matchGroups = [];
    doc.activeMatchIndex = -1;
    doc.activeGroupIndex = -1;

    if (!query) {
      doc.activeMatchIndicesCache = new Set();
      doc.matchesByPage = new Map();
      this.notify();
      return;
    }

    if (query.includes('@')) {
      this._searchAtSyntax(doc, query.split('@').map(t => t.trim()).filter(t => t.length > 0));
    } else {
      const terms = query.split(/\s+/).filter(t => t.length > 0);
      if (terms.length > 1) this._searchMultiTerm(doc, terms);
      else this._searchSingleTerm(doc, query);
    }

    doc.matchesByPage = new Map();
    for (const m of doc.matches) {
      let arr = doc.matchesByPage.get(m.pageIndex);
      if (!arr) { arr = []; doc.matchesByPage.set(m.pageIndex, arr); }
      arr.push(m);
    }

    if (doc.matches.length > 0) {
      let bestIdx = -1;
      if (useClickedLocation) {
        const loc = this._lastClickedLocation;
        if (loc && loc.fileName === doc.fileName) {
          for (let i = 0; i < doc.matches.length; i++) {
            const m = doc.matches[i];
            if (m.pageIndex === loc.pageIndex && m.itemIndex === loc.itemIndex) { bestIdx = i; break; }
          }
          this._lastClickedLocation = null; // consume
        }
      }

      if (bestIdx < 0) {
        const prevPageIdx = prevPage - 1;
        bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < doc.matches.length; i++) {
          const dist = Math.abs(doc.matches[i].pageIndex - prevPageIdx);
          if (dist < bestDist) { bestDist = dist; bestIdx = i; if (dist === 0) break; }
        }
      }

      if (doc.matchGroups.length > 0) {
        const g = doc.matchGroups.findIndex(group => group.includes(bestIdx));
        doc.activeGroupIndex = g >= 0 ? g : 0;
        doc.activeMatchIndex = doc.matchGroups[doc.activeGroupIndex][0];
      } else {
        doc.activeMatchIndex = bestIdx;
        doc.activeGroupIndex = -1;
      }
      doc.currentPage = doc.matches[doc.activeMatchIndex].pageIndex + 1;
    }

    this._rebuildActiveIndicesCache(doc);
    this.notify();
  }

  private _rebuildActiveIndicesCache(d: PdfDocument) {
    if (d.matchGroups.length > 0 && d.activeGroupIndex >= 0) {
      d.activeMatchIndicesCache = new Set(d.matchGroups[d.activeGroupIndex]);
    } else if (d.activeMatchIndex >= 0) {
      d.activeMatchIndicesCache = new Set([d.activeMatchIndex]);
    } else {
      d.activeMatchIndicesCache = new Set();
    }
  }

  /**
   * Re-pick the active match among already-found `primary` occurrences using
   * the geometric scorer in pdf-lookup-score. Only scans pages that contain a
   * match (few) and a capped number of context-term hits — no extra
   * full-document passes. Nets are matched in cross-item dense text; pin tokens
   * are matched as discrete glyph-run items (their own text items), which also
   * sidesteps dense-text concatenation false-positives like "1"+"2" → "12".
   */
  private _applyContextScoring(doc: PdfDocument, context: LookupContextTerm[]) {
    if (doc.matches.length === 0) return;

    const nets: string[] = [];
    const pins: string[] = [];
    for (const t of context) {
      const norm = t.text.trim().toLowerCase();
      if (!norm) continue;
      if (t.kind === 'net') nets.push(norm);
      // Keep only distinctive pin names (ball coords like "A1"); drop purely
      // numeric pin numbers — they are sequential, non-distinctive, and appear
      // densely in pin/connector tables, biasing the pick toward those tables.
      else if (!/^\d+$/.test(norm)) pins.push(norm);
    }

    const candidates: LookupCandidate[] = doc.matches.map((m, i) => ({
      matchIndex: i,
      page: m.pageIndex,
      x: m.item.transform[4],
      y: m.item.transform[5],
      fontSize: pdfFontSize(m.item.transform) || 10,
    }));

    const pages = new Set<number>();
    for (const m of doc.matches) pages.add(m.pageIndex);

    const pinSet = new Set(pins);
    const contextHits: LookupContextHit[] = [];
    // Skip the page scans entirely when there is no net/pin context — the
    // scorer still runs (below) and falls back to biggest-font / proximity.
    for (const pi of (nets.length || pinSet.size) ? pages : []) {
      const items = doc.textPages[pi];
      if (!items) continue;
      const lines = mergeItemsIntoLines(items);
      // Nets — cross-item dense-text substring (an identifier may be split).
      for (const net of nets) {
        let count = 0;
        for (const line of lines) {
          if (count >= this._lookupTermCap) break;
          const lower = line.denseText.toLowerCase();
          let pos = 0;
          while ((pos = lower.indexOf(net, pos)) !== -1 && count < this._lookupTermCap) {
            let ii = -1;
            for (let c = pos; c < pos + net.length; c++) {
              if (line.denseCharToItem[c] >= 0) { ii = line.denseCharToItem[c]; break; }
            }
            if (ii >= 0) {
              const it = items[ii];
              contextHits.push({ page: pi, x: it.transform[4], y: it.transform[5], term: 'net:' + net, weight: 2 });
              count++;
            }
            pos += net.length;
          }
        }
      }
      // Pins — discrete glyph-run items (pin numbers are their own text items).
      if (pinSet.size > 0) {
        for (const it of items) {
          const s = it.str.trim().toLowerCase();
          if (s && pinSet.has(s)) {
            contextHits.push({ page: pi, x: it.transform[4], y: it.transform[5], term: 'pin:' + s, weight: 1 });
          }
        }
      }
    }

    const result = scoreLookupCandidates(
      candidates, contextHits,
      { xGapMul: this._lookupXGap, yGapMul: this._lookupYGap },
      doc.currentPage - 1,
    );
    // -1 → no context AND no font signal; keep _runSearch's page-proximity pick.
    if (result.bestMatchIndex < 0) return;

    doc.activeMatchIndex = result.bestMatchIndex;
    doc.activeGroupIndex = -1;
    doc.currentPage = doc.matches[result.bestMatchIndex].pageIndex + 1;
    this._rebuildActiveIndicesCache(doc);
    log.pdf.log(`lookup score: best match #${result.bestMatchIndex} on page ${doc.currentPage} (${contextHits.length} ctx hits)`);
    this.notify();
  }

  /** TERM1@TERM2 syntax: whole-page co-occurrence, one group per page where all terms appear.
   *  No proximity window — any position on the page counts. Zoom fits all terms in view. */
  private _searchAtSyntax(d: PdfDocument, terms: string[]) {
    if (terms.length === 0) return;
    const termsLower = terms.map(t => t.toLowerCase());

    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const lines = mergeItemsIntoLines(items);
      const pageMatches: PdfTextMatch[] = [];
      let allFound = true;

      for (const term of termsLower) {
        let found = false;
        for (const line of lines) {
          // Dense text — @-separated terms are whitespace-free identifiers.
          const lower = line.denseText.toLowerCase();
          const pos = lower.indexOf(term);
          if (pos !== -1) {
            // Find the primary item for this match (first contributing item)
            let bestItem = -1;
            let bestCharStart = 0;
            for (let c = pos; c < pos + term.length; c++) {
              if (line.denseCharToItem[c] >= 0) { bestItem = line.denseCharToItem[c]; bestCharStart = line.denseCharToOffset[c]; break; }
            }
            if (bestItem >= 0) {
              pageMatches.push({ pageIndex: pi, itemIndex: bestItem, charStart: bestCharStart, charEnd: Math.min(bestCharStart + term.length, items[bestItem].str.length), item: items[bestItem] });
              found = true;
              break; // first occurrence per term per page
            }
          }
        }
        if (!found) { allFound = false; break; }
      }

      if (allFound && pageMatches.length === terms.length) {
        const groupIndices: number[] = [];
        for (const m of pageMatches) { groupIndices.push(d.matches.length); d.matches.push(m); }
        d.matchGroups.push(groupIndices);
      }
    }
  }

  private _searchSingleTerm(d: PdfDocument, query: string) {
    const qLower = query.toLowerCase();
    // Single-term queries never contain spaces (multi-term branches split on
    // \s+), so search the dense line text — that way identifiers like
    // "-PWRSW_EC" still match when pdf.js splits the glyph run with a wide
    // reported gap between "-" and "PWRSW_EC".
    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const lines = mergeItemsIntoLines(items);
      for (const line of lines) {
        const lower = line.denseText.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(qLower, pos)) !== -1) {
          // Map match back to original items — find all items that contribute to this match
          const matchEnd = pos + qLower.length;
          const itemsHit = new Set<number>();
          for (let c = pos; c < matchEnd; c++) {
            if (line.denseCharToItem[c] >= 0) itemsHit.add(line.denseCharToItem[c]);
          }
          // Create a match for each item that contributes (so all get highlighted)
          for (const ii of itemsHit) {
            const item = items[ii];
            // Compute char range within this specific item
            let itemCharStart = item.str.length, itemCharEnd = 0;
            for (let c = pos; c < matchEnd; c++) {
              if (line.denseCharToItem[c] === ii) {
                itemCharStart = Math.min(itemCharStart, line.denseCharToOffset[c]);
                itemCharEnd = Math.max(itemCharEnd, line.denseCharToOffset[c] + 1);
              }
            }
            d.matches.push({
              pageIndex: pi,
              itemIndex: ii,
              charStart: itemCharStart,
              charEnd: itemCharEnd,
              item,
            });
          }
          pos += qLower.length;
        }
      }
    }
  }

  private _searchMultiTerm(d: PdfDocument, terms: string[]) {
    const termsLower = terms.map(t => t.toLowerCase());

    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const lines = mergeItemsIntoLines(items);

      // Find all hits per term using dense line text (each term is split on
      // \s+ so it never contains whitespace — identifiers split across items
      // by pdf.js must still match).
      const termHits: { ii: number; charStart: number; charEnd: number; x: number; y: number; fontSize: number }[][] = [];
      for (const term of termsLower) {
        const hits: typeof termHits[0] = [];
        for (const line of lines) {
          const lower = line.denseText.toLowerCase();
          let pos = 0;
          while ((pos = lower.indexOf(term, pos)) !== -1) {
            // Find the primary item for spatial positioning
            let primaryItem = -1;
            let primaryCharStart = 0;
            for (let c = pos; c < pos + term.length; c++) {
              if (line.denseCharToItem[c] >= 0) {
                primaryItem = line.denseCharToItem[c];
                primaryCharStart = line.denseCharToOffset[c];
                break;
              }
            }
            if (primaryItem >= 0) {
              const pItem = items[primaryItem];
              const fs = pdfFontSize(pItem.transform) || line.fontSize;
              hits.push({
                ii: primaryItem,
                charStart: primaryCharStart,
                charEnd: Math.min(primaryCharStart + term.length, pItem.str.length),
                x: pItem.transform[4],
                y: pItem.transform[5],
                fontSize: fs,
              });
            }
            pos += term.length;
          }
        }
        termHits.push(hits);
      }

      if (termHits.some(h => h.length === 0)) continue;

      for (const anchor of termHits[0]) {
        const groupIndices: number[] = [];

        const anchorIdx = d.matches.length;
        d.matches.push({
          pageIndex: pi,
          itemIndex: anchor.ii,
          charStart: anchor.charStart,
          charEnd: anchor.charEnd,
          item: items[anchor.ii],
        });
        groupIndices.push(anchorIdx);

        const xTol = anchor.fontSize * this._multiTermXGap;
        let prevY = anchor.y;
        const maxGap = anchor.fontSize * this._multiTermYGap;
        let chainOk = true;

        for (let ti = 1; ti < termsLower.length; ti++) {
          let best: typeof termHits[0][0] | null = null;
          let bestDist = Infinity;

          for (const hit of termHits[ti]) {
            if (hit.y >= prevY) continue;
            if (Math.abs(hit.x - anchor.x) > xTol) continue;
            const dist = prevY - hit.y;
            if (dist > maxGap) continue;
            if (dist < bestDist) {
              bestDist = dist;
              best = hit;
            }
          }

          if (!best) {
            chainOk = false;
            break;
          }

          const matchIdx = d.matches.length;
          d.matches.push({
            pageIndex: pi,
            itemIndex: best.ii,
            charStart: best.charStart,
            charEnd: best.charEnd,
            item: items[best.ii],
          });
          groupIndices.push(matchIdx);
          prevY = best.y;
        }

        if (chainOk) {
          d.matchGroups.push(groupIndices);
        } else {
          d.matches.length = anchorIdx;
        }
      }
    }
  }

  nextMatch() { this._stepMatch(1); }
  prevMatch() { this._stepMatch(-1); }

  /** Set the active match to a specific index (silent — won't re-trigger nav UI). */
  setActiveMatchIndex(idx: number) {
    const d = this._active;
    if (!d || idx < 0 || idx >= d.matches.length) return;
    d.activeMatchIndex = idx;
    if (d.matchGroups.length > 0) {
      const g = d.matchGroups.findIndex(group => group.includes(idx));
      if (g >= 0) d.activeGroupIndex = g;
    }
    d.currentPage = d.matches[idx].pageIndex + 1;
    this._rebuildActiveIndicesCache(d);
    this.notify();
  }

  private _stepMatch(delta: 1 | -1) {
    if (!this._active) return;
    this._stepMatchInDoc(this._active, delta);
  }

  private _stepMatchInDoc(d: PdfDocument, delta: 1 | -1) {
    if (d.matches.length === 0) return;
    if (d.matchGroups.length > 0) {
      d.activeGroupIndex = (d.activeGroupIndex + delta + d.matchGroups.length) % d.matchGroups.length;
      d.activeMatchIndex = d.matchGroups[d.activeGroupIndex][0];
    } else {
      d.activeMatchIndex = (d.activeMatchIndex + delta + d.matches.length) % d.matches.length;
    }
    d.currentPage = d.matches[d.activeMatchIndex].pageIndex + 1;
    this._rebuildActiveIndicesCache(d);
    this.notify();
  }

  // ── PDF↔PDF cross-lookup ──────────────────────────────────────────────
  /** The persisted partner for fileName (open or not), or null. */
  getLinkedDoc(fileName: string): string | null { return this._links.get(fileName); }

  /** The partner only if it is currently open, or null. */
  getLiveLinkedDoc(fileName: string): string | null {
    return this._links.getLive(fileName, (f) => this._documents.has(f));
  }

  /** Establish a symmetric 1:1 link between two open PDFs. */
  linkDocs(a: string, b: string): void {
    this._links.link(a, b);
    this.notify();
  }

  /** Remove the link on a (and its partner). */
  unlinkDoc(a: string): void {
    this._links.unlink(a);
    this.notify();
  }

  /**
   * Drive the linked document's search for `word`:
   *  - first probe (or a different word): run a fresh search, jump to the match
   *    nearest the target's current page;
   *  - re-probing the same word: advance to the next occurrence (cycle).
   * Sets a hint on the SOURCE doc when the partner is closed or has no match.
   * Never changes the active document.
   */
  crossProbe(sourceFileName: string, word: string): void {
    const source = this._documents.get(sourceFileName) ?? null;
    const targetName = this.getLiveLinkedDoc(sourceFileName);
    if (!targetName) {
      if (source && this._links.get(sourceFileName)) {
        source.crossProbeHint = 'Linked PDF not open';
        this.notify();
      }
      return;
    }
    const target = this._documents.get(targetName);
    if (!target) return;

    const q = word.trim();
    if (!q) return;

    const sameQuery = target.searchQuery.toUpperCase() === q.toUpperCase();
    if (sameQuery && target.searchSource === 'lookup' && target.matches.length > 0) {
      if (source) source.crossProbeHint = null;   // success — clear any stale hint
      this._stepMatchInDoc(target, 1);             // cycle to next occurrence (notifies)
      return;
    }

    this._runSearch(target, q, 'lookup', false);   // fresh search (notifies)
    if (source) {
      source.crossProbeHint = target.matches.length === 0
        ? `No match for ${q} in ${targetName}`
        : null;
      this.notify();
    }
  }

  setMultiTermYGap(value: number) {
    this._multiTermYGap = value;
    this._rerunMultiTerm();
  }

  setMultiTermXGap(value: number) {
    this._multiTermXGap = value;
    this._rerunMultiTerm();
  }

  private _rerunMultiTerm() {
    const active = this._active;
    if (active?.searchQuery && this.isMultiTerm) {
      this.searchText(active.searchQuery, active.searchSource ?? 'user');
    } else {
      this.notify();
    }
  }

  getTextItemsForPage(pageIndex: number): PdfTextItem[] {
    return this._active?.textPages[pageIndex] ?? [];
  }

  getMatchesForPage(pageIndex: number): PdfTextMatch[] {
    return this._active?.matchesByPage.get(pageIndex) ?? [];
  }

  getDocTextItemsForPage(fileName: string, pageIndex: number): PdfTextItem[] {
    return this._documents.get(fileName)?.textPages[pageIndex] ?? [];
  }

  // Watermark filtering used to live here as a `getWatermarkSizes` +
  // `invalidateWatermarkSizes` pair driving a client-side `operationsFilter`
  // callback. That whole machinery is gone — the patched pdf.js worker now
  // drops watermark `showText` ops at parse time, so the operator stream
  // never carries them. See `src/frontend/patches/README.md`.

  /** Count occurrences of `query` across all pages of a loaded document.
   *  Searches merged-line dense text so identifiers split across pdf.js
   *  text items (e.g. "-PWRSW_EC" rendered as "-" + "PWRSW_EC") still count. */
  countTextMatches(fileName: string, query: string): number {
    const doc = this._documents.get(fileName);
    if (!doc?.textPages || !query) return 0;
    const ql = query.toLowerCase();
    let count = 0;
    for (const pageItems of doc.textPages) {
      const lines = mergeItemsIntoLines(pageItems);
      for (const line of lines) {
        const text = line.denseText.toLowerCase();
        let pos = 0;
        while ((pos = text.indexOf(ql, pos)) !== -1) {
          count++;
          pos += ql.length;
        }
      }
    }
    return count;
  }

  /** Async version of countTextMatches that yields to the event loop every N
   *  pages so it doesn't block the main thread. Used by the right-click
   *  context menu, which opens instantly with placeholder counts and fills
   *  them in as each promise resolves.
   *
   *  Returns -1 if the AbortSignal fires (caller can ignore the result).
   *  Yields every 8 pages — small enough to keep the UI responsive even on
   *  100+ page PDFs, large enough that the per-page cost dominates the
   *  per-yield setTimeout cost. */
  async countTextMatchesAsync(
    fileName: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<number> {
    const doc = this._documents.get(fileName);
    if (!doc?.textPages || !query) return 0;
    const ql = query.toLowerCase();
    let count = 0;
    let pagesSinceYield = 0;
    for (const pageItems of doc.textPages) {
      if (signal?.aborted) return -1;
      const lines = mergeItemsIntoLines(pageItems);
      for (const line of lines) {
        const text = line.denseText.toLowerCase();
        let pos = 0;
        while ((pos = text.indexOf(ql, pos)) !== -1) {
          count++;
          pos += ql.length;
        }
      }
      if (++pagesSinceYield >= 8) {
        pagesSinceYield = 0;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }
    return count;
  }

  getDocMatchesForPage(fileName: string, pageIndex: number): PdfTextMatch[] {
    return this._documents.get(fileName)?.matchesByPage.get(pageIndex) ?? [];
  }

  // --- Follow target (silent navigation, no highlights) ---

  /** Navigate to the first page containing `query` and set a zoom target, without highlighting. */
  navigateToText(query: string): void {
    const d = this._active;
    if (!d || d.textPages.length === 0) {
      log.pdf.log(`navigateToText: no active doc or no text pages`);
      return;
    }

    const terms = query.split('@').map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
    if (terms.length === 0) return;

    // Format: net@component — last term is component (mandatory), preceding are nets (optional)
    const component = terms[terms.length - 1]; // component name — mandatory
    const nets = terms.slice(0, -1); // net names — optional disambiguation

    log.pdf.log(`navigateToText: component="${component}" nets=[${nets.join(', ')}] pages=${d.textPages.length}`);

    let fallbackPage = -1;
    let fallbackItems: PdfTextItem[] = [];

    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const lines = mergeItemsIntoLines(items);

      // Check mandatory primary term (component name) first — dense text so
      // identifiers split across items by pdf.js still match.
      let primaryItem: PdfTextItem | null = null;
      for (const line of lines) {
        const pos = line.denseText.toLowerCase().indexOf(component);
        if (pos !== -1) {
          // Find the first contributing item for zoom target
          for (let c = pos; c < pos + component.length; c++) {
            if (line.denseCharToItem[c] >= 0) { primaryItem = items[line.denseCharToItem[c]]; break; }
          }
          if (primaryItem) break;
        }
      }
      if (!primaryItem) continue;

      // Track first page with component name as fallback
      if (fallbackPage === -1) {
        fallbackPage = pi;
        fallbackItems = [primaryItem];
      }

      if (nets.length > 0) {
        // Try to match all net terms on this page for best disambiguation
        const matchedItems: PdfTextItem[] = [primaryItem];
        let allNetsFound = true;
        for (const net of nets) {
          let netItem: PdfTextItem | null = null;
          for (const line of lines) {
            const pos = line.denseText.toLowerCase().indexOf(net);
            if (pos !== -1) {
              for (let c = pos; c < pos + net.length; c++) {
                if (line.denseCharToItem[c] >= 0) { netItem = items[line.denseCharToItem[c]]; break; }
              }
              if (netItem) break;
            }
          }
          if (!netItem) { allNetsFound = false; break; }
          matchedItems.push(netItem);
        }
        if (allNetsFound) {
          log.pdf.log(`navigateToText: full match on page ${pi + 1} (${matchedItems.length} items)`);
          d.currentPage = pi + 1;
          this._followTarget = { pageIndex: pi, items: matchedItems };
          this.notify();
          return;
        }
      } else {
        // No nets — primary-only match is sufficient
        log.pdf.log(`navigateToText: primary-only match on page ${pi + 1}`);
        d.currentPage = pi + 1;
        this._followTarget = { pageIndex: pi, items: [primaryItem] };
        this.notify();
        return;
      }
    }

    // Fallback: navigate to first page with component name
    if (fallbackPage !== -1) {
      log.pdf.log(`navigateToText: fallback to page ${fallbackPage + 1} (primary only, nets not all found)`);
      d.currentPage = fallbackPage + 1;
      this._followTarget = { pageIndex: fallbackPage, items: fallbackItems };
      this.notify();
    } else {
      log.pdf.log(`navigateToText: no match found for "${component}"`);
    }
  }

  /** Show a "double-click to search" tooltip for a specific PDF document. */
  setLookupHint(fileName: string, componentName: string): void {
    const d = this._documents.get(fileName);
    if (!d) return;
    d.lookupHint = componentName;
    this.notify();
  }

  /** Clear the lookup hint (e.g. on timeout or user interaction). */
  clearLookupHint(fileName: string): void {
    const d = this._documents.get(fileName);
    if (!d || !d.lookupHint) return;
    d.lookupHint = null;
    this.notify();
  }

  /** Clear the cross-probe hint (e.g. on timeout). */
  clearCrossProbeHint(fileName: string): void {
    const d = this._documents.get(fileName);
    if (!d || !d.crossProbeHint) return;
    d.crossProbeHint = null;
    this.notify();
  }

  /** Consume the follow target (called by PdfViewerPanel after zooming). */
  consumeFollowTarget(): FollowTarget | null {
    const t = this._followTarget;
    this._followTarget = null;
    return t;
  }

  // --- Bookmarks ---

  addBookmark(page: number, zoom: number, panX: number, panY: number) {
    const d = this._active;
    if (!d) return;
    const bm: PdfBookmark = {
      id: bookmarkId(),
      page, zoom, panX, panY,
      label: `p${page}`,
    };
    d.bookmarks = [...d.bookmarks, bm];
    saveBookmarks(d.fileName, d.bookmarks);
    this.notify();
  }

  updateBookmark(id: string, page: number, zoom: number, panX: number, panY: number) {
    const d = this._active;
    if (!d) return;
    d.bookmarks = d.bookmarks.map(b =>
      b.id === id ? { ...b, page, zoom, panX, panY } : b,
    );
    saveBookmarks(d.fileName, d.bookmarks);
    this.notify();
  }

  renameBookmark(id: string, label: string) {
    const d = this._active;
    if (!d) return;
    d.bookmarks = d.bookmarks.map(b =>
      b.id === id ? { ...b, label: label || `p${b.page}` } : b,
    );
    saveBookmarks(d.fileName, d.bookmarks);
    this.notify();
  }

  removeBookmark(id: string) {
    const d = this._active;
    if (!d) return;
    d.bookmarks = d.bookmarks.filter(b => b.id !== id);
    saveBookmarks(d.fileName, d.bookmarks);
    this.notify();
  }

  /** Close the active document and remove it from memory */
  close() {
    const d = this._active;
    if (d) {
      d.doc.destroy();
      d.strippedDoc?.destroy();
      this._documents.delete(d.fileName);
    }
    this._activeFileName = null;
    this.notify();
  }

  /** Debug: dump extracted text to a new browser tab for inspection.
   *  Shows raw items, merged lines, and item boundaries per page. */
  dumpTextToNewTab(fileName?: string) {
    const d = fileName ? this._documents.get(fileName) : this._active;
    if (!d) { log.pdf.warn('dumpText: no document'); return; }

    const lines: string[] = [];
    lines.push('<!DOCTYPE html><html><head><meta charset="utf-8">');
    lines.push(`<title>PDF Text Dump: ${d.fileName}</title>`);
    lines.push('<style>');
    lines.push('body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; margin: 20px; }');
    lines.push('h1 { color: #00d4ff; }');
    lines.push('h2 { color: #ff6b9d; border-bottom: 1px solid #333; padding-bottom: 4px; margin-top: 32px; }');
    lines.push('h3 { color: #ffd93d; margin-top: 16px; }');
    lines.push('.item { background: #16213e; padding: 2px 6px; margin: 1px 0; border-left: 3px solid #0f3460; }');
    lines.push('.merged { background: #1a3a2a; padding: 4px 8px; margin: 2px 0; border-left: 3px solid #00b894; white-space: pre-wrap; word-break: break-all; }');
    lines.push('.meta { color: #888; font-size: 0.85em; }');
    lines.push('.empty { color: #666; font-style: italic; }');
    lines.push('.stats { background: #2d2d44; padding: 8px 12px; border-radius: 4px; margin-bottom: 16px; }');
    lines.push('</style></head><body>');
    lines.push(`<h1>PDF Text Dump: ${this._escHtml(d.fileName)}</h1>`);
    lines.push(`<div class="stats">Pages: ${d.pageCount} | Extracted: ${d.textPages.length} | Total items: ${d.textPages.reduce((s, p) => s + p.length, 0)}</div>`);

    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const merged = mergeItemsIntoLines(items);
      lines.push(`<h2>Page ${pi + 1} (${items.length} items → ${merged.length} lines)</h2>`);

      // Merged lines view
      lines.push('<h3>Merged Lines</h3>');
      if (merged.length === 0) {
        lines.push('<div class="empty">No text on this page</div>');
      }
      for (let li = 0; li < merged.length; li++) {
        const ml = merged[li];
        lines.push(`<div class="merged">${this._escHtml(ml.text)} <span class="meta">[y=${ml.y.toFixed(1)} x=${ml.x.toFixed(1)} fs=${ml.fontSize.toFixed(1)} items=${ml.itemIndices.length}]</span></div>`);
      }

      // Raw items view
      lines.push('<h3>Raw Items</h3>');
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        const t = item.transform;
        lines.push(`<div class="item">[${ii}] "${this._escHtml(item.str)}" <span class="meta">x=${t[4].toFixed(1)} y=${t[5].toFixed(1)} w=${item.width.toFixed(1)} h=${item.height.toFixed(1)} font=${item.fontName}</span></div>`);
      }
    }

    lines.push('</body></html>');
    const blob = new Blob([lines.join('\n')], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    // Clean up after a delay
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  private _escHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /** Close a specific document by filename */
  closeFile(fileName: string) {
    const d = this._documents.get(fileName);
    if (!d) return;
    d.doc.destroy();
    d.strippedDoc?.destroy();
    this._documents.delete(fileName);
    if (this._activeFileName === fileName) {
      this._activeFileName = null;
    }
    this.notify();
  }
}

export const pdfStore = new PdfStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __pdfStore?: typeof pdfStore }).__pdfStore = pdfStore;
}
