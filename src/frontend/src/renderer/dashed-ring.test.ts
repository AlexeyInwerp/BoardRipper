import { describe, it, expect } from 'vitest';
import { strokeDashedRing } from './board-scene';

/** Minimal stand-in for the Graphics calls strokeDashedRing makes. */
function recorder() {
  const ops: Array<{ op: 'move' | 'line'; x: number; y: number }> = [];
  return {
    ops,
    gfx: {
      moveTo(x: number, y: number) { ops.push({ op: 'move', x, y }); return this; },
      lineTo(x: number, y: number) { ops.push({ op: 'line', x, y }); return this; },
    } as never,
  };
}

const SQUARE: Array<[number, number]> = [[0, 0], [100, 0], [100, 100], [0, 100]];

describe('strokeDashedRing', () => {
  it('breaks each edge into separate move/line pairs rather than one solid path', () => {
    const r = recorder();
    strokeDashedRing(r.gfx, SQUARE, 10);
    // a solid outline would be 1 move + 3 lines; dashes are many pairs
    const moves = r.ops.filter((o) => o.op === 'move').length;
    expect(moves).toBeGreaterThan(4);
    expect(r.ops.filter((o) => o.op === 'line').length).toBe(moves);
  });

  it('leaves gaps — the drawn length is well under the ring perimeter', () => {
    const r = recorder();
    strokeDashedRing(r.gfx, SQUARE, 10);
    let drawn = 0;
    for (let i = 0; i < r.ops.length; i += 2) {
      const a = r.ops[i], b = r.ops[i + 1];
      drawn += Math.hypot(b.x - a.x, b.y - a.y);
    }
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(400 * 0.75); // perimeter is 400
  });

  it('stays within the ring it was given', () => {
    const r = recorder();
    strokeDashedRing(r.gfx, SQUARE, 10);
    for (const o of r.ops) {
      expect(o.x).toBeGreaterThanOrEqual(-0.001);
      expect(o.x).toBeLessThanOrEqual(100.001);
      expect(o.y).toBeGreaterThanOrEqual(-0.001);
      expect(o.y).toBeLessThanOrEqual(100.001);
    }
  });

  it('handles a degenerate edge without emitting NaN', () => {
    const r = recorder();
    strokeDashedRing(r.gfx, [[5, 5], [5, 5], [50, 5]], 4);
    for (const o of r.ops) { expect(Number.isFinite(o.x)).toBe(true); expect(Number.isFinite(o.y)).toBe(true); }
  });

  it('works on a rotated (non-axis-aligned) ring', () => {
    const r = recorder();
    strokeDashedRing(r.gfx, [[0, 0], [70, 70], [0, 140], [-70, 70]], 8);
    expect(r.ops.length).toBeGreaterThan(8);
  });
});
