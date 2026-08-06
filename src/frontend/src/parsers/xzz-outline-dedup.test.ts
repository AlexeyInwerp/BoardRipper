import { describe, it, expect } from 'vitest';
import { dedupeCoincidentSegments } from './xzz-parser';

const seg = (x1: number, y1: number, x2: number, y2: number) =>
  ({ p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } });

describe('dedupeCoincidentSegments', () => {
  it('drops an edge listed twice', () => {
    const segs = [seg(0, 0, 10, 0), seg(0, 0, 10, 0)];
    expect(dedupeCoincidentSegments(segs)).toBe(1);
    expect(segs).toHaveLength(1);
  });

  it('drops a reversed copy of the same edge', () => {
    const segs = [seg(0, 0, 10, 0), seg(10, 0, 0, 0)];
    expect(dedupeCoincidentSegments(segs)).toBe(1);
    expect(segs).toHaveLength(1);
  });

  it('KEEPS adjacent short segments — the bug this replaced', () => {
    // Two 0.774-mil segments joined end to end, taken from the arc-sampled
    // corners of A2485-820-02100-A. Under the old 1-mil endpoint epsilon each
    // was deleted as a "duplicate" of its own neighbour, because both of its
    // endpoints sit within 1 mil of both of the neighbour's. That cut the
    // outline loop open at every fillet on 8 of 32 corpus boards.
    const segs = [seg(0, 0, 0.774, 0), seg(0.774, 0, 1.548, 0)];
    expect(dedupeCoincidentSegments(segs)).toBe(0);
    expect(segs).toHaveLength(2);
  });

  it('keeps a whole arc-sampled fillet intact', () => {
    // 90° of r = 14.6 mil in 9 steps — 0.8 mil each, the real corpus case.
    const r = 14.6, N = 9;
    const segs = [];
    for (let i = 0; i < N; i++) {
      const t0 = (Math.PI / 2) * (i / N), t1 = (Math.PI / 2) * ((i + 1) / N);
      segs.push(seg(r * Math.cos(t0), r * Math.sin(t0), r * Math.cos(t1), r * Math.sin(t1)));
    }
    expect(dedupeCoincidentSegments(segs)).toBe(0);
    expect(segs).toHaveLength(N);
  });

  it('keeps distinct edges that merely share a vertex', () => {
    const segs = [seg(0, 0, 10, 0), seg(10, 0, 10, 10), seg(10, 10, 0, 10)];
    expect(dedupeCoincidentSegments(segs)).toBe(0);
    expect(segs).toHaveLength(3);
  });

  it('absorbs sub-quantum float noise between identical arc samples', () => {
    // Identical arcs sample to identical floats, but be tolerant of the last
    // ulp: 0.001 mil apart is the same edge, 0.05 mil apart is not noise.
    const near = [seg(0, 0, 10, 0), seg(0.001, 0, 10.001, 0)];
    expect(dedupeCoincidentSegments(near)).toBe(1);
    const far = [seg(0, 0, 10, 0), seg(0.05, 0, 10.05, 0)];
    expect(dedupeCoincidentSegments(far)).toBe(0);
  });

  it('preserves order of the survivors', () => {
    const segs = [seg(0, 0, 1, 0), seg(1, 0, 2, 0), seg(0, 0, 1, 0), seg(2, 0, 3, 0)];
    dedupeCoincidentSegments(segs);
    expect(segs.map(s => `${s.p1.x}->${s.p2.x}`)).toEqual(['0->1', '1->2', '2->3']);
  });

  it('handles an empty list', () => {
    const segs: ReturnType<typeof seg>[] = [];
    expect(dedupeCoincidentSegments(segs)).toBe(0);
  });
});
