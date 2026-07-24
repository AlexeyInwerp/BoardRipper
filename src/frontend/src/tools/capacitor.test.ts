import { describe, it, expect } from 'vitest';
import { decodeCapacitor } from './capacitor';

describe('decodeCapacitor', () => {
  it('decodes 3-digit codes (value in pF)', () => {
    const r = decodeCapacitor('104');
    expect(r.pF).toBe(100000);
    expect(r.nF).toBeCloseTo(100);
    expect(r.uF).toBeCloseTo(0.1);
    expect(r.formatted).toBe('100 nF');
  });
  it('decodes p/n/u notation', () => {
    expect(decodeCapacitor('4n7').pF).toBeCloseTo(4700);
    expect(decodeCapacitor('22p').pF).toBeCloseTo(22);
    expect(decodeCapacitor('1u').pF).toBeCloseTo(1_000_000);
    expect(decodeCapacitor('n47').pF).toBeCloseTo(470);
  });
  it('treats 1-2 bare digits as literal pF', () => {
    expect(decodeCapacitor('47').pF).toBe(47);
  });
  it('parses a trailing tolerance letter', () => {
    const r = decodeCapacitor('104J');
    expect(r.pF).toBe(100000);
    expect(r.tolerancePct).toBe(5);
  });
  it('reports an error for junk', () => {
    expect(decodeCapacitor('xyz').error).toBeDefined();
    expect(decodeCapacitor('').error).toBeDefined();
  });
});
