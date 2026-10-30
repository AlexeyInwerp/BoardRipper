/** The store side of N / Shift+N — see search-step.ts for the rule. */
import { boardStore } from './board-store';
import { netStops, nextStop, partStops, walkingNet } from './search-step';

/** Step the active board's search results. Returns false when there is
 *  nothing to step through, so the key can fall through. */
export function stepBoardResult(dir: 1 | -1): boolean {
  const tab = boardStore.activeTab;
  const board = tab?.board;
  if (!tab || !board) return false;
  const sel = tab.selection;
  const nav = { cause: 'search' as const };

  if (walkingNet(sel)) {
    const stop = nextStop(netStops(board, sel.highlightedNet!), sel.partIndex, dir);
    if (!stop || stop.pinIndex === null) return false;
    boardStore.promotePartOnNet(stop.partIndex, stop.pinIndex, nav);
    return true;
  }
  if (tab.searchQuery.trim()) {
    const stop = nextStop(partStops(board, boardStore.searchResultIndices), sel.partIndex, dir);
    if (!stop) return false;
    boardStore.focusPart(board.parts[stop.partIndex].name, nav);
    return true;
  }
  return false;
}
