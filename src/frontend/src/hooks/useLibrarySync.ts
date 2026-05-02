import { librarySyncStore } from '../store/librarysync-store';
import { createStoreHook } from './createStoreHook';
import type { SyncConfig, SyncStatus } from '../store/librarysync-store';

interface LibrarySyncSnapshot {
  config: SyncConfig;
  status: SyncStatus;
  configLoaded: boolean;
  backendAvailable: boolean;
}

export const useLibrarySync = createStoreHook<LibrarySyncSnapshot>(librarySyncStore, () => ({
  config: librarySyncStore.config,
  status: librarySyncStore.status,
  configLoaded: librarySyncStore.configLoaded,
  backendAvailable: librarySyncStore.backendAvailable,
}));
