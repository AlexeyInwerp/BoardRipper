import { describe, it, expect } from 'vitest';
import { buildDanglingIndex, inferPlacement, pointKey } from './allegro/allegro-infer-placement';
import type { Trace } from './types';

const seg = (net: string, x1: number, y1: number, x2: number, y2: number, layer = 0): Trace =>
  ({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, width: 4, net, layer });

/**
 * A row of pads at 16 mil pitch whose component is gone: each pad is still fed
 * by a stub, and the far end of every stub drops to a via — which is what makes
 * the pad end the only loose end on that net.
 */
function ghostRing(x0: number, y0: number, nets: string[]): { traces: Trace[]; vias: Set<string> } {
  const traces = nets.map((n, i) => seg(n, x0 + i * 16, y0, x0 + i * 16, y0 - 50));
  const vias = new Set(nets.map((_, i) => pointKey({ x: x0 + i * 16, y: y0 - 50 })));
  return { traces, vias };
}

describe('buildDanglingIndex', () => {
  it('keeps endpoints that terminate on nothing', () => {
    const idx = buildDanglingIndex([seg('A', 0, 0, 100, 0)], new Set());
    // both ends are loose
    expect(idx.byNet.get('A')).toHaveLength(2);
  });

  it('ignores endpoints that land on a real pad', () => {
    const idx = buildDanglingIndex([seg('A', 0, 0, 100, 0)], new Set([pointKey({ x: 0, y: 0 })]));
    expect(idx.byNet.get('A')).toHaveLength(1);
  });

  it('ignores endpoints that land on a via — a trace changing layer is routed, not orphaned', () => {
    const idx = buildDanglingIndex([seg('A', 0, 0, 100, 0)], new Set([pointKey({ x: 100, y: 0 })]));
    expect(idx.byNet.get('A')?.[0]).toEqual({ x: 0, y: 0 });
  });

  it('does not treat a corner shared by two segments as a termination', () => {
    const idx = buildDanglingIndex([seg('A', 0, 0, 50, 0), seg('A', 50, 0, 50, 50)], new Set());
    const pts = idx.byNet.get('A')!;
    expect(pts).toHaveLength(2);
    expect(pts.some((p) => p.x === 50 && p.y === 0)).toBe(false);
  });

  it('records the layer each loose end sits on', () => {
    const idx = buildDanglingIndex([seg('A', 0, 0, 100, 0, 3)], new Set());
    expect(idx.layerAt.get(pointKey({ x: 0, y: 0 }))).toBe(3);
  });
});

describe('inferPlacement', () => {
  const nets = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8'];

  it('recovers a footprint from the routing that ends on its pads', () => {
    const g = ghostRing(1000, 2000, nets);
    const idx = buildDanglingIndex(g.traces, g.vias);
    const res = inferPlacement(nets, idx)!;
    expect(res).not.toBeNull();
    expect(res.resolved).toBe(8);
    // pads sit on the ring row, so the recovered span matches the pitch × count
    expect(res.bounds.maxX - res.bounds.minX).toBe(16 * 7);
    expect(res.origin.x).toBeCloseTo(1000 + (16 * 7) / 2, 5);
  });

  it('refuses a part with too few pins to be inferable', () => {
    const few = ['N1', 'N2', 'N3'];
    const g = ghostRing(1000, 2000, few);
    expect(inferPlacement(few, buildDanglingIndex(g.traces, g.vias))).toBeNull();
  });

  it('will not claim a pin whose net has several loose ends nearby', () => {
    // N1 gets a second loose end right next to the ring: ambiguous, so unclaimed.
    const g = ghostRing(1000, 2000, nets);
    const idx = buildDanglingIndex([...g.traces, seg('N1', 1008, 2000, 1008, 1950)], g.vias);
    const res = inferPlacement(nets, idx)!;
    expect(res.pinPositions[0]).toBeNull();
    expect(res.resolved).toBe(7);
  });

  it('ignores a net that is loose all over the board, and still places the part', () => {
    const spread: Trace[] = [];
    for (let i = 0; i < 40; i++) spread.push(seg('GND', 9000 + i * 500, 100, 9000 + i * 500, 150));
    const withGnd = [...nets.slice(0, 7), 'GND'];
    const g = ghostRing(1000, 2000, withGnd);
    const idx = buildDanglingIndex([...g.traces, ...spread], g.vias);
    const res = inferPlacement(withGnd, idx)!;
    expect(res).not.toBeNull();
    // the far-away GND stubs must not drag the body across the board
    expect(res.origin.x).toBeGreaterThan(900);
    expect(res.origin.x).toBeLessThan(1200);
  });

  it('returns null when there is no routing to go on', () => {
    expect(inferPlacement(nets, buildDanglingIndex([], new Set()))).toBeNull();
  });

  it('drops an outlier claim rather than stretching the body to reach it', () => {
    // N8's only loose end is 3000 mils away — it must not join the footprint.
    const g = ghostRing(1000, 2000, nets.slice(0, 7));
    const idx = buildDanglingIndex([...g.traces, seg('N8', 4000, 2000, 4000, 1950)], g.vias);
    const res = inferPlacement(nets, idx)!;
    expect(res.bounds.maxX).toBeLessThan(1200);
  });
});

/**
 * Gap filling along an edge. A footprint's pads are evenly spaced, so a pin
 * whose number falls between two located pins of the same run is determined by
 * that run's pitch — the case that left PUB1 missing pins 17 and 18 from an
 * otherwise complete top row.
 */
describe('edge gap filling', () => {
  /** One row of pads at 16 mil pitch, all but `absent` reachable by copper. */
  function row(pins: number[], absent: number[]) {
    const nets = pins.map((n) => `N${n}`);
    const traces: Trace[] = [];
    const vias = new Set<string>();
    pins.forEach((n, i) => {
      if (absent.includes(n)) return;
      traces.push(seg(`N${n}`, 1000 + i * 16, 2000, 1000 + i * 16, 1950));
      vias.add(pointKey({ x: 1000 + i * 16, y: 1950 }));
    });
    return { nets, numbers: pins.map(String), idx: buildDanglingIndex(traces, vias) };
  }

  it('fills a hole in the middle of a row at the row pitch', () => {
    const r = row([1, 2, 3, 4, 5, 6, 7], [4]);
    const res = inferPlacement(r.nets, r.idx, r.numbers)!;
    expect(res.pinPositions[3]).toEqual({ x: 1048, y: 2000 });   // pin 4
    expect(res.interpolated).toBe(1);
  });

  it('fills several holes at once', () => {
    const r = row([1, 2, 3, 4, 5, 6, 7], [3, 5]);
    const res = inferPlacement(r.nets, r.idx, r.numbers)!;
    expect(res.pinPositions[2]).toEqual({ x: 1032, y: 2000 });
    expect(res.pinPositions[4]).toEqual({ x: 1064, y: 2000 });
    expect(res.interpolated).toBe(2);
  });

  it('never extrapolates past the ends of a run — that walks around the corner', () => {
    const r = row([1, 2, 3, 4, 5, 6, 7], [1, 7]);
    const res = inferPlacement(r.nets, r.idx, r.numbers)!;
    expect(res.pinPositions[0]).toBeNull();
    expect(res.pinPositions[6]).toBeNull();
    expect(res.interpolated).toBe(0);
  });

  it('does nothing without pin numbers to order the run by', () => {
    const r = row([1, 2, 3, 4, 5, 6, 7], [4]);
    const res = inferPlacement(r.nets, r.idx)!;
    expect(res.pinPositions[3]).toBeNull();
    expect(res.interpolated).toBe(0);
  });

  it('leaves non-numeric designators alone (a BGA row carries no pitch)', () => {
    const r = row([1, 2, 3, 4, 5, 6, 7], [4]);
    const bga = r.numbers.map((n) => `M${n}`);
    const res = inferPlacement(r.nets, r.idx, bga)!;
    expect(res.interpolated).toBe(0);
  });

  it('refuses a run whose located pads do not share one pitch', () => {
    // Pin 5 sits 8 mils off the row's grid — close enough to stay in the
    // cluster, far enough that 1..6 is not one evenly-spaced edge. Nothing may
    // be read off a run like that, so the pin-4 gap stays empty.
    const nets = [1, 2, 3, 4, 5, 6].map((n) => `N${n}`);
    const traces: Trace[] = []; const vias = new Set<string>();
    [0, 16, 32, 48, 72, 80].forEach((dx, i) => {
      if (i === 3) return;                     // pin 4 absent, the gap to fill
      traces.push(seg(`N${i + 1}`, 1000 + dx, 2000, 1000 + dx, 1950));
      vias.add(pointKey({ x: 1000 + dx, y: 1950 }));
    });
    const res = inferPlacement(nets, buildDanglingIndex(traces, vias), ['1','2','3','4','5','6']);
    expect(res?.interpolated ?? 0).toBe(0);
  });

  it('a pad far outside the cluster is dropped, and the rest still fills', () => {
    // The same row with pin 5 abandoned 900 mils away: clustering discards it,
    // and the remaining 1,2,3,6 are a consistent edge, so 4 and 5 fill in.
    const nets = [1, 2, 3, 4, 5, 6].map((n) => `N${n}`);
    const traces: Trace[] = []; const vias = new Set<string>();
    [0, 16, 32, 48, 999, 80].forEach((dx, i) => {
      if (i === 3) return;
      traces.push(seg(`N${i + 1}`, 1000 + dx, 2000, 1000 + dx, 1950));
      vias.add(pointKey({ x: 1000 + dx, y: 1950 }));
    });
    const res = inferPlacement(nets, buildDanglingIndex(traces, vias), ['1','2','3','4','5','6'])!;
    expect(res.pinPositions[3]).toEqual({ x: 1048, y: 2000 });
    expect(res.pinPositions[4]).toEqual({ x: 1064, y: 2000 });
  });
});
