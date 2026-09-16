/** Interactive mode announces itself over the board and can be left from there. */
import { test, expect } from '@playwright/test';

test('a banner with Done appears over the board while Interactive mode is on', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('boardripper-welcome-done', '1'); });
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles('../../samples/allegroBRD/PC Laptop/DA0ZS8MB8E0 BOARD VIEW/SKI_ZS8_DB_EL_v0E.brd');
  await expect(page.getByTestId('board-canvas')).toBeVisible();
  await expect(page.getByTestId('resize-mode-banner')).toHaveCount(0);
  await page.evaluate(() => (window as any).__resizeModeStore.setEnabled(true));
  const banner = page.getByTestId('resize-mode-banner');
  await expect(banner).toBeVisible();
  await banner.getByTestId('resize-mode-done').click();
  await expect(page.getByTestId('resize-mode-banner')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__resizeModeStore.enabled)).toBe(false);
});
