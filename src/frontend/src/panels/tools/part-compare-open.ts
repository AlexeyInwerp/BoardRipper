/**
 * The one way to jump into Part comparison from elsewhere.
 *
 * Mirrors `store/cross-target-search.ts`: a small module that owns a
 * cross-panel navigation so the callers (right now the board right-click menu)
 * do not each re-assemble the same three steps.
 */

import { partCompareStore, type CompareSideRef } from '../../store/part-compare-store';
import { showSidebarTab } from '../../components/Sidebar.utils';
import { setActiveTool } from './tools-nav';

/**
 * Prefill the comparison and put it on screen.
 *
 * `b` may be null — the "Compare part…" entry, where only the subject is known
 * and the user picks the other side in the tool.
 */
export function openPartCompare(a: CompareSideRef, b: CompareSideRef | null): void {
  partCompareStore.open(a, b);
  setActiveTool('partcompare');
  showSidebarTab('tools');
}
