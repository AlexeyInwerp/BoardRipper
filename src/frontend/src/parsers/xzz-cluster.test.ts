import { describe, it, expect } from 'vitest';
import { clusterSegments, type Segment } from './xzz-parser';

/** Reference: verbatim copy of the pre-optimization all-pairs implementation. */
function clusterSegmentsNaive(segments: Segment[], eps = 1.0): number[][] {
  const n = segments.length;
  if (n === 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(i: number): number {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < n; i++) {
    const si = segments[i];
    for (let j = i + 1; j < n; j++) {
      const sj = segments[j];
      if (Math.hypot(si.p1.x - sj.p1.x, si.p1.y - sj.p1.y) < eps ||
          Math.hypot(si.p1.x - sj.p2.x, si.p1.y - sj.p2.y) < eps ||
          Math.hypot(si.p2.x - sj.p1.x, si.p2.y - sj.p1.y) < eps ||
          Math.hypot(si.p2.x - sj.p2.x, si.p2.y - sj.p2.y) < eps) union(i, j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(i);
  }
  return [...groups.values()];
}

/** Canonicalize: sort members within groups, then groups by first member. */
function canon(groups: number[][]): number[][] {
  return groups.map(g => [...g].sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seg(x1: number, y1: number, x2: number, y2: number): Segment {
  return { p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

describe('clusterSegments', () => {
  it('groups a connected chain and isolates a distant segment', () => {
    const segs = [seg(0, 0, 10, 0), seg(10, 0.5, 20, 0), seg(100, 100, 110, 100)];
    expect(canon(clusterSegments(segs))).toEqual([[0, 1], [2]]);
  });

  it('treats distance exactly eps as NOT connected (strict <)', () => {
    const segs = [seg(0, 0, 10, 0), seg(11.0, 0, 20, 0)]; // gap exactly 1.0
    expect(canon(clusterSegments(segs, 1.0))).toEqual([[0], [1]]);
  });

  it('connects across cell boundaries and negative coordinates', () => {
    const close = [seg(-0.3, 0, -10, -10), seg(0.3, 0, 10, 10)]; // endpoints 0.6 apart
    expect(canon(clusterSegments(close))).toEqual([[0, 1]]);
    const apart = [seg(-1.4, 0, -10, -10), seg(1.4, 0, 10, 10)]; // 2.8 apart
    expect(canon(clusterSegments(apart)).length).toBe(2);
  });

  it('matches the all-pairs reference on 500 random segments (three seeds)', () => {
    for (const seedVal of [1, 42, 20260712]) {
      const r = rng(seedVal);
      const segs: Segment[] = [];
      for (let i = 0; i < 500; i++) {
        const x = r() * 80, y = r() * 80;
        segs.push(seg(x, y, x + r() * 4 - 2, y + r() * 4 - 2));
      }
      expect(canon(clusterSegments(segs))).toEqual(canon(clusterSegmentsNaive(segs)));
    }
  });

  it('matches the reference with a non-default eps', () => {
    const r = rng(7);
    const segs: Segment[] = [];
    for (let i = 0; i < 200; i++) {
      const x = r() * 40, y = r() * 40;
      segs.push(seg(x, y, x + r() * 6 - 3, y + r() * 6 - 3));
    }
    expect(canon(clusterSegments(segs, 2.5))).toEqual(canon(clusterSegmentsNaive(segs, 2.5)));
  });

  it('returns [] on empty input', () => {
    expect(clusterSegments([])).toEqual([]);
  });
});
