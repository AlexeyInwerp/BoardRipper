import { databankStore } from '../store/databank-store';
import { createStoreHook } from './createStoreHook';
import type { DatabankFile, FileDetail, FolderNode, ScanStatus, SearchResult, ViewMode, MetadataGroup, ModelGroup, DatabankStats, BrowseResult, RecentItem } from '../store/databank-store';

interface DatabankSnapshot {
  files: DatabankFile[];
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
  metadataTree: MetadataGroup[];
  modelTree: ModelGroup[];
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
  metadataTree: databankStore.metadataTree,
  modelTree: databankStore.modelTree,
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
