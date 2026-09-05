import { describe, it, expect } from 'vitest';
import { selectionOutlineWorld } from './render-settings';

const S = { selectionWidth: 2, selectionPadding: 0, selectionMinScreenPx: 24 };

describe('selectionOutlineWorld', () => {
  it('stroke is constant on screen: world width shrinks as zoom grows', () => {
    expect(selectionOutlineWorld(S, 0.1, 100).strokeWorld).toBeCloseTo(20);   // 2 px at 10 %
    expect(selectionOutlineWorld(S, 4, 100).strokeWorld).toBeCloseTo(0.5);   // 2 px at 400 %
  });

  it('a tiny part on screen is padded out to the minimum size', () => {
    // 40-mil part at 10 % zoom = 4 px on screen → needs (24 − 4) / 2 = 10 px of
    // padding each side = 100 mils at this zoom.
    expect(selectionOutlineWorld(S, 0.1, 40).padWorld).toBeCloseTo(100);
  });

  it('once the part is at least the minimum size, the outline is the border', () => {
    // 40-mil part at 100 % = 40 px ≥ 24 px → no padding at all.
    expect(selectionOutlineWorld(S, 1, 40).padWorld).toBe(0);
    expect(selectionOutlineWorld(S, 6, 40).padWorld).toBe(0);
  });

  it('the user gap is added on top, never replaced', () => {
    expect(selectionOutlineWorld({ ...S, selectionPadding: 4 }, 6, 40).padWorld).toBe(4);
    expect(selectionOutlineWorld({ ...S, selectionPadding: 4 }, 0.1, 40).padWorld).toBeCloseTo(104);
  });

  it('is exactly continuous at the threshold', () => {
    // Part reaches 24 px at scale 0.6 → padding hits zero there, not before.
    expect(selectionOutlineWorld(S, 0.6, 40).padWorld).toBeCloseTo(0);
    expect(selectionOutlineWorld(S, 0.59, 40).padWorld).toBeGreaterThan(0);
  });
});
