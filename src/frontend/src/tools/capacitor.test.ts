import { describe, it, expect } from 'vitest';
import { convertCapacitance, formatCapValue } from './capacitor';

describe('convertCapacitance', () => {
  it('converts across pF / nF / µF', () => {
    expect(convertCapacitance(100, 'nF', 'pF')).toBe(100_000);
    expect(convertCapacitance(100, 'nF', 'µF')).toBeCloseTo(0.1);
    expect(convertCapacitance(1, 'µF', 'nF')).toBe(1_000);
    expect(convertCapacitance(1, 'µF', 'pF')).toBe(1_000_000);
    expect(convertCapacitance(4700, 'pF', 'nF')).toBeCloseTo(4.7);
  });
  it('is identity for the same unit', () => {
    expect(convertCapacitance(47, 'nF', 'nF')).toBe(47);
  });
});

describe('formatCapValue', () => {
  it('strips float noise and trailing zeros', () => {
    expect(formatCapValue(0.1)).toBe('0.1');
    expect(formatCapValue(100_000)).toBe('100000');
    expect(formatCapValue(4.7)).toBe('4.7');
    expect(formatCapValue(0)).toBe('0');
  });
  it('keeps precision for 4.7 nF expressed in µF (not rounded to 0.005)', () => {
    expect(formatCapValue(convertCapacitance(4.7, 'nF', 'µF'))).toBe('0.0047');
  });
  it('returns empty string for a non-finite value (half-typed field)', () => {
    expect(formatCapValue(NaN)).toBe('');
  });
});
