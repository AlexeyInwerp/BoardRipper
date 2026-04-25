import { databankStore } from '../store/databank-store';
import { createStoreHook } from './createStoreHook';
import type { DatabankFile, FileDetail, FolderNode, ScanStatus, SearchResult, ViewMode, DatabankStats, BrowseResult, RecentItem } from '../store/databank-store';

// `metadataTree`/`modelTree` are deliberately NOT in the snapshot. Including
// them would call the (O(N)) groupby getters on every store notify — even
// when the active tab doesn't render either tree. They are computed lazily
// inside the panel/views via `useMemo` so the cost is only paid by the tab
// that actually needs them.
interface DatabankSnapshot {
  files: DatabankFile[];
  filesComplete: boolean;
  folderTree: FolderNode | null;
  scanStatus: ScanStatus | null;
  searchResults: SearchResult[];
  searchQuery: string;
  autoPdf: boolean;
  viewMode: ViewMode;
  selectedFileId: number | null;
  selectedFileDetail: FileDetail | null;
  loading: boolean;
  backendAvailable: boolean;
  libraryPath: string | null;
  electronMode: boolean;
  verboseScan: boolean;
  showPreviews: boolean;
  stats: DatabankStats | null;
  browseMode: 'database' | 'live';
  browseResult: BrowseResult | null;
  browsing: boolean;
  recentItems: RecentItem[];
  historyDepth: number;
}

export const useDatabank = createStoreHook<DatabankSnapshot>(databankStore, () => ({
  files: databankStore.files,
  filesComplete: databankStore.filesComplete,
  folderTree: databankStore.folderTree,
  scanStatus: databankStore.scanStatus,
  searchResults: databankStore.searchResults,
  searchQuery: databankStore.searchQuery,
  autoPdf: databankStore.autoPdf,
  viewMode: databankStore.viewMode,
  selectedFileId: databankStore.selectedFileId,
  selectedFileDetail: databankStore.selectedFileDetail,
  loading: databankStore.loading,
  backendAvailable: databankStore.backendAvailable,
  libraryPath: databankStore.libraryPath,
  electronMode: databankStore.electronMode,
  verboseScan: databankStore.verboseScan,
  showPreviews: databankStore.showPreviews,
  stats: databankStore.stats,
  browseMode: databankStore.browseMode,
  browseResult: databankStore.browseResult,
  browsing: databankStore.browsing,
  recentItems: databankStore.recentItems,
  historyDepth: databankStore.historyDepth,
}));
