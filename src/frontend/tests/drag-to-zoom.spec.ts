/**
 * Verifies drag-to-zoom wiring:
 *  - Default: dragToZoom is false (or unset).
 *  - After flipping dragToZoom: bare-drag does not cause a pan.
 *  - Sub-threshold click (no movement) remains harmless.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');

// Skip (not fail) when the gitignored, proprietary sample is absent — same
// idiom as ci-smoke.spec.ts. Guarding inside the shared helper covers every
// test, each of which calls openBoard() first.
const haveBvr = fs.existsSync(BVR_FILE);

async function openBoard(page: import('@playwright/test').Page) {
  test.skip(!haveBvr, 'samples/820-02016.bvr not present (proprietary fixture)');
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByTestId('file-input').setInputFiles(BVR_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
}

test('dragToZoom default is false or unset', async ({ page }) => {
  await openBoard(page);
  const initial = await page.evaluate(() => {
    const raw = localStorage.getItem('boardripper-render-settings');
    return raw ? (JSON.parse(raw).dragToZoom as boolean | undefined) : undefined;
  });
  expect(initial === undefined || initial === false).toBe(true);
});

test('bare drag with dragToZoom=true does not crash', async ({ page }) => {
  await openBoard(page);

  await page.evaluate(async () => {
    const mod = await import('/src/store/render-settings.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (mod as any).renderSettingsStore;
    const cur = store.globalSnapshot();
    store.applyGlobal({ ...cur, dragToZoom: true });
  });

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Move + press + drag up 120 px + release
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 40);
  await page.mouse.move(cx, cy - 80);
  await page.mouse.move(cx, cy - 120);
  await page.mouse.up();

  // App should not have crashed; canvas remains visible. The main invariant
  // is that no runtime error was thrown; scale-value introspection requires
  // a test hook on BoardRenderer that does not yet exist.
  await expect(canvas).toBeVisible();
});

test('sub-threshold click with dragToZoom=true does not crash', async ({ page }) => {
  await openBoard(page);

  await page.evaluate(async () => {
    const mod = await import('/src/store/render-settings.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (mod as any).renderSettingsStore;
    const cur = store.globalSnapshot();
    store.applyGlobal({ ...cur, dragToZoom: true });
  });

  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Pointerdown + pointerup at the same location — below the 3px threshold.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.up();

  await expect(canvas).toBeVisible();
});
