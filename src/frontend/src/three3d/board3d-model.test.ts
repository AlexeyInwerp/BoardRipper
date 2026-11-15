import { describe, it, expect } from 'vitest';
import type { BoardData, Part, Pin } from '../parsers/types';
import { buildBoard3DModel } from './board3d-model';

const pin = (n: string, x: number, y: number, net = 'N' + n): Pin => ({ name: n, number: n, position: { x, y }, radius: 10, side: 'top', net });
const part = (name: string, pins: Pin[]): Part => ({ name, side: 'top', type: 'smd', origin: pins[0].position, pins, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } });
function board(format: string, flipY: boolean | undefined): BoardData {
  const outline = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 500 }, { x: 0, y: 500 }];
  // a SOT-23 near the top edge (y = 450 in the file's own frame): two pins on the lower row
  const sot = part('Q1', [pin('1', 200 - 37, 450 - 40), pin('2', 200 + 37, 450 - 40), pin('3', 200, 450 + 40)]);
  return { format, flipY, outline, parts: [sot, part('R1', [pin('1', 600, 100), pin('2', 663, 100)])], nails: [], nets: new Map(), bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 500 } };
}

describe('board3d model', () => {
  it('centres the board in mm and estimates its parts', () => {
    const m = buildBoard3DModel(board('KICAD', true));
    expect(m.width).toBeCloseTo(25.4); expect(m.height).toBeCloseTo(12.7);
    expect(m.parts.map(p => p.est.family)).toEqual(['sot23', 'chip']);
  });
  it('puts a Y-up file\'s high y away from the viewer, a Y-down file\'s towards', () => {
    const up = buildBoard3DModel(board('KICAD', true)), down = buildBoard3DModel(board('KICAD', false));
    const z = (m: typeof up) => m.toScene({ x: m.parts[0].est.cx, y: m.parts[0].est.cy })[1];
    expect(z(up)).toBeLessThan(0);    // y = 450 of 500, Y-up: the far half of the board
    expect(z(down)).toBeGreaterThan(0); // the same numbers read Y-down: the near half
  });
  it('turns a Y-down SOT-23 the same way as the 2D view shows it', () => {
    // in a Y-down file the two-pin row (smaller y) is the upper row on screen; mirrored to Y-up it is the upper row too
    const down = buildBoard3DModel(board('KICAD', false)).parts[0].est.rotDeg, up = buildBoard3DModel(board('KICAD', true)).parts[0].est.rotDeg;
    expect(Math.abs(((down - up) % 360 + 360) % 360 - 180)).toBeLessThan(1);
  });
});

describe('layer stack', () => {
  it('carries every trace with its layer, pours and vias with their span, and reads a primary-bottom board upside down', () => {
    const base = { parts: [], outline: [], bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 }, nets: [], format: 'KICAD', flipY: true,
      layerNames: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
      traces: [{ start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, width: 10, net: 'A', layer: 0 }, { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, width: 10, net: 'B', layer: 3 }],
      surfaces: [{ polygon: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], layer: 1, net: 'GND' }],
      vias: [{ position: { x: 50, y: 50 }, diameter: 12, net: 'A', layers: [] }, { position: { x: 60, y: 50 }, diameter: 12, net: 'A', layers: [0, 1] }],
    } as unknown as Parameters<typeof buildBoard3DModel>[0];
    const m = buildBoard3DModel(base);
    expect(m.layerNames).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    expect(m.copper.map(c => c.layer)).toEqual([0, 3]); expect(m.pours[0].layer).toBe(1);
    expect(m.vias.map(v => [v.l0, v.l1])).toEqual([[0, 3], [0, 1]]);
    const flipped = buildBoard3DModel({ ...base, primarySide: 'bottom' } as unknown as Parameters<typeof buildBoard3DModel>[0]);
    expect(flipped.layerNames).toEqual(['B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu']);
    expect(flipped.copper.map(c => c.layer)).toEqual([3, 0]); expect(flipped.pours[0].layer).toBe(2); expect(flipped.vias[1]).toMatchObject({ l0: 2, l1: 3 });
  });
});
