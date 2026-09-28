/**
 * Navigation history — ⌘[ / ⌘] (Preview's Go ▸ Back / Forward), the ribbon
 * ‹ › pair, and the rules of docs/specs/2026-09-29-navigation-history-design.md
 * that only the live app can prove: the camera comes back to the pose the
 * user *left* (departure rule), a new visit after backing re-anchors instead
 * of deleting rows, a layer switched off is skipped, and the browser never
 * navigates — ⌘[ is Chrome's and Safari's own Back on macOS.
 *
 * Runs on the public KiCad sample and the checked-in PDF fixture, so it runs
 * on every machine. Selections are driven through the DEV-only store globals
 * because where a part sits on screen is not what is under test.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const PDF = path.resolve(here, 'fixtures/two-page-text.pdf');
const have = fs.existsSync(BOARD);

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

type Cam = { x: number; y: number; scaleX: number; scaleY: number };

interface Win {
  __boardStore: {
    activeTabId: number | null;
    activeTab: { searchQuery: string } | null;
    selection: { partIndex: number | null; pinIndex: number | null; highlightedNet: string | null };
    board: { parts: { name: string; pins: { net: string }[] }[] } | null;
    selectPart(i: number | null, nav?: unknown): void;
    selectPin(i: number, p: number): void;
    focusPart(n: string, nav?: unknown): void;
    setSearch(q: string): void;
  };
  __navHistory: {
    store: {
      entries: { id: number; cause: string; label: string; revisit?: boolean; place: { kind: string; part?: string; camera?: Cam } | null; query?: { surface: string; text: string } }[];
      cursor: number;
      canBack: boolean;
      canForward: boolean;
      layers: Record<string, boolean>;
      setLayer(c: string, on: boolean): void;
      cameraOf(p: { kind: 'board'; tabId: number }): Cam | undefined;
      flushQuery(): void;
    };
  };
  __pdfStore: { activeDoc: { fileName: string; searchQuery: string; activeMatchIndex: number; currentPage: number } | null; searchText(q: string): void };
}

async function load(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const devHooks = await page.evaluate(() => '__navHistory' in window && '__boardStore' in window);
  test.skip(!devHooks, 'stores are DEV-only globals');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await page.waitForTimeout(1200);
}

const selectedName = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as Win).__boardStore;
  return s.selection.partIndex == null ? null : s.board!.parts[s.selection.partIndex].name;
});

const camera = (page: Page) => page.evaluate(() => {
  const w = window as unknown as Win;
  return w.__navHistory.store.cameraOf({ kind: 'board', tabId: w.__boardStore.activeTabId! })!;
});

const labels = (page: Page) => page.evaluate(() => (window as unknown as Win).__navHistory.store.entries.map(e => e.label));
const cursor = (page: Page) => page.evaluate(() => (window as unknown as Win).__navHistory.store.cursor);

const focus = (page: Page, name: string) => page.evaluate(n => (window as unknown as Win).__boardStore.focusPart(n), name);
const click = (page: Page, name: string) => page.evaluate(n => {
  const s = (window as unknown as Win).__boardStore;
  s.selectPart(s.board!.parts.findIndex(p => p.name === n));
}, name);

async function pan(page: Page, times: number) {
  // Alt+arrows are the keyboard pan; each press moves a fraction of the panel.
  await page.locator('canvas').first().hover();
  for (let i = 0; i < times; i++) await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(300);
}

function near(a: Cam, b: Cam, px = 4) {
  return Math.abs(a.x - b.x) <= px && Math.abs(a.y - b.y) <= px && Math.abs(a.scaleX - b.scaleX) < 1e-3;
}

test.describe('navigation history', () => {
  test.skip(!have, 'kicad sample not present');

  test('⌘[ returns to the previous part at the pose it was left at, ⌘] goes forward; the browser never navigates', async ({ page }) => {
    await load(page);
    const url = page.url();
    const histLen = await page.evaluate(() => history.length);

    await focus(page, 'U1');
    await page.waitForTimeout(600);
    await pan(page, 4);                       // move away from U1 by hand — the departure pose
    const leftAt = await camera(page);

    await focus(page, 'C1');
    await page.waitForTimeout(600);
    expect(near(await camera(page), leftAt)).toBe(false);   // the focus moved the camera
    await focus(page, 'R1');
    await page.waitForTimeout(600);
    expect(await labels(page)).toEqual(['U1', 'C1', 'R1']);

    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(600);
    expect(await selectedName(page)).toBe('C1');
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(700);
    expect(await selectedName(page)).toBe('U1');
    expect(near(await camera(page), leftAt)).toBe(true);    // not a fit: the pose it was left at

    await page.keyboard.press(`${MOD}+BracketRight`);
    await page.waitForTimeout(600);
    expect(await selectedName(page)).toBe('C1');

    for (let i = 0; i < 10; i++) await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(url);
    expect(await page.evaluate(() => history.length)).toBe(histLen);
    expect(await selectedName(page)).toBe('U1');            // stops at the start, no wrap
  });

  test('a new visit after backing re-anchors — nothing is deleted, back is where you just were', async ({ page }) => {
    await load(page);
    // Five parts that exist on this board, in file order — names are not the point.
    const names = await page.evaluate(() => (window as unknown as Win).__boardStore.board!.parts.slice(0, 5).map(p => p.name));
    const [A, B, C, D, E] = names;
    for (const n of [A, B, C, D]) { await click(page, n); await page.waitForTimeout(150); }
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe(B);

    await click(page, E);
    await page.waitForTimeout(300);
    expect(await labels(page)).toEqual([A, B, C, D, B, E]);
    const revisit = await page.evaluate(() => (window as unknown as Win).__navHistory.store.entries[4].revisit);
    expect(revisit).toBe(true);

    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe(B);
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe(D);               // the abandoned branch, still there
  });

  test('pin walking on one part is one entry; a search and its pick are one entry with the query', async ({ page }) => {
    await load(page);
    await click(page, 'U1');
    await page.evaluate(() => {
      const s = (window as unknown as Win).__boardStore;
      const i = s.board!.parts.findIndex(p => p.name === 'U1');
      s.selectPin(i, 0); s.selectPin(i, 1); s.selectPin(i, 2);
    });
    await page.waitForTimeout(200);
    expect(await labels(page)).toHaveLength(1);
    expect((await labels(page))[0]).toMatch(/^U1 · pin /);

    await page.evaluate(() => (window as unknown as Win).__boardStore.setSearch('C'));
    await page.waitForTimeout(100);
    await focus(page, 'C1');
    await page.waitForTimeout(300);
    const l = await labels(page);
    expect(l).toHaveLength(2);
    expect(l[1]).toMatch(/^“C” → C1/);   // focusPart keeps a net the part touches

    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe('U1');
    await page.keyboard.press(`${MOD}+BracketRight`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe('C1');
    expect(await page.evaluate(() => (window as unknown as Win).__boardStore.activeTab!.searchQuery)).toBe('C');
  });

  test('a layer switched off is skipped by ⌘[ and hidden from the list', async ({ page }) => {
    await load(page);
    await page.evaluate(() => (window as unknown as Win).__boardStore.setSearch('R'));
    await focus(page, 'R1');                     // search entry
    await page.waitForTimeout(200);
    await click(page, 'C1');                     // click entry
    await click(page, 'U1');                     // click entry
    await page.waitForTimeout(200);
    await page.evaluate(() => (window as unknown as Win).__navHistory.store.setLayer('click', false));
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe('R1');
    expect(await cursor(page)).toBe(0);
    await page.evaluate(() => (window as unknown as Win).__navHistory.store.setLayer('click', true));
  });

  test('the ribbon ‹ › pair walks the same timeline and disables at the ends', async ({ page }) => {
    await load(page);
    const back = page.getByTestId('history-back');
    const fwd = page.getByTestId('history-forward');
    await expect(back).toBeDisabled();
    await expect(fwd).toBeDisabled();
    await click(page, 'U1');
    await click(page, 'C1');
    await expect(back).toBeEnabled();
    await expect(fwd).toBeDisabled();
    await back.click();
    await page.waitForTimeout(400);
    expect(await selectedName(page)).toBe('U1');
    await expect(back).toBeDisabled();
    await expect(fwd).toBeEnabled();
    await fwd.click();
    await page.waitForTimeout(400);
    expect(await selectedName(page)).toBe('C1');
  });

  test('a PDF find is a search entry and comes back with its query and match', async ({ page }) => {
    test.skip(!fs.existsSync(PDF), 'pdf fixture missing');
    await load(page);
    await click(page, 'U1');
    await page.getByTestId('file-input').setInputFiles(PDF);
    await page.waitForTimeout(2500);
    await page.evaluate(() => (window as unknown as Win).__pdfStore.searchText('PPBUS_G3H'));
    await page.waitForTimeout(400);
    const entries = await page.evaluate(() => (window as unknown as Win).__navHistory.store.entries);
    const last = entries[entries.length - 1];
    expect(last.cause).toBe('search');
    expect(last.query).toEqual(expect.objectContaining({ surface: 'pdf', text: 'PPBUS_G3H' }));
    expect(last.place?.kind).toBe('pdf');
    expect(await page.evaluate(() => (window as unknown as Win).__pdfStore.activeDoc?.currentPage)).toBe(2);

    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(600);
    expect(await selectedName(page)).toBe('U1');
    // the board panel is the active one again
    await expect(page.locator('.dv-tab.dv-active-tab', { hasText: /kicad_pcb/ })).toHaveCount(1);

    await page.keyboard.press(`${MOD}+BracketRight`);
    await page.waitForTimeout(800);
    const doc = await page.evaluate(() => (window as unknown as Win).__pdfStore.activeDoc);
    expect(doc?.searchQuery).toBe('PPBUS_G3H');
    expect(doc?.currentPage).toBe(2);
    expect(doc?.activeMatchIndex).toBeGreaterThanOrEqual(0);
  });
});
