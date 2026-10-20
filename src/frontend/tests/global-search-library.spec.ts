/**
 * The toolbar's global search lists library hits in its dropdown (2026-10-20):
 * the first five files under the Library row, a "N more…" spoiler for the
 * rest, and the Library row itself still opens the panel with the query.
 *
 * Same throwaway folder library as library-search-hits.spec.ts, so it needs
 * no backend and no proprietary files, and runs in the lite dev project only.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line no-empty-pattern -- Playwright wants a destructured first argument
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'lite-dev', 'needs the lite dev server (folder library + DEV globals)');
});

const LAYOUT: Record<string, string[]> = {
  'Apple/A2338 820-02773/Schematic': ['820-02773 boardview.brd', 'J293 schematic.pdf', 'notes.pdf'],
  'Apple/A2338 820-02773/Datasheets': ['CD3217.pdf', 'ISL9240.pdf'],
  'Apple/A1990 820-01041': ['820-01041.bvr', 'a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'g.pdf'],
  'Dell/Latitude 5400': ['LA-G891P.bvr', 'LA-G891P.pdf'],
};

function makeFolder(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-gsearch-'));
  for (const [dir, names] of Object.entries(LAYOUT)) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const n of names) fs.writeFileSync(path.join(root, dir, n), 'x');
  }
  return root;
}

async function loadLibrary(page: Page) {
  const root = makeFolder();
  await page.goto('.');
  const prompt = page.getByTestId('session-restore-prompt');
  if (await prompt.count()) await page.getByTestId('session-discard').click();
  if (!(await page.locator('.library-panel').isVisible())) {
    await page.locator('[data-sidebar-tab="library"]').first().click();
  }
  await page.getByTestId('folder-library-input').setInputFiles(root);
  await expect(page.getByTestId('folder-library-chip')).toBeVisible();
}

test('library hits sit under the Library row: five, then a spoiler', async ({ page }) => {
  await loadLibrary(page);
  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill('pdf');
  const dropdown = page.locator('.toolbar-search-dropdown');
  await expect(dropdown).toBeVisible();

  const libraryRow = dropdown.locator('.toolbar-search-option', { hasText: 'Library' });
  await expect(libraryRow).toBeVisible();
  await expect(libraryRow.locator('.toolbar-search-count')).toHaveText('12');

  const rows = page.getByTestId('search-library-file');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator('.library-file-icon')).toHaveText('P');
  const more = page.getByTestId('search-library-more');
  await expect(more).toHaveText('7 more…');
  await more.click();
  await expect(rows).toHaveCount(12);
  await expect(more).toHaveCount(0);
});

test('a board-number query ranks that board first and shows its folder', async ({ page }) => {
  await loadLibrary(page);
  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill('820-01041');
  const rows = page.getByTestId('search-library-file');
  await expect(rows.first()).toContainText('820-01041.bvr');
  await expect(rows.first().locator('.toolbar-search-file-sub')).toContainText('Apple/A1990 820-01041');
  await expect(page.getByTestId('search-library-more')).toHaveCount(0);
});

test('the Library row still opens the panel with the query', async ({ page }) => {
  await loadLibrary(page);
  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill('LA-G891P');
  await expect(page.getByTestId('search-library-file')).toHaveCount(2);
  await page.locator('.toolbar-search-dropdown .toolbar-search-option', { hasText: 'Library' }).click();
  await expect(page.locator('.toolbar-search-dropdown')).toHaveCount(0);
  await expect(page.locator('.library-search-input')).toHaveValue('LA-G891P');
});
