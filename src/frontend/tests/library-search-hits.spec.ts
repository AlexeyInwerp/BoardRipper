import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Library ▸ Folders while searching:
//  1. "N files found" above the tree; a click opens the branch the file is in,
//     selects it and scrolls it into view (no clicking through folders).
//  2. A folder holding a hit also lists its other files (its schematic, its
//     documents), muted, behind a toggle when there are more than five.
//
// The library is a throwaway folder handed to the folder-library producer
// (the lite build's), so the spec needs no backend and no proprietary files.
// It runs in the lite config's dev project only: the full build ignores a
// folder library while it expects a backend, and the built bundle has no
// DEV test globals. `npx playwright test --config playwright.lite.config.ts
// --project=lite-dev library-search-hits`.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-hits-'));
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
  // Clicking the active destination hides the panel, so only open it.
  if (!(await page.locator('.library-panel').isVisible())) {
    await page.locator('[data-sidebar-tab="library"]').first().click();
  }
  await page.getByTestId('folder-library-input').setInputFiles(root);
  await expect(page.getByTestId('folder-library-chip')).toBeVisible();
  await page.locator('[data-library-tab="folders"]').click();
  await expect(page.locator('.library-search-input')).toBeVisible();
}

async function search(page: Page, q: string) {
  await page.locator('.library-search-input').fill(q);
}

test('a click in the found list opens the branch and selects the file', async ({ page }) => {
  await loadLibrary(page);
  // A file-name match. (The search also matches folder paths: "820-02773"
  // alone finds all five files under that folder, each listed.)
  await search(page, 'boardview');
  const hits = page.getByTestId('library-hit');
  await expect(page.getByTestId('library-hits')).toContainText('1 file found');
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText('820-02773 boardview.brd');
  // The branch is closed until the hit is clicked.
  const row = page.locator('.library-file-row.hit', { hasText: '820-02773 boardview.brd' });
  await expect(row).toHaveCount(0);
  await hits.first().click();
  await expect(row).toBeVisible();
  await expect(row).toHaveClass(/selected/);
});

test('a folder holding a hit lists its other files, muted', async ({ page }) => {
  await loadLibrary(page);
  await search(page, '820-02773 boardview');
  await page.getByTestId('library-hit').first().click();
  // Same folder: the schematic and notes, not the Datasheets sibling folder.
  const n = page.getByTestId('library-neighbour');
  await expect(n).toHaveCount(2);
  await expect(n.nth(0)).toContainText('J293 schematic.pdf');
  await expect(page.getByTestId('library-neighbours-toggle')).toHaveCount(0);
});

test('more than five other files sit behind a toggle', async ({ page }) => {
  await loadLibrary(page);
  await search(page, '820-01041.bvr');
  await page.getByTestId('library-hit').first().click();
  const toggle = page.getByTestId('library-neighbours-toggle');
  await expect(toggle).toContainText('7 more files in this folder');
  await expect(page.getByTestId('library-neighbour')).toHaveCount(0);
  await toggle.click();
  await expect(page.getByTestId('library-neighbour')).toHaveCount(7);
  if (process.env.LIBRARY_HITS_SHOT) await page.locator('.library-panel').screenshot({ path: process.env.LIBRARY_HITS_SHOT });
});

test('several hits across branches are all one click away', async ({ page }) => {
  await loadLibrary(page);
  await search(page, 'bvr');
  const hits = page.getByTestId('library-hit');
  await expect(hits).toHaveCount(2);
  await hits.filter({ hasText: 'LA-G891P.bvr' }).click();
  await expect(page.locator('.library-file-row.hit.selected', { hasText: 'LA-G891P.bvr' })).toBeVisible();
  // The other hit's branch was not opened by that click.
  await expect(page.locator('.library-file-row', { hasText: '820-01041.bvr' })).toHaveCount(0);
});
