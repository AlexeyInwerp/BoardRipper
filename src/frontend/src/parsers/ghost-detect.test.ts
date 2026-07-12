import { describe, it, expect } from 'vitest';
import { detectGhostComponents } from './types';
import type { Part, Pin } from './types';

/** Minimal Part builder: rectangular part with one pin per given net, pins
 *  placed at opposite box corners (≤2 pins keeps computePartHullPolygon on
 *  its AABB path — no OBB geometry needed for these fixtures). */
function makePart(
  name: string,
  x0: number, y0: number, x1: number, y1: number,
  nets: string[],
  side: 'top' | 'bottom' = 'top',
): Part {
  const pins: Pin[] = nets.map((net, i) => ({
    name: String(i + 1),
    net,
    position: { x: i % 2 === 0 ? x0 : x1, y: i % 2 === 0 ? y0 : y1 },
    side,
  } as unknown as Pin));
  return {
    name,
    side,
    origin: { x: (x0 + x1) / 2, y: (y0 + y1) / 2 },
    bounds: { minX: x0, minY: y0, maxX: x1, maxY: y1 },
    pins,
  } as unknown as Part;
}

describe('detectGhostComponents', () => {
  it('flags an overlapping smaller part whose nets are a subset of the bigger part', () => {
    const dom = makePart('U1', 0, 0, 100, 100, ['SIG_A', 'SIG_B', 'GND']);
    const ghost = makePart('U1_GHOST', 10, 10, 60, 60, ['SIG_A', 'GND']);
    const far = makePart('U2', 500, 500, 600, 600, ['SIG_C', 'GND']);
    const ghosts = detectGhostComponents([dom, ghost, far]);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0].partName).toBe('U1_GHOST');
    expect(ghosts[0].dominatorName).toBe('U1');
    expect(ghosts[0].partIndex).toBe(1);
    expect(ghosts[0].dominatorIndex).toBe(0);
  });

  it('does not flag parts on opposite sides', () => {
    const a = makePart('T1', 0, 0, 100, 100, ['SIG_A', 'SIG_B'], 'top');
    const b = makePart('B1', 10, 10, 60, 60, ['SIG_A'], 'bottom');
    expect(detectGhostComponents([a, b])).toHaveLength(0);
  });

  it('does not flag a power-only smaller part (heatsink/shield rule)', () => {
    const dom = makePart('U1', 0, 0, 100, 100, ['SIG_A', 'SIG_B', 'GND']);
    const shield = makePart('SHIELD', 10, 10, 60, 60, ['GND']);
    expect(detectGhostComponents([dom, shield])).toHaveLength(0);
  });

  it('returns ghosts sorted by (partIndex, dominatorIndex) regardless of X position', () => {
    // Pair B sits at larger X but has smaller part indices; a sweep ordered by
    // minX alone would emit pair A first. The output sort must restore
    // partIndex order.
    const domB = makePart('UB', 200, 0, 300, 100, ['SIG_X', 'SIG_Y', 'GND']);   // index 0
    const ghostB = makePart('UB_G', 210, 10, 260, 60, ['SIG_X', 'GND']);        // index 1
    const domA = makePart('UA', 0, 0, 100, 100, ['SIG_P', 'SIG_Q', 'GND']);     // index 2
    const ghostA = makePart('UA_G', 10, 10, 60, 60, ['SIG_P', 'GND']);          // index 3
    const ghosts = detectGhostComponents([domB, ghostB, domA, ghostA]);
    expect(ghosts).toHaveLength(2);
    expect(ghosts.map(g => g.partIndex)).toEqual([1, 3]);
    expect(ghosts.map(g => g.dominatorIndex)).toEqual([0, 2]);
  });

  it('scales: 2000 non-overlapping parts complete in bounded time', () => {
    const parts: Part[] = [];
    for (let i = 0; i < 2000; i++) {
      parts.push(makePart(`P${i}`, i * 200, 0, i * 200 + 100, 100, ['SIG_' + i, 'GND']));
    }
    const t0 = performance.now();
    expect(detectGhostComponents(parts)).toHaveLength(0);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
