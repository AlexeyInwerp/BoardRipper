import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Renderer Lifecycle Stability', () => {

  test('rapid open/close/reopen does not crash (batchPool corruption)', async ({ page }) => {
    // Capture page errors during test
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    const boardFile = path.resolve('samples/820-02016.bvr');

    // Open → close → reopen 3 times
    for (let i = 0; i < 3; i++) {
      await fileInput.setInputFiles(boardFile);
      await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 15000 });

      // Close tab via Dockview close button
      const closeBtn = page.locator('.dv-default-tab-action').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
        await page.waitForTimeout(500);
      }
    }

    // No critical PixiJS errors
    const criticalErrors = pageErrors.filter(e =>
      e.includes('batchPool') || e.includes('GlobalResourceRegistry') || e.includes('_DefaultBatcher')
    );
    expect(criticalErrors).toHaveLength(0);
  });

  test('settings change during render does not crash', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(path.resolve('samples/820-02016.bvr'));
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 15000 });

    // Open settings via gear icon (actual selector from Toolbar.tsx)
    const settingsBtn = page.locator('.toolbar-btn-icon', { hasText: '⚙' });
    if (await settingsBtn.isVisible()) {
      await settingsBtn.click();
      await page.waitForTimeout(300);

      // Toggle layer buttons rapidly
      const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
      if (await topBtn.isVisible()) {
        await topBtn.click();
        await topBtn.click();
        await topBtn.click();
      }
    }

    // Board should still be rendered (no crash)
    await expect(page.getByTestId('statusbar')).toContainText('Components');

    // No critical renderer errors
    const criticalErrors = pageErrors.filter(e =>
      e.includes('batchPool') || e.includes('removeChild') || e.includes('Cannot read properties of null')
    );
    expect(criticalErrors).toHaveLength(0);
  });
});
