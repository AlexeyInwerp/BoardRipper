/**
 * Multilayer "bump on top" — clicking a layer row selects/bumps it; a per-row
 * pin fixates one layer on top. Pin wins: while a layer is pinned, selecting
 * other layers must not move the pin (the renderer suppresses select-bump then).
 *
 * Asserts store state (`__boardStore`) + DOM classes — both independent of
 * WebGL, which headless Chromium lacks. The z-order/dim itself is verified in
 * the live app. Loads a bundled minimal multilayer GenCAD fixture (3 layers).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BOARD = path.resolve(__dirname, '../public/samples/multilayer-test.cad');

type StoreWin = {
  __boardStore?: {
    selectedLayerIndex: number | null;
    fixatedLayerIndex: number | null;
  };
};

const selectedIdx = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as StoreWin).__boardStore!.selectedLayerIndex);
const fixatedIdx = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as StoreWin).__boardStore!.fixatedLayerIndex);

async function loadMultilayer(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: 'multilayer-test.cad' })).toBeVisible({ timeout: 15000 });
  // The sidebar auto-opens to the Layers tab on multilayer load, but that can
  // race in headless — open it explicitly if it isn't already showing. The
  // Layers tab is the default active tab whenever the board has layers.
  const layerList = page.getByTestId('layer-list');
  if (!(await layerList.isVisible().catch(() => false))) {
    await page.locator('.board-sidebar-toggle').first().click();
  }
  await expect(layerList).toBeVisible({ timeout: 15000 });
}

test('renders one row per layer', async ({ page }) => {
  await loadMultilayer(page);
  await expect(page.locator('.layer-list-container .layer-item')).toHaveCount(3);
});

test('clicking a layer row selects it; selection follows the click', async ({ page }) => {
  await loadMultilayer(page);
  const rows = page.locator('.layer-list-container .layer-item');

  await rows.nth(0).locator('.layer-name').click();
  await expect(rows.nth(0)).toHaveClass(/layer-selected/);
  expect(await selectedIdx(page)).toBe(0);

  await rows.nth(1).locator('.layer-name').click();
  await expect(rows.nth(1)).toHaveClass(/layer-selected/);
  await expect(rows.nth(0)).not.toHaveClass(/layer-selected/);
  expect(await selectedIdx(page)).toBe(1);

  // Clicking the selected row again clears the selection.
  await rows.nth(1).locator('.layer-name').click();
  await expect(rows.nth(1)).not.toHaveClass(/layer-selected/);
  expect(await selectedIdx(page)).toBe(null);
});

test('pin fixates one layer; pinning another moves it; clicking again unpins', async ({ page }) => {
  await loadMultilayer(page);
  const rows = page.locator('.layer-list-container .layer-item');

  await rows.nth(0).locator('.layer-pin').click();
  await expect(rows.nth(0)).toHaveClass(/layer-pinned/);
  expect(await fixatedIdx(page)).toBe(0);

  // Only one fixated at a time — pinning another moves the pin.
  await rows.nth(2).locator('.layer-pin').click();
  await expect(rows.nth(2)).toHaveClass(/layer-pinned/);
  await expect(rows.nth(0)).not.toHaveClass(/layer-pinned/);
  expect(await fixatedIdx(page)).toBe(2);

  await rows.nth(2).locator('.layer-pin').click();
  await expect(rows.nth(2)).not.toHaveClass(/layer-pinned/);
  expect(await fixatedIdx(page)).toBe(null);
});

test('selecting or pinning a hidden layer reveals it', async ({ page }) => {
  await loadMultilayer(page);
  const rows = page.locator('.layer-list-container .layer-item');

  // Only the primary (Top) layer is visible by default; inner/bottom are hidden.
  await expect(rows.nth(1)).toHaveClass(/layer-hidden/);
  await expect(rows.nth(2)).toHaveClass(/layer-hidden/);

  // Selecting a hidden layer turns it on.
  await rows.nth(1).locator('.layer-name').click();
  await expect(rows.nth(1)).not.toHaveClass(/layer-hidden/);

  // Pinning a hidden layer turns it on.
  await rows.nth(2).locator('.layer-pin').click();
  await expect(rows.nth(2)).not.toHaveClass(/layer-hidden/);
});

test('pin wins: selecting other layers never moves the pin', async ({ page }) => {
  await loadMultilayer(page);
  const rows = page.locator('.layer-list-container .layer-item');

  await rows.nth(0).locator('.layer-pin').click();
  expect(await fixatedIdx(page)).toBe(0);

  // Selection still updates (UI affordance) but the pin is untouched.
  await rows.nth(2).locator('.layer-name').click();
  expect(await selectedIdx(page)).toBe(2);
  expect(await fixatedIdx(page)).toBe(0);
});
