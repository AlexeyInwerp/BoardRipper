import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Board sidebar ▸ Notes (BoardNotesTab.tsx): board knowledge from the file,
// shown only when the file carries some.
//
// iPhoneXSMAX Common problems: an XZZ pack whose repair table (caption 通病,
// header 故障现象 / 故障点 / 处理方法, 7 rows) is drawn as loose text, plus a
// ~500-entry `===信号` net glossary. Proprietary, so the XZZ cases skip on a
// clean checkout; the "no notes, no tab" case runs on the public sample.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const XSMAX = path.resolve(HERE, '../../../samples/XZZ PCB SAMPLES/nas-iphone/XZZ/Phones/iPhone/iPhoneXSMAX/FAQs/iPhoneXSMAX Common problems.pcb');
const haveXsMax = fs.existsSync(XSMAX);
const PUBLIC = path.resolve(HERE, '../public/samples/test-board.bvr');

test.use({
  viewport: { width: 1280, height: 800 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

async function open(page: Page, file: string) {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  await page.locator('.board-sidebar-toggle').first().click();
}

// What "Translate page" does to the DOM: each text node it translates becomes
// <font><font>text</font></font>, and React keeps the node it no longer finds.
function simulateTranslation() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement;
    if (t.nodeValue?.trim() && parent && !parent.closest('[translate="no"], script, style, font, canvas')) nodes.push(t);
  }
  for (const t of nodes) {
    const outer = document.createElement('font');
    const inner = document.createElement('font');
    inner.textContent = t.nodeValue;
    outer.appendChild(inner);
    t.parentNode!.replaceChild(outer, t);
  }
}

test('a board without notes has no Notes tab', async ({ page }) => {
  await open(page, PUBLIC);
  await expect(page.locator('[data-board-tab="info"]')).toBeVisible();
  await expect(page.locator('[data-board-tab="notes"]')).toHaveCount(0);
});

test('an XZZ FAQ board shows its repair table and net glossary under Notes', async ({ page }) => {
  test.skip(!haveXsMax, 'iPhoneXSMAX Common problems sample not present');
  await open(page, XSMAX);
  await page.locator('[data-board-tab="notes"]').click();

  const table = page.getByTestId('board-notes-table');
  await expect(table).toHaveCount(1);
  await expect(table.locator('caption')).toHaveText('通病');
  await expect(table.locator('thead th')).toHaveText(['故障现象', '故障点', '处理方法']);
  await expect(table.locator('tbody tr')).toHaveCount(7);
  // Prose is tagged for the translator, identifiers fenced off from it.
  await expect(table.locator('th[lang="zh-CN"]')).toHaveCount(3);
  await expect(table.locator('[translate="no"] [data-part="J3200"]')).toHaveCount(1);

  const glossary = page.getByTestId('board-notes-glossary');
  await glossary.locator('summary').click();
  const rows = page.getByTestId('board-notes-glossary-row');
  expect(await rows.count()).toBeGreaterThan(400);
  await page.getByTestId('board-notes-filter').fill('PP_VDD_BOOST');
  await expect(rows.first()).toContainText('PP_VDD_BOOST');
  expect(await rows.count()).toBeLessThan(10);
});

test('highlighting a described net puts its description at the top', async ({ page }) => {
  test.skip(!haveXsMax, 'iPhoneXSMAX Common problems sample not present');
  await open(page, XSMAX);
  await page.locator('[data-board-tab="notes"]').click();
  const net = await page.evaluate(() => {
    const b = (window as unknown as { __boardStore: { activeTab: { board: {
      nets: Map<string, unknown>; netDescriptions?: Map<string, string>;
    } } } }).__boardStore.activeTab.board;
    return [...(b.netDescriptions ?? new Map()).keys()].find(n => b.nets.has(n)) ?? null;
  });
  expect(net).not.toBeNull();
  await page.evaluate((n) => (window as unknown as { __boardStore: { highlightNet(n: string): void } }).__boardStore.highlightNet(n), net!);
  const card = page.getByTestId('board-notes-net');
  await expect(card).toBeVisible();
  await expect(card.locator(`[data-net="${net}"]`)).toHaveCount(1);
});

test('the Notes tab survives "Translate page" while nets change and the glossary filters', async ({ page }) => {
  test.skip(!haveXsMax, 'iPhoneXSMAX Common problems sample not present');
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await open(page, XSMAX);
  await page.locator('[data-board-tab="notes"]').click();
  await page.getByTestId('board-notes-glossary').locator('summary').click();
  const nets = await page.evaluate(() => {
    const b = (window as unknown as { __boardStore: { activeTab: { board: {
      nets: Map<string, unknown>; netDescriptions?: Map<string, string>;
    } } } }).__boardStore.activeTab.board;
    return [...(b.netDescriptions ?? new Map()).keys()].filter(n => b.nets.has(n)).slice(0, 4);
  });
  for (const n of [...nets, null, nets[0]]) {
    await page.evaluate(simulateTranslation);
    await page.evaluate((x) => (window as unknown as { __boardStore: { highlightNet(n: string | null): void } }).__boardStore.highlightNet(x), n);
  }
  for (const q of ['PP', 'MIPI', '', 'zzzz-none', '']) {
    await page.evaluate(simulateTranslation);
    await page.getByTestId('board-notes-filter').fill(q);
  }
  // Scoped to the board sidebar, which hosts this tab. Other panels are not
  // this spec's subject: the left sidebar's History list is known to crash
  // under the same simulation (issue #36 follow-up). Names the panel and the
  // error instead of "a panel crashed somewhere".
  const crashed = await page.evaluate(() => [...document.querySelectorAll('.board-sidebar [data-testid="panel-error-boundary"]')].map(el => {
    const host = el.parentElement?.closest('[data-testid], .board-sidebar, .sidebar, .dv-groupview');
    return `${host?.getAttribute('data-testid') ?? host?.className ?? '?'}: ${el.textContent?.slice(0, 200)}`;
  }));
  expect(crashed).toEqual([]);
  await expect(page.getByTestId('board-notes')).toBeVisible();
  // An uncaught throw takes the whole window, whichever panel it came from.
  expect(errors.filter(e => /insertBefore|removeChild|NotFoundError/.test(e))).toEqual([]);
});

test('the notes survive a board-cache hit', async ({ page }) => {
  test.skip(!haveXsMax, 'iPhoneXSMAX Common problems sample not present');
  await open(page, XSMAX);                 // parses and stores
  await expect(page.locator('[data-board-tab="notes"]')).toBeVisible();
  // Close the tab and open the same file again in this page: same
  // name:size:modified, so it is served from the IndexedDB board cache.
  await page.evaluate(() => {
    const s = (window as unknown as { __boardStore: { activeTab: { id: number }; closeTab(id: number): void } }).__boardStore;
    s.closeTab(s.activeTab.id);
  });
  await page.getByTestId('file-input').setInputFiles(XSMAX);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  const toggle = page.locator('.board-sidebar-toggle').first();
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.locator('[data-board-tab="notes"]').click();
  await expect(page.getByTestId('board-notes-table')).toHaveCount(1);
  await page.getByTestId('board-notes-glossary').locator('summary').click();
  expect(await page.getByTestId('board-notes-glossary-row').count()).toBeGreaterThan(400);
});
