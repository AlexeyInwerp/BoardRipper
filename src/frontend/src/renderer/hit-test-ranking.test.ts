import { describe, it, expect } from 'vitest';
import { compareStackHits, type StackHit } from './hit-test-ranking';

// Helper: sort a copy and return the partIndex order.
const order = (hits: StackHit[]) => [...hits].sort(compareStackHits).map(h => h.partIndex);

describe('compareStackHits (#24 selection ranking)', () => {
  it('a contained component outranks a smaller test point hit only by distance', () => {
    // The #24 bug: a tiny test point (area 1) admitted via the zoom-scaled click
    // threshold (contained=false) must NOT beat the component the click is
    // actually inside (area 100, contained=true).
    const component: StackHit = { partIndex: 10, pinIndex: -1, area: 100, sub: 0, contained: true };
    const testPoint: StackHit = { partIndex: 20, pinIndex: 0, area: 1, sub: 0, contained: false };
    expect(order([testPoint, component])).toEqual([10, 20]);
  });

  it('among genuinely stacked (contained) parts, smallest area still wins (#23 preserved)', () => {
    const big: StackHit = { partIndex: 1, pinIndex: -1, area: 200, sub: 0, contained: true };
    const small: StackHit = { partIndex: 2, pinIndex: -1, area: 40, sub: 0, contained: true };
    expect(order([big, small])).toEqual([2, 1]);
  });

  it('within one part, the pin entry (sub 0) precedes the whole-body entry (sub 1)', () => {
    const body: StackHit = { partIndex: 5, pinIndex: -1, area: 30, sub: 1, contained: true };
    const pin: StackHit = { partIndex: 5, pinIndex: 1, area: 30, sub: 0, contained: true };
    expect([...[body, pin]].sort(compareStackHits).map(h => h.pinIndex)).toEqual([1, -1]);
  });

  it('when nothing is contained, falls back to smallest-first among distance hits', () => {
    const a: StackHit = { partIndex: 7, pinIndex: 0, area: 5, sub: 0, contained: false };
    const b: StackHit = { partIndex: 8, pinIndex: 0, area: 1, sub: 0, contained: false };
    expect(order([a, b])).toEqual([8, 7]);
  });
});
