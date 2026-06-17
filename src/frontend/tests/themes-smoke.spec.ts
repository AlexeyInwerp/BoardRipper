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
    expect(bgPrimary).toBe('#08080c'); // THEMES.default.ui.bgPrimary

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#050508'); // THEMES.default.board.canvasBackground
  });

  test('switching to Landrex Classic flips the canvas to black, leaves chrome, and persists', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.evaluate(async () => {
      const mod = await import('/src/store/themes.ts');
      mod.themeStore.setTheme('landrex');
    });

    // Allow one animation frame for the DOM update + scene rebuild.
    await page.waitForTimeout(100);

    // Landrex is a *board* style: the canvas goes pure black but the interface
    // chrome is deliberately left identical to default (ui mirrors default).
    const bgPrimary = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim()
    );
    expect(bgPrimary).toBe('#08080c');

    const canvasBg = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasBg).toBe('#000000');

    // Persistence: reload and confirm Landrex sticks (canvas stays black).
    await page.reload();
    await page.waitForLoadState('networkidle');

    const canvasAfterReload = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim()
    );
    expect(canvasAfterReload).toBe('#000000');
  });

  test('light theme flips background light and text dark (auto-contrast)', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('boardripper-theme', JSON.stringify({ activeId: 'daylight' }));
      localStorage.removeItem('boardripper-background-override');
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const vars = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        bg: cs.getPropertyValue('--bg-primary').trim(),
        text: cs.getPropertyValue('--text-primary').trim(),
      };
    });
    // Daylight is a light theme: background light, and pickTextColors must have
    // flipped body text to the dark graphite pair (the white-on-white guard).
    expect(vars.bg.toLowerCase()).toBe('#eceef1');
    expect(vars.text.toLowerCase()).toBe('#1c1f24');
  });

  test('Settings panel renders four tabs', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
      localStorage.removeItem('boardripper-settings-active-tab');
    });

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // The Library/Settings/Debug sidebar is open by default; switch to its
    // Settings tab (a .sidebar-tab button), which reveals the SettingsPanel.
    await page.locator('.sidebar-tab', { hasText: 'Settings' }).first().click();

    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible();

    const tabsRow = panel.locator('.settings-tabs-row, .library-tabs-row').first();
    await expect(tabsRow.getByText('Theme', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Board', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('Input', { exact: true })).toBeVisible();
    await expect(tabsRow.getByText('System', { exact: true })).toBeVisible();
  });

  test('Theme tab shows the board + pin-group colour editors', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.removeItem('boardripper-theme');
      localStorage.removeItem('boardripper-custom-theme');
      localStorage.removeItem('boardripper-settings-active-tab');
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await page.locator('.sidebar-tab', { hasText: 'Settings' }).first().click();
    const panel = page.locator('[data-testid="settings-panel"]');
    await expect(panel).toBeVisible();

    // The board + pin colour editors (carried by theme) live on the Theme tab.
    // Creation of the custom slot is implicit on first edit (no Create button).
    const tabsRow = panel.locator('.settings-tabs-row, .library-tabs-row').first();
    await tabsRow.getByText('Theme', { exact: true }).click();
    await expect(panel.getByText('Pin colours (by net group)')).toBeVisible();
    await expect(panel.getByText('Power', { exact: true })).toBeVisible();
    await expect(panel.getByText('Component fills')).toBeVisible();
  });
});
