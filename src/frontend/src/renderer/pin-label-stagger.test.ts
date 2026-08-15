import { describe, it, expect } from 'vitest';
import { buildBoardScene } from './board-scene';
import { DEFAULTS } from '../store/render-settings';
import type { BoardData } from '../parsers/types';
import type { LabelRecord } from './label-model';

/**
 * A QFP-shaped part: one pin run along X (board-horizontal, "top edge") and one
 * along Y (board-vertical, "left edge"), each pin on its own net.
 *
 * The pin-number / net-name stagger only helps on the run the user sees as
 * HORIZONTAL — labels are always drawn upright, so they collide along screen X.
 * Which run gets it therefore has to follow the view rotation, not the board
 * axes: under 90°/270° the scene root is rotated, so the board-vertical run is
 * what the user sees as a horizontal row.
 */
const SPACING = 100;
const N = 8;
const ROW_Y = 600;    // run A — varies in X
const COL_X = -600;   // run B — varies in Y

function qfpBoard(): BoardData {
  const pins: unknown[] = [];
  for (let i = 0; i < N; i++) {
    pins.push({
      name: `${i + 1}`, number: `${i + 1}`,
      position: { x: i * SPACING, y: ROW_Y },
      radius: 30, side: 'top', net: `NET_ROW_${i}`,
    });
  }
  for (let i = 0; i < N; i++) {
    pins.push({
      name: `${N + i + 1}`, number: `${N + i + 1}`,
      position: { x: COL_X, y: i * SPACING },
      radius: 30, side: 'top', net: `NET_COL_${i}`,
    });
  }
  return {
    format: 'CAD',
    parts: [{
      name: 'OU1', side: 'top', type: 'smd',
      origin: { x: 0, y: 0 },
      pins,
      bounds: { minX: COL_X, minY: 0, maxX: (N - 1) * SPACING, maxY: ROW_Y },
    }],
    nets: [],
    bounds: { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 },
    outline: [],
  } as unknown as BoardData;
}

/** Pin-number labels, sorted by pin number, for a given view rotation. */
function pinNumbers(rotationDeg: number, gapFactor = 0) {
  const s = {
    ...DEFAULTS, textFastMode: true, showPinNumbers: true, showNetNames: true,
    bgaLabelGapFactor: gapFactor,
  };
  const scene = buildBoardScene(qfpBoard(), s, undefined, undefined, undefined, rotationDeg);
  const all = [...(scene.labelModel?.top ?? []), ...(scene.labelModel?.bottom ?? [])];
  const nums = all.filter(l => l.kind === 'circleNum')
    .sort((a, b) => Number(a.text) - Number(b.text));
  return {
    runA: nums.filter(l => Number(l.text) <= N),      // board-horizontal
    runB: nums.filter(l => Number(l.text) > N),       // board-vertical
    total: nums.length,
  };
}

/** Adjacent labels sit on opposite sides of their pin (anchor 1.0 = above the
 *  pin centre, 0.0 = below; 0.8 is the un-staggered default). */
function anchorsAlternate(labels: LabelRecord[]): boolean {
  if (labels.length < 3) return false;
  const a = labels.map(l => l.anchorY);
  if (!a.every(v => v === 0 || v === 1)) return false;
  return a.every((v, i) => i === 0 || v !== a[i - 1]);
}

describe('pin-label stagger follows the view rotation', () => {
  it('unrotated: staggers the board-horizontal run only', () => {
    const { runA, runB, total } = pinNumbers(0);
    expect(total, 'pin numbers emitted').toBe(N * 2);
    expect(anchorsAlternate(runA), 'horizontal run staggers').toBe(true);
    expect(anchorsAlternate(runB), 'vertical run must not stagger').toBe(false);
  });

  it('rotated 90°: staggers the board-vertical run (screen-horizontal) instead', () => {
    const { runA, runB } = pinNumbers(90);
    expect(anchorsAlternate(runB), 'screen-horizontal run staggers').toBe(true);
    expect(anchorsAlternate(runA), 'screen-vertical run must not stagger').toBe(false);
  });

  it('rotated 180°: back to the board-horizontal run', () => {
    const { runA, runB } = pinNumbers(180);
    expect(anchorsAlternate(runA)).toBe(true);
    expect(anchorsAlternate(runB)).toBe(false);
  });

  it('the label gap offset lands on the axis that is vertical on screen', () => {
    // gapFactor > 0 also pushes the label off the pin centre. Unrotated that
    // offset is board Y; rotated 90°/270° board Y is screen X, so it has to
    // move to board X or the pair separates sideways instead of stacking.
    const flat = pinNumbers(0, 0.6);
    expect(flat.runA.every(l => l.y !== ROW_Y), 'offset applied in y').toBe(true);

    const rot = pinNumbers(90, 0.6);
    expect(rot.runB.every(l => l.x !== COL_X), 'offset applied in x').toBe(true);
    expect(rot.runB.every(l => l.y === l.y), 'run B y untouched by the swap').toBe(true);

    // 270° flips which side is visually "up", so the board-space sign inverts.
    const rot270 = pinNumbers(270, 0.6);
    expect(Math.sign(rot270.runB[0].x - COL_X)).toBe(-Math.sign(rot.runB[0].x - COL_X));
  });
});
