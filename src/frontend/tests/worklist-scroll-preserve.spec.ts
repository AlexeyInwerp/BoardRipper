import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(__dirname2, '../../../samples/820-02935-05 Kopie.brd');

// Issue #22: clicking a component on the board resets the worklist scroll to top.
test('worklist scroll position survives a board part-selection', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board missing');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(BOARD);

  // Wait for the board to parse (stores populated).
  await page.waitForFunction(() => {
    // @ts-expect-error DEV global
    return !!window.__boardStore?.board;
  }, { timeout: 20000 });

  // Expand the (right-anchored) board sidebar, then open the Worklist tab.
  await page.locator('.board-sidebar-toggle').first().click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();

  // Populate a long worklist (40 parts) so the list overflows and scrolls.
  await page.evaluate(() => {
    // @ts-expect-error DEV global
    window.__worklistStore.pushParts(null, Array.from({ length: 40 }, (_, i) => i));
  });

  const list = page.getByTestId('worklist-scroll');
  await expect(list).toBeVisible();
  // Ensure it actually overflows.
  await expect.poll(async () => list.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(50);

  // Tag the node so we can detect a remount, then scroll to the bottom.
  const scrolledTo = await list.evaluate((el: HTMLElement) => {
    (el as HTMLElement & { __mark?: number }).__mark = 12345;
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolledTo).toBeGreaterThan(50);

  // Click a component on the board — the real interaction the tester reports.
  const canvas = page.getByTestId('board-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  // Let React flush + a couple frames pass.
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));

  const after = await list.evaluate((el: HTMLElement) => ({
    scrollTop: el.scrollTop,
    remounted: (el as HTMLElement & { __mark?: number }).__mark !== 12345,
  }));

  // Diagnostic: if the node was remounted, __mark is gone → scroll reset is a remount.
  expect(after.remounted, 'scroll container should NOT be remounted on selection').toBe(false);
  expect(Math.abs(after.scrollTop - scrolledTo), 'scrollTop should be preserved').toBeLessThan(4);

  // And it must also survive a genuine remount of the panel (switch the
  // sidebar tab away and back) — the durable-scroll guarantee for #22.
  await page.locator('.board-sidebar-tab', { hasText: 'Info' }).click();
  await page.locator('.board-sidebar-tab', { hasText: 'Worklist' }).click();
  const list2 = page.getByTestId('worklist-scroll');
  await expect(list2).toBeVisible();
  await expect
    .poll(async () => list2.evaluate((el: HTMLElement) => el.scrollTop))
    .toBeGreaterThan(scrolledTo - 4);
});
