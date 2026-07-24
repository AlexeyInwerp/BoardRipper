import { describe, it, expect } from 'vitest';
import { decodeSmdResistor } from './smd-resistor';

describe('decodeSmdResistor', () => {
  it('decodes 3-digit codes', () => {
    expect(decodeSmdResistor('103').ohms).toBe(10000);
    expect(decodeSmdResistor('472').ohms).toBe(4700);
    expect(decodeSmdResistor('100').ohms).toBe(10);
  });
  it('decodes 4-digit codes', () => {
    expect(decodeSmdResistor('1002').ohms).toBe(10000);
    expect(decodeSmdResistor('4700').ohms).toBe(470);
  });
  it('decodes R-notation', () => {
    expect(decodeSmdResistor('4R7').ohms).toBeCloseTo(4.7);
    expect(decodeSmdResistor('R47').ohms).toBeCloseTo(0.47);
    expect(decodeSmdResistor('0R5').ohms).toBeCloseTo(0.5);
  });
  it('decodes EIA-96 (2 digits + multiplier letter)', () => {
    expect(decodeSmdResistor('01C').ohms).toBe(10000);
    expect(decodeSmdResistor('68X').ohms).toBeCloseTo(49.9);
    expect(decodeSmdResistor('01A').ohms).toBe(100);
  });
  it('is case-insensitive and trims', () => {
    expect(decodeSmdResistor(' 4r7 ').ohms).toBeCloseTo(4.7);
    expect(decodeSmdResistor('01c').ohms).toBe(10000);
  });
  it('reports an error for junk', () => {
    expect(decodeSmdResistor('zzz').error).toBeDefined();
    expect(decodeSmdResistor('').error).toBeDefined();
  });
});
