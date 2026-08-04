import { describe, it, expect } from 'vitest';
import { focusHaloGeometry } from './focus-halo';

describe('focusHaloGeometry', () => {
  it('centres on the bounds centroid', () => {
    const g = focusHaloGeometry({ minX: 100, maxX: 300, minY: 50, maxY: 150 });
    expect(g.x).toBe(200);
    expect(g.y).toBe(100);
  });

  it('applies the 1500 mil floor to tiny passives', () => {
    // an 0402 is ~40x20 mils — far under the floor
    const g = focusHaloGeometry({ minX: 0, maxX: 40, minY: 0, maxY: 20 });
    expect(g.size).toBe(1500);
  });

  it('grows additively (not multiplicatively) for large parts', () => {
    // 2000 mil BGA -> 2000 + 800 padding, NOT a multiple of 2000
    const g = focusHaloGeometry({ minX: 0, maxX: 2000, minY: 0, maxY: 2000 });
    expect(g.size).toBe(2800);
  });

  it('sizes from the longer axis', () => {
    const g = focusHaloGeometry({ minX: 0, maxX: 3000, minY: 0, maxY: 100 });
    expect(g.size).toBe(3800);
  });

  it('never returns a zero size for degenerate bounds', () => {
    const g = focusHaloGeometry({ minX: 5, maxX: 5, minY: 5, maxY: 5 });
    expect(g.size).toBe(1500);
  });
});
