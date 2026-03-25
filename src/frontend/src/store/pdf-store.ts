import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/pdf';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { PDFDocument, PDFName, PDFDict, PDFStream, PDFNumber, PDFRef, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { boardCache } from './board-cache';
import { log } from './log-store';

// In Electron (file:// protocol), Workers can't load file:// URLs.
// Import the worker module directly so pdfjs runs it on the main thread
// (sets globalThis.pdfjsWorker which pdfjs checks before spawning a Worker).
// In normal web mode, use workerSrc for a real Web Worker.
if (window.location.protocol === 'file:') {
  import('pdfjs-dist/build/pdf.worker.min.mjs');
} else {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
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
        // Significant gap — insert space
        text += ' ';
        charToItem.push(-1); // space doesn't belong to any item
        charToOffset.push(-1);
      }
    }

    for (let c = 0; c < li.item.str.length; c++) {
      text += li.item.str[c];
      charToItem.push(li.idx);
      charToOffset.push(c);
    }
  }

  return {
    text,
    charToItem,
    charToOffset,
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

type Listener = () => void;

const BOOKMARKS_KEY_PREFIX = 'boardripper-pdf-bookmarks-';

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
  textPages: PdfTextItem[][];
  searchQuery: string;
  matches: PdfTextMatch[];
  activeMatchIndex: number;
  matchGroups: number[][];
  activeGroupIndex: number;
  activeMatchIndicesCache: Set<number>;
  matchesByPage: Map<number, PdfTextMatch[]>;
  bookmarks: PdfBookmark[];
}

/** Follow target: a location to zoom to without highlighting */
export interface FollowTarget {
  pageIndex: number;     // 0-based page index
  items: PdfTextItem[];  // text items to zoom to (bounding box)
}

class PdfStore {
  private _documents: Map<string, PdfDocument> = new Map();
  private _activeFileName: string | null = null;
  /** Vertical distance multiplier for multi-term search (fontSize × this) */
  private _multiTermYGap = 4;
  /** Horizontal tolerance multiplier for multi-term search (fontSize × this) */
  private _multiTermXGap = 3;
  private _loading = false;
  private _listeners = new Set<Listener>();
  /** Consumable follow target — PDF viewer zooms to this location without highlighting */
  private _followTarget: FollowTarget | null = null;

  private get _active(): PdfDocument | null {
    return this._activeFileName ? this._documents.get(this._activeFileName) ?? null : null;
  }

  get fileName(): string { return this._active?.fileName ?? ''; }
  get pageCount(): number { return this._active?.pageCount ?? 0; }
  get currentPage(): number { return this._active?.currentPage ?? 1; }
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
  getDocTextExtracting(fileName: string): boolean {
    const d = this._documents.get(fileName);
    return d != null && d.textPages.length < d.pageCount;
  }
  getDocTextExtractProgress(fileName: string): number {
    const d = this._documents.get(fileName);
    if (!d || d.pageCount === 0) return 1;
    return d.textPages.length / d.pageCount;
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  /** Switch to an already-loaded PDF instantly (no I/O). */
  switchTo(fileName: string | null) {
    if (fileName === this._activeFileName) return;
    if (fileName && !this._documents.has(fileName)) return;
    this._activeFileName = fileName;
    this.notify();
  }

  /** Load a PDF into memory (or switch to it if already loaded). */
  async loadFile(file: File) {
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
      const buffer = await file.arrayBuffer();
      // Copy buffer before passing to pdf.js — getDocument() transfers/detaches the original
      const bufferCopy = buffer.slice(0);
      const doc = await pdfjsLib.getDocument({ data: bufferCopy }).promise;

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
        textPages: [],
        searchQuery: '',
        matches: [],
        activeMatchIndex: -1,
        matchGroups: [],
        activeGroupIndex: -1,
        activeMatchIndicesCache: new Set(),
        matchesByPage: new Map(),
        bookmarks: loadBookmarks(file.name),
      };
      this._documents.set(file.name, pdfDoc);
      this._activeFileName = file.name;
      this._loading = false;
      this.notify();

      // Extract text from all pages in the background so search becomes available.
      // The viewer can render pages immediately without waiting for this.
      this._extractText(pdfDoc);
    } catch (err) {
      log.pdf.error('loadFile failed:', err);
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
        pdfDoc.textPages = cached.map(page =>
          page.map(item => ({ ...item, fontName: (item as any).fontName ?? '' }))
        );
        this.notify();
        return;
      }
    } catch { /* cache miss — fall through to extraction */ }

    // Extract from PDF, notifying periodically for the progress bar.
    try {
      const NOTIFY_INTERVAL = 5; // update UI every N pages
      for (let i = 1; i <= pdfDoc.pageCount; i++) {
        if (!this._documents.has(pdfDoc.fileName)) return; // closed
        const page = await pdfDoc.doc.getPage(i);
        const content = await page.getTextContent();
        const items: PdfTextItem[] = [];
        for (const item of content.items) {
          const ti = item as TextItem;
          if (ti.str) {
            items.push({
              str: ti.str,
              transform: ti.transform,
              width: ti.width,
              height: ti.height,
              fontName: (ti as any).fontName ?? '',
            });
          }
        }
        pdfDoc.textPages.push(items);
        if (i % NOTIFY_INTERVAL === 0) this.notify(); // progress update
      }
    } catch (err) {
      log.pdf.error('text extraction failed:', err);
    }

    this.notify();

    // Persist to IndexedDB for next time.
    if (pdfDoc.textPages.length === pdfDoc.pageCount) {
      boardCache.putPdfText(pdfDoc.fileName, pdfDoc.fileSize, pdfDoc.fileLastModified, pdfDoc.textPages).catch(() => {});
    }
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
        d.strippedDoc = await pdfjsLib.getDocument({ data: stripped }).promise;
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

  searchText(query: string) {
    const active = this._active;
    if (!active) return;

    active.searchQuery = query;
    active.matches = [];
    active.matchGroups = [];
    active.activeMatchIndex = -1;
    active.activeGroupIndex = -1;

    if (!query) {
      active.activeMatchIndicesCache = new Set();
      active.matchesByPage = new Map();
      this.notify();
      return;
    }

    if (query.includes('@')) {
      this._searchAtSyntax(active, query.split('@').map(t => t.trim()).filter(t => t.length > 0));
    } else {
      const terms = query.split(/\s+/).filter(t => t.length > 0);
      if (terms.length > 1) {
        this._searchMultiTerm(active, terms);
      } else {
        this._searchSingleTerm(active, query);
      }
    }

    // Build per-page index
    active.matchesByPage = new Map();
    for (const m of active.matches) {
      let arr = active.matchesByPage.get(m.pageIndex);
      if (!arr) { arr = []; active.matchesByPage.set(m.pageIndex, arr); }
      arr.push(m);
    }

    if (active.matches.length > 0) {
      active.activeMatchIndex = 0;
      active.activeGroupIndex = active.matchGroups.length > 0 ? 0 : -1;
      active.currentPage = active.matches[0].pageIndex + 1;
    }
    this._rebuildActiveIndicesCache(active);
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
          const lower = line.text.toLowerCase();
          const pos = lower.indexOf(term);
          if (pos !== -1) {
            // Find the primary item for this match (first contributing item)
            let bestItem = -1;
            let bestCharStart = 0;
            for (let c = pos; c < pos + term.length; c++) {
              if (line.charToItem[c] >= 0) { bestItem = line.charToItem[c]; bestCharStart = line.charToOffset[c]; break; }
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
    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      const lines = mergeItemsIntoLines(items);
      for (const line of lines) {
        const lower = line.text.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(qLower, pos)) !== -1) {
          // Map match back to original items — find all items that contribute to this match
          const matchEnd = pos + qLower.length;
          const itemsHit = new Set<number>();
          for (let c = pos; c < matchEnd; c++) {
            if (line.charToItem[c] >= 0) itemsHit.add(line.charToItem[c]);
          }
          // Create a match for each item that contributes (so all get highlighted)
          for (const ii of itemsHit) {
            const item = items[ii];
            // Compute char range within this specific item
            let itemCharStart = item.str.length, itemCharEnd = 0;
            for (let c = pos; c < matchEnd; c++) {
              if (line.charToItem[c] === ii) {
                itemCharStart = Math.min(itemCharStart, line.charToOffset[c]);
                itemCharEnd = Math.max(itemCharEnd, line.charToOffset[c] + 1);
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

      // Find all hits per term using merged lines
      const termHits: { ii: number; charStart: number; charEnd: number; x: number; y: number; fontSize: number }[][] = [];
      for (const term of termsLower) {
        const hits: typeof termHits[0] = [];
        for (const line of lines) {
          const lower = line.text.toLowerCase();
          let pos = 0;
          while ((pos = lower.indexOf(term, pos)) !== -1) {
            // Find the primary item for spatial positioning
            let primaryItem = -1;
            let primaryCharStart = 0;
            for (let c = pos; c < pos + term.length; c++) {
              if (line.charToItem[c] >= 0) {
                primaryItem = line.charToItem[c];
                primaryCharStart = line.charToOffset[c];
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

  private _stepMatch(delta: 1 | -1) {
    const d = this._active;
    if (!d || d.matches.length === 0) return;
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

  setMultiTermYGap(value: number) {
    this._multiTermYGap = value;
    this._rerunMultiTerm();
  }

  setMultiTermXGap(value: number) {
    this._multiTermXGap = value;
    this._rerunMultiTerm();
  }

  private _rerunMultiTerm() {
    const query = this._active?.searchQuery;
    if (query && this.isMultiTerm) {
      this.searchText(query);
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

      // Check mandatory primary term (component name) first — search merged lines
      let primaryItem: PdfTextItem | null = null;
      for (const line of lines) {
        const pos = line.text.toLowerCase().indexOf(component);
        if (pos !== -1) {
          // Find the first contributing item for zoom target
          for (let c = pos; c < pos + component.length; c++) {
            if (line.charToItem[c] >= 0) { primaryItem = items[line.charToItem[c]]; break; }
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
            const pos = line.text.toLowerCase().indexOf(net);
            if (pos !== -1) {
              for (let c = pos; c < pos + net.length; c++) {
                if (line.charToItem[c] >= 0) { netItem = items[line.charToItem[c]]; break; }
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
      id: crypto.randomUUID(),
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

// Expose for integration tests (Playwright)
if (typeof window !== 'undefined') {
  (window as any).__pdfStore = pdfStore;
}
