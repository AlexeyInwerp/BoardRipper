import { test, expect } from '@playwright/test';

// Regression: when buildRenderedBoard filters parts (BOM-alternate filter or
// hide-ghosts toggle), nets must be rebuilt against the filtered array. The
// old code passed through rev.nets, whose partIndex values still pointed at
// the unfiltered array, so every index past the first drop resolved to the
// wrong part. On the ROG_STRIX_RTX4090 sample (1 BOM cluster) this caused
// e.g. net 12V_F_R1 to show PC104/PC258/C415 as members and to NOT link
// PC101 with PC265 (the actually-on-net pair).

test('filtered board rebuilds nets so partIndex refs resolve to correct parts', async ({ page }) => {
  await page.goto(process.env.BASE_URL ?? 'http://localhost:8082/');
  await page.waitForFunction(() => !!(window as any).__boardStore, { timeout: 15000 });

  const result = await page.evaluate(() => {
    const store: any = (window as any).__boardStore;

    // Synthetic 4-part board:
    //   - A (0): cap on net "VCC" + GND
    //   - B (1): cap on net "VCC" + GND   (BOM-alternate of A — same XY+nets+pins)
    //   - C (2): cap on net "VCC" + GND   (truly on VCC, distinct refdes prefix)
    //   - D (3): cap on net "5V"  + GND
    const mkPart = (name: string, x: number, y: number, net1: string) => ({
      name,
      side: 'top',
      type: 'smd',
      origin: { x, y },
      pins: [
        { name: '1', number: '1', position: { x, y },     radius: 6, side: 'top', net: net1 },
        { name: '2', number: '2', position: { x: x + 30, y }, radius: 6, side: 'top', net: 'GND' },
      ],
      bounds: { minX: x - 5, minY: y - 5, maxX: x + 35, maxY: y + 5 },
      meta: { value: '0.1uF_X1', package: 'CAP_0402' },
    });
    const parts = [
      mkPart('CA1', 100, 100, 'VCC'),  // cluster member 1 (default primary by lowest refdes)
      mkPart('CA2', 100, 100, 'VCC'),  // cluster member 2 (will be dropped)
      mkPart('CC1', 200, 100, 'VCC'),  // distinct refdes prefix — separate cluster
      mkPart('CD1', 300, 100, '5V'),
    ];
    const nets = new Map();
    for (let pi = 0; pi < parts.length; pi++) {
      for (let ni = 0; ni < parts[pi].pins.length; ni++) {
        const pin = parts[pi].pins[ni];
        if (!nets.has(pin.net)) nets.set(pin.net, { name: pin.net, pinIndices: [] });
        nets.get(pin.net).pinIndices.push({ partIndex: pi, pinIndex: ni });
      }
    }
    const board = {
      format: 'TEST',
      parts,
      nets,
      bounds: { minX: 0, minY: 0, maxX: 400, maxY: 200 },
      outline: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 200 }, { x: 0, y: 200 }],
      bomClusters: [{
        memberIndices: [0, 1],
        memberRefdes: ['CA1', 'CA2'],
        defaultPrimaryIndex: 0,
        defaultPrimaryRefdes: 'CA1',
        reason: 'shape-named-device',
      }],
    };

    store.openBoardFromData('synthetic.test', board);

    // showBomAlternates defaults to false → CA2 is dropped → board.parts has 3 entries.
    const tab = store.activeTab;
    const rendered = tab.board;
    const partsByName = new Map(rendered.parts.map((p: any, i: number) => [p.name, i]));

    // Walk each net's pinIndices and verify each ref resolves to a pin that
    // is actually on that net.
    const netDiscrepancies: any[] = [];
    for (const [name, net] of rendered.nets) {
      for (const ref of net.pinIndices) {
        const part = rendered.parts[ref.partIndex];
        const pin = part?.pins[ref.pinIndex];
        if (!pin || pin.net !== name) {
          netDiscrepancies.push({
            netName: name,
            partIndex: ref.partIndex,
            pinIndex: ref.pinIndex,
            actualPart: part?.name,
            actualPin: pin?.name,
            actualNet: pin?.net,
          });
        }
      }
    }

    return {
      partCount: rendered.parts.length,
      partNames: rendered.parts.map((p: any) => p.name),
      vccPartNames: [...rendered.nets.get('VCC').pinIndices].map((r: any) => rendered.parts[r.partIndex].name).sort(),
      v5PartNames: [...rendered.nets.get('5V').pinIndices].map((r: any) => rendered.parts[r.partIndex].name).sort(),
      netDiscrepancies,
    };
  });

  // CA2 was dropped by the BOM-alternate filter.
  expect(result.partCount).toBe(3);
  expect(result.partNames).toEqual(['CA1', 'CC1', 'CD1']);

  // Critical: every ref in every net must resolve to a pin actually on that net.
  expect(result.netDiscrepancies).toEqual([]);

  // Specifically: VCC contains exactly CA1 and CC1 (not CD1 or anything else),
  // and 5V contains exactly CD1.
  expect(result.vccPartNames).toEqual(['CA1', 'CC1']);
  expect(result.v5PartNames).toEqual(['CD1']);
});
