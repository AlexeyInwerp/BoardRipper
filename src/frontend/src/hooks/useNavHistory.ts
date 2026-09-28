import { createStoreHook } from './createStoreHook';
import { navHistoryStore } from '../store/nav-history-store';
import type { NavEntry, NavLayers } from '../store/nav-history';

export interface NavHistorySnapshot {
  /** Switched-on layers only, newest first. */
  listed: NavEntry[];
  /** Every entry, oldest first (the raw timeline). */
  entries: NavEntry[];
  cursor: number;
  currentId: number | null;
  layers: NavLayers;
  canBack: boolean;
  canForward: boolean;
}

export const useNavHistory = createStoreHook<NavHistorySnapshot>(navHistoryStore, () => ({
  listed: navHistoryStore.listed,
  entries: navHistoryStore.entries,
  cursor: navHistoryStore.cursor,
  currentId: navHistoryStore.current?.id ?? null,
  layers: navHistoryStore.layers,
  canBack: navHistoryStore.canBack,
  canForward: navHistoryStore.canForward,
}));
