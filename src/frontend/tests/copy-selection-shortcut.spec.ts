/**
 * Cmd/Ctrl+C in a board panel copies the current selection to the clipboard:
 *   - part-only selection → component name
 *   - pin on a net        → net name
 * Drives selection through the DEV `window.__boardStore` hook and presses the
 * platform copy chord via Playwright's `ControlOrMeta` modifier.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD = path.resolve(__dirname, '../public/samples/test-board.bvr');

type StoreWin = {
  __boardStore?: {
    activeTab?: { board?: { parts: { name: string; pins: { net: string }[] }[] } };
    selectPart: (i: number) => void;
    selectPin: (p: number, q: number) => void;
  };
};

async function loadBoard(page: import('@playwright/test').Page) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: 'test-board.bvr' })).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => {
    const s = (window as unknown as StoreWin).__boardStore;
    return s?.activeTab?.board != null;
  }, undefined, { timeout: 15000 });
}

test('Cmd/Ctrl+C copies the selected component name', async ({ page }) => {
  await loadBoard(page);

  const partName = await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__boardStore!;
    s.selectPart(0);
    return s.activeTab!.board!.parts[0].name;
  });

  await page.keyboard.press('ControlOrMeta+c');

  await expect(page.locator('.toast', { hasText: `Copied '${partName}'` })).toBeVisible({ timeout: 2000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(partName);
});

test('Cmd/Ctrl+C copies the net name when a pin on a net is selected', async ({ page }) => {
  await loadBoard(page);

  const netName = await page.evaluate(() => {
    const s = (window as unknown as StoreWin).__boardStore!;
    const board = s.activeTab!.board!;
    for (let pi = 0; pi < board.parts.length; pi++) {
      const part = board.parts[pi];
      for (let qi = 0; qi < part.pins.length; qi++) {
        if (part.pins[qi].net) {
          s.selectPin(pi, qi);
          return part.pins[qi].net;
        }
      }
    }
    return null;
  });
  expect(netName).toBeTruthy();

  await page.keyboard.press('ControlOrMeta+c');

  await expect(page.locator('.toast', { hasText: `Copied '${netName}'` })).toBeVisible({ timeout: 2000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(netName);
});
