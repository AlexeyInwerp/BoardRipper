/**
 * The minimap header's ‹ › as an action — shared by the header buttons and
 * the bare ← / → keys on an active board panel. Steps whichever list the map
 * is set to walk: the navigation history, or the board's loaded worklist.
 */
import { boardStore } from './board-store';
import { renderSettingsStore } from './render-settings';
import { worklistStore } from './worklist-store';
import { historyBack, historyForward } from './nav-history-actions';
import { worklistStepKeys, currentWorklistKey, worklistStep, type WlKey } from './minimap-worklist';

/** Select a worklist row on `tabId`'s board. The store acts on the active
 *  tab, so that board is made active first (in a split view the other board
 *  may be the active one). */
export function focusWorklistKey(tabId: number | null, key: WlKey | null): boolean {
  if (!key) return false;
  if (tabId !== null && boardStore.activeTabId !== tabId) boardStore.switchTab(tabId);
  const name = key.slice(2);
  if (key.startsWith('n:')) boardStore.focusNet(name); else boardStore.focusPart(name);
  return true;
}

/** The row ‹ (-1) or › (+1) leads to on `tabId`'s board, from what it has
 *  selected; null at either end or with no worklist loaded. */
export function worklistStepTarget(tabId: number | null, dir: 1 | -1): WlKey | null {
  const tab = tabId === null ? null : boardStore.tabs.find(t => t.id === tabId) ?? null;
  const sel = tab?.selection ?? boardStore.selection;
  const board = tab?.board ?? boardStore.board;
  const keys = worklistStepKeys(worklistStore.worklistForTab(tabId));
  const part = sel.partIndex !== null ? (board?.parts[sel.partIndex]?.name ?? null) : null;
  return worklistStep(keys, currentWorklistKey(keys, part, sel.highlightedNet), dir);
}

/** One step back (-1) or forward (+1) in the map's current mode. */
export function minimapNavStep(dir: 1 | -1, tabId: number | null = boardStore.activeTabId): boolean {
  if ((renderSettingsStore.settings.minimapNav ?? 'history') === 'worklist') {
    return focusWorklistKey(tabId, worklistStepTarget(tabId, dir));
  }
  return dir < 0 ? historyBack() : historyForward();
}
