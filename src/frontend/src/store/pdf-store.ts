import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, TextItem } from 'pdfjs-dist/types/src/pdf';

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

export interface PdfTextMatch {
  pageIndex: number;   // 0-based
  itemIndex: number;
  charStart: number;
  charEnd: number;
  item: PdfTextItem;
}

type Listener = () => void;

class PdfStore {
  private _doc: PDFDocumentProxy | null = null;
  private _fileName = '';
  private _pageCount = 0;
  private _currentPage = 1;           // 1-based
  private _textPages: PdfTextItem[][] = [];
  private _searchQuery = '';
  private _matches: PdfTextMatch[] = [];
  private _activeMatchIndex = -1;
  private _loading = false;
  private _listeners = new Set<Listener>();

  get fileName(): string { return this._fileName; }
  get pageCount(): number { return this._pageCount; }
  get currentPage(): number { return this._currentPage; }
  get searchQuery(): string { return this._searchQuery; }
  get matches(): PdfTextMatch[] { return this._matches; }
  get activeMatchIndex(): number { return this._activeMatchIndex; }
  get isLoaded(): boolean { return this._doc !== null; }
  get loading(): boolean { return this._loading; }

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
    }

    this._loading = true;
    this._fileName = file.name;
    this._searchQuery = '';
    this._matches = [];
    this._activeMatchIndex = -1;
    this.notify();

    const buffer = await file.arrayBuffer();
    const doc = await pdfjsLib.getDocument({ data: buffer }).promise;

    this._doc = doc;
    this._pageCount = doc.numPages;
    this._currentPage = 1;

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

    this._loading = false;
    this.notify();
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
    this._activeMatchIndex = -1;

    if (!query) {
      this.notify();
      return;
    }

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

    if (this._matches.length > 0) {
      this._activeMatchIndex = 0;
      this._currentPage = this._matches[0].pageIndex + 1;
    }
    this.notify();
  }

  nextMatch() {
    if (this._matches.length === 0) return;
    this._activeMatchIndex = (this._activeMatchIndex + 1) % this._matches.length;
    this._currentPage = this._matches[this._activeMatchIndex].pageIndex + 1;
    this.notify();
  }

  prevMatch() {
    if (this._matches.length === 0) return;
    this._activeMatchIndex = (this._activeMatchIndex - 1 + this._matches.length) % this._matches.length;
    this._currentPage = this._matches[this._activeMatchIndex].pageIndex + 1;
    this.notify();
  }

  getTextItemsForPage(pageIndex: number): PdfTextItem[] {
    return this._textPages[pageIndex] ?? [];
  }

  getMatchesForPage(pageIndex: number): PdfTextMatch[] {
    return this._matches.filter(m => m.pageIndex === pageIndex);
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
    this._activeMatchIndex = -1;
    this.notify();
  }
}

export const pdfStore = new PdfStore();
