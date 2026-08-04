import { describe, it, expect } from 'vitest';
import { pqEncode } from './pq';

describe('pqEncode', () => {
  it('maps 0 nits to signal 0', () => {
    expect(pqEncode(0)).toBe(0);
  });

  it('maps the PQ peak (10000 nits) to signal 1', () => {
    expect(pqEncode(10000)).toBeCloseTo(1, 6);
  });

  // SDR reference white. The exact value falls near 0.5065; the loose bound
  // catches a broken formula (wrong m1/m2/c-constants land far outside this)
  // without being brittle about the last decimal.
  it('maps SDR reference white (100 nits) to roughly half signal', () => {
    const v = pqEncode(100);
    expect(v).toBeGreaterThan(0.49);
    expect(v).toBeLessThan(0.52);
  });

  it('is monotonically increasing', () => {
    let prev = -1;
    for (const nits of [0, 1, 10, 100, 203, 600, 1000, 4000, 10000]) {
      const v = pqEncode(nits);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it('clamps above the PQ peak instead of exceeding 1', () => {
    expect(pqEncode(50000)).toBeCloseTo(1, 6);
  });
});
