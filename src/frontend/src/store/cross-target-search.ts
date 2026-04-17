/**
 * Cross-target search — shared primitives for "find term X in target Y"
 * used by both the toolbar global search and the right-click context menu.
 *
 * Single source of truth so the right-click path and the dropdown path
 * are guaranteed to behave identically.
 */
import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { fileInputRefs } from './file-inputs';
import { openBoardSearch } from '../panels/BoardViewerPanel';

/**
 * Count substring (case-insensitive) matches of `term` across the given
 * board tab's parts and net names. Returns 0 if tab not found or not loaded.
 *
 * Matches the legacy scan in Toolbar.GlobalSearch so the global dropdown's
 * counts are preserved byte-for-byte.
 */
export function countInBoardTab(term: string, tabId: number): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  const tab = boardStore.getTab(tabId);
  if (!tab?.board) return 0;

  let count = 0;
  for (const p of tab.board.parts) {
    if (p.name.toLowerCase().includes(t)) count++;
  }
  for (const [name] of tab.board.nets) {
    if (name.toLowerCase().includes(t)) count++;
  }
  return count;
}

/**
 * Count substring matches of `term` in the given PDF's extracted text.
 * Delegates to the existing pdfStore helper.
 */
export function countInPdf(term: string, fileName: string): number {
  const t = term.trim().toLowerCase();
  if (!t) return 0;
  return pdfStore.countTextMatches(fileName, t);
}

/**
 * Switch to the given board tab, auto-select the part whose refdes equals
 * `term` (case-insensitive exact match) if one exists, and open the Board
 * Search panel with the query populated.
 *
 * Auto-select uses boardStore.focusPart() which also auto-flips the board
 * to the correct side and sets a focus request consumed by BoardRenderer
 * to recenter the viewport.
 *
 * The count reported by countInBoardTab is substring-based and can exceed
 * 1 (e.g. "R1" matches "R1", "R10", "R100") — but auto-select is strict
 * equality, so no silent mis-selection.
 */
export function findInBoardTab(term: string, tabId: number): void {
  const t = term.trim();
  if (!t) return;
  boardStore.switchTab(tabId);
  boardStore.focusPart(t);
  openBoardSearch(t, tabId);
}

/**
 * Switch the active PDF to `fileName`, set the PDF search query, and focus
 * the PDF search input. Lifted from the inline body that
 * GlobalSearch.runSearch used to carry.
 */
export function findInPdf(term: string, fileName: string): void {
  const t = term.trim();
  if (!t) return;
  pdfStore.switchTo(fileName);
  pdfStore.searchText(t);
  setTimeout(() => {
    if (fileInputRefs.pdfSearch) {
      fileInputRefs.pdfSearch.value = t;
      fileInputRefs.pdfSearch.focus();
    }
  }, 50);
}
