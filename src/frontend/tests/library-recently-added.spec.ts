import { test, expect } from '@playwright/test';

// Library ▸ History has a second pane under a draggable separator listing the
// newest library files. Needs a backend with a scanned library (BACKEND_PORT);
// skips on an empty one.

test('History tab: recently added pane lists the newest files and resizes', async ({ page, request }) => {
  const res = await request.get('/api/databank/stats').catch(() => null);
  const stats = res && res.ok() ? await res.json() : null;
  test.skip(!stats || (stats.boards ?? 0) + (stats.pdfs ?? 0) === 0, 'needs a backend with a scanned library');

  await page.goto('/');
  await page.waitForSelector('.library-tabs-row');
  await page.locator('[data-library-tab="history"]').click();

  const pane = page.getByTestId('library-added');
  await expect(pane.locator('.library-file-row').first()).toBeVisible();
  const n = await pane.locator('.library-file-row').count();
  expect(n).toBeGreaterThan(0);

  // Search narrows it like the opened list.
  const first = (await pane.locator('.library-file-name').first().textContent())!;
  await page.locator('.library-search-input').fill(first);
  await expect(pane.locator('.library-file-row')).toHaveCount(1);
  await page.locator('.library-search-input').fill('');

  // Dragging the separator up grows the pane, and the height is remembered.
  const h0 = (await pane.boundingBox())!.height;
  const bar = (await page.getByTestId('library-added-splitter').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  await page.mouse.move(bar.x + bar.width / 2, bar.y - 60, { steps: 5 });
  await page.mouse.up();
  const h1 = (await pane.boundingBox())!.height;
  expect(h1).toBeGreaterThan(h0 + 40);

  await page.reload();
  await page.waitForSelector('.library-tabs-row');
  await page.locator('[data-library-tab="history"]').click();
  expect(Math.abs((await page.getByTestId('library-added').boundingBox())!.height - h1)).toBeLessThan(2);
});
