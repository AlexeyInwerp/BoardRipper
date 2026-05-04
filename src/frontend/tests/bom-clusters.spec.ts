import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('BOM-alternate cluster detection', () => {
  test('detects same-XY same-net inductor alternates with different packages', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    // Two 2-pin inductors at the same site: a THT-packaged primary (shape-suffixed
    // device value) and an SMD-packaged alternate.
    const parts = [
      {
        name: 'L5', side: 'top' as const, type: 'throughhole' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 50, y: 100 }, radius: 6, side: 'top' as const, net: 'PP1V8' },
          { name: '2', number: '2', position: { x: 150, y: 100 }, radius: 6, side: 'top' as const, net: 'PP1V8_OUT' },
        ],
        bounds: { minX: 50, minY: 95, maxX: 150, maxY: 105 },
        meta: { value: '0.22uh_IND_NONRKO_TH_100X072_B', package: 'IND_NONRKO_TH_100X072_B' },
      },
      {
        name: 'L121', side: 'top' as const, type: 'smd' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 50, y: 100 }, radius: 6, side: 'top' as const, net: 'PP1V8' },
          { name: '2', number: '2', position: { x: 150, y: 100 }, radius: 6, side: 'top' as const, net: 'PP1V8_OUT' },
        ],
        bounds: { minX: 55, minY: 96, maxX: 145, maxY: 104 },
        meta: { value: '0.33uh', package: 'IND_NONRKO_SMD_118X081' },
      },
    ];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(1);
    const c = clusters[0];
    expect(c.memberRefdes.sort()).toEqual(['L121', 'L5']);
    // L5 wins as primary because its device value is shape-suffixed.
    expect(c.defaultPrimaryRefdes).toBe('L5');
    expect(c.reason).toBe('shape-named-device');
  });

  test('falls back to lowest-refdes when no member has a shape-suffixed device', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    const parts = [
      {
        name: 'C2293', side: 'top' as const, type: 'smd' as const,
        origin: { x: 200, y: 200 },
        pins: [
          { name: '1', number: '1', position: { x: 195, y: 200 }, radius: 6, side: 'top' as const, net: 'VBUS' },
          { name: '2', number: '2', position: { x: 205, y: 200 }, radius: 6, side: 'top' as const, net: 'GND' },
        ],
        bounds: { minX: 195, minY: 198, maxX: 205, maxY: 202 },
        meta: { value: '22uf_0805', package: '0805' },
      },
      {
        name: 'C2174', side: 'top' as const, type: 'smd' as const,
        origin: { x: 200, y: 200 },
        pins: [
          { name: '1', number: '1', position: { x: 190, y: 200 }, radius: 6, side: 'top' as const, net: 'VBUS' },
          { name: '2', number: '2', position: { x: 210, y: 200 }, radius: 6, side: 'top' as const, net: 'GND' },
        ],
        bounds: { minX: 190, minY: 195, maxX: 210, maxY: 205 },
        meta: { value: '220uf', package: 'CAP_SMD_7343' },
      },
    ];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(1);
    const c = clusters[0];
    expect(c.defaultPrimaryRefdes).toBe('C2174'); // lower numeric refdes
    expect(c.reason).toBe('lowest-refdes');
  });

  test('does not flag overlapping parts with different refdes prefixes', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    // R and C overlapping — different roles, never alternates of each other.
    const parts = [
      {
        name: 'R10', side: 'top' as const, type: 'smd' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 95, y: 100 }, radius: 6, side: 'top' as const, net: 'A' },
          { name: '2', number: '2', position: { x: 105, y: 100 }, radius: 6, side: 'top' as const, net: 'B' },
        ],
        bounds: { minX: 95, minY: 98, maxX: 105, maxY: 102 },
        meta: { value: '10k', package: '0603' },
      },
      {
        name: 'C20', side: 'top' as const, type: 'smd' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 95, y: 100 }, radius: 6, side: 'top' as const, net: 'A' },
          { name: '2', number: '2', position: { x: 105, y: 100 }, radius: 6, side: 'top' as const, net: 'B' },
        ],
        bounds: { minX: 95, minY: 98, maxX: 105, maxY: 102 },
        meta: { value: '100nf', package: '0603' },
      },
    ];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(0);
  });

  test('does not flag overlapping parts on different sides', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    const parts = [
      {
        name: 'L1', side: 'top' as const, type: 'smd' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 95, y: 100 }, radius: 6, side: 'top' as const, net: 'X' },
          { name: '2', number: '2', position: { x: 105, y: 100 }, radius: 6, side: 'top' as const, net: 'Y' },
        ],
        bounds: { minX: 95, minY: 98, maxX: 105, maxY: 102 },
        meta: { value: '1uh', package: '0603' },
      },
      {
        name: 'L2', side: 'bottom' as const, type: 'smd' as const,
        origin: { x: 100, y: 100 },
        pins: [
          { name: '1', number: '1', position: { x: 95, y: 100 }, radius: 6, side: 'bottom' as const, net: 'X' },
          { name: '2', number: '2', position: { x: 105, y: 100 }, radius: 6, side: 'bottom' as const, net: 'Y' },
        ],
        bounds: { minX: 95, minY: 98, maxX: 105, maxY: 102 },
        meta: { value: '2uh', package: '0805' },
      },
    ];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(0);
  });

  test('does not flag pure duplicates (same device, same package)', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    const parts = [
      {
        name: 'C1', side: 'top' as const, type: 'smd' as const,
        origin: { x: 0, y: 0 },
        pins: [
          { name: '1', number: '1', position: { x: -5, y: 0 }, radius: 6, side: 'top' as const, net: 'A' },
          { name: '2', number: '2', position: { x: 5, y: 0 }, radius: 6, side: 'top' as const, net: 'B' },
        ],
        bounds: { minX: -5, minY: -2, maxX: 5, maxY: 2 },
        meta: { value: '100nf', package: '0603' },
      },
      {
        name: 'C2', side: 'top' as const, type: 'smd' as const,
        origin: { x: 0, y: 0 },
        pins: [
          { name: '1', number: '1', position: { x: -5, y: 0 }, radius: 6, side: 'top' as const, net: 'A' },
          { name: '2', number: '2', position: { x: 5, y: 0 }, radius: 6, side: 'top' as const, net: 'B' },
        ],
        bounds: { minX: -5, minY: -2, maxX: 5, maxY: 2 },
        meta: { value: '100nf', package: '0603' },
      },
    ];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(0);
  });

  test('detects 1-large-vs-N-small cluster via transitive merging', async () => {
    const { detectBomAlternateClusters } = await import('../src/parsers/types');
    // Big tantalum centered at (0,0); four small 0805 caps offset around it.
    // The small caps don't pairwise overlap each other, but each overlaps the
    // big one — union-find should merge all five into a single cluster.
    const big = {
      name: 'C100', side: 'top' as const, type: 'smd' as const,
      origin: { x: 0, y: 0 },
      pins: [
        { name: '1', number: '1', position: { x: -100, y: 0 }, radius: 6, side: 'top' as const, net: 'VBUS' },
        { name: '2', number: '2', position: { x: 100, y: 0 }, radius: 6, side: 'top' as const, net: 'GND' },
      ],
      bounds: { minX: -100, minY: -50, maxX: 100, maxY: 50 },
      meta: { value: '220uf', package: 'CAP_SMD_7343' },
    };
    const mkSmall = (name: string, dx: number, dy: number) => ({
      name, side: 'top' as const, type: 'smd' as const,
      origin: { x: dx, y: dy },
      pins: [
        { name: '1', number: '1', position: { x: dx - 4, y: dy }, radius: 6, side: 'top' as const, net: 'VBUS' },
        { name: '2', number: '2', position: { x: dx + 4, y: dy }, radius: 6, side: 'top' as const, net: 'GND' },
      ],
      bounds: { minX: dx - 4, minY: dy - 2, maxX: dx + 4, maxY: dy + 2 },
      meta: { value: '22uf', package: '0805' },
    });
    const parts = [big, mkSmall('C201', -60, 30), mkSmall('C202', 60, 30), mkSmall('C203', -60, -30), mkSmall('C204', 60, -30)];
    const clusters = detectBomAlternateClusters(parts);
    expect(clusters.length).toBe(1);
    const c = clusters[0];
    expect(c.memberRefdes.length).toBe(5);
    expect(c.memberRefdes.sort()).toEqual(['C100', 'C201', 'C202', 'C203', 'C204']);
    // C100 is the lowest refdes, primary by lowest-refdes heuristic.
    expect(c.defaultPrimaryRefdes).toBe('C100');
  });

  test('V389_61 sample: detects BOM clusters; L39 is the auto-picked primary at its site', async () => {
    const { parseCAD } = await import('../src/parsers/cad-parser');
    const file = path.resolve(__dirname, '../../../samples/BROKEN/V389_61.cad');
    if (!fs.existsSync(file)) test.skip(true, 'V389_61 sample not available');
    const buf = fs.readFileSync(file);
    const board = parseCAD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

    expect(board.format).toBe('CAD');
    expect(board.bomClusters).toBeDefined();
    // The strict polygon+net+differing-device gate yields ~66 clusters on this
    // file (vs 163 raw overlap locations). Anything over 30 indicates the
    // detector is firing on the documented multi-source-vendor sites.
    expect(board.bomClusters!.length).toBeGreaterThanOrEqual(30);

    // Schematic-known cluster around (4841.693, 1703.661): L39 is the
    // "COMMON" mark and should be the auto-picked primary because its
    // DEVICE value carries the shape suffix.
    const targetCluster = board.bomClusters!.find(c =>
      c.memberRefdes.includes('L39') && c.memberRefdes.includes('L137'),
    );
    expect(targetCluster).toBeDefined();
    expect(targetCluster!.defaultPrimaryRefdes).toBe('L39');
    expect(targetCluster!.reason).toBe('shape-named-device');
  });
});
