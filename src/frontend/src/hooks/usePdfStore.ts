import { useSyncExternalStore } from 'react';
import { pdfStore } from '../store/pdf-store';
import type { PdfTextMatch, PdfBookmark } from '../store/pdf-store';

interface PdfSnapshot {
  fileName: string;
  pageCount: number;
  currentPage: number;
  searchQuery: string;
  matches: PdfTextMatch[];
  activeMatchIndex: number;
  matchGroupCount: number;
  activeGroupIndex: number;
  isMultiTerm: boolean;
  isAtSyntax: boolean;
  multiTermYGap: number;
  multiTermXGap: number;
  isLoaded: boolean;
  loading: boolean;
  textExtracting: boolean;
  textExtractProgress: number;
  bookmarks: PdfBookmark[];
}

let cachedSnapshot: PdfSnapshot | null = null;
let snapshotVersion = 0;
let lastVersion = -1;

pdfStore.subscribe(() => { snapshotVersion++; });

function getSnapshot(): PdfSnapshot {
  if (lastVersion !== snapshotVersion || !cachedSnapshot) {
    cachedSnapshot = {
      fileName: pdfStore.fileName,
      pageCount: pdfStore.pageCount,
      currentPage: pdfStore.currentPage,
      searchQuery: pdfStore.searchQuery,
      matches: pdfStore.matches,
      activeMatchIndex: pdfStore.activeMatchIndex,
      matchGroupCount: pdfStore.matchGroups.length,
      activeGroupIndex: pdfStore.activeGroupIndex,
      isMultiTerm: pdfStore.isMultiTerm,
      isAtSyntax: pdfStore.isAtSyntax,
      multiTermYGap: pdfStore.multiTermYGap,
      multiTermXGap: pdfStore.multiTermXGap,
      isLoaded: pdfStore.isLoaded,
      loading: pdfStore.loading,
      textExtracting: pdfStore.textExtracting,
      textExtractProgress: pdfStore.textExtractProgress,
      bookmarks: pdfStore.bookmarks,
    };
    lastVersion = snapshotVersion;
  }
  return cachedSnapshot;
}

function subscribe(cb: () => void) {
  return pdfStore.subscribe(cb);
}

export function usePdfStore() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Per-document snapshot — allows a panel to render even when not the active doc. */
export interface PdfDocSnapshot {
  isLoaded: boolean;
  pageCount: number;
  currentPage: number;
  searchQuery: string;
  matches: PdfTextMatch[];
  activeMatchIndex: number;
  matchGroupCount: number;
  activeGroupIndex: number;
  isMultiTerm: boolean;
  isAtSyntax: boolean;
  multiTermYGap: number;
  multiTermXGap: number;
  textExtracting: boolean;
  textExtractProgress: number;
  bookmarks: PdfBookmark[];
}

// Per-document snapshot cache: fileName → { version, snapshot }
const docSnapshots = new Map<string, { version: number; snapshot: PdfDocSnapshot }>();

function getDocSnapshot(fileName: string): PdfDocSnapshot {
  const cached = docSnapshots.get(fileName);
  if (cached && cached.version === snapshotVersion) return cached.snapshot;

  const snapshot: PdfDocSnapshot = {
    isLoaded: pdfStore.isDocLoaded(fileName),
    pageCount: pdfStore.getDocPageCount(fileName),
    currentPage: pdfStore.getDocCurrentPage(fileName),
    searchQuery: pdfStore.getDocSearchQuery(fileName),
    matches: pdfStore.getDocMatches(fileName),
    activeMatchIndex: pdfStore.getDocActiveMatchIndex(fileName),
    matchGroupCount: pdfStore.getDocMatchGroups(fileName).length,
    activeGroupIndex: pdfStore.getDocActiveGroupIndex(fileName),
    isMultiTerm: pdfStore.isDocMultiTerm(fileName),
    isAtSyntax: pdfStore.isDocAtSyntax(fileName),
    multiTermYGap: pdfStore.multiTermYGap,
    multiTermXGap: pdfStore.multiTermXGap,
    textExtracting: pdfStore.getDocTextExtracting(fileName),
    textExtractProgress: pdfStore.getDocTextExtractProgress(fileName),
    bookmarks: pdfStore.getDocBookmarks(fileName),
  };
  docSnapshots.set(fileName, { version: snapshotVersion, snapshot });
  return snapshot;
}

/** Hook that returns per-document state — panel renders regardless of which doc is "active". */
export function usePdfDoc(fileName: string): PdfDocSnapshot {
  return useSyncExternalStore(subscribe, () => getDocSnapshot(fileName));
}
