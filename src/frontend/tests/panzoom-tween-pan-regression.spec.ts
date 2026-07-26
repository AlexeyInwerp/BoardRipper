/**
 * Regression: starting a pan while a smooth-zoom tween is still animating must
 * move the board. The wheel-zoom tween re-pins viewport.x/y every frame; before
 * the fix it overwrote a concurrent drag so the board only panned once the tween
 * settled ("pan doesn't work right after zooming" on the smoothZoom=true default).
 * The drag-zoom pointerdown handler now cancels the tween when a pan begins.
 *
 * Needs a real WebGL context + the proprietary sample; skips when absent.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');
const have = fs.existsSync(SAMPLE);

function center(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const v = (window as unknown as { __boardRenderer?: { viewport?: { center: { x: number; y: number } } } }).__boardRenderer?.viewport;
    return v ? { cx: v.center.x, cy: v.center.y } : null;
  });
}

test('pan works during an in-flight smooth-zoom tween', async ({ page }) => {
  test.skip(!have, 'samples/820-02016/820-02016.bvr not present (proprietary fixture)');
  test.setTimeout(120_000);
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.clear();
    // MOUSE mode so the wheel zooms (creating the tween); smoothZoom left at its
    // default (true) — this is the configuration that regressed.
    localStorage.setItem('boardripper-render-settings', JSON.stringify({ twoFingerPan: false }));
  });
  await page.reload();
  await page.locator('input[type="file"]').first().setInputFiles(SAMPLE);
  await page.waitForFunction(() => !!(window as unknown as { __boardRenderer?: { board?: unknown } }).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // Build a long-lived tween with several rapid wheel notches.
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -240);
  const before = await center(page);

  // Pan immediately, while the tween is still animating.
  await page.mouse.down();
  await page.mouse.move(cx - 60, cy - 40);
  await page.mouse.move(cx - 160, cy - 100);
  const during = await center(page);
  await page.mouse.up();

  // The drag must have moved the viewport center even though the tween was live.
  const moved = Math.hypot(during!.cx - before!.cx, during!.cy - before!.cy);
  expect(moved, 'pan should move the center during a smooth-zoom tween').toBeGreaterThan(50);
});
