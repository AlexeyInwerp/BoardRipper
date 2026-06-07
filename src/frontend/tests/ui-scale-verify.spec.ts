/**
 * Quick visual verification for the global UI scale slider.
 *
 * Asserts:
 *   - The centered slider row is mounted on HomeBackdrop.
 *   - Sliding from 100% → 150% updates --ui-scale CSS var and re-applies
 *     `zoom` on <body> (toolbar bounding box grows ~1.5×).
 *   - localStorage persists the value, and a reload restores it.
 */
import { test, expect } from '@playwright/test';

test.describe('global interface scale', () => {
  test('home slider scales chrome live and persists', async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('.home-backdrop', { state: 'attached' });
    await page.evaluate(() => { localStorage.removeItem('boardripper-ui-scale'); });
    await page.reload();
    await page.waitForSelector('.home-backdrop', { state: 'attached' });

    const slider = page.locator('.home-ui-scale-row input[type="range"]');
    await expect(slider).toBeVisible();

    // Toolbar before scaling
    const toolbar = page.locator('.toolbar').first();
    await expect(toolbar).toBeVisible();
    const before = await toolbar.boundingBox();
    expect(before).not.toBeNull();

    // Drag slider to max via fill + input event so React's onInput fires
    await slider.evaluate((el: HTMLInputElement) => {
      el.value = '1.5';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Commit by simulating pointer-up
    await slider.evaluate((el: HTMLInputElement) => {
      el.dispatchEvent(new Event('pointerup', { bubbles: true }));
    });

    const cssVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
    );
    expect(cssVar).toBe('1.5');

    const after = await toolbar.boundingBox();
    expect(after).not.toBeNull();
    // Width is viewport-clamped (body width tracks viewport), but height
    // (var(--toolbar-height) = 40px) scales freely. 40 → 60 under 1.5×.
    expect(after!.height / before!.height).toBeGreaterThan(1.3);
    expect(after!.height / before!.height).toBeLessThan(1.7);

    const persisted = await page.evaluate(() => localStorage.getItem('boardripper-ui-scale'));
    expect(persisted).toBe('1.5');

    // Reload and re-check
    await page.reload();
    await page.waitForSelector('.home-backdrop');
    const restored = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim()
    );
    expect(restored).toBe('1.5');
  });
});
