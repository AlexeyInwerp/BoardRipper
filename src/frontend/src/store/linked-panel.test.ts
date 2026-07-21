import { describe, it, expect } from 'vitest';
import { pickLinkedBoardTab, type LinkableTab } from './linked-panel';

const tab = (id: number, ...pdfs: string[]): LinkableTab => ({ id, pdfFileNames: pdfs });

describe('pickLinkedBoardTab', () => {
  it('returns null when no tab is bound to the PDF', () => {
    const tabs = [tab(1, 'other.pdf'), tab(2)];
    expect(pickLinkedBoardTab(tabs, 1, 'schematic.pdf')).toBeNull();
  });

  it('returns the single bound tab', () => {
    const tabs = [tab(1, 'schematic.pdf')];
    expect(pickLinkedBoardTab(tabs, 1, 'schematic.pdf')).toBe(1);
  });

  it('stays on the active tab when it is bound (regression: double-click lookup must not switch board)', () => {
    // Two revisions share one schematic PDF; revision tab 2 is active. The old
    // `find`-first logic returned tab 1 here and yanked the board to it.
    const tabs = [tab(1, 'schematic.pdf'), tab(2, 'schematic.pdf')];
    expect(pickLinkedBoardTab(tabs, 2, 'schematic.pdf')).toBe(2);
  });

  it('falls back to the first bound tab when the active tab is not bound', () => {
    // Active board (tab 3) has no link to this PDF — genuine cross-navigation.
    const tabs = [tab(1, 'schematic.pdf'), tab(2, 'schematic.pdf'), tab(3, 'other.pdf')];
    expect(pickLinkedBoardTab(tabs, 3, 'schematic.pdf')).toBe(1);
  });

  it('falls back to the first bound tab when there is no active tab', () => {
    const tabs = [tab(5, 'schematic.pdf'), tab(6, 'schematic.pdf')];
    expect(pickLinkedBoardTab(tabs, null, 'schematic.pdf')).toBe(5);
  });
});
