/** Pure helpers for RangeControl — kept out of the component so the value
 *  arithmetic is unit-testable without a DOM. */

/** Snap `v` to the step grid anchored at `min`, clamped to [min, max]. */
export function snapToStep(v: number, min: number, max: number, step: number): number {
  if (!(step > 0)) return Math.min(max, Math.max(min, v));
  const n = Math.round((v - min) / step);
  const snapped = min + n * step;
  // Round away floating-point dust (0.30000000000000004) to the step's decimals.
  const decimals = Math.max(0, Math.min(10, Math.ceil(-Math.log10(step)) + 1));
  const fixed = Number(snapped.toFixed(decimals));
  return Math.min(max, Math.max(min, fixed));
}

/** Fraction 0..1 of where `v` sits on [min, max]. */
export function valueToRatio(v: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

/** Value at fraction `t` (clamped to 0..1), snapped to the step grid. */
export function ratioToValue(t: number, min: number, max: number, step: number): number {
  const tt = Math.min(1, Math.max(0, t));
  return snapToStep(min + tt * (max - min), min, max, step);
}

/** Keyboard delta for a slider: arrows move one step, Shift ×5, Page ×10. */
export function keyboardDelta(key: string, step: number, shift: boolean): number | null {
  switch (key) {
    case 'ArrowRight': case 'ArrowUp': return step * (shift ? 5 : 1);
    case 'ArrowLeft': case 'ArrowDown': return -step * (shift ? 5 : 1);
    case 'PageUp': return step * 10;
    case 'PageDown': return -step * 10;
    default: return null;
  }
}
