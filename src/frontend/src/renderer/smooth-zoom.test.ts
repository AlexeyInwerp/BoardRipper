import { describe, it, expect } from 'vitest';
import { stepExpApproach, ZOOM_TWEEN_RATE } from './smooth-zoom';

describe('stepExpApproach', () => {
  it('moves toward the target and converges', () => {
    let v = 1;
    for (let i = 0; i < 200; i++) v = stepExpApproach(v, 2, 16.7, ZOOM_TWEEN_RATE);
    expect(v).toBeCloseTo(2, 5);
  });

  it('is frame-rate independent: two 8ms steps ≈ one 16ms step', () => {
    const one = stepExpApproach(1, 2, 16, ZOOM_TWEEN_RATE);
    const two = stepExpApproach(stepExpApproach(1, 2, 8, ZOOM_TWEEN_RATE), 2, 8, ZOOM_TWEEN_RATE);
    expect(Math.abs(one - two)).toBeLessThan(1e-9);
  });

  it('snaps exactly onto the target within epsilon', () => {
    expect(stepExpApproach(1.99999, 2, 16, ZOOM_TWEEN_RATE)).toBe(2);
  });

  it('never overshoots', () => {
    expect(stepExpApproach(1, 2, 10_000, ZOOM_TWEEN_RATE)).toBeLessThanOrEqual(2);
  });
});
