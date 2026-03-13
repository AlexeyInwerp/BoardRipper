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
  multiTermYGap: number;
  multiTermXGap: number;
  isLoaded: boolean;
  loading: boolean;
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
      multiTermYGap: pdfStore.multiTermYGap,
      multiTermXGap: pdfStore.multiTermXGap,
      isLoaded: pdfStore.isLoaded,
      loading: pdfStore.loading,
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
