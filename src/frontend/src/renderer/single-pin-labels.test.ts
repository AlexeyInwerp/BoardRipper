import { describe, it, expect } from 'vitest';
import { buildBoardScene } from './board-scene';
import { DEFAULTS } from '../store/render-settings';
import type { BoardData } from '../parsers/types';
import type { LabelRecord } from './label-model';

/**
 * A board with a single 1-pin part (a testpoint) carrying a long refdes and a
 * long net name — the shape that made the two labels land on top of each other.
 */
function testpointBoard(name = 'PTP12345_LONG', net = 'PPVIN_S0_CPU_VCORE'): BoardData {
  const pin = {
    name: '1', number: '1',
    position: { x: 0, y: 0 },
    radius: 25,
    side: 'top' as const,
    net,
  };
  return {
    format: 'CAD',
    parts: [{
      name, side: 'top' as const, type: 'smd' as const,
      origin: { x: 0, y: 0 },
      pins: [pin],
      bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    }],
    nets: [{ name: net, pins: [{ partIndex: 0, pinIndex: 0 }] }],
    bounds: { minX: -500, minY: -500, maxX: 500, maxY: 500 },
    outline: [],
  } as unknown as BoardData;
}

function labelsFor(board: BoardData, over: Partial<typeof DEFAULTS> = {}) {
  const s = { ...DEFAULTS, textFastMode: true, showPartLabels: true, showNetNames: true, ...over };
  const scene = buildBoardScene(board, s);
  const all = [...(scene.labelModel?.top ?? []), ...(scene.labelModel?.bottom ?? [])];
  return {
    part: all.find(l => l.kind === 'part'),
    net:  all.find(l => l.kind === 'circleNet' || l.kind === 'twoPinNet'),
    all,
  };
}

/** Vertical span of a label given its anchorY (0 = top at y, 1 = bottom at y). */
function span(l: LabelRecord): [number, number] {
  const h = l.fontSize;
  const top = l.y - h * (l.anchorY ?? 0.5);
  return [top, top + h];
}

describe('single-pin (testpoint) labels', () => {
  it('does not stack the part name and the net name on the same point', () => {
    const { part, net } = labelsFor(testpointBoard());
    expect(part, 'part label emitted').toBeTruthy();
    expect(net, 'net label emitted').toBeTruthy();
    // The original bug: both at (0,0) with anchorY 0.5 — identical placement.
    expect({ x: part!.x, y: part!.y, a: part!.anchorY })
      .not.toEqual({ x: net!.x, y: net!.y, a: net!.anchorY });
  });

  it('leaves no vertical overlap between the two labels', () => {
    const { part, net } = labelsFor(testpointBoard());
    const [pTop, pBot] = span(part!);
    const [nTop, nBot] = span(net!);
    const gap = Math.max(pTop, nTop) - Math.min(pBot, nBot);
    expect(gap, `part [${pTop},${pBot}] vs net [${nTop},${nBot}] must not overlap`)
      .toBeGreaterThanOrEqual(0);
  });

  it('straddles the pin centre — name above, net below, equal offsets', () => {
    const { part, net } = labelsFor(testpointBoard());
    const pinY = 0;  // the testpoint sits at the origin
    // Name occupies the upper half, net the lower half.
    expect(part!.anchorY).toBeCloseTo(1.0, 3);
    expect(net!.anchorY).toBeCloseTo(0.0, 3);
    expect(part!.y).toBeLessThanOrEqual(pinY);
    expect(net!.y).toBeGreaterThanOrEqual(pinY);
    // Symmetric: each is offset from the centre by the same half-gap.
    expect(pinY - part!.y).toBeCloseTo(net!.y - pinY, 6);
    // Both share the pin's X.
    expect(part!.x).toBeCloseTo(net!.x, 6);
  });

  it('keeps the pair symmetric when the gap factor is opened up', () => {
    const { part, net } = labelsFor(testpointBoard(), { bgaLabelGapFactor: 0.8 });
    const pinY = 0;
    expect(pinY - part!.y).toBeCloseTo(net!.y - pinY, 6);
    expect(pinY - part!.y).toBeGreaterThan(0);   // actually pushed apart
    const [, pBot] = span(part!);
    const [nTop] = span(net!);
    expect(nTop).toBeGreaterThanOrEqual(pBot);
  });

  it('centres the name on the pad when the pin has no net label', () => {
    // GND is suppressed as a net label (already colour-coded), so nothing
    // shares the pin and the name should not be pushed off-centre.
    const { part, net } = labelsFor(testpointBoard('TP9', 'GND'));
    expect(net, 'no net label for GND').toBeFalsy();
    expect(part!.anchorY).toBeCloseTo(0.5, 3);
    expect(part!.y).toBeCloseTo(0, 6);
  });

  it('sizes the part label from the pad instead of a degenerate zero-width box', () => {
    // eb.pw is 0 for a 1-pin part, so the old fit formula collapsed to
    // labelMinSize for every testpoint no matter how big the pad was.
    // Radii stay under pinMaxRadius (15) so the clamp doesn't flatten them.
    const mk = (r: number) => {
      const b = testpointBoard('TP1');
      b.parts[0].pins[0].radius = r;
      return labelsFor(b).part!;
    };
    expect(mk(15).fontSize).toBeGreaterThan(mk(5).fontSize);
    // …and it still honours the floor on a tiny pad.
    expect(mk(3).fontSize).toBeGreaterThanOrEqual(DEFAULTS.labelMinSize);
  });

  it('still separates them when the net label is scaled up', () => {
    const { part, net } = labelsFor(testpointBoard(), { netLabelScale: 3 });
    const [pTop, pBot] = span(part!);
    const [nTop, nBot] = span(net!);
    expect(Math.max(pTop, nTop) - Math.min(pBot, nBot)).toBeGreaterThanOrEqual(0);
  });

  it('leaves multi-pin parts untouched (part label stays at the body centre)', () => {
    const b = testpointBoard();
    b.parts[0].pins = [0, 1, 2, 3].map(i => ({
      name: String(i + 1), number: String(i + 1),
      position: { x: (i % 2) * 100, y: Math.floor(i / 2) * 100 },
      radius: 20, side: 'top' as const, net: 'N' + i,
    }));
    b.parts[0].bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const { part } = labelsFor(b);
    expect(part!.x).toBeCloseTo(50, 3);
    expect(part!.y).toBeCloseTo(50, 3);
    expect(part!.anchorY).toBeCloseTo(0.5, 3);
  });
});
