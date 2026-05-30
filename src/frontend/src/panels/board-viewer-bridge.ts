/**
 * Cross-panel bridge for board viewer panels.
 *
 * Lives in a sibling file (not BoardViewerPanel.tsx) so the panel module can
 * keep `react-refresh/only-export-components` happy. Consumers (Toolbar,
 * ContextMenu, PdfViewerPanel, useKeyboardShortcuts, cross-target-search,
 * BoardRenderer) import the named functions from here; BoardViewerPanel
 * registers/unregisters its per-tab handlers via the *register* APIs.
 */

import { boardStore } from '../store/board-store';

type SearchHandler = (query: string) => void;
type SidebarTabName = 'layers' | 'info' | 'search' | 'worklist' | 'revisions';
type SidebarTabHandler = (tab: SidebarTabName) => void;

const searchHandlers = new Map<number, SearchHandler>();
const sidebarTabHandlers = new Map<number, SidebarTabHandler>();

export function registerBoardSearchHandler(tabId: number, fn: SearchHandler): () => void {
  searchHandlers.set(tabId, fn);
  return () => { searchHandlers.delete(tabId); };
}

export function registerBoardSidebarTabHandler(tabId: number, fn: SidebarTabHandler): () => void {
  sidebarTabHandlers.set(tabId, fn);
  return () => { sidebarTabHandlers.delete(tabId); };
}

export function openBoardSearch(query: string, tabId?: number): void {
  if (tabId != null) {
    searchHandlers.get(tabId)?.(query);
  } else {
    const activeId = boardStore.activeTabId;
    if (activeId != null) searchHandlers.get(activeId)?.(query);
  }
}

export function openBoardSidebarTab(tab: SidebarTabName, tabId?: number): void {
  if (tabId != null) {
    sidebarTabHandlers.get(tabId)?.(tab);
  } else {
    const activeId = boardStore.activeTabId;
    if (activeId != null) sidebarTabHandlers.get(activeId)?.(tab);
  }
}

export type { SidebarTabName };
