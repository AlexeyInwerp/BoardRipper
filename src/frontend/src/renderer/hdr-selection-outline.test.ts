import { describe, it, expect } from 'vitest';
import { rungForIntensity, GLOW_RUNGS, layoutPolygonEdges, isHdrPromptDismissed, dismissHdrPrompt, DEMO_RUNG } from './hdr-selection-outline';

describe('rungForIntensity', () => {
  it('maps max intensity to the brightest rung', () => {
    expect(rungForIntensity(10)).toBe(0);
  });

  it('maps min intensity to the dimmest rung', () => {
    expect(rungForIntensity(1)).toBe(GLOW_RUNGS - 1);
  });

  it('is monotonically decreasing in rung as intensity rises', () => {
    let prev = GLOW_RUNGS;
    for (let i = 1; i <= 10; i++) {
      const r = rungForIntensity(i);
      expect(r).toBeLessThanOrEqual(prev);
      prev = r;
    }
  });

  it('never returns a rung outside the baked ladder', () => {
    for (const i of [-5, 0, 1, 5, 10, 99]) {
      const r = rungForIntensity(i);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThan(GLOW_RUNGS);
    }
  });

  it('returns an integer (rungs are file names, not fractions)', () => {
    expect(Number.isInteger(rungForIntensity(7))).toBe(true);
  });
});

describe('layoutPolygonEdges', () => {
  const square = [[0, 0], [100, 0], [100, 100], [0, 100]] as const;

  it('closes the loop — a 4-gon yields 4 edges, not 3', () => {
    expect(layoutPolygonEdges(square, 4)).toHaveLength(4);
  });

  it('extends each edge by the thickness so corners meet without notches', () => {
    const [top] = layoutPolygonEdges(square, 4);
    expect(top.length).toBe(104);   // 100 + thickness
    expect(top.x).toBe(-2);         // started half a thickness early
    expect(top.y).toBe(0);
  });

  it('orients edges along their direction', () => {
    const e = layoutPolygonEdges(square, 4);
    expect(e[0].angleRad).toBeCloseTo(0, 6);              // left -> right
    expect(e[1].angleRad).toBeCloseTo(Math.PI / 2, 6);    // top -> bottom
  });

  it('handles a rotated (OBB) polygon, not just axis-aligned rects', () => {
    const diamond = [[50, 0], [100, 50], [50, 100], [0, 50]] as const;
    const e = layoutPolygonEdges(diamond, 2);
    expect(e).toHaveLength(4);
    expect(e[0].angleRad).toBeCloseTo(Math.PI / 4, 6);
  });

  it('skips degenerate zero-length edges instead of emitting NaN angles', () => {
    const dup = [[0, 0], [0, 0], [50, 0], [50, 50]] as const;
    const e = layoutPolygonEdges(dup, 2);
    expect(e).toHaveLength(3);
    for (const p of e) expect(Number.isFinite(p.angleRad)).toBe(true);
  });

  it('returns nothing for a degenerate polygon', () => {
    expect(layoutPolygonEdges([[5, 5]], 2)).toHaveLength(0);
    expect(layoutPolygonEdges([], 2)).toHaveLength(0);
  });
});

describe('HDR discovery prompt dismissal', () => {
  // vitest runs in the 'node' environment, so localStorage is absent — which is
  // also the real-world "storage blocked / private mode" case. The prompt must
  // report itself as already dismissed there rather than throwing or nagging
  // every single boot with no way to persist the dismissal.
  it('reports dismissed when storage is unavailable, instead of throwing', () => {
    expect(() => isHdrPromptDismissed()).not.toThrow();
    expect(isHdrPromptDismissed()).toBe(true);
  });

  it('swallows storage failures when dismissing', () => {
    expect(() => dismissHdrPrompt()).not.toThrow();
  });

  it('demos at the brightest rung — the point is to be unmistakable', () => {
    expect(DEMO_RUNG).toBe(0);
    expect(rungForIntensity(10)).toBe(DEMO_RUNG);
  });
});
