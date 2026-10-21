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

/** `activate`: bring the board panel to the front (a search the user aimed at
 *  the board). A mirror from a PDF click passes false — the user is in the PDF
 *  and the board follows without taking Dockview's active panel. */
export interface BoardSearchOpts { activate: boolean }
type SearchHandler = (query: string, opts: BoardSearchOpts) => void;
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

export function openBoardSearch(query: string, tabId?: number, opts: BoardSearchOpts = { activate: true }): void {
  if (tabId != null) {
    searchHandlers.get(tabId)?.(query, opts);
  } else {
    const activeId = boardStore.activeTabId;
    if (activeId != null) searchHandlers.get(activeId)?.(query, opts);
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
