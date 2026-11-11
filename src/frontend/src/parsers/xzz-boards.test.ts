import { describe, it, expect } from 'vitest';
import { classifyComponents, pairMajors, decideSide, splitSymmetricLoop, windingMode, synthesizeMissingHalf, type OutlineComponent, type ComponentPair } from './xzz-boards';

const comp = (minX: number, minY: number, w: number, h: number, segCount = 100): OutlineComponent =>
  ({ minX, minY, maxX: minX + w, maxY: minY + h, segCount, segIdxs: [] });

describe('classifyComponents', () => {
  it('keeps two boards as majors and nests a cutout into its board', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000), comp(100, 100, 50, 80, 12)];
    const c = classifyComponents(comps, [500, 500, 0]);
    expect(c.cls).toEqual(['major', 'major', 'cutout']);
    expect(c.parentOf[2]).toBe(0);
    expect(c.majors).toEqual([0, 1]);
  });

  it('resolves a hole inside a hole to the board', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(100, 100, 400, 400, 20), comp(200, 200, 50, 50, 8)];
    const c = classifyComponents(comps, [500, 0, 0]);
    expect(c.cls[2]).toBe('cutout');
    expect(c.parentOf[2]).toBe(0);
  });

  it('drops a plain rectangle drawn around everything as a frame', () => {
    const comps = [comp(-100, -100, 2300, 2200, 4), comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000)];
    const c = classifyComponents(comps, [0, 500, 500]);
    expect(c.cls[0]).toBe('frame');
    expect(c.majors).toEqual([1, 2]);
  });

  it('drops an empty plain rectangle beside the boards', () => {
    // iPhone XS "plug charging" file: a 4-segment sheet border next to the pack.
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000), comp(2100, 0, 2350, 3355, 4)];
    const c = classifyComponents(comps, [500, 500, 0]);
    expect(c.cls[2]).toBe('fragment');
  });

  it('keeps a small loop that holds parts (a sub-board) as a major', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000), comp(0, 2100, 100, 50, 30)];
    const c = classifyComponents(comps, [500, 500, 12]);
    expect(c.cls[2]).toBe('major');
  });

  it('drops a tiny empty loop as a fragment', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000), comp(0, 2100, 20, 20, 9)];
    const c = classifyComponents(comps, [500, 500, 0]);
    expect(c.cls[2]).toBe('fragment');
  });
});

describe('pairMajors', () => {
  it('pairs two mirror halves side by side and folds between them', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000)];
    const { pairs, singles } = pairMajors(comps, [0, 1]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ lower: 0, upper: 1, dim: 'x', axis: 1010, gap: 20 });
    expect(singles).toEqual([]);
  });

  it('tolerates a one-segment and a sub-3-mil difference between halves', () => {
    // iPhone 5 boardview: 386 vs 387 segments; XS Max: 431 vs 340 with a notch.
    const comps = [comp(0, 0, 1000, 2000, 386), comp(1020, 0, 1001.5, 2000, 431)];
    expect(pairMajors(comps, [0, 1]).pairs).toHaveLength(1);
  });

  it('refuses halves of different size', () => {
    const comps = [comp(0, 0, 945, 2647), comp(1000, 0, 945, 2985)];
    const r = pairMajors(comps, [0, 1]);
    expect(r.pairs).toHaveLength(0);
    expect(r.singles).toEqual([0, 1]);
  });

  it('pairs each board with its own neighbour in a pack of identical boards', () => {
    // Four identical halves in a row: (0,1) and (2,3), never (1,2) or (0,2).
    const comps = [comp(0, 0, 1000, 2000), comp(1020, 0, 1000, 2000), comp(2140, 0, 1000, 2000), comp(3160, 0, 1000, 2000)];
    const { pairs } = pairMajors(comps, [0, 1, 2, 3]);
    const key = pairs.map(p => `${p.lower}-${p.upper}`).sort();
    expect(key).toEqual(['0-1', '2-3']);
  });

  it('pairs vertically stacked halves on y', () => {
    const comps = [comp(0, -1933, 7342, 1771), comp(0, 0, 7342, 1771)];
    const { pairs } = pairMajors(comps, [0, 1]);
    expect(pairs[0]).toMatchObject({ lower: 0, upper: 1, dim: 'y' });
  });

  it('accepts the wide gaps of iPhone 4/5-era exports', () => {
    const comps = [comp(0, 0, 1621, 3919), comp(1840, 4, 1621, 3919)];
    expect(pairMajors(comps, [0, 1]).pairs).toHaveLength(1);
  });

  it('does not pair halves that overlap on both axes', () => {
    const comps = [comp(0, 0, 1000, 2000), comp(500, 500, 1000, 2000)];
    expect(pairMajors(comps, [0, 1]).pairs).toHaveLength(0);
  });
});

describe('decideSide', () => {
  const pairX: ComponentPair = { lower: 0, upper: 1, dim: 'x', axis: 1010, gap: 20, score: 0 };
  const pairY: ComponentPair = { lower: 0, upper: 1, dim: 'y', axis: -80, gap: 160, score: 0 };

  it('takes the copper verdict when it is decisive', () => {
    const votes = [{ first: 0, last: 431 }, { first: 512, last: 0 }];
    expect(decideSide(pairX, votes, null)).toMatchObject({ top: 1, bottom: 0, source: 'copper' });
  });

  it('ignores copper below the evidence floor', () => {
    const votes = [{ first: 3, last: 5 }, { first: 4, last: 2 }];
    expect(decideSide(pairX, votes, null)).toMatchObject({ top: 0, source: 'layout' });
  });

  it('uses the layout rule without copper: left is top, upper is top', () => {
    expect(decideSide(pairX, null, null)).toMatchObject({ top: 0, bottom: 1, source: 'layout' });
    expect(decideSide(pairY, null, null)).toMatchObject({ top: 1, bottom: 0, source: 'layout' });
  });

  it('flags a CPU-rule prior that points the other way, without obeying it', () => {
    const d = decideSide(pairX, null, 1);
    expect(d).toMatchObject({ top: 0, source: 'layout', cpuDisagrees: true });
    expect(decideSide(pairX, null, 0).cpuDisagrees).toBeUndefined();
  });
});

describe('splitSymmetricLoop', () => {
  // A board outline with a notch on its top edge, drawn twice: once as the
  // top half and once mirrored below it, the halves touching at y = 0.
  const half = (sign: number) => {
    const y = (v: number) => sign * v;
    const pts = [[0, 0], [0, 800], [300, 800], [300, 600], [700, 600], [700, 800], [1000, 800], [1000, 0]];
    const segs: Array<{ p1: { x: number; y: number }; p2: { x: number; y: number } }> = [];
    for (let i = 0; i < pts.length - 1; i++) segs.push({ p1: { x: pts[i][0], y: y(pts[i][1]) }, p2: { x: pts[i + 1][0], y: y(pts[i + 1][1]) } });
    // seam edge, drawn by each half
    segs.push({ p1: { x: 1000, y: 0 }, p2: { x: 0, y: 0 } });
    return segs;
  };
  it('cuts a self-mirrored loop at its seam and keeps the seam segments aside', () => {
    const segments = [...half(1), ...half(-1)];
    const comp = { minX: 0, minY: -800, maxX: 1000, maxY: 800, segCount: segments.length, segIdxs: segments.map((_, i) => i) };
    const split = splitSymmetricLoop(segments, comp, () => ({ below: 100, above: 120 }));
    expect(split).not.toBeNull();
    expect(split!.dim).toBe('y');
    expect(split!.axis).toBe(0);
    expect(split!.seam).toHaveLength(2);
    expect(split!.lower.maxY).toBeLessThanOrEqual(0);
    expect(split!.upper.minY).toBeGreaterThanOrEqual(0);
    expect(split!.lower.segCount).toBe(split!.upper.segCount);
  });
  it('refuses a loop that is not its own mirror image', () => {
    // One board with an off-centre notch: symmetric about neither centre line.
    const pts = [[0, 0], [0, 800], [100, 800], [100, 600], [400, 600], [400, 800], [1000, 800], [1000, 0], [0, 0]];
    const segments = pts.slice(0, -1).map((p, i) => ({ p1: { x: p[0], y: p[1] }, p2: { x: pts[i + 1][0], y: pts[i + 1][1] } }));
    const comp = { minX: 0, minY: 0, maxX: 1000, maxY: 800, segCount: segments.length, segIdxs: segments.map((_, i) => i) };
    expect(splitSymmetricLoop(segments, comp, () => ({ below: 50, above: 50 }))).toBeNull();
  });
  it('refuses when one side would hold almost no parts', () => {
    const segments = [...half(1), ...half(-1)];
    const comp = { minX: 0, minY: -800, maxX: 1000, maxY: 800, segCount: segments.length, segIdxs: segments.map((_, i) => i) };
    expect(splitSymmetricLoop(segments, comp, () => ({ below: 2, above: 500 }))).toBeNull();
  });
});

describe('windingMode', () => {
  it('reads a mirror fold from same-direction halves', () => {
    expect(windingMode({ lowerCW: 0, lowerCCW: 29, upperCW: 3, upperCCW: 30 })).toBe('mirror');  // K90I
    expect(windingMode({ lowerCW: 20, lowerCCW: 1, upperCW: 18, upperCCW: 2 })).toBe('mirror');  // stored mirrored
  });
  it('reads a translate fold from opposite-direction halves', () => {
    expect(windingMode({ lowerCW: 22, lowerCCW: 0, upperCW: 3, upperCCW: 16 })).toBe('translate'); // 820-2494 K22
  });
  it('refuses mixed winding and too few samples', () => {
    expect(windingMode({ lowerCW: 10, lowerCCW: 9, upperCW: 8, upperCCW: 11 })).toBeNull();
    expect(windingMode({ lowerCW: 1, lowerCCW: 1, upperCW: 0, upperCCW: 30 })).toBeNull();
  });
});

describe('synthesizeMissingHalf', () => {
  // An L: a 1000×200 strip with a 100×400 arm rising from its left end
  // (iPad Pro 11 3rd gen, 820-02172, at a tenth of the scale).
  const L = [[0, 0], [1000, 0], [1000, 200], [200, 200], [200, 600], [100, 600], [100, 200], [0, 200]];
  const loopSegs = (pts: number[][]) => pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return { p1: { x: p[0], y: p[1] }, p2: { x: q[0], y: q[1] } };
  });
  const bbox = (segs: ReturnType<typeof loopSegs>): OutlineComponent => {
    const xs = segs.flatMap(s => [s.p1.x, s.p2.x]), ys = segs.flatMap(s => [s.p1.y, s.p2.y]);
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys), segCount: segs.length, segIdxs: segs.map((_, i) => i) };
  };
  const part = (x: number, y: number) => ({ pins: [{ x: x - 2, y }, { x: x + 2, y }] });
  // Parts on the drawn half, and parts of the bottom half mirrored below
  // y = -50 with no outline of their own — some of them down the arm.
  const topParts = Array.from({ length: 60 }, (_, i) => part(20 + i * 16, 100));
  const bottomParts = [
    ...Array.from({ length: 30 }, (_, i) => part(30 + i * 30, -100 - 150 + 50)), // strip, y ∈ (-300, -100)
    ...Array.from({ length: 10 }, (_, i) => part(150, -320 - i * 30)),           // arm, y < -300
  ];

  it('mirrors the lone loop onto the parts that have no outline', () => {
    const segs = loopSegs(L);
    const r = synthesizeMissingHalf(segs, [bbox(segs)], [...topParts, ...bottomParts]);
    expect(r).not.toBeNull();
    expect(r!.dim).toBe('y');
    expect(r!.mode).toBe('mirror');
    expect(r!.fit).toBe(r!.outsidePins);
    const moved = bbox(r!.segments);
    expect(moved.maxY).toBeLessThan(0);
    expect(moved.minY).toBeLessThanOrEqual(-590);
  });

  it('leaves a file alone when every part sits inside the loop', () => {
    const segs = loopSegs(L);
    expect(synthesizeMissingHalf(segs, [bbox(segs)], topParts)).toBeNull();
  });

  it('refuses when the outside parts do not fit the loop', () => {
    const segs = loopSegs(L);
    // Arm parts on the wrong end: neither the mirror nor a slide fits them.
    const wrong = [...bottomParts.slice(0, 30), ...Array.from({ length: 10 }, (_, i) => part(900, -320 - i * 30))];
    expect(synthesizeMissingHalf(segs, [bbox(segs)], [...topParts, ...wrong])).toBeNull();
  });

  it('does nothing when the file already pairs two loops', () => {
    const a = loopSegs(L);
    const b = loopSegs(L.map(([x, y]) => [x, -100 - y]));
    const segs = [...a, ...b];
    const ca = bbox(a), cb = { ...bbox(b), segIdxs: b.map((_, i) => a.length + i) };
    expect(synthesizeMissingHalf(segs, [ca, cb], [...topParts, ...bottomParts])).toBeNull();
  });
});
