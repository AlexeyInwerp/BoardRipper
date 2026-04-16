/**
 * Pan/Zoom scroll-mode toggle tests.
 * Covers the toolbar button behavior, Settings checkbox, and the
 * looksLikeMouseWheel heuristic edge cases.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');

test.describe('Pan/zoom scroll-mode toggle', () => {
  test('clicking the board toolbar button flips twoFingerPan and inverts PDF bindings', async ({ page }) => {
    await page.goto('/');
    // Start from a clean slate so defaults apply
    await page.evaluate(() => {
      localStorage.removeItem('boardripper-render-settings');
      localStorage.removeItem('boardripper-pdf-scroll-bindings');
    });
    await page.reload();

    await page.getByTestId('file-input').setInputFiles(BVR_FILE);
    await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

    const toggleBtn = page.locator('.board-status-indicators').getByTitle(/click to swap/);
    await expect(toggleBtn).toBeVisible();

    const before = await page.evaluate(() => {
      const r = localStorage.getItem('boardripper-render-settings');
      return r ? (JSON.parse(r).twoFingerPan as boolean) : true; // default true if missing
    });
    expect(before).toBe(true);

    await toggleBtn.click();

    const afterOneClick = await page.evaluate(() => ({
      twoFingerPan: JSON.parse(localStorage.getItem('boardripper-render-settings') || '{}').twoFingerPan,
      pdf: JSON.parse(localStorage.getItem('boardripper-pdf-scroll-bindings') || '{}'),
    }));
    expect(afterOneClick.twoFingerPan).toBe(false);
    expect(afterOneClick.pdf.bare).toBe('zoom');
    expect(afterOneClick.pdf.shift).toBe('pan');
    expect(afterOneClick.pdf.meta).toBe('switch');

    await toggleBtn.click();

    const afterTwoClicks = await page.evaluate(() => ({
      twoFingerPan: JSON.parse(localStorage.getItem('boardripper-render-settings') || '{}').twoFingerPan,
      pdf: JSON.parse(localStorage.getItem('boardripper-pdf-scroll-bindings') || '{}'),
    }));
    expect(afterTwoClicks.twoFingerPan).toBe(true);
    expect(afterTwoClicks.pdf.bare).toBe('pan');
    expect(afterTwoClicks.pdf.shift).toBe('zoom');
    expect(afterTwoClicks.pdf.meta).toBe('switch');
  });

  test('toggle preserves meta slot when it is non-default', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.setItem('boardripper-pdf-scroll-bindings', JSON.stringify({ bare: 'pan', shift: 'switch', meta: 'zoom' }));
    });
    await page.reload();

    await page.getByTestId('file-input').setInputFiles(BVR_FILE);
    await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

    const toggleBtn = page.locator('.board-status-indicators').getByTitle(/click to swap/);
    await toggleBtn.click();

    const pdf = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('boardripper-pdf-scroll-bindings') || '{}'),
    );
    expect(pdf.bare).toBe('switch');
    expect(pdf.shift).toBe('pan');
    expect(pdf.meta).toBe('zoom');
  });
});

test.describe('looksLikeMouseWheel heuristic', () => {
  test('classifies wheel events correctly in browser context', async ({ page }) => {
    await page.goto('/');

    const results = await page.evaluate(async () => {
      const mod = await import('/src/store/scroll-mode.ts');
      const mk = (opts: WheelEventInit) => new WheelEvent('wheel', opts);
      return {
        classicWheel: mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 0 })),
        bigNegative:  mod.looksLikeMouseWheel(mk({ deltaY: -120, deltaX: 0 })),
        smallWheel:   mod.looksLikeMouseWheel(mk({ deltaY: 10, deltaX: 0 })),
        withDeltaX:   mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 5 })),
        pinchCtrl:    mod.looksLikeMouseWheel(mk({ deltaY: 100, deltaX: 0, ctrlKey: true })),
        fractional:   mod.looksLikeMouseWheel(mk({ deltaY: 83.3, deltaX: 0 })),
      };
    });

    expect(results.classicWheel).toBe(true);
    expect(results.bigNegative).toBe(true);
    expect(results.smallWheel).toBe(false);
    expect(results.withDeltaX).toBe(false);
    expect(results.pinchCtrl).toBe(false);
    expect(results.fractional).toBe(false);
  });
});
