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
      __contextMenuStore: { showBoard: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.showBoard(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // New flat row: [B] 820-02935-05 — <firstPart> (<count>)
  const entry = menu.locator('.context-menu-item', {
    hasText: `820-02935-05 — ${firstPart}`,
  }).first();
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
      __contextMenuStore: { showBoard: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.showBoard(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // No "Search 'X' in Board" entry because no other board tabs are open.
  await expect(menu.locator('.context-menu-item', { hasText: 'in Board' })).toHaveCount(0);
  // Also no entry of the form "Search 'X' in 820-..." (single-other-board flat item).
  await expect(menu.locator('.context-menu-item', { hasText: /in 820-/ })).toHaveCount(0);
});

test('other PDFs surface: unbound PDF appears in menu', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  // Open the matching PDF (auto-binds), then unbind so it goes to "Other PDFs"
  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!bs && !!ps && bs.tabs[0].board !== null && ps.loadedFileNames.length > 0;
  }, null, { timeout: 15000 });

  await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTabId: number | null;
        tabs: { id: number; pdfFileNames: string[] }[];
        removePdfBinding: (tabId: number, name: string) => void;
      };
    }).__boardStore;
    const active = bs.tabs.find(t => t.id === bs.activeTabId);
    if (active) {
      for (const name of [...active.pdfFileNames]) bs.removePdfBinding(active.id, name);
    }
  });

  const firstPart = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: { tabs: { board: { parts: { name: string }[] } | null }[] };
    }).__boardStore;
    return bs.tabs[0].board!.parts[0].name;
  });

  await page.evaluate(({ refdes }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { showBoard: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.showBoard(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // New flat row: [P] 820-02016 — <firstPart> (<count>)
  const otherRow = menu.locator('.context-menu-item', {
    hasText: `820-02016 — ${firstPart}`,
  }).first();
  await expect(otherRow).toBeVisible();
});

test('scope badges render in global search dropdown (regression guard)', async ({ page }) => {
  const { firstPart } = await loadTwoBoardsAndPickRefdes(page);

  // Also open a PDF so the dropdown lists a PDF row.
  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  const search = page.getByTestId('search-input');
  await search.click();
  await search.fill(firstPart);

  const dropdown = page.locator('.toolbar-search-dropdown');
  await expect(dropdown).toBeVisible();

  const boardBadge = dropdown.locator('.toolbar-search-tag-board').first();
  await expect(boardBadge).toBeVisible();
  await expect(boardBadge).toHaveText('B');

  const pdfBadge = dropdown.locator('.toolbar-search-tag-pdf').first();
  await expect(pdfBadge).toBeVisible();
  await expect(pdfBadge).toHaveText('P');
});

test('flat rows carry scope badges on both board and PDF donor groups', async ({ page }) => {
  // Load two distinct boards so there is 1 active + 1 other. That's the
  // flat case (1 other) — no submenu trigger on the board side. To exercise
  // the 2+ item branch honestly we'd need a third distinct sample; we don't
  // have one. Instead assert the 2+ branch for PDFs: open 2 unbound PDFs.
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  // Load 2 different PDFs; unbind all so they both go to "Other PDFs"
  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  // Open the DFUT testing PDF as a second distinct file (or reuse a known sample)
  const secondPdf = path.join(SAMPLES, '820-02935 051-08286 Rev 5.0.3.pdf');
  await page.getByTestId('pdf-input').setInputFiles(secondPdf);

  await page.waitForFunction(() => {
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!ps && ps.loadedFileNames.length >= 2;
  }, null, { timeout: 15000 });

  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    return !!bs && bs.tabs[0].board !== null;
  }, null, { timeout: 15000 });

  // Unbind all PDFs from the active board
  await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTabId: number | null;
        tabs: { id: number; pdfFileNames: string[] }[];
        removePdfBinding: (tabId: number, name: string) => void;
      };
    }).__boardStore;
    const active = bs.tabs.find(t => t.id === bs.activeTabId);
    if (active) {
      for (const name of [...active.pdfFileNames]) bs.removePdfBinding(active.id, name);
    }
  });

  const firstPart = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: { tabs: { board: { parts: { name: string }[] } | null }[] };
    }).__boardStore;
    return bs.tabs[0].board!.parts[0].name;
  });

  await page.evaluate(({ refdes }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { showBoard: (x: number, y: number, name: string, pinId: string | null, net: string | null) => void };
    }).__contextMenuStore;
    cms.showBoard(200, 200, refdes, null, null);
  }, { refdes: firstPart });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // Flat rows for Other PDFs carry the [P] badge.
  const pdfBadge = menu.locator('.context-menu-item .toolbar-search-tag-pdf').first();
  await expect(pdfBadge).toBeVisible();
  await expect(pdfBadge).toHaveText('P');
});

test('PDF right-click menu lists Bound Boards and Other PDFs', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02935 051-08286 Rev 5.0.3.pdf'));
  await expect(page.locator('.dv-tab', { hasText: /820-02935 051-08286/ })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!ps && ps.loadedFileNames.length >= 2;
  }, null, { timeout: 15000 });

  // Switch active PDF to the bound one
  await page.evaluate(() => {
    const ps = (window as unknown as {
      __pdfStore: { switchTo: (name: string) => void; loadedFileNames: string[] };
    }).__pdfStore;
    const bound = ps.loadedFileNames.find(n => n.includes('820-02016'));
    if (bound) ps.switchTo(bound);
  });

  await page.evaluate(() => {
    const cms = (window as unknown as {
      __contextMenuStore: { showPdf: (x: number, y: number, q: string, origin: string) => void };
    }).__contextMenuStore;
    const ps = (window as unknown as {
      __pdfStore: { loadedFileNames: string[] };
    }).__pdfStore;
    const bound = ps.loadedFileNames.find(n => n.includes('820-02016'))!;
    cms.showPdf(200, 200, 'UF400', bound);
  });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // New flat row format: [B] 820-02016 — UF400 (N)
  await expect(menu.locator('.context-menu-item', {
    hasText: /820-02016 — UF400 \(\d+\)/,
  }).first()).toBeVisible();

  // Other PDFs row: [P] 820-02935 051-08286 — UF400 (N)
  await expect(menu.locator('.context-menu-item', {
    hasText: /820-02935 051-08286.*— UF400 \(\d+\)/,
  }).first()).toBeVisible();
});

test('PDF menu board entry jumps to the board tab + auto-selects', async ({ page }) => {
  await page.goto('/');

  // Load board A first, then the matching PDF, then board B. Loading B
  // before the PDF would double-bind the PDF (auto-bind to A via 820-code
  // match, explicit bind to active-tab B) — polluting Bound Boards.
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.getByTestId('file-input').setInputFiles(BOARD_B);
  await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' })).toBeVisible({ timeout: 15000 });

  await page.waitForFunction(() => {
    const bs = (window as unknown as { __boardStore?: { tabs: { board: unknown }[] } }).__boardStore;
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!bs && !!ps && bs.tabs.length >= 2 && ps.loadedFileNames.length >= 1 && bs.tabs.every(t => t.board !== null);
  }, null, { timeout: 15000 });

  const info = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        tabs: { id: number; fileName: string; board: { parts: { name: string }[] } | null }[];
      };
    }).__boardStore;
    const ps = (window as unknown as {
      __pdfStore: { loadedFileNames: string[] };
    }).__pdfStore;
    const a = bs.tabs.find(t => t.fileName.includes('820-02016'))!;
    return {
      boardAId: a.id,
      firstPart: a.board!.parts[0].name,
      pdfName: ps.loadedFileNames.find(n => n.includes('820-02016'))!,
    };
  });

  await page.evaluate(({ query, origin }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { showPdf: (x: number, y: number, q: string, origin: string) => void };
    }).__contextMenuStore;
    cms.showPdf(200, 200, query, origin);
  }, { query: info.firstPart, origin: info.pdfName });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  // New flat row: [B] 820-02016 — <firstPart> (<count>)
  const entry = menu.locator('.context-menu-item', {
    hasText: `820-02016 — ${info.firstPart}`,
  }).first();
  await expect(entry).toBeVisible();
  await entry.click();

  const after = await page.evaluate(() => {
    const bs = (window as unknown as {
      __boardStore: {
        activeTabId: number | null;
        activeTab: { fileName: string; selection: { partIndex: number | null }; board: { parts: { name: string }[] } | null } | null;
      };
    }).__boardStore;
    const tab = bs.activeTab;
    const sel = tab?.selection?.partIndex ?? null;
    return {
      activeTabId: bs.activeTabId,
      activeFileName: tab?.fileName ?? null,
      selectionName: (sel != null && tab?.board) ? tab.board.parts[sel].name : null,
    };
  });

  expect(after.activeTabId).toBe(info.boardAId);
  expect(after.activeFileName).toContain('820-02016');
  expect(after.selectionName?.toUpperCase()).toBe(info.firstPart.toUpperCase());
});

test('PDF hit-test picks the text item under the cursor', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const ps = (window as unknown as {
      __pdfStore?: {
        loadedFileNames: string[];
        getDocTextItemsForPage?: (n: string, p: number) => unknown[];
      };
    }).__pdfStore;
    if (!ps) return false;
    const name = ps.loadedFileNames[0];
    if (!name) return false;
    const items = ps.getDocTextItemsForPage ? ps.getDocTextItemsForPage(name, 0) : [];
    return Array.isArray(items) && items.length > 0;
  }, null, { timeout: 30000 });

  const pdfName = await page.evaluate(() => {
    const ps = (window as unknown as { __pdfStore: { loadedFileNames: string[] } }).__pdfStore;
    return ps.loadedFileNames[0];
  });

  // Wait until the panel registered its test hook
  await page.waitForFunction((name) => {
    const hooks = (window as unknown as {
      __pdfPanelTestHooks?: Record<string, { firstItemScreenCenter?: () => unknown }>;
    }).__pdfPanelTestHooks;
    return !!hooks && !!hooks[name] && typeof hooks[name].firstItemScreenCenter === 'function';
  }, pdfName, { timeout: 15000 });

  const target = await page.evaluate((name) => {
    const hooks = (window as unknown as {
      __pdfPanelTestHooks: Record<string, { firstItemScreenCenter: () => { clientX: number; clientY: number; str: string } | null }>;
    }).__pdfPanelTestHooks;
    return hooks[name].firstItemScreenCenter();
  }, pdfName);

  expect(target).not.toBeNull();
  const { clientX, clientY, str } = target!;

  // Dispatch contextmenu at the text item's center
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    if (!el) throw new Error('no element at point');
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: x, clientY: y, bubbles: true }));
  }, { x: clientX, y: clientY });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible({ timeout: 3000 });

  const state = await page.evaluate(() => {
    const cms = (window as unknown as {
      __contextMenuStore: { state: { query: string; source: string } };
    }).__contextMenuStore;
    return { query: cms.state.query, source: cms.state.source };
  });
  expect(state.source).toBe('pdf');
  expect(state.query).toBe(str.trim());
});

test('PDF menu zero-count row stays clickable (jump + manual tweak)', async ({ page }) => {
  await page.goto('/');

  // Load board A and its bound PDF, plus a second unrelated PDF
  await page.getByTestId('file-input').setInputFiles(BOARD_A);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02935 051-08286 Rev 5.0.3.pdf'));
  await expect(page.locator('.dv-tab', { hasText: /820-02935 051-08286/ })).toBeVisible({ timeout: 10000 });

  await page.waitForFunction(() => {
    const ps = (window as unknown as { __pdfStore?: { loadedFileNames: string[] } }).__pdfStore;
    return !!ps && ps.loadedFileNames.length >= 2;
  }, null, { timeout: 15000 });

  // Pick an obviously-absent query string. The Other PDFs group renders
  // the 820-02935 PDF; with a gibberish query, its count is 0.
  const missingQuery = 'ZZXYZNOPE';
  const pdfName = await page.evaluate(() => {
    const ps = (window as unknown as { __pdfStore: { loadedFileNames: string[] } }).__pdfStore;
    return ps.loadedFileNames.find(n => n.includes('820-02016'))!;
  });

  await page.evaluate(({ q, origin }) => {
    const cms = (window as unknown as {
      __contextMenuStore: { showPdf: (x: number, y: number, q: string, origin: string) => void };
    }).__contextMenuStore;
    cms.showPdf(200, 200, q, origin);
  }, { q: missingQuery, origin: pdfName });

  const menu = page.locator('.context-menu');
  await expect(menu).toBeVisible();

  const zeroRow = menu.locator('.context-menu-item', {
    hasText: new RegExp(`820-02935 051-08286.*— ${missingQuery} \\(0\\)`),
  }).first();
  await expect(zeroRow).toBeVisible();
  // Must NOT carry the disabled class
  await expect(zeroRow).not.toHaveClass(/disabled/);

  await zeroRow.click();

  // PDF store should have switched to the other PDF with the query applied.
  // _activeFileName is private on PdfStore; in the DEV hook we can still
  // read it by index.
  const after = await page.evaluate(() => {
    const ps = (window as unknown as {
      __pdfStore: { _activeFileName?: string | null };
    }).__pdfStore;
    return { active: ps._activeFileName ?? null };
  });
  expect(after.active).toContain('820-02935 051-08286');
});
