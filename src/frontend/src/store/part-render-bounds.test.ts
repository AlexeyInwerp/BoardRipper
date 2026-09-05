import { describe, it, expect } from 'vitest';
import {
  DEFAULTS,
  computeEffectiveBounds,
  computePartRenderBounds,
  computeOutlinePadding,
  computeMinPinSpacing,
  computePinRadius,
  type RenderSettings,
} from './render-settings';

const s: RenderSettings = { ...DEFAULTS, selectionPadding: 0 };

const pin = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ position: { x, y }, radius: 4, side: 'top' as const, net: 'N', name: '', number: '1', ...extra });

describe('2-pin body rect: border and selection share one box', () => {
  it('with real pad outlines the body is the pad union, not the union plus a pad depth', () => {
    // 0201-ish: pins 20 mil apart, pads 8.5 x 12.5 (XZZ iPhone numbers)
    const pins = [
      pin(0, 0, { padBounds: { minX: -4.25, maxX: 4.25, minY: -6.25, maxY: 6.25 } }),
      pin(20, 0, { padBounds: { minX: 15.75, maxX: 24.25, minY: -6.25, maxY: 6.25 } }),
    ];
    const part = { name: 'C1', bounds: { minX: 0, maxX: 20, minY: 0, maxY: 0 }, pins };
    const rb = computePartRenderBounds(part, s);
    expect(rb.px).toBeCloseTo(-4.25);
    expect(rb.pw).toBeCloseTo(28.5);
    // Height follows the effective bounds: the thin-part rule inflates a body
    // shorter than 80% of the pin span (12.5 -> 16 here), for border and
    // selection alike.
    const eb = computeEffectiveBounds(part.bounds, pins, s);
    expect(rb.py).toBeCloseTo(eb.py);
    expect(rb.ph).toBeCloseTo(eb.ph);
    expect(rb.ph).toBeCloseTo(16);
  });

  it('without pad outlines the body is the pin span plus one synthesised pad depth', () => {
    const pins = [pin(0, 0), pin(20, 0)];
    const part = { name: 'R1', bounds: { minX: 0, maxX: 20, minY: 0, maxY: 0 }, pins };
    const eb = computeEffectiveBounds(part.bounds, pins, s);
    const padDepth = Math.min(eb.ph, eb.pw * 0.4);
    const rb = computePartRenderBounds(part, s);
    expect(rb.px).toBeCloseTo(-padDepth / 2);
    expect(rb.pw).toBeCloseTo(20 + padDepth);
    expect(rb.ph).toBeCloseTo(eb.ph);
  });
});

describe('multi-pin outline padding uses the drawn (overlap-clamped) pin radius', () => {
  it('a dense grid pads with 45% of the pitch, not the file radius', () => {
    const pins: ReturnType<typeof pin>[] = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) pins.push(pin(c * 16, r * 16, { radius: 14 }));
    expect(computeMinPinSpacing(pins)).toBe(16);
    const clampedR = 16 * 0.45;
    expect(computePinRadius(s, 14)).toBeGreaterThan(clampedR);   // the clamp actually bites
    expect(computeOutlinePadding(s, pins)).toBeCloseTo(s.partPadding + Math.max(s.pinMinRadius, clampedR));
    const part = { name: 'U1', bounds: { minX: 0, maxX: 48, minY: 0, maxY: 48 }, pins };
    const rb = computePartRenderBounds(part, s);
    expect(rb.px).toBeCloseTo(-(s.partPadding + Math.max(s.pinMinRadius, clampedR)));
  });

  it('a sparse part keeps the unclamped radius', () => {
    const pins = [pin(0, 0, { radius: 10 }), pin(200, 0, { radius: 10 }), pin(200, 200, { radius: 10 }), pin(0, 200, { radius: 10 }), pin(100, 100, { radius: 10 })];
    expect(computeOutlinePadding(s, pins)).toBeCloseTo(s.partPadding + computePinRadius(s, 10));
  });
});
