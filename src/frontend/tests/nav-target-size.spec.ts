import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Verify the `navTargetSize` render setting actually changes the post-navigate
 * zoom level on a real board. Uses the tracked test-board.bvr fixture, runs
 * under `navZoomMode = 'always'` so every focus call snaps to the target
 * (autoZoom band would mask the effect when the part is already comfortable),
 * and compares the viewport scale between two `navTargetSize` values.
 *
 * Acceptable ratio band: the smaller-screen-dim cap can clip large targets
 * for tiny parts (the absolute 6× cap kicks in), so the test asserts a
 * monotonic increase ≥ 1.5× rather than the ideal 2×, which would over-
 * specify the cap interplay. Bench math:
 *   scale ≈ (screenMin × navTargetSize) / maxBboxDim
 *   ratio = scale(0.50) / scale(0.25) ≈ 2.0 absent caps
 */

const TARGET_PART = 'U1';

async function waitForZoomAnimSettled(page: import('@playwright/test').Page) {
  // The zoom animation duration in BoardRenderer is 400ms. Give it 600ms
  // headroom for the ticker + render flush.
  await page.waitForFunction(() => {
    const r = (window as unknown as {
      __boardRenderer?: { zoomAnim?: unknown };
    }).__boardRenderer;
    return r != null && r.zoomAnim == null;
  }, undefined, { timeout: 3000 });
  await page.waitForTimeout(100);
}

async function readViewportScale(page: import('@playwright/test').Page): Promise<number> {
  return await page.evaluate(() => {
    const r = (window as unknown as {
      __boardRenderer?: { viewport?: { scale: { x: number } } };
    }).__boardRenderer;
    if (!r?.viewport) throw new Error('viewport not exposed');
    return Math.abs(r.viewport.scale.x);
  });
}

async function applyRenderSettings(
  page: import('@playwright/test').Page,
  partial: { navTargetSize?: number; navZoomMode?: 'auto' | 'keep' | 'always' },
) {
  await page.evaluate((p) => {
    const store = (window as unknown as {
      __renderSettings?: {
        snapshot(): Record<string, unknown>;
        applyGlobal(s: Record<string, unknown>): void;
      };
    }).__renderSettings;
    if (!store) throw new Error('renderSettings not exposed');
    const next = { ...store.snapshot(), ...p };
    store.applyGlobal(next);
  }, partial);
}

async function focusPartAndSettle(
  page: import('@playwright/test').Page,
  name: string,
) {
  await page.evaluate((n) => {
    const bs = (window as unknown as {
      __boardStore?: { focusPart: (name: string) => void };
    }).__boardStore;
    if (!bs) throw new Error('boardStore not exposed');
    bs.focusPart(n);
  }, name);
  await waitForZoomAnimSettled(page);
}

test.describe('nav target size', () => {
  test('larger navTargetSize zooms in more on the same part', async ({ page }) => {
    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('statusbar')).toContainText('Components');

    // Run under 'always' so every navigate snaps to navTargetSize — auto/keep
    // would short-circuit when the part is in the comfortable band and the
    // setting wouldn't change the outcome.
    await applyRenderSettings(page, { navZoomMode: 'always', navTargetSize: 0.25 });
    await focusPartAndSettle(page, TARGET_PART);
    const scaleSmall = await readViewportScale(page);

    await applyRenderSettings(page, { navTargetSize: 0.50 });
    await focusPartAndSettle(page, TARGET_PART);
    const scaleLarge = await readViewportScale(page);

    console.log(`[nav-target-size] scale@0.25=${scaleSmall.toFixed(4)} scale@0.50=${scaleLarge.toFixed(4)} ratio=${(scaleLarge / scaleSmall).toFixed(3)}`);
    // Monotonic increase — bigger target → bigger zoom. Lower bound 1.5×
    // tolerates the absolute 6× cap and 3× fit-to-board cap clipping the
    // larger target for very small parts on tight viewports.
    expect(scaleLarge).toBeGreaterThan(scaleSmall * 1.5);
  });

  test("'keep' mode preserves zoom across navigate", async ({ page }) => {
    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('statusbar')).toContainText('Components');

    // First, snap to a known scale.
    await applyRenderSettings(page, { navZoomMode: 'always', navTargetSize: 0.30 });
    await focusPartAndSettle(page, TARGET_PART);
    const scaleBefore = await readViewportScale(page);

    // Switch to keep mode and re-navigate — scale must not change.
    await applyRenderSettings(page, { navZoomMode: 'keep' });
    await focusPartAndSettle(page, TARGET_PART);
    const scaleAfter = await readViewportScale(page);

    console.log(`[nav-target-size] keep-mode scaleBefore=${scaleBefore.toFixed(4)} scaleAfter=${scaleAfter.toFixed(4)}`);
    // Allow 1% tolerance for ticker float-rounding; should be effectively equal.
    expect(scaleAfter).toBeGreaterThan(scaleBefore * 0.99);
    expect(scaleAfter).toBeLessThan(scaleBefore * 1.01);
  });
});
