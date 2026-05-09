/**
 * Library browse-mode filter coverage.
 *
 * Three tests:
 *   1. DB-mode (Folders + database) regression guard — typing into the
 *      filter prunes the folder tree to matching files only.
 *   2. Live-mode filter — typing into the filter shrinks the live
 *      filesystem listing to matching directory + file entries.
 *   3. Filter survival across sidebar tab switches — the library-search-input
 *      value persists across a Library → Settings → Library tab switch because
 *      all three sidebar panels are always-mounted (display:none swap) and
 *      localSearch is React state that survives without remounting.
 *
 * Key DOM facts (verified against source):
 *   - Search input: `.library-search-input`
 *   - Tree nodes (folders + files in DB/live view): `.library-tree-node`
 *   - Sidebar tab buttons: `.sidebar-tab` with text "Library" / "Settings" / "Debug"
 *   - Dev hook: `window.__databankStore` — present when `import.meta.env.DEV`
 *     (Vite dev server used by Playwright satisfies this).
 *   - `__databankStore.setBrowseMode('database'|'live')` — switches browse mode
 *   - `__databankStore.setViewMode('folders'|'history'|'metadata'|'model')` — switches view
 */
import { test, expect } from '@playwright/test';

type LoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

interface MinimalDatabankStore {
  loadStatus: LoadStatus;
  files: { id?: number; filename?: string }[];
  setBrowseMode: (m: 'database' | 'live') => void;
  setViewMode: (m: 'history' | 'metadata' | 'model' | 'folders') => void;
}

async function waitForReady(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForFunction(() => {
    const w = window as unknown as { __databankStore?: MinimalDatabankStore };
    return w.__databankStore != null;
  }, undefined, { timeout: 5000 });
  await page.waitForFunction(() => {
    const w = window as unknown as { __databankStore?: MinimalDatabankStore };
    const s = w.__databankStore?.loadStatus;
    return s === 'loaded' || s === 'error';
  }, undefined, { timeout: 15000 });
}

test.describe('library browse-mode filter', () => {

  test('DB-mode (folders + database) filter prunes the tree', async ({ page }) => {
    await waitForReady(page);

    // Switch to folders view in DB mode (the FolderView component).
    await page.evaluate(() => {
      const w = window as unknown as { __databankStore?: MinimalDatabankStore };
      w.__databankStore?.setViewMode('folders');
      w.__databankStore?.setBrowseMode('database');
    });

    // Wait briefly for React to commit the view-mode change.
    await page.waitForTimeout(150);

    // Count tree nodes before filtering.
    const initialNodes = await page.locator('.library-tree-node').count();

    if (initialNodes === 0) {
      // No indexed files — filter behaviour can't be tested meaningfully.
      test.skip(true, 'DB-mode folder tree is empty (no indexed files in this env)');
      return;
    }

    // Type a filter that is extremely unlikely to match everything.
    // Using 'zzz_unlikely_match_xyz' guarantees we see a real reduction
    // when the library contains items whose names don't include this token.
    const searchInput = page.locator('.library-search-input').first();
    await searchInput.fill('zzz_unlikely_match_xyz');
    await page.waitForTimeout(200);

    const filteredNodes = await page.locator('.library-tree-node').count();
    // The filter must reduce visible nodes — proves the filterFile callback
    // and FolderView's pruneEmptyFolders chain are wired correctly.
    expect(filteredNodes).toBeLessThan(initialNodes);

    // Clear the filter — nodes should return to the initial count.
    await searchInput.fill('');
    await page.waitForTimeout(150);
    const restoredNodes = await page.locator('.library-tree-node').count();
    expect(restoredNodes).toBe(initialNodes);
  });

  test('Live-mode filter shrinks the listing', async ({ page }) => {
    await waitForReady(page);

    // Switch to folders view in live mode (the LiveBrowser component).
    await page.evaluate(() => {
      const w = window as unknown as { __databankStore?: MinimalDatabankStore };
      w.__databankStore?.setViewMode('folders');
      w.__databankStore?.setBrowseMode('live');
    });

    // Wait for React to commit the mode change.
    await page.waitForTimeout(150);

    // Live mode fires a /api/databank/browse request on mount. Wait for
    // at least one entry to appear, or bail if the backend has no live dir.
    const hasEntries = await page.waitForFunction(() => {
      return document.querySelectorAll('.library-tree-node').length > 0;
    }, undefined, { timeout: 5000 }).then(() => true).catch(() => false);

    if (!hasEntries) {
      test.skip(true, 'live tree has no entries (LIBRARY_DIR not set or backend down)');
      return;
    }

    const initialEntries = await page.locator('.library-tree-node').count();

    const searchInput = page.locator('.library-search-input').first();
    // Use a filter that is extremely unlikely to match any real filename.
    await searchInput.fill('zzz_unlikely_match_xyz');
    await page.waitForTimeout(200);

    const filteredEntries = await page.locator('.library-tree-node').count();
    // With an impossible filter, LiveBrowser's client-side filter must reduce
    // the count. The ".." nav node is rendered unconditionally only when
    // currentPath is non-empty (root level has no ".." row), so at root
    // all entries should vanish.
    expect(filteredEntries).toBeLessThan(initialEntries);
  });

  test('filter survives sidebar tab switch (always-mounted panel regression guard)', async ({ page }) => {
    await waitForReady(page);

    // Library tab is active by default. Confirm the search input is present.
    const searchInput = page.locator('.library-search-input').first();
    await expect(searchInput).toBeAttached();

    // Type a distinctive filter value.
    const filterValue = 'test_filter_value';
    await searchInput.fill(filterValue);

    // Confirm the value is set before switching away.
    await expect(searchInput).toHaveValue(filterValue);

    // Switch to the Settings tab.
    const settingsTab = page.locator('.sidebar-tab', { hasText: 'Settings' }).first();
    await settingsTab.click();
    await expect(settingsTab).toHaveClass(/active/);

    // Switch back to the Library tab.
    const libraryTab = page.locator('.sidebar-tab', { hasText: 'Library' }).first();
    await libraryTab.click();
    await expect(libraryTab).toHaveClass(/active/);

    // One rAF for any async re-render.
    await page.waitForTimeout(150);

    // The search input must still hold the typed value — the panel was never
    // unmounted (display:none swap), so localSearch React state is preserved.
    await expect(searchInput).toHaveValue(filterValue);
  });

});
