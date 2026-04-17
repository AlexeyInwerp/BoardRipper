/**
 * Donor search — verifies the right-click "find on other board" submenu
 * and the global-search auto-select refactor.
 *
 * Uses dev-only window hooks (window.__boardStore, window.__contextMenuStore)
 * to avoid canvas-coordinate fragility against the PixiJS renderer.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES = path.resolve(__dirname, '../../../samples');
const BOARD_A = path.join(SAMPLES, '820-02016.bvr');
const BOARD_B = path.join(SAMPLES, '820-02935-05.brd');

interface TabSnapshot { id: number; fileName: string; }

async function loadTwoBoardsAndPickRefdes(page: import('@playwright/test').Page) {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('file-input').setInputFiles(BOARD_B);
  await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' })).toBeVisible({ timeout: 15000 });

  // Wait until both boards have parsed boards available on their tabs
  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    return !!bs && bs.tabs.length >= 2 && bs.tabs.every(t => t.board !== null);
  }, null, { timeout: 15000 });

  const info = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        tabs: { id: number; fileName: string; board: { parts: { name: string }[] } | null }[];
        switchTab: (id: number) => void;
      };
    }).__boardStore;
    const tabs: TabSnapshot[] = bs.tabs.map((t) => ({ id: t.id, fileName: t.fileName }));
    const a = tabs.find((t) => t.fileName.includes('820-02016'))!;
    bs.switchTab(a.id);
    const tabA = bs.tabs.find((t) => t.id === a.id)!;
    const firstPart = tabA.board!.parts[0].name;
    return { tabs, firstPart };
  });

  return info;
}

test('donor submenu renders and jumps to donor board', async ({ page }) => {
  const { tabs, firstPart } = await loadTwoBoardsAndPickRefdes(page);
  const boardB = tabs.find((t) => t.fileName.includes('820-02935-05'))!;

  await page.evaluate(({ refdes }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { show: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.show(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  const entry = menu.locator('.context-menu-item', {
    hasText: `Search '${firstPart}' in 820-02935-05`,
  });
  await expect(entry).toBeVisible();

  await entry.click();

  const afterClick = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTabId: number | null;
        activeTab: { fileName: string; selection: { partIndex: number | null } } | null;
      };
    }).__boardStore;
    return {
      activeTabId: bs.activeTabId,
      selectionPartIndex: bs.activeTab?.selection?.partIndex ?? null,
      activeFileName: bs.activeTab?.fileName ?? null,
    };
  });
  expect(afterClick.activeTabId).toBe(boardB.id);
  expect(afterClick.activeFileName).toContain('820-02935-05');
  // selectionPartIndex may be null if the donor has no refdes matching firstPart.
  // The contract we guarantee for the submenu click is: tab switch + search query open.
  // Auto-select is best-effort.
});

test('global search auto-selects exact refdes on click', async ({ page }) => {
  const { tabs, firstPart } = await loadTwoBoardsAndPickRefdes(page);
  const boardB = tabs.find((t) => t.fileName.includes('820-02935-05'))!;

  // Switch to B first so clicking the A row requires a tab switch.
  await page.evaluate((id) => {
    const bs = (window as unknown as { __boardStore: { switchTab: (id: number) => void } }).__boardStore;
    bs.switchTab(id);
  }, boardB.id);

  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill(firstPart);

  const dropdown = page.locator('.toolbar-search-dropdown');
  await expect(dropdown).toBeVisible({ timeout: 5000 });

  const boardARow = dropdown.locator('.toolbar-search-option', {
    hasText: '820-02016',
  });
  await boardARow.click();

  const result = await page.evaluate((expectedName) => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTab: {
          fileName: string;
          selection: { partIndex: number | null };
          board: { parts: { name: string }[] } | null;
        } | null;
      };
    }).__boardStore;
    const tab = bs.activeTab;
    const sel = tab?.selection?.partIndex ?? null;
    const selName = (sel != null && tab?.board) ? tab.board.parts[sel].name : null;
    return {
      activeFileName: tab?.fileName ?? null,
      selectionName: selName,
      expectedName,
    };
  }, firstPart);

  expect(result.activeFileName).toContain('820-02016');
  expect(result.selectionName?.toUpperCase()).toBe(result.expectedName.toUpperCase());
});

test('donor submenu hides when only one board is open', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    return !!bs && bs.tabs.length === 1 && bs.tabs[0].board !== null;
  }, null, { timeout: 15000 });

  const firstPart = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: { tabs: { board: { parts: { name: string }[] } | null }[] };
    }).__boardStore;
    return bs.tabs[0].board!.parts[0].name;
  });

  await page.evaluate(({ refdes }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { show: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.show(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // No "Search 'X' in Board" entry because no other board tabs are open.
  await expect(menu.locator('.context-menu-item', { hasText: 'in Board' })).toHaveCount(0);
  // Also no entry of the form "Search 'X' in 820-..." (single-other-board flat item).
  await expect(menu.locator('.context-menu-item', { hasText: /in 820-/ })).toHaveCount(0);
});
