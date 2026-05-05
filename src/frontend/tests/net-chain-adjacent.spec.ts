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
});
