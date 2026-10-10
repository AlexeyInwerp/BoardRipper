/**
 * Settings ▸ System ▸ Troubleshooting ▸ "Reset all local settings": two
 * clicks clear every stored preference and reload, and the user's own data
 * (recent files here) survives. Asked for 2026-10-09 after a stored setting
 * left a board drawing no components, curable only by clearing site data.
 */
import { test, expect } from '@playwright/test';

test('resets stored preferences, keeps recent files', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('boardripper-render-settings', JSON.stringify({ showPinNumbers: false }));
    localStorage.setItem('boardripper-board-overrides', '{}');
    localStorage.setItem('boardripper-history', '[]');
  });
  await page.reload();
  await page.click('[data-testid="activity-rail"] [data-sidebar-tab="settings"]');
  await page.click('[data-settings-tab="system"]');
  await page.locator('.settings-section-header', { hasText: 'Troubleshooting' }).click();
  const btn = page.getByTestId('reset-local-settings');
  await btn.click();
  await expect(btn).toHaveText('Click again to reset and reload');
  await Promise.all([page.waitForEvent('load'), btn.click()]);
  const left = await page.evaluate(() => ({
    rs: JSON.parse(localStorage.getItem('boardripper-render-settings') ?? '{}').showPinNumbers,
    bo: localStorage.getItem('boardripper-board-overrides'),
    hist: localStorage.getItem('boardripper-history'),
  }));
  expect(left.rs).not.toBe(false);
  expect(left.bo).toBeNull();
  expect(left.hist).toBe('[]');
});
