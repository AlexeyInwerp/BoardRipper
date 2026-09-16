import { describe, it, expect } from 'vitest';
import { snapToStep, valueToRatio, ratioToValue, keyboardDelta } from './range-math';

describe('range-math', () => {
  it('snaps to the step grid without floating-point dust', () => {
    expect(snapToStep(0.30000000000000004, 0.3, 4, 0.1)).toBe(0.3);
    expect(snapToStep(1.04, 0.3, 4, 0.1)).toBe(1);
    expect(snapToStep(1.06, 0.3, 4, 0.1)).toBe(1.1);
    expect(snapToStep(9, 0, 5, 1)).toBe(5);
    expect(snapToStep(-1, 0, 5, 1)).toBe(0);
  });
  it('maps ratio and value both ways', () => {
    expect(valueToRatio(2.15, 0.3, 4)).toBeCloseTo(0.5);
    expect(ratioToValue(0.5, 0, 10, 1)).toBe(5);
    expect([2.1, 2.2]).toContain(ratioToValue(0.5, 0.3, 4, 0.1)); // 2.15 sits on a grid boundary
    expect(ratioToValue(-1, 0, 10, 1)).toBe(0);
    expect(ratioToValue(2, 0, 10, 1)).toBe(10);
  });
  it('keyboard deltas: arrows one step, shift ×5, page ×10', () => {
    expect(keyboardDelta('ArrowRight', 0.1, false)).toBeCloseTo(0.1);
    expect(keyboardDelta('ArrowLeft', 0.1, true)).toBeCloseTo(-0.5);
    expect(keyboardDelta('PageUp', 1, false)).toBe(10);
    expect(keyboardDelta('a', 1, false)).toBeNull();
  });
});
