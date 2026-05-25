/**
 * E2E tests for the chain-adjacent net-line highlight mode.
 *
 * Test 1: Mode cycle via the store — off → star → chain → chain-adjacent → off.
 * Test 2: Synthetic pull-up board (VSENSE→R12→VCC) — adjacentNets should be {VCC}.
 * Test 3: Anchor on GND — adjacentNets should be empty.
 *
 * Tests 2–3 use openBoardFromData (DEV helper on __boardStore) to inject an
 * in-memory BoardData and browser-side dynamic import to call buildNets.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('chain-adjacent net mode', () => {
  test('cycle: off → star → chain → chain-adjacent → off via store', async ({ page }) => {
    await page.goto('/');

    const sampleAbs = path.resolve(__dirname, '../../../samples/820-02016.bvr');
    if (!fs.existsSync(sampleAbs)) {
      test.skip();
      return;
    }

    // Load the board via the file input (same approach as ci-smoke.spec.ts).
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(sampleAbs);

    // Wait for the board to be parsed and available.
    await page.waitForFunction(() => {
      const w = window as unknown as { __boardStore?: { activeTab?: { board?: { parts?: unknown[] } } } };
      return (w.__boardStore?.activeTab?.board?.parts?.length ?? 0) > 0;
    }, { timeout: 15_000 });

    const readMode = () =>
      page.evaluate(() =>
        (window as unknown as { __boardStore: { netLineMode: string } }).__boardStore.netLineMode,
      );
    const cycle = () =>
      page.evaluate(() =>
        (window as unknown as { __boardStore: { cycleNetLineMode: () => void } }).__boardStore.cycleNetLineMode(),
      );

    // Reset to a known baseline: cycle until we're at 'off'.
    let mode = await readMode();
    let guard = 0;
    while (mode !== 'off' && guard++ < 5) {
      await cycle();
      mode = await readMode();
    }

    expect(mode).toBe('off');
    await cycle(); expect(await readMode()).toBe('star');
    await cycle(); expect(await readMode()).toBe('chain');
    await cycle(); expect(await readMode()).toBe('chain-adjacent');
    await cycle(); expect(await readMode()).toBe('off');
  });

  test('chain-adjacent populates adjacentNets for VSENSE→R12→VCC pull-up', async ({ page }) => {
    await page.goto('/');

    // Inject a synthetic board from in-memory data via the DEV store helper.
    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'U1',
          side: 'top' as const,
          type: 'smd' as const,
          origin: { x: 0, y: 0 },
          pins: [{ name: '1', number: '1', position: { x: 0, y: 0 }, radius: 5, side: 'top' as const, net: 'VSENSE' }],
          bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
        },
        {
          name: 'R12',
          side: 'top' as const,
          type: 'smd' as const,
          origin: { x: 50, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: 40, y: 0 }, radius: 5, side: 'top' as const, net: 'VSENSE' },
            { name: '2', number: '2', position: { x: 60, y: 0 }, radius: 5, side: 'top' as const, net: 'VCC' },
          ],
          bounds: { minX: 40, minY: -5, maxX: 60, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST',
        outline: [],
        parts,
        nails: [],
        nets: buildNets(parts),
        bounds: { minX: -10, minY: -10, maxX: 70, maxY: 10 },
      };
      const w = window as unknown as {
        __boardStore: {
          openBoardFromData: (name: string, board: unknown) => void;
          netLineMode: string;
          cycleNetLineMode: () => void;
          highlightNet: (net: string) => void;
        };
      };
      w.__boardStore.openBoardFromData('synth.bvr', board);
    });

    // Cycle until chain-adjacent.
    await page.evaluate(() => {
      const s = (window as unknown as {
        __boardStore: { netLineMode: string; cycleNetLineMode: () => void };
      }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
    });

    // Select the VSENSE net — this populates adjacentNets.
    await page.evaluate(() => {
      (window as unknown as { __boardStore: { highlightNet: (n: string) => void } }).__boardStore.highlightNet('VSENSE');
    });

    const adj = await page.evaluate(() => {
      const tab = (window as unknown as {
        __boardStore: { activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore.activeTab;
      return [...(tab?.selection?.adjacentNets ?? [])];
    });

    expect(adj.sort()).toEqual(['VCC']);
  });

  test('chain-adjacent: selecting a 2-pin part by body highlights both pins\' nets', async ({ page }) => {
    await page.goto('/');

    // Same VSENSE→R12→VCC pull-up, with a second part on each net so each net
    // has ≥2 parts (otherwise the chain has nothing to draw — but adjacency is
    // what we assert here, which only needs the 2-pin bridge).
    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'U1', side: 'top' as const, type: 'smd' as const, origin: { x: 0, y: 0 },
          pins: [{ name: '1', number: '1', position: { x: 0, y: 0 }, radius: 5, side: 'top' as const, net: 'VSENSE' }],
          bounds: { minX: -5, minY: -5, maxX: 5, maxY: 5 },
        },
        {
          name: 'R12', side: 'top' as const, type: 'smd' as const, origin: { x: 50, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: 40, y: 0 }, radius: 5, side: 'top' as const, net: 'VSENSE' },
            { name: '2', number: '2', position: { x: 60, y: 0 }, radius: 5, side: 'top' as const, net: 'VCC' },
          ],
          bounds: { minX: 40, minY: -5, maxX: 60, maxY: 5 },
        },
        {
          name: 'C3', side: 'top' as const, type: 'smd' as const, origin: { x: 100, y: 0 },
          pins: [{ name: '1', number: '1', position: { x: 100, y: 0 }, radius: 5, side: 'top' as const, net: 'VCC' }],
          bounds: { minX: 95, minY: -5, maxX: 105, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -10, minY: -10, maxX: 110, maxY: 10 },
      };
      (window as unknown as { __boardStore: { openBoardFromData: (n: string, b: unknown) => void } })
        .__boardStore.openBoardFromData('synth-2pin.bvr', board);
    });

    await page.evaluate(() => {
      const s = (window as unknown as { __boardStore: { netLineMode: string; cycleNetLineMode: () => void } }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
    });

    // R12 is index 1. Select the *part* (not a pin) — body selection.
    const result = await page.evaluate(() => {
      const store = (window as unknown as {
        __boardStore: {
          selectPart: (i: number) => void;
          activeTab?: { selection?: { highlightedNet?: string | null; adjacentNets?: Iterable<string> } };
        };
      }).__boardStore;
      store.selectPart(1);
      const selSt = store.activeTab?.selection;
      return {
        highlighted: selSt?.highlightedNet ?? null,
        adjacent: [...(selSt?.adjacentNets ?? [])],
      };
    });

    // One pin's net becomes the primary highlight, the other arrives via the
    // one-hop 2-pin adjacency — together VSENSE + VCC ("both pins").
    const both = [result.highlighted, ...result.adjacent].filter(Boolean).sort();
    expect(both).toEqual(['VCC', 'VSENSE']);
  });

  test('non-chain-adjacent: selecting a 2-pin part highlights no net', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'R12', side: 'top' as const, type: 'smd' as const, origin: { x: 50, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: 40, y: 0 }, radius: 5, side: 'top' as const, net: 'VSENSE' },
            { name: '2', number: '2', position: { x: 60, y: 0 }, radius: 5, side: 'top' as const, net: 'VCC' },
          ],
          bounds: { minX: 40, minY: -5, maxX: 60, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: 30, minY: -10, maxX: 70, maxY: 10 },
      };
      (window as unknown as { __boardStore: { openBoardFromData: (n: string, b: unknown) => void } })
        .__boardStore.openBoardFromData('synth-2pin-off.bvr', board);
    });

    // Default netLineMode after load is 'off' (or star/chain) — cycle to 'chain'
    // so we're explicitly NOT in chain-adjacent, then select the part.
    const highlighted = await page.evaluate(() => {
      const s = (window as unknown as {
        __boardStore: { netLineMode: string; cycleNetLineMode: () => void; selectPart: (i: number) => void; activeTab?: { selection?: { highlightedNet?: string | null } } };
      }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain' && guard++ < 5) s.cycleNetLineMode();
      s.selectPart(0);
      return s.activeTab?.selection?.highlightedNet ?? null;
    });

    expect(highlighted).toBeNull();
  });

  test('chain-adjacent leaves adjacentNets empty when anchor is GND', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'R5',
          side: 'top' as const,
          type: 'smd' as const,
          origin: { x: 0, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: -10, y: 0 }, radius: 5, side: 'top' as const, net: 'RAIL' },
            { name: '2', number: '2', position: { x: 10, y: 0 }, radius: 5, side: 'top' as const, net: 'GND' },
          ],
          bounds: { minX: -15, minY: -5, maxX: 15, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST',
        outline: [],
        parts,
        nails: [],
        nets: buildNets(parts),
        bounds: { minX: -20, minY: -10, maxX: 20, maxY: 10 },
      };
      const w = window as unknown as {
        __boardStore: { openBoardFromData: (name: string, board: unknown) => void };
      };
      w.__boardStore.openBoardFromData('synth-gnd.bvr', board);
    });

    // Cycle to chain-adjacent.
    await page.evaluate(() => {
      const s = (window as unknown as {
        __boardStore: { netLineMode: string; cycleNetLineMode: () => void };
      }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
    });

    // GND as the anchor — computeAdjacentNets returns empty because the anchor
    // itself is a ground rail.
    await page.evaluate(() => {
      (window as unknown as { __boardStore: { highlightNet: (n: string) => void } }).__boardStore.highlightNet('GND');
    });

    const adj = await page.evaluate(() =>
      [...((window as unknown as {
        __boardStore: { activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore.activeTab?.selection?.adjacentNets ?? [])],
    );

    expect(adj).toEqual([]);
  });

  test('chain-adjacent bridges through a 4-pin resistor (hierarchyBridge default on)', async ({ page }) => {
    await page.goto('/');

    // R1 is a 4-pin (Kelvin / current-sense) resistor touching 4 distinct
    // signal nets. The default resistor part-type has hierarchyBridge: true,
    // so the >2-pin limit is bypassed and all other nets are reached.
    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'R1', side: 'top' as const, type: 'smd' as const, origin: { x: 0, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: -10, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_A' },
            { name: '2', number: '2', position: { x: -3, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_B' },
            { name: '3', number: '3', position: { x: 3, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_C' },
            { name: '4', number: '4', position: { x: 10, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_D' },
          ],
          bounds: { minX: -15, minY: -5, maxX: 15, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -20, minY: -10, maxX: 20, maxY: 10 },
      };
      (window as unknown as { __boardStore: { openBoardFromData: (n: string, b: unknown) => void } })
        .__boardStore.openBoardFromData('synth-4pin-r.bvr', board);
    });

    await page.evaluate(() => {
      const s = (window as unknown as { __boardStore: { netLineMode: string; cycleNetLineMode: () => void } }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
    });

    await page.evaluate(() => {
      (window as unknown as { __boardStore: { highlightNet: (n: string) => void } }).__boardStore.highlightNet('TRACE_A');
    });

    const adj = await page.evaluate(() =>
      [...((window as unknown as {
        __boardStore: { activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore.activeTab?.selection?.adjacentNets ?? [])],
    );

    expect(adj.sort()).toEqual(['TRACE_B', 'TRACE_C', 'TRACE_D']);
  });

  test('chain-adjacent does NOT bridge through a 4-pin IC (hierarchyBridge off)', async ({ page }) => {
    await page.goto('/');

    // Same 4-pin layout but as U1 (IC). The IC part-type keeps hierarchyBridge
    // off, so the universal 2-pin rule still excludes it — no nets reached.
    await page.evaluate(async () => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const parts = [
        {
          name: 'U1', side: 'top' as const, type: 'smd' as const, origin: { x: 0, y: 0 },
          pins: [
            { name: '1', number: '1', position: { x: -10, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_A' },
            { name: '2', number: '2', position: { x: -3, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_B' },
            { name: '3', number: '3', position: { x: 3, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_C' },
            { name: '4', number: '4', position: { x: 10, y: 0 }, radius: 5, side: 'top' as const, net: 'TRACE_D' },
          ],
          bounds: { minX: -15, minY: -5, maxX: 15, maxY: 5 },
        },
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -20, minY: -10, maxX: 20, maxY: 10 },
      };
      (window as unknown as { __boardStore: { openBoardFromData: (n: string, b: unknown) => void } })
        .__boardStore.openBoardFromData('synth-4pin-u.bvr', board);
    });

    const adj = await page.evaluate(() => {
      const s = (window as unknown as {
        __boardStore: { netLineMode: string; cycleNetLineMode: () => void; highlightNet: (n: string) => void; activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
      s.highlightNet('TRACE_A');
      return [...(s.activeTab?.selection?.adjacentNets ?? [])];
    });

    expect(adj).toEqual([]);
  });

  // Helper: a 3-resistor series chain A–R1–B–R2–C–R3–D (all bridging).
  const openResistorChain = async (page: import('@playwright/test').Page, fileName: string) => {
    await page.evaluate(async (name) => {
      const { buildNets } = await import('/src/parsers/types.ts');
      const mk = (refdes: string, x: number, na: string, nb: string) => ({
        name: refdes, side: 'top' as const, type: 'smd' as const, origin: { x, y: 0 },
        pins: [
          { name: '1', number: '1', position: { x: x - 3, y: 0 }, radius: 5, side: 'top' as const, net: na },
          { name: '2', number: '2', position: { x: x + 3, y: 0 }, radius: 5, side: 'top' as const, net: nb },
        ],
        bounds: { minX: x - 5, minY: -5, maxX: x + 5, maxY: 5 },
      });
      const parts = [
        mk('R1', 0, 'TRACE_A', 'TRACE_B'),
        mk('R2', 30, 'TRACE_B', 'TRACE_C'),
        mk('R3', 60, 'TRACE_C', 'TRACE_D'),
      ];
      const board = {
        format: 'TEST', outline: [], parts, nails: [], nets: buildNets(parts),
        bounds: { minX: -10, minY: -10, maxX: 70, maxY: 10 },
      };
      (window as unknown as { __boardStore: { openBoardFromData: (n: string, b: unknown) => void } })
        .__boardStore.openBoardFromData(name, board);
    }, fileName);
    await page.evaluate(() => {
      const s = (window as unknown as { __boardStore: { netLineMode: string; cycleNetLineMode: () => void } }).__boardStore;
      let guard = 0;
      while (s.netLineMode !== 'chain-adjacent' && guard++ < 5) s.cycleNetLineMode();
    });
  };

  test('hierarchyDepth default (2) follows two hops down a resistor chain', async ({ page }) => {
    await page.goto('/');
    await openResistorChain(page, 'synth-chain-d2.bvr');
    await page.evaluate(() => {
      (window as unknown as { __boardStore: { highlightNet: (n: string) => void } }).__boardStore.highlightNet('TRACE_A');
    });
    const adj = await page.evaluate(() =>
      [...((window as unknown as {
        __boardStore: { activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore.activeTab?.selection?.adjacentNets ?? [])],
    );
    // 2 hops: A→B (R1), B→C (R2). D is a third hop, out of reach.
    expect(adj.sort()).toEqual(['TRACE_B', 'TRACE_C']);
  });

  test('hierarchyDepth is honored — depth 1 reaches only the first hop', async ({ page }) => {
    await page.goto('/');
    await openResistorChain(page, 'synth-chain-d1.bvr');
    // Set the depth setting to 1 before highlighting.
    await page.evaluate(() => {
      const m = (window as unknown as { __renderSettings: { settings: Record<string, unknown>; applyGlobal: (s: unknown) => void } }).__renderSettings;
      m.applyGlobal({ ...m.settings, hierarchyDepth: 1 });
    });
    await page.evaluate(() => {
      (window as unknown as { __boardStore: { highlightNet: (n: string) => void } }).__boardStore.highlightNet('TRACE_A');
    });
    const adj = await page.evaluate(() =>
      [...((window as unknown as {
        __boardStore: { activeTab?: { selection?: { adjacentNets?: Iterable<string> } } };
      }).__boardStore.activeTab?.selection?.adjacentNets ?? [])],
    );
    expect(adj.sort()).toEqual(['TRACE_B']);
  });
});
