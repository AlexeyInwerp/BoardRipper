import { test, expect } from '@playwright/test';

test.describe('Themes', () => {
  test('default theme applies on first load', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgPrimary).toBe('#0f0f1a');

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#1a1a2e');
  });

  test('switching to Landrex Classic flips UI + canvas to black and persists', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.evaluate(async () => {
      const mod = await import('/src/store/themes.ts');
      mod.themeStore.setTheme('landrex');
    });

    // Allow one animation frame for the DOM update + scene rebuild.
    await page.waitForTimeout(100);

    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgPrimary).toBe('#000000');

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#000000');

    // Persistence: reload and confirm Landrex sticks.
    await page.reload();
    await page.waitForLoadState('networkidle');

    const bgAfterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgAfterReload).toBe('#000000');
  });

  test('Settings panel renders four tabs', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
      localStorage.removeItem('boardripper-settings-active-tab');
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Open Settings panel via the toolbar settings button.
    // (Selector loose enough to tolerate aria-label / text label changes.)
    const settingsButton = page.getByRole('button', { name: /settings/i }).first();
    await settingsButton.click();

    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible();

    const tabsRow = panel.locator('.settings-tabs-row, .library-tabs-row').first();
    await expect(tabsRow.getByText('Theme', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Board', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Input', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('System', { exact: true })).toBeVisible();
  });
});
