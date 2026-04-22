import { test, expect } from '@playwright/test';

// Library panel rework — smoke coverage for behavioral changes:
// 1) PDF toggle hidden on History tab.
// 2) DB/Live pill only rendered when Folders tab is active.
// 3) Local filter still filters the file list (regression guard).
//
// These tests use the empty-library default state so they work in CI without
// a seeded databank. They only assert DOM structure / visibility.

test.describe('Library panel header', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Open the Library panel. It's present by default in the layout.
    // Wait for the tabs row to mount.
    await page.waitForSelector('.library-tabs-row');
  });

  test('history tab hides the PDF search toggle', async ({ page }) => {
    await page.locator('.library-tab[title="Recently opened"]').click();
    await expect(page.locator('.library-pdf-search-toggle')).toHaveCount(0);
  });

  test('board# tab shows the PDF search toggle', async ({ page }) => {
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await expect(page.locator('.library-pdf-search-toggle')).toBeVisible();
  });

  test('DB/Live pill only appears on the Folders tab', async ({ page }) => {
    // Not on History
    await page.locator('.library-tab[title="Recently opened"]').click();
    await expect(page.locator('.library-browse-pill')).toHaveCount(0);

    // Not on Board#
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await expect(page.locator('.library-browse-pill')).toHaveCount(0);

    // Appears on Folders
    await page.locator('.library-tab[title="Browse folders"]').click();
    await expect(page.locator('.library-browse-pill')).toBeVisible();

    // Both options rendered
    await expect(page.locator('.library-browse-pill-btn', { hasText: 'DB' })).toBeVisible();
    await expect(page.locator('.library-browse-pill-btn', { hasText: 'Live' })).toBeVisible();
  });

  test('filter input is present and takes text', async ({ page }) => {
    const input = page.locator('.library-search-input');
    await expect(input).toBeVisible();
    await input.fill('hello');
    await expect(input).toHaveValue('hello');
  });
});
