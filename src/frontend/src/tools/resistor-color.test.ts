import { describe, it, expect } from 'vitest';
import { decodeResistorColor } from './resistor-color';

describe('decodeResistorColor', () => {
  it('decodes a 4-band 1kΩ ±5% (brown black red gold)', () => {
    const r = decodeResistorColor(['brown', 'black', 'red', 'gold']);
    expect(r.error).toBeUndefined();
    expect(r.ohms).toBe(1000);
    expect(r.tolerancePct).toBe(5);
    expect(r.min).toBeCloseTo(950);
    expect(r.max).toBeCloseTo(1050);
    expect(r.formatted).toBe('1 kΩ');
  });
  it('decodes a 5-band 10.0kΩ ±1% (brown black black red brown)', () => {
    const r = decodeResistorColor(['brown', 'black', 'black', 'red', 'brown']);
    expect(r.ohms).toBe(10000);
    expect(r.tolerancePct).toBe(1);
    expect(r.formatted).toBe('10 kΩ');
  });
  it('decodes a 6-band with temp-co (brown black black red brown red)', () => {
    const r = decodeResistorColor(['brown', 'black', 'black', 'red', 'brown', 'red']);
    expect(r.ohms).toBe(10000);
    expect(r.tempCoPpm).toBe(50);
  });
  it('treats a missing 4th tolerance band as ±20%', () => {
    const r = decodeResistorColor(['brown', 'black', 'red', 'none']);
    expect(r.tolerancePct).toBe(20);
  });
  it('errors when a digit band holds a non-digit color', () => {
    const r = decodeResistorColor(['gold', 'black', 'red', 'gold']);
    expect(r.error).toBeDefined();
  });
});
