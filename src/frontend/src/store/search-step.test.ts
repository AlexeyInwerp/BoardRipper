import { describe, it, expect } from 'vitest';
import type { BoardData, Part } from '../parsers';
import { netStops, nextStop, partStops, walkingNet } from './search-step';

function part(name: string, nets: string[]): Part {
  return { name, pins: nets.map((net, i) => ({ net, number: String(i + 1) })) } as unknown as Part;
}
function board(parts: Part[]): BoardData {
  return { parts } as unknown as BoardData;
}

describe('netStops', () => {
  const b = board([
    part('U10', ['PP3V3', 'GND', 'X', 'Y']),   // 0: four pins
    part('C12', ['PP3V3', 'GND']),             // 1
    part('C2', ['GND', 'PP3V3']),              // 2: on the net at pin 2
    part('R5', ['A', 'B']),                    // 3: not on the net
    part('U2', ['PP3V3', 'PP3V3', 'Z', 'W']),  // 4: twice on the net, one stop
  ]);

  it('puts small parts first, each run in natural order, one stop per part', () => {
    expect(netStops(b, 'PP3V3').map(s => b.parts[s.partIndex].name)).toEqual(['C2', 'C12', 'U2', 'U10']);
  });

  it('stops at the pin that sits on the net', () => {
    const c2 = netStops(b, 'PP3V3').find(s => s.partIndex === 2)!;
    expect(c2.pinIndex).toBe(1);
    expect(netStops(b, 'PP3V3').find(s => s.partIndex === 4)!.pinIndex).toBe(0);
  });
});

describe('partStops', () => {
  it('orders by natural refdes', () => {
    const b = board([part('R10', []), part('R2', []), part('C1', [])]);
    expect(partStops(b, new Set([0, 1, 2])).map(s => s.partIndex)).toEqual([2, 1, 0]);
  });
});

describe('nextStop', () => {
  const stops = [{ partIndex: 5, pinIndex: null }, { partIndex: 7, pinIndex: null }, { partIndex: 9, pinIndex: null }];
  it('steps from the selected part and wraps both ways', () => {
    expect(nextStop(stops, 7, 1)!.partIndex).toBe(9);
    expect(nextStop(stops, 9, 1)!.partIndex).toBe(5);
    expect(nextStop(stops, 5, -1)!.partIndex).toBe(9);
  });
  it('starts at an end when the selection is not in the list', () => {
    expect(nextStop(stops, null, 1)!.partIndex).toBe(5);
    expect(nextStop(stops, 42, -1)!.partIndex).toBe(9);
  });
  it('returns null for an empty list', () => {
    expect(nextStop([], 1, 1)).toBeNull();
  });
});

describe('walkingNet', () => {
  const sel = (partIndex: number | null, pinIndex: number | null, net: string | null) =>
    ({ partIndex, pinIndex, highlightedNet: net, adjacentNets: new Set<string>() });
  it('is a net picked alone or through a pin', () => {
    expect(walkingNet(sel(null, null, 'GND'))).toBe(true);
    expect(walkingNet(sel(3, 1, 'GND'))).toBe(true);
  });
  it('is not a part body that happens to carry a net, nor no net', () => {
    expect(walkingNet(sel(3, null, 'GND'))).toBe(false);
    expect(walkingNet(sel(3, null, null))).toBe(false);
  });
});
