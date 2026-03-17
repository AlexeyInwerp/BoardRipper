import { useSyncExternalStore } from 'react';
import { databankStore } from '../store/databank-store';
import type { DatabankFile, FileDetail, FolderNode, ScanStatus, SearchResult, ViewMode, MetadataGroup, ModelGroup } from '../store/databank-store';

interface DatabankSnapshot {
  files: DatabankFile[];
  folderTree: FolderNode | null;
  scanStatus: ScanStatus | null;
  searchResults: SearchResult[];
  searchQuery: string;
  donorOnlyFilter: boolean;
  autoPdf: boolean;
  viewMode: ViewMode;
  selectedFileId: number | null;
  selectedFileDetail: FileDetail | null;
  loading: boolean;
  backendAvailable: boolean;
  metadataTree: MetadataGroup[];
  modelTree: ModelGroup[];
}

let cachedSnapshot: DatabankSnapshot | null = null;
let snapshotVersion = 0;
let lastVersion = -1;

databankStore.subscribe(() => { snapshotVersion++; });

function getSnapshot(): DatabankSnapshot {
  if (lastVersion !== snapshotVersion || !cachedSnapshot) {
    cachedSnapshot = {
      files: databankStore.files,
      folderTree: databankStore.folderTree,
      scanStatus: databankStore.scanStatus,
      searchResults: databankStore.searchResults,
      searchQuery: databankStore.searchQuery,
      donorOnlyFilter: databankStore.donorOnlyFilter,
      autoPdf: databankStore.autoPdf,
      viewMode: databankStore.viewMode,
      selectedFileId: databankStore.selectedFileId,
      selectedFileDetail: databankStore.selectedFileDetail,
      loading: databankStore.loading,
      backendAvailable: databankStore.backendAvailable,
      metadataTree: databankStore.metadataTree,
      modelTree: databankStore.modelTree,
    };
    lastVersion = snapshotVersion;
  }
  return cachedSnapshot;
}

function subscribe(cb: () => void) {
  return databankStore.subscribe(cb);
}

export function useDatabank() {
  return useSyncExternalStore(subscribe, getSnapshot);
}
