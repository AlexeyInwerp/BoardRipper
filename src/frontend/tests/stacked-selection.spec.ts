import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(__dirname2, '../../../samples/820-02935-05 Kopie.brd');

// Issue #23: selecting stacked / overlapping components.
test.describe('stacked / overlapping component selection', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!fs.existsSync(BOARD), 'sample board missing');
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await page.waitForFunction(() => {
      // @ts-expect-error DEV global
      return !!window.__boardStore?.board;
    }, { timeout: 20000 });
  });

  test('canvas click selects a part; a double-click does not crash or cycle away', async ({ page }) => {
    const canvas = page.getByTestId('board-canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas');
    const cx = box.width / 2, cy = box.height / 2;

    // A single click selects a part (integrated handleClick + hitTestStack).
    await canvas.click({ position: { x: cx, y: cy } });
    const first = await page.evaluate(() => {
      // @ts-expect-error DEV global
      return window.__boardStore.selection.partIndex;
    });
    expect(typeof first).toBe('number');

    // A double-click at the same spot must not throw and must leave a valid
    // selection (the deferred cycle advance is cancelled — #23 hard rule that
    // double-click drives PDF lookup, never the cycle).
    await canvas.dblclick({ position: { x: cx, y: cy } });
    await page.evaluate(() => new Promise(r => setTimeout(r, 400))); // past the guard window
    const afterDbl = await page.evaluate(() => {
      // @ts-expect-error DEV global
      return window.__boardStore.selection.partIndex;
    });
    expect(typeof afterDbl).toBe('number');
    // No advance survived the double-click.
    expect(afterDbl).toBe(first);
  });

  test('right-click menu repeats the action row per overlapping part; a stacked part can be pinned', async ({ page }) => {
    // Two real refdes from this board, used as a synthetic overlap stack.
    const [a, b] = await page.evaluate(() => {
      // @ts-expect-error DEV global
      const parts = window.__boardStore.board.parts;
      return [parts[0].name as string, parts[1].name as string];
    });

    // Drive the context menu with an overlap stack (smallest-first [a, b]).
    await page.evaluate(([a, b]) => {
      // @ts-expect-error DEV global
      window.__contextMenuStore.showBoard(200, 200, a, null, null, [a, b]);
    }, [a, b]);

    // One header row per overlapping part.
    const headers = page.getByTestId('context-menu-header');
    await expect(headers).toHaveCount(2);
    await expect(page.getByTestId('qa-copy-part')).toHaveCount(2);

    // Pin the SECOND (stacked) part via its row's worklist button.
    const pinButtons = page.getByTestId('qa-worklist-part');
    await expect(pinButtons).toHaveCount(2);
    await pinButtons.nth(1).click();

    // b is now in the active worklist.
    const inWorklist = await page.evaluate((b) => {
      // @ts-expect-error DEV global
      return !!window.__worklistStore.activeWorklist?.entries.some((e: { refdes: string }) => e.refdes === b);
    }, b);
    expect(inWorklist).toBe(true);
  });

  test('non-overlapping right-click still renders a single header row (back-compat)', async ({ page }) => {
    const a = await page.evaluate(() => {
      // @ts-expect-error DEV global
      return window.__boardStore.board.parts[0].name as string;
    });
    await page.evaluate((a) => {
      // @ts-expect-error DEV global — no overlap arg → defaults to [componentName]
      window.__contextMenuStore.showBoard(200, 200, a, null, null);
    }, a);
    await expect(page.getByTestId('context-menu-header')).toHaveCount(1);
  });
});
