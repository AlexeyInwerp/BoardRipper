import { test, expect } from '@playwright/test';

test.describe('net classification predicates', () => {
  test('isGroundRail matches GND family only', async () => {
    const { isGroundRail } = await import('../src/parsers/types');
    expect(isGroundRail('GND')).toBe(true);
    expect(isGroundRail('AGND')).toBe(true);
    expect(isGroundRail('DGND')).toBe(true);
    expect(isGroundRail('PGND')).toBe(true);
    expect(isGroundRail('EARTH')).toBe(true);
    expect(isGroundRail('CHASSIS')).toBe(true);
    expect(isGroundRail('GND_DIG')).toBe(true);
    expect(isGroundRail('gnd')).toBe(true);

    expect(isGroundRail('VCC')).toBe(false);
    expect(isGroundRail('VDD')).toBe(false);
    expect(isGroundRail('VSS')).toBe(false);
    expect(isGroundRail('+3V3')).toBe(false);
    expect(isGroundRail('VSENSE')).toBe(false);
    expect(isGroundRail('')).toBe(false);
  });

  test('isPowerRail still matches power + ground (existing behaviour)', async () => {
    const { isPowerRail } = await import('../src/parsers/types');
    expect(isPowerRail('GND')).toBe(true);
    expect(isPowerRail('VCC')).toBe(true);
    expect(isPowerRail('+3V3')).toBe(true);
    expect(isPowerRail('-5V')).toBe(true);
    expect(isPowerRail('VSENSE')).toBe(false);
  });
});

test.describe('computeAdjacentNets', () => {
  // Helper: build a minimal BoardData from a parts spec.
  // Each "part" is { name, pinNets: string[] } — pin positions are stubbed.
  type PartSpec = { name: string; pinNets: string[] };
  async function buildBoard(parts: PartSpec[]) {
    const { buildNets } = await import('../src/parsers/types');
    const built = parts.map((p, i) => ({
      name: p.name,
      side: 'top' as const,
      type: 'smd' as const,
      origin: { x: i * 100, y: 0 },
      pins: p.pinNets.map((net, pi) => ({
        name: String(pi + 1),
        number: String(pi + 1),
        position: { x: i * 100 + pi * 10, y: 0 },
        radius: 5,
        side: 'top' as const,
        net,
      })),
      bounds: { minX: i * 100, minY: -5, maxX: i * 100 + (p.pinNets.length - 1) * 10, maxY: 5 },
    }));
    return {
      format: 'TEST',
      outline: [],
      parts: built,
      nails: [],
      nets: buildNets(built),
      bounds: { minX: 0, minY: -10, maxX: 1000, maxY: 10 },
    };
  }

  test('pull-up: VSENSE → R12(2-pin) → VCC ⇒ adjacent = {VCC}', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['VSENSE'] },
      { name: 'R12', pinNets: ['VSENSE', 'VCC'] },
      { name: 'U2', pinNets: ['VCC'] },  // VCC fan-out — must not be added under depth=1
    ]);
    const adj = computeAdjacentNets(board, 'VSENSE', 1);
    expect([...adj].sort()).toEqual(['VCC']);
  });

  test('GND stitch: RAIL → R5(2-pin) → GND ⇒ adjacent = {} (ground skipped)', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['RAIL'] },
      { name: 'R5', pinNets: ['RAIL', 'GND'] },
    ]);
    const adj = computeAdjacentNets(board, 'RAIL', 1);
    expect([...adj]).toEqual([]);
  });

  test('MOSFET 3-pin Q1 does not bridge from GATE', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['GATE'] },
      { name: 'Q1', pinNets: ['GATE', 'DRAIN', 'SOURCE'] },
    ]);
    const adj = computeAdjacentNets(board, 'GATE', 1);
    expect([...adj]).toEqual([]);
  });

  test('series signal: NET_A → R1 → NET_B at depth 1', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
      { name: 'R2', pinNets: ['NET_B', 'NET_C'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 1);
    expect([...adj].sort()).toEqual(['NET_B']);
  });

  test('series signal: depth=2 reaches NET_C', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
      { name: 'R2', pinNets: ['NET_B', 'NET_C'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 2);
    expect([...adj].sort()).toEqual(['NET_B', 'NET_C']);
  });

  test('power rail does not propagate even at depth=2', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['VSENSE'] },
      { name: 'R12', pinNets: ['VSENSE', 'VCC'] },
      { name: 'R13', pinNets: ['VCC', 'OTHER'] },
    ]);
    const adj = computeAdjacentNets(board, 'VSENSE', 2);
    expect([...adj].sort()).toEqual(['VCC']);
  });

  test('anchor is GND ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'R1', pinNets: ['SIG', 'GND'] },
    ]);
    const adj = computeAdjacentNets(board, 'GND', 1);
    expect([...adj]).toEqual([]);
  });

  test('anchor is VCC ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'R1', pinNets: ['SIG', 'VCC'] },
    ]);
    const adj = computeAdjacentNets(board, 'VCC', 1);
    expect([...adj]).toEqual([]);
  });

  test('anchor net not found in nets map ⇒ empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
    ]);
    const adj = computeAdjacentNets(board, 'NONEXISTENT', 1);
    expect([...adj]).toEqual([]);
  });

  test('depth=0 returns empty set', async () => {
    const { computeAdjacentNets } = await import('../src/parsers/types');
    const board = await buildBoard([
      { name: 'U1', pinNets: ['NET_A'] },
      { name: 'R1', pinNets: ['NET_A', 'NET_B'] },
    ]);
    const adj = computeAdjacentNets(board, 'NET_A', 0);
    expect([...adj]).toEqual([]);
  });
});
