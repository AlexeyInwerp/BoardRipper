import { useSyncExternalStore } from 'react';
import { pdfStore } from '../store/pdf-store';
import { createStoreHook } from './createStoreHook';
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

export const usePdfStore = createStoreHook<PdfSnapshot>(pdfStore, () => ({
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
}));

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
  cleanMode: boolean;
  searchSource: 'user' | 'lookup' | null;
  lookupHint: string | null;
}

// Per-document snapshot cache: fileName → { version, snapshot }
let docSnapshotVersion = 0;
let lastPruneVersion = -1;
pdfStore.subscribe(() => { docSnapshotVersion++; });

const docSnapshots = new Map<string, { version: number; snapshot: PdfDocSnapshot }>();

function getDocSnapshot(fileName: string): PdfDocSnapshot {
  // Prune stale entries for documents that have been closed (at most once per version bump)
  if (lastPruneVersion !== docSnapshotVersion) {
    lastPruneVersion = docSnapshotVersion;
    for (const key of docSnapshots.keys()) {
      if (!pdfStore.isDocLoaded(key)) docSnapshots.delete(key);
    }
  }

  const cached = docSnapshots.get(fileName);
  if (cached && cached.version === docSnapshotVersion) return cached.snapshot;

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
    cleanMode: pdfStore.isDocClean(fileName),
    searchSource: pdfStore.getDocSearchSource(fileName),
    lookupHint: pdfStore.getDocLookupHint(fileName),
  };
  docSnapshots.set(fileName, { version: docSnapshotVersion, snapshot });
  return snapshot;
}

function subscribeDoc(cb: () => void) {
  return pdfStore.subscribe(cb);
}

/** Hook that returns per-document state — panel renders regardless of which doc is "active". */
export function usePdfDoc(fileName: string): PdfDocSnapshot {
  return useSyncExternalStore(subscribeDoc, () => getDocSnapshot(fileName));
}
