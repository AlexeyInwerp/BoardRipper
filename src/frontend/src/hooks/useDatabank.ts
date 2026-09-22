import { databankStore } from '../store/databank-store';
import { createStoreHook } from './createStoreHook';
import type { FolderLibraryState } from '../store/folder-library';
import type { DatabankFile, FileDetail, FolderNode, ScanStatus, SearchResult, ViewMode, DatabankStats, BrowseResult, RecentItem, LoadStatus, PdfIndexProgress, PdfIndexStats, DedupProgress, DedupStats, BackendState } from '../store/databank-store';

// `metadataTree`/`modelTree` are deliberately NOT in the snapshot. Including
// them would call the (O(N)) groupby getters on every store notify — even
// when the active tab doesn't render either tree. They are computed lazily
// inside the panel/views via `useMemo` so the cost is only paid by the tab
// that actually needs them.
interface DatabankSnapshot {
  files: DatabankFile[];
  /** Monotonic version bumped on every `files` mutation. `files` is appended
   *  in place during streaming so its reference is stable — consumers that
   *  must react to content changes key on this instead of the array identity. */
  filesVersion: number;
  filesComplete: boolean;
  libraryLoadMode: 'stream' | 'bulk';
  folderTree: FolderNode | null;
  folderTreeLoading: boolean;
  scanStatus: ScanStatus | null;
  searchResults: SearchResult[];
  searchQuery: string;
  autoPdf: boolean;
  viewMode: ViewMode;
  selectedFileId: number | null;
  selectedFileDetail: FileDetail | null;
  loading: boolean;
  loadStatus: LoadStatus;
  loadError: Error | null;
  backendAvailable: boolean;
  backendState: BackendState;
  backendRetryDelaySec: number;
  libraryPath: string | null;
  electronMode: boolean;
  /** Local-folder library state (lite / offline builds). */
  folderState: FolderLibraryState;
  /** The index is local (Electron IPC or a picked folder) — no backend. */
  localLibrary: boolean;
  verboseScan: boolean;
  showPreviews: boolean;
  stats: DatabankStats | null;
  browseMode: 'database' | 'live';
  browseResult: BrowseResult | null;
  browsing: boolean;
  recentItems: RecentItem[];
  historyDepth: number;
  favoritePaths: Set<string>;
  donorIds: ReadonlySet<number>;
  pdfIndexProgress: PdfIndexProgress | null;
  pdfIndexStats: PdfIndexStats | null;
  dedupProgress: DedupProgress | null;
  dedupStats: DedupStats | null;
  pendingPdfSearch: { query: string; scope: 'all' | 'donor' } | null;
}

export const useDatabank = createStoreHook<DatabankSnapshot>(databankStore, () => ({
  files: databankStore.files,
  filesVersion: databankStore.filesVersion,
  filesComplete: databankStore.filesComplete,
  libraryLoadMode: databankStore.libraryLoadMode,
  folderTree: databankStore.folderTree,
  folderTreeLoading: databankStore.folderTreeLoading,
  scanStatus: databankStore.scanStatus,
  searchResults: databankStore.searchResults,
  searchQuery: databankStore.searchQuery,
  autoPdf: databankStore.autoPdf,
  viewMode: databankStore.viewMode,
  selectedFileId: databankStore.selectedFileId,
  selectedFileDetail: databankStore.selectedFileDetail,
  loading: databankStore.loading,
  loadStatus: databankStore.loadStatus,
  loadError: databankStore.loadError,
  backendAvailable: databankStore.backendAvailable,
  backendState: databankStore.backendState,
  backendRetryDelaySec: databankStore.backendRetryDelaySec,
  libraryPath: databankStore.libraryPath,
  electronMode: databankStore.electronMode,
  folderState: databankStore.folderState,
  localLibrary: databankStore.localLibrary,
  verboseScan: databankStore.verboseScan,
  showPreviews: databankStore.showPreviews,
  stats: databankStore.stats,
  browseMode: databankStore.browseMode,
  browseResult: databankStore.browseResult,
  browsing: databankStore.browsing,
  recentItems: databankStore.recentItems,
  historyDepth: databankStore.historyDepth,
  favoritePaths: databankStore.favoritePaths,
  donorIds: databankStore.donorIds,
  pdfIndexProgress: databankStore._pdfIndexProgress,
  pdfIndexStats: databankStore._pdfIndexStats,
  dedupProgress: databankStore._dedupProgress,
  dedupStats: databankStore._dedupStats,
  pendingPdfSearch: databankStore.pendingPdfSearch,
}));
