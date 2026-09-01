import { test, expect } from '@playwright/test';
import { xzzArcSweepDeg } from '../src/parsers/xzz-parser';
import { gencadArcSweepRad } from '../src/parsers/cad-parser';

// Issue #33: an arc stored as (centre, radius, angleStart, angleEnd) — or as
// (start, end, centre) — names TWO arcs, the CCW one and the CW one. Both share
// their endpoints exactly, so no endpoint check can tell them apart and only the
// MIDPOINT discriminates. XZZ and GenCAD each normalised the sweep into
// (−180, +180] (a shortest-arc rule), silently swapping every arc that sweeps
// past 180° for its complement: concave board features — notches, slot mouths,
// re-entrant corner fillets — rendered as outward lobes of the same radius.
//
// These are fixture-free: the vectors below are the raw values as stored, so the
// test holds even where the proprietary sample boards are unavailable.

const XZZ_SCALE = 10000;

/** Midpoint of the arc actually drawn — the only thing that separates the two candidates. */
function xzzMidpoint(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const mid = (startDeg + xzzArcSweepDeg(startDeg, endDeg) / 2) * Math.PI / 180;
  return { x: cx + r * Math.cos(mid), y: cy + r * Math.sin(mid) };
}

// Mini4 Pro-PP003675.04 MB PCB layer.pcb, layer 28. Raw integer units ÷ 10000.
const XZZ_VECTORS = [
  { id: 'A', cx: 532474990, cy: 531872990, r: 307610, start: 1130129, end: 3472309,
    sweep: 234.218, mid: { x: 532277764, y: 531636927 }, kind: 'major' },
  { id: 'B', cx: 518264289, cy: 531735380, r: 331240, start: 1615879, end: 516079,
    sweep: 250.020, mid: { x: 518358909, y: 531417942 }, kind: 'major' },
  { id: 'C', cx: 515725710, cy: 531735380, r: 331240, start: 1283920, end: 184120,
    sweep: 250.020, mid: { x: 515631090, y: 531417942 }, kind: 'major' },
  { id: 'D', cx: 501515009, cy: 531872990, r: 307610, start: 1927690, end: 669870,
    sweep: 234.218, mid: { x: 501712235, y: 531636927 }, kind: 'major' },
  // E and F are ordinary fillets under 180°: they must be untouched by the fix.
  { id: 'E', cx: 508875000, cy: 533275000, r: 235000, start: 0, end: 900000,
    sweep: 90, mid: null, kind: 'fillet' },
  { id: 'F', cx: 500995000, cy: 501069060, r: 519060, start: 2250000, end: 2700000,
    sweep: 45, mid: null, kind: 'fillet' },
];

test.describe('XZZ arc sweep (#33)', () => {
  for (const v of XZZ_VECTORS) {
    test(`${v.id} (${v.kind}) sweeps ${v.sweep}°, not its complement`, () => {
      const got = xzzArcSweepDeg(v.start / XZZ_SCALE, v.end / XZZ_SCALE);
      expect(got).toBeCloseTo(v.sweep, 3);
    });
  }

  for (const v of XZZ_VECTORS.filter(v => v.mid)) {
    test(`${v.id} midpoint lands on the correct side of the circle`, () => {
      const got = xzzMidpoint(v.cx / XZZ_SCALE, v.cy / XZZ_SCALE, v.r / XZZ_SCALE,
                              v.start / XZZ_SCALE, v.end / XZZ_SCALE);
      // 1e-3 mil — the vectors in the issue are rounded to integer raw units.
      expect(got.x).toBeCloseTo(v.mid!.x / XZZ_SCALE, 3);
      expect(got.y).toBeCloseTo(v.mid!.y / XZZ_SCALE, 3);
    });
  }

  test('a sweep below 180° is returned unchanged (no board that renders today may move)', () => {
    for (let start = -350; start <= 350; start += 7) {
      for (const delta of [0.5, 30, 90, 170, 179.9]) {
        const end = start + delta;
        expect(xzzArcSweepDeg(start, end)).toBeCloseTo(delta, 9);
      }
    }
  });

  test('never returns a negative sweep or one at/above a full turn', () => {
    for (let start = -720; start <= 720; start += 13) {
      for (let end = -720; end <= 720; end += 17) {
        const s = xzzArcSweepDeg(start, end);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(360);
      }
    }
  });
});

test.describe('GenCAD arc sweep (#33)', () => {
  test('a >180° arc keeps its true sweep instead of collapsing to a sliver', () => {
    // The widest in 2080.cad: 350.908°, which the old ±π clamp drew as 9.09°.
    const start = 0, end = 350.908 * Math.PI / 180;
    expect(gencadArcSweepRad(start, end) * 180 / Math.PI).toBeCloseTo(350.908, 6);
  });

  test('endpoint-swapped 180° twins tile the circle rather than retracing one half', () => {
    // Exporters emit a full circle as two ARC records sharing a centre with
    // endpoints swapped. Under the old clamp one landed at +pi and the other at
    // -pi, so walking -pi backwards redrew the same semicircle.
    const a = gencadArcSweepRad(0, Math.PI);          // first half
    const b = gencadArcSweepRad(Math.PI, 2 * Math.PI); // twin, endpoints swapped
    expect(a).toBeCloseTo(Math.PI, 12);
    expect(b).toBeCloseTo(Math.PI, 12);
    // Together they cover the whole circle.
    expect(a + b).toBeCloseTo(2 * Math.PI, 12);
    // And they start on opposite sides, so they are not the same half twice.
    const midA = 0 + a / 2, midB = Math.PI + b / 2;
    expect(Math.sin(midA)).toBeGreaterThan(0);
    expect(Math.sin(midB)).toBeLessThan(0);
  });

  test('sub-180° arcs are unchanged, and the result is always in [0, 2pi)', () => {
    for (let start = -6; start <= 6; start += 0.37) {
      for (const delta of [0.01, 1, 2, 3.0]) {
        expect(gencadArcSweepRad(start, start + delta)).toBeCloseTo(delta, 9);
      }
      for (let end = -6; end <= 6; end += 0.41) {
        const s = gencadArcSweepRad(start, end);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThan(2 * Math.PI + 1e-12);
      }
    }
  });
});
