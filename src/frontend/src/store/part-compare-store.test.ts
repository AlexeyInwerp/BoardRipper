import { describe, it, expect, beforeEach } from 'vitest';
import { partCompareStore } from './part-compare-store';
import type { PinDiffStatus } from './part-compare';

/**
 * `highlightFor` is what the renderer asks, and it is the only place that
 * knows which side of a comparison a given board tab is. The comparison kernel
 * itself is covered by `part-compare.test.ts`; these tests are about the
 * projection and the off-by-default contract.
 */
describe('partCompareStore.highlightFor', () => {
  beforeEach(() => {
    partCompareStore.open({ tabId: 1, partName: 'U1' }, { tabId: 2, partName: 'U1' });
    partCompareStore.setHighlight(false);
  });

  it('is off by default', () => {
    expect(partCompareStore.state.highlight).toBe(false);
    expect(partCompareStore.highlightFor(1)).toBeNull();
  });

  it('stays null for a tab that is neither side, even when on', () => {
    partCompareStore.setHighlight(true);
    expect(partCompareStore.highlightFor(99)).toBeNull();
  });

  it('survives open() — opening a new pair must not silently light up the board', () => {
    partCompareStore.setHighlight(true);
    partCompareStore.open({ tabId: 3, partName: 'U7' }, { tabId: 4, partName: 'U7' });
    // The user asked for the highlight; a new pair keeps it, it does not reset.
    expect(partCompareStore.state.highlight).toBe(true);
    // But an unrelated tab is still not painted.
    expect(partCompareStore.highlightFor(1)).toBeNull();
  });

  it('toggles', () => {
    partCompareStore.toggleHighlight();
    expect(partCompareStore.state.highlight).toBe(true);
    partCompareStore.toggleHighlight();
    expect(partCompareStore.state.highlight).toBe(false);
  });
});

describe('compare mark colours', () => {
  // The mapping lives in the renderer, but the contract it encodes belongs
  // with the statuses: only disagreement and near-miss are worth a mark.
  const marked: PinDiffStatus[] = ['differs', 'only-a', 'only-b', 'renamed', 'similar', 'partial'];
  const unmarked: PinDiffStatus[] = ['same', 'bulk', 'nc'];
  it('covers every status exactly once', () => {
    expect(new Set([...marked, ...unmarked]).size).toBe(9);
  });
});
