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

class PdfStore {
  private _doc: PDFDocumentProxy | null = null;
  private _fileName = '';
  private _pageCount = 0;
  private _currentPage = 1;           // 1-based
  private _textPages: PdfTextItem[][] = [];
  private _searchQuery = '';
  private _matches: PdfTextMatch[] = [];
  private _activeMatchIndex = -1;
  /** Multi-term search: groups of match indices that belong together */
  private _matchGroups: number[][] = [];
  private _activeGroupIndex = -1;
  /** Vertical distance multiplier for multi-term search (fontSize × this) */
  private _multiTermYGap = 4;
  /** Horizontal tolerance multiplier for multi-term search (fontSize × this) */
  private _multiTermXGap = 3;
  private _activeMatchIndicesCache: Set<number> = new Set();
  private _matchesByPage: Map<number, PdfTextMatch[]> = new Map();
  private _loading = false;
  private _bookmarks: PdfBookmark[] = [];
  private _listeners = new Set<Listener>();

  get fileName(): string { return this._fileName; }
  get pageCount(): number { return this._pageCount; }
  get currentPage(): number { return this._currentPage; }
  get searchQuery(): string { return this._searchQuery; }
  get matches(): PdfTextMatch[] { return this._matches; }
  get activeMatchIndex(): number { return this._activeMatchIndex; }
  get matchGroups(): number[][] { return this._matchGroups; }
  get activeGroupIndex(): number { return this._activeGroupIndex; }
  get multiTermYGap(): number { return this._multiTermYGap; }
  get multiTermXGap(): number { return this._multiTermXGap; }
  get isMultiTerm(): boolean { return this._searchQuery.split(/\s+/).filter(t => t.length > 0).length > 1; }
  get isLoaded(): boolean { return this._doc !== null; }
  get loading(): boolean { return this._loading; }
  get bookmarks(): PdfBookmark[] { return this._bookmarks; }

  /** Returns cached set of match indices in the active group */
  get activeMatchIndices(): Set<number> { return this._activeMatchIndicesCache; }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  async loadFile(file: File) {
    // Clean up previous document
    if (this._doc) {
      this._doc.destroy();
      this._doc = null;
    }

    this._loading = true;
    this._fileName = file.name;
    this._searchQuery = '';
    this._matches = [];
    this._matchGroups = [];
    this._activeMatchIndex = -1;
    this._activeGroupIndex = -1;
    this._activeMatchIndicesCache = new Set();
    this._matchesByPage = new Map();
    this.notify();

    try {
      const buffer = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

      this._doc = doc;
      this._pageCount = doc.numPages;
      this._currentPage = 1;
      this._bookmarks = loadBookmarks(file.name);

      // Extract text from all pages
      this._textPages = [];
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
        this._textPages.push(items);
      }
    } catch (err) {
      console.error('[PdfStore] loadFile failed:', err);
      this._doc = null;
      this._pageCount = 0;
      this._textPages = [];
      throw err;
    } finally {
      this._loading = false;
      this.notify();
    }
  }

  async getPage(pageNum: number): Promise<PDFPageProxy> {
    if (!this._doc) throw new Error('No PDF loaded');
    return this._doc.getPage(pageNum);
  }

  goToPage(n: number) {
    if (n < 1 || n > this._pageCount) return;
    if (n === this._currentPage) return;
    this._currentPage = n;
    this.notify();
  }

  searchText(query: string) {
    this._searchQuery = query;
    this._matches = [];
    this._matchGroups = [];
    this._activeMatchIndex = -1;
    this._activeGroupIndex = -1;

    if (!query) {
      this._activeMatchIndicesCache = new Set();
      this._matchesByPage = new Map();
      this.notify();
      return;
    }

    // Split by whitespace — multiple terms trigger vertical proximity search
    const terms = query.split(/\s+/).filter(t => t.length > 0);
    if (terms.length > 1) {
      this._searchMultiTerm(terms);
    } else {
      this._searchSingleTerm(query);
    }

    // Build per-page index for O(1) lookup in getMatchesForPage
    this._matchesByPage = new Map();
    for (const m of this._matches) {
      let arr = this._matchesByPage.get(m.pageIndex);
      if (!arr) { arr = []; this._matchesByPage.set(m.pageIndex, arr); }
      arr.push(m);
    }

    if (this._matches.length > 0) {
      this._activeMatchIndex = 0;
      this._activeGroupIndex = this._matchGroups.length > 0 ? 0 : -1;
      this._currentPage = this._matches[0].pageIndex + 1;
    }
    this._rebuildActiveIndicesCache();
    this.notify();
  }

  private _rebuildActiveIndicesCache() {
    if (this._matchGroups.length > 0 && this._activeGroupIndex >= 0) {
      this._activeMatchIndicesCache = new Set(this._matchGroups[this._activeGroupIndex]);
    } else if (this._activeMatchIndex >= 0) {
      this._activeMatchIndicesCache = new Set([this._activeMatchIndex]);
    } else {
      this._activeMatchIndicesCache = new Set();
    }
  }

  private _searchSingleTerm(query: string) {
    const qLower = query.toLowerCase();
    for (let pi = 0; pi < this._textPages.length; pi++) {
      const items = this._textPages[pi];
      for (let ii = 0; ii < items.length; ii++) {
        const item = items[ii];
        const lower = item.str.toLowerCase();
        let pos = 0;
        while ((pos = lower.indexOf(qLower, pos)) !== -1) {
          this._matches.push({
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

  /**
   * Multi-term vertical proximity search.
   * Finds all occurrences of the first term, then looks for subsequent terms
   * appearing below (lower Y in PDF coords = visually below) on the same page
   * within a horizontal tolerance.
   */
  private _searchMultiTerm(terms: string[]) {
    const termsLower = terms.map(t => t.toLowerCase());

    for (let pi = 0; pi < this._textPages.length; pi++) {
      const items = this._textPages[pi];

      // Build a lookup: for each term, find all text items containing it
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
              y: t[5],  // PDF Y (increases upward)
              fontSize,
            });
            pos += term.length;
          }
        }
        termHits.push(hits);
      }

      // No matches for any term on this page — skip
      if (termHits.some(h => h.length === 0)) continue;

      // For each hit of the first term, try to find a vertical chain of subsequent terms
      for (const anchor of termHits[0]) {
        const groupIndices: number[] = [];

        // Add the anchor match
        const anchorIdx = this._matches.length;
        this._matches.push({
          pageIndex: pi,
          itemIndex: anchor.ii,
          charStart: anchor.charStart,
          charEnd: anchor.charEnd,
          item: items[anchor.ii],
        });
        groupIndices.push(anchorIdx);

        // X tolerance: items should be roughly horizontally aligned
        const xTol = anchor.fontSize * this._multiTermXGap;
        let prevY = anchor.y;
        // Max vertical gap between consecutive terms (in PDF units)
        const maxGap = anchor.fontSize * this._multiTermYGap;
        let chainOk = true;

        for (let ti = 1; ti < termsLower.length; ti++) {
          // Find the best candidate: below previous, horizontally close, closest Y
          let best: typeof termHits[0][0] | null = null;
          let bestDist = Infinity;

          for (const hit of termHits[ti]) {
            // Must be below (lower PDF Y) the previous term
            if (hit.y >= prevY) continue;
            // Must be horizontally close
            if (Math.abs(hit.x - anchor.x) > xTol) continue;
            const dist = prevY - hit.y;
            // Must be within max gap
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

          const matchIdx = this._matches.length;
          this._matches.push({
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
          this._matchGroups.push(groupIndices);
        } else {
          // Remove partial matches that didn't form a complete chain
          this._matches.length = anchorIdx;
        }
      }
    }
  }

  nextMatch() { this._stepMatch(1); }
  prevMatch() { this._stepMatch(-1); }

  private _stepMatch(delta: 1 | -1) {
    if (this._matches.length === 0) return;
    if (this._matchGroups.length > 0) {
      this._activeGroupIndex = (this._activeGroupIndex + delta + this._matchGroups.length) % this._matchGroups.length;
      this._activeMatchIndex = this._matchGroups[this._activeGroupIndex][0];
    } else {
      this._activeMatchIndex = (this._activeMatchIndex + delta + this._matches.length) % this._matches.length;
    }
    this._currentPage = this._matches[this._activeMatchIndex].pageIndex + 1;
    this._rebuildActiveIndicesCache();
    this.notify();
  }

  /** Update gap multipliers and re-run multi-term search */
  setMultiTermYGap(value: number) {
    this._multiTermYGap = value;
    this._rerunMultiTerm();
  }

  setMultiTermXGap(value: number) {
    this._multiTermXGap = value;
    this._rerunMultiTerm();
  }

  private _rerunMultiTerm() {
    if (this.isMultiTerm && this._searchQuery) {
      this.searchText(this._searchQuery);
    } else {
      this.notify();
    }
  }

  getTextItemsForPage(pageIndex: number): PdfTextItem[] {
    return this._textPages[pageIndex] ?? [];
  }

  getMatchesForPage(pageIndex: number): PdfTextMatch[] {
    return this._matchesByPage.get(pageIndex) ?? [];
  }

  // --- Bookmarks ---

  addBookmark(page: number, zoom: number, panX: number, panY: number) {
    const bm: PdfBookmark = {
      id: crypto.randomUUID(),
      page, zoom, panX, panY,
      label: `p${page}`,
    };
    this._bookmarks = [...this._bookmarks, bm];
    saveBookmarks(this._fileName, this._bookmarks);
    this.notify();
  }

  updateBookmark(id: string, page: number, zoom: number, panX: number, panY: number) {
    this._bookmarks = this._bookmarks.map(b =>
      b.id === id ? { ...b, page, zoom, panX, panY } : b,
    );
    saveBookmarks(this._fileName, this._bookmarks);
    this.notify();
  }

  renameBookmark(id: string, label: string) {
    this._bookmarks = this._bookmarks.map(b =>
      b.id === id ? { ...b, label: label || `p${b.page}` } : b,
    );
    saveBookmarks(this._fileName, this._bookmarks);
    this.notify();
  }

  removeBookmark(id: string) {
    this._bookmarks = this._bookmarks.filter(b => b.id !== id);
    saveBookmarks(this._fileName, this._bookmarks);
    this.notify();
  }

  close() {
    if (this._doc) {
      this._doc.destroy();
      this._doc = null;
    }
    this._fileName = '';
    this._pageCount = 0;
    this._currentPage = 1;
    this._textPages = [];
    this._searchQuery = '';
    this._matches = [];
    this._matchGroups = [];
    this._activeMatchIndex = -1;
    this._activeGroupIndex = -1;
    this._activeMatchIndicesCache = new Set();
    this._matchesByPage = new Map();
    this._bookmarks = [];
    this.notify();
  }
}

export const pdfStore = new PdfStore();
