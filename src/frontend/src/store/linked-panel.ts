/**
 * Pure selection logic for board ↔ PDF linked-panel auto-switching.
 *
 * Extracted from the panel components so the "which board tab should a
 * just-activated PDF pull into view?" decision is unit-testable without a live
 * Dockview / DOM.
 */

/** Minimal board-tab shape needed to resolve a PDF's linked board tab. */
export interface LinkableTab {
  id: number;
  pdfFileNames: string[];
}

/**
 * Choose which board tab a newly-activated PDF panel should activate.
 *
 * A single PDF can be bound to *several* board tabs (e.g. two revisions of the
 * same board sharing one schematic PDF). When the user double-clicks a
 * component to look it up, the PDF is activated programmatically and its
 * `onDidActiveChange` handler runs this to decide the linked board.
 *
 * Rule: if the currently-active board tab is already bound to this PDF, stay on
 * it — the lookup came *from* that board and must not yank the view to a
 * sibling tab. Only when the active board isn't linked to this PDF at all (a
 * genuine cross-navigation, e.g. clicking a PDF tab whose board lives in a
 * different tab) do we fall back to the first bound tab.
 *
 * Returns the target tab id, or `null` when no open tab is bound to the PDF.
 */
export function pickLinkedBoardTab(
  tabs: readonly LinkableTab[],
  activeTabId: number | null,
  pdfFileName: string,
): number | null {
  const bound = tabs.filter(t => t.pdfFileNames.includes(pdfFileName));
  if (bound.length === 0) return null;
  if (activeTabId != null && bound.some(t => t.id === activeTabId)) return activeTabId;
  return bound[0].id;
}
