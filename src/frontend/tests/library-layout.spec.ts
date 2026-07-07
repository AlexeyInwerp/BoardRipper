/**
 * Library panel optical-organization pass (2026-07-07).
 *
 * Regression coverage for the four layout changes:
 *   1. Folder tab sits directly after "Board #" (was trailing at the end).
 *   2. Status bar is pinned at the BOTTOM of the panel (was under the tabs).
 *   3. DB/Live folder source is an icon-menu popup in the Folders view toolbar
 *      (was an inline pill that shifted the tab row).
 *   4. Switching to a tab focuses its search field (PDF search / filter).
 *
 * Runs against the Vite dev server with no backend — the DOM/layout renders
 * regardless (API calls just error), which is all these assertions need.
 */
import { test, expect, type Page } from '@playwright/test';

async function openLibrary(page: Page) {
  await page.goto('/');
  await page.waitForSelector('.library-tabs-row', { timeout: 10_000 });
  await expect(page.locator('.library-panel').first()).toBeVisible();
}

test.describe('Library panel layout', () => {
  test('Folder tab is positioned directly after Board #', async ({ page }) => {
    await openLibrary(page);
    const tabs = page.locator('.library-tabs .library-tab');
    // 0 = History (icon), 1 = Board # (text), 2 = Folder (icon, title="Browse folders")
    await expect(tabs.nth(1)).toHaveText('Board #');
    await expect(tabs.nth(2)).toHaveAttribute('title', 'Browse folders');
    // The inline DB/Live pill must be gone from the tab row.
    await expect(page.locator('.library-browse-pill')).toHaveCount(0);
  });

  test('status bar is pinned at the bottom of the panel', async ({ page }) => {
    await openLibrary(page);
    const content = page.locator('.library-content').first();
    const stats = page.locator('.library-statsbar').first();
    await expect(stats).toBeVisible();
    const cb = await content.boundingBox();
    const sb = await stats.boundingBox();
    expect(cb && sb).toBeTruthy();
    // The status bar sits below the (flex-1) content region — its top is at or
    // past the content's bottom edge.
    expect(sb!.y).toBeGreaterThanOrEqual(cb!.y + cb!.height - 4);
    // Single summary row is present.
    await expect(page.locator('.library-statsbar-summary')).toBeVisible();
    await page.locator('.library-panel').first().screenshot({ path: 'test-results/library-layout-default.png' });
  });

  test('folder source is an icon-menu popup with DB + Live', async ({ page }) => {
    await openLibrary(page);
    await page.locator('.library-tab[title="Browse folders"]').click();
    const srcBtn = page.locator('.library-source-btn');
    await expect(srcBtn).toBeVisible();
    // Popup closed initially.
    await expect(page.locator('.library-source-popup')).toHaveCount(0);
    await srcBtn.click();
    const popup = page.locator('.library-source-popup');
    await expect(popup).toBeVisible();
    await expect(popup.locator('.library-source-item')).toHaveCount(2);
    // Popup stays within the viewport horizontally.
    const pb = await popup.boundingBox();
    const vw = page.viewportSize()!.width;
    expect(pb!.x).toBeGreaterThanOrEqual(0);
    expect(pb!.x + pb!.width).toBeLessThanOrEqual(vw + 1);
    await page.locator('.library-panel').first().screenshot({ path: 'test-results/library-folder-source.png' });
    // Selecting an option switches source and closes the popup.
    await popup.getByText('Live filesystem').click();
    await expect(page.locator('.library-source-popup')).toHaveCount(0);
    await expect(srcBtn).toHaveAttribute('title', /Live filesystem/);
  });

  test('switching tabs focuses the relevant search field', async ({ page }) => {
    await openLibrary(page);
    // PDF tab → the PDF search input gets focus.
    await page.locator('.library-tab', { hasText: 'PDF' }).click();
    await page.waitForTimeout(120); // one rAF + settle
    const pdfPlaceholder = await page.evaluate(() =>
      (document.activeElement as HTMLInputElement | null)?.placeholder ?? '');
    expect(pdfPlaceholder.toLowerCase()).toContain('search pdf');

    // Board # tab → the filter input gets focus.
    await page.locator('.library-tab', { hasText: 'Board #' }).click();
    await page.waitForTimeout(120);
    const filterPlaceholder = await page.evaluate(() =>
      (document.activeElement as HTMLInputElement | null)?.placeholder ?? '');
    expect(filterPlaceholder.toLowerCase()).toContain('filter');
  });
});
