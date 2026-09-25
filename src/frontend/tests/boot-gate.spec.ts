/**
 * The boot gate in index.html: on a browser that lacks one of the engine
 * features the bundle needs, the page shows a sentence instead of staying
 * blank — and the app does not mount over it.
 *
 * We cannot run an old Safari here, so the missing feature is simulated by
 * deleting the global before any page script runs. That exercises the gate's
 * own logic and main.tsx's guard; the parse-failure case (a real Safari 16.3
 * refusing the lookbehind literal) is what the gate exists for and can only
 * be seen on a device.
 */
import { test, expect } from '@playwright/test';

test.describe('boot gate', () => {
  test('a missing engine feature shows the message and the app does not mount', async ({ page }) => {
    await page.addInitScript(() => {
      // Simulate Safari < 15.4.
      delete (window as unknown as { structuredClone?: unknown }).structuredClone;
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'BoardRipper needs a newer browser' })).toBeVisible();
    await expect(page.getByText('structuredClone')).toBeVisible();
    // Give the module bundle time to load and (wrongly) mount, then assert it did not.
    await page.waitForTimeout(1500);
    await expect(page.locator('.toolbar')).toHaveCount(0);
    const flagged = await page.evaluate(() => (window as unknown as { __brUnsupported?: string[] }).__brUnsupported);
    expect(flagged).toEqual(['structuredClone']);
  });

  test('a supported browser never sees the gate', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.toolbar').first()).toBeVisible();
    await expect(page.getByText('needs a newer browser')).toHaveCount(0);
    const flagged = await page.evaluate(() => (window as unknown as { __brUnsupported?: string[] }).__brUnsupported);
    expect(flagged).toBeUndefined();
  });
});
