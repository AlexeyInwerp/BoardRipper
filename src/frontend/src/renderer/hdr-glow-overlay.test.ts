import { describe, it, expect } from 'vitest';
import { rungForIntensity, GLOW_RUNGS } from './hdr-glow-overlay';

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
