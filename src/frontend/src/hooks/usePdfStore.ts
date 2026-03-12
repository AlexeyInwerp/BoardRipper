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
