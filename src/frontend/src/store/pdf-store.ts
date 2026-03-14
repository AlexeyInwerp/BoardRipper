import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/pdf';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString();

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
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

export interface PdfBookmark {
  id: string;
  page: number;    // 1-based
  zoom: number;
  panX: number;
  panY: number;
  label: string;   // user-editable, defaults to "p{page}"
}

type Listener = () => void;

const BOOKMARKS_KEY_PREFIX = 'boardviewer-pdf-bookmarks-';

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

/** Per-document state kept in memory for instant switching */
interface PdfDocument {
  doc: PDFDocumentProxy;
  fileName: string;
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

class PdfStore {
  private _documents: Map<string, PdfDocument> = new Map();
  private _activeFileName: string | null = null;
  /** Vertical distance multiplier for multi-term search (fontSize × this) */
  private _multiTermYGap = 4;
  /** Horizontal tolerance multiplier for multi-term search (fontSize × this) */
  private _multiTermXGap = 3;
  private _loading = false;
  private _listeners = new Set<Listener>();

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
    return q.split(/\s+/).filter(t => t.length > 0).length > 1;
  }
  get isLoaded(): boolean { return this._active?.doc != null; }
  get loading(): boolean { return this._loading; }
  get bookmarks(): PdfBookmark[] { return this._active?.bookmarks ?? []; }
  get activeMatchIndices(): Set<number> { return this._active?.activeMatchIndicesCache ?? new Set(); }

  /** All loaded PDF filenames */
  get loadedFileNames(): string[] { return [...this._documents.keys()]; }

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
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

      // Extract text from all pages
      const textPages: PdfTextItem[][] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
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
            });
          }
        }
        textPages.push(items);
      }

      const pdfDoc: PdfDocument = {
        doc,
        fileName: file.name,
        pageCount: doc.numPages,
        currentPage: 1,
        textPages,
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
    } catch (err) {
      console.error('[PdfStore] loadFile failed:', err);
      this._activeFileName = null;
      throw err;
    } finally {
      this._loading = false;
      this.notify();
    }
  }

  async getPage(pageNum: number): Promise<PDFPageProxy> {
    const active = this._active;
    if (!active) throw new Error('No PDF loaded');
    return active.doc.getPage(pageNum);
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

    const terms = query.split(/\s+/).filter(t => t.length > 0);
    if (terms.length > 1) {
      this._searchMultiTerm(active, terms);
    } else {
      this._searchSingleTerm(active, query);
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

  private _searchSingleTerm(d: PdfDocument, query: string) {
    const qLower = query.toLowerCase();
    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        const lower = item.str.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(qLower, pos)) !== -1) {
          d.matches.push({
            pageIndex: pi,
            itemIndex: ii,
            charStart: pos,
            charEnd: pos + query.length,
            item,
          });
          pos += query.length;
        }
      }
    }
  }

  private _searchMultiTerm(d: PdfDocument, terms: string[]) {
    const termsLower = terms.map(t => t.toLowerCase());

    for (let pi = 0; pi < d.textPages.length; pi++) {
      const items = d.textPages[pi];

      const termHits: { ii: number; charStart: number; charEnd: number; x: number; y: number; fontSize: number }[][] = [];
      for (const term of termsLower) {
        const hits: typeof termHits[0] = [];
        for (let ii = 0; ii < items.length; ii++) {
          const item = items[ii];
          const lower = item.str.toLowerCase();
          let pos = 0;
          while ((pos = lower.indexOf(term, pos)) !== -1) {
            const t = item.transform;
            const fontSize = pdfFontSize(t);
            hits.push({
              ii,
              charStart: pos,
              charEnd: pos + term.length,
              x: t[4],
              y: t[5],
              fontSize,
            });
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
      this._documents.delete(d.fileName);
    }
    this._activeFileName = null;
    this.notify();
  }

  /** Close a specific document by filename */
  closeFile(fileName: string) {
    const d = this._documents.get(fileName);
    if (!d) return;
    d.doc.destroy();
    this._documents.delete(fileName);
    if (this._activeFileName === fileName) {
      this._activeFileName = null;
    }
    this.notify();
  }
}

export const pdfStore = new PdfStore();
