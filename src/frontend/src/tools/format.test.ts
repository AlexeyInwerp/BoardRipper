import { describe, it, expect } from 'vitest';
import { formatOhms, trimNum } from './format';

describe('formatOhms', () => {
  it('formats sub-kilo values in ohms', () => {
    expect(formatOhms(4.7)).toBe('4.7 Ω');
    expect(formatOhms(470)).toBe('470 Ω');
  });
  it('formats kilo/mega/giga with a decimal', () => {
    expect(formatOhms(1000)).toBe('1 kΩ');
    expect(formatOhms(10000)).toBe('10 kΩ');
    expect(formatOhms(4700)).toBe('4.7 kΩ');
    expect(formatOhms(1_000_000)).toBe('1 MΩ');
    expect(formatOhms(1_000_000_000)).toBe('1 GΩ');
  });
  it('formats fractional ohms', () => {
    expect(formatOhms(0.47)).toBe('0.47 Ω');
  });
});

describe('trimNum', () => {
  it('rounds to 3 decimals and strips trailing zeros', () => {
    expect(trimNum(1)).toBe('1');
    expect(trimNum(4.7)).toBe('4.7');
    expect(trimNum(10)).toBe('10');
    expect(trimNum(0.47)).toBe('0.47');
  });
});
