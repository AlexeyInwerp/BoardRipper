/**
 * Context-menu top-of-menu icon strip — Copy / Search quick actions.
 * Uses the existing window.__contextMenuStore dev hook to drive the menu
 * synthetically, avoiding canvas-coordinate fragility.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES = path.resolve(__dirname, '../../../samples');
const BOARD = path.join(SAMPLES, '820-02016.bvr');

async function loadBoard(page: import('@playwright/test').Page) {
  // Grant clipboard permissions before navigation
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => {
    const s = (window as unknown as { __boardStore?: { activeTab?: { board: unknown } } }).__boardStore;
    return s?.activeTab?.board != null;
  }, undefined, { timeout: 15000 });
}

async function showBoardMenu(page: import('@playwright/test').Page, opts: {
  componentName: string; pinId?: string | null; netName?: string | null;
}) {
  await page.evaluate((o) => {
    const w = window as unknown as { __contextMenuStore?: {
      showBoard: (x: number, y: number, c: string, p: string | null, n: string | null) => void;
    } };
    w.__contextMenuStore?.showBoard(200, 200, o.componentName, o.pinId ?? null, o.netName ?? null);
  }, opts);
}

async function showPdfMenu(page: import('@playwright/test').Page, query: string) {
  await page.evaluate((q) => {
    const w = window as unknown as { __contextMenuStore?: {
      showPdf: (x: number, y: number, q: string, origin: string) => void;
    } };
    w.__contextMenuStore?.showPdf(200, 200, q, '');
  }, query);
}

test('part-only right-click shows Copy Part + Search Part', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400' });

  await expect(page.getByTestId('qa-copy-part')).toBeVisible();
  await expect(page.getByTestId('qa-search-part')).toBeVisible();
  await expect(page.getByTestId('qa-copy-net')).toHaveCount(0);
  await expect(page.getByTestId('qa-search-net')).toHaveCount(0);
});

test('pin+net right-click shows all 4 buttons', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400', pinId: 'F11', netName: 'PP_VCC' });

  await expect(page.getByTestId('qa-copy-net')).toBeVisible();
  await expect(page.getByTestId('qa-copy-part')).toBeVisible();
  await expect(page.getByTestId('qa-search-net')).toBeVisible();
  await expect(page.getByTestId('qa-search-part')).toBeVisible();
});

test('Copy Part writes part name to clipboard and shows toast', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400' });

  await page.getByTestId('qa-copy-part').click();

  await expect(page.locator('.toast', { hasText: "Copied 'UF400'" })).toBeVisible({ timeout: 2000 });
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('UF400');
});

test('Copy Net writes net name to clipboard', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400', pinId: 'F11', netName: 'PP_VCC' });

  await page.getByTestId('qa-copy-net').click();

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe('PP_VCC');
});

test('Search Net opens Google with encoded net name', async ({ page }) => {
  // Stub window.open BEFORE navigation so addInitScript captures it from page load
  await page.addInitScript(() => {
    const w = window as unknown as { __openCalls?: Array<{ url: string; target: string; features: string }> };
    w.__openCalls = [];
    const orig = window.open.bind(window);
    window.open = ((url?: string | URL, target?: string, features?: string) => {
      w.__openCalls!.push({
        url: String(url ?? ''),
        target: target ?? '',
        features: features ?? '',
      });
      return orig(url, target, features);
    }) as typeof window.open;
  });

  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400', pinId: 'F11', netName: 'PP_VCC' });
  await page.getByTestId('qa-search-net').click();

  const calls = await page.evaluate(() => (window as unknown as { __openCalls?: Array<{ url: string; target: string; features: string }> }).__openCalls);
  expect(calls?.[0]?.url).toBe('https://www.google.com/search?q=PP_VCC');
  expect(calls?.[0]?.target).toBe('_blank');
  expect(calls?.[0]?.features).toContain('noopener');
});

test('PDF right-click shows icon-only Copy + Search', async ({ page }) => {
  await loadBoard(page);
  await showPdfMenu(page, 'IC123');

  await expect(page.getByTestId('qa-copy-text')).toBeVisible();
  await expect(page.getByTestId('qa-search-text')).toBeVisible();
});

test('empty PDF query renders no strip', async ({ page }) => {
  await loadBoard(page);
  await showPdfMenu(page, '');

  await expect(page.getByTestId('context-menu-actions')).toHaveCount(0);
});

test('board header shows component name when no pin', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400' });

  const header = page.getByTestId('context-menu-header');
  await expect(header).toBeVisible();
  await expect(header).toHaveText('UF400');
});

test('board header includes component, pin, and net when all are set', async ({ page }) => {
  await loadBoard(page);
  await showBoardMenu(page, { componentName: 'UF400', pinId: 'F11', netName: 'PP_VCC' });

  const header = page.getByTestId('context-menu-header');
  await expect(header).toBeVisible();
  await expect(header).toHaveText('UF400 · pin F11 · net PP_VCC');
});

test('PDF header shows cursor query', async ({ page }) => {
  await loadBoard(page);
  await showPdfMenu(page, 'IC123');

  const header = page.getByTestId('context-menu-header');
  await expect(header).toBeVisible();
  await expect(header).toHaveText('IC123');
});
