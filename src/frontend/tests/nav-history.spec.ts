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

  test('the History rail tab lists visits newest first, jumps on click, filters by chip, and clears', async ({ page }) => {
    await load(page);
    for (const n of ['U1', 'C1', 'R1']) { await click(page, n); await page.waitForTimeout(120); }
    await page.evaluate(() => (window as unknown as Win).__boardStore.setSearch('J'));
    await page.evaluate(() => (window as unknown as Win).__navHistory.store.flushQuery());
    await page.waitForTimeout(200);

    await page.locator('[data-sidebar-tab="history"]').first().click();
    const panel = page.getByTestId('history-panel');
    await expect(panel).toBeVisible();
    const rows = panel.getByTestId('history-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('“J”');
    await expect(rows.nth(1)).toContainText('R1');
    await expect(rows.nth(0)).toHaveAttribute('data-current', 'true');

    // Jump to U1 (the oldest): cursor moves, nothing is appended.
    await rows.nth(3).click();
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe('U1');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(3)).toHaveAttribute('data-current', 'true');

    // Layer chip: switching clicks off hides the three click rows.
    await panel.locator('[data-history-layer="click"]').click();
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0)).toContainText('“J”');
    await panel.locator('[data-history-layer="click"]').click();
    await expect(rows).toHaveCount(4);

    // The board search field offers the recent query while empty.
    await page.evaluate(() => (window as unknown as Win).__boardStore.setSearch(''));
    await page.locator('.board-sidebar-toggle').first().click();
    await page.locator('[data-board-tab="search"]').first().click();
    const field = page.locator('.search-tab-input');
    await field.click();
    await expect(page.getByTestId('search-recent').first()).toContainText('J');

    // Clear asks first, then empties the list.
    await page.getByTestId('history-clear').click();
    await expect(page.getByTestId('history-confirm')).toBeVisible();
    await page.getByTestId('history-confirm-yes').click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('history-back')).toBeDisabled();
  });

  test('holding the ribbon back button lists the entries behind the cursor', async ({ page }) => {
    await load(page);
    for (const n of ['U1', 'C1', 'R1']) { await click(page, n); await page.waitForTimeout(120); }
    const back = page.getByTestId('history-back');
    const box = (await back.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.up();
    const menu = page.getByTestId('history-back-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toContainText('C1');
    await expect(menu).toContainText('U1');
    expect(await selectedName(page)).toBe('R1');       // the hold did not also step
    await menu.locator('button', { hasText: 'U1' }).first().click();
    await page.waitForTimeout(500);
    expect(await selectedName(page)).toBe('U1');
  });

  test('viewpoints: a settled drag that leaves the view is a row only while the layer is on; a small one is not', async ({ page }) => {
    await load(page);
    await click(page, 'U1');
    await page.waitForTimeout(300);
    // Keyboard pans move a tenth of the panel per press and are user moves
    // to the settle detector like a drag is; they are deterministic where a
    // synthetic drag arms the inertia.
    const arrived = await camera(page);
    const drag = async (presses: number, dir: 'Left' | 'Right') => {
      await page.locator('canvas').first().hover();
      for (let i = 0; i < presses; i++) await page.keyboard.press(`Alt+Arrow${dir}`);
      await page.waitForTimeout(900);    // 600 ms settle
    };

    // Layer off (the default): a big pan leaves no row, but the click entry
    // remembers the pose it was left at (departure rule).
    await drag(9, 'Left');
    expect(await labels(page)).toEqual(['U1']);
    const left = await camera(page);
    expect(near(arrived, left, 6)).toBe(false);   // it did move
    const recorded = await page.evaluate(() => (window as unknown as Win).__navHistory.store.entries[0].place!.camera!);
    expect(near(recorded, left, 6)).toBe(true);

    // Layer on: a big drag is a viewpoint named after the region, a nudge is not.
    await page.evaluate(() => (window as unknown as Win).__navHistory.store.setLayer('view', true));
    await drag(9, 'Right');
    let l = await labels(page);
    expect(l).toHaveLength(2);
    expect(l[1]).toMatch(/^(near \S+|region) · \d+\.\d×$/);
    await drag(1, 'Right');
    l = await labels(page);
    expect(l).toHaveLength(2);

    // ⌘[ returns to U1 at the pose it was left in.
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(700);
    expect(await selectedName(page)).toBe('U1');
    expect(near(await camera(page), left, 6)).toBe(true);
    await page.evaluate(() => (window as unknown as Win).__navHistory.store.setLayer('view', false));
  });

  test('the timeline survives a reload; a row whose file is closed is greyed and skipped', async ({ page }) => {
    await load(page);
    await click(page, 'U1');
    await click(page, 'C1');
    await page.waitForTimeout(800);            // persist debounce
    await page.reload();
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    const prompt = page.getByTestId('session-restore-prompt');
    if (await prompt.count()) await page.getByTestId('session-discard').click();
    await page.waitForTimeout(500);
    expect(await labels(page)).toEqual(['U1', 'C1']);
    await page.locator('[data-sidebar-tab="history"]').first().click();
    const rows = page.getByTestId('history-panel').getByTestId('history-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveClass(/closed/);
    await expect(page.getByTestId('history-back')).toHaveCount(0);   // no board, no ribbon

    // Open the same file again: the rows come back to life by file key.
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
    await page.waitForTimeout(1200);
    await expect(rows.nth(0)).not.toHaveClass(/closed/);
    await page.keyboard.press(`${MOD}+BracketLeft`);
    await page.waitForTimeout(600);
    expect(await selectedName(page)).toBe('U1');
  });

  test('the PDF find field lists recent queries while focused and runs one on pick', async ({ page }) => {
    test.skip(!fs.existsSync(PDF), 'pdf fixture missing');
    await load(page);
    await page.getByTestId('file-input').setInputFiles(PDF);
    await page.waitForTimeout(2500);
    await page.evaluate(() => { const s = (window as unknown as Win).__pdfStore; s.searchText('PPBUS_G3H'); s.searchText('U8100'); });
    await page.waitForTimeout(300);

    // The store searches leave the (uncontrolled) field empty; a click is the
    // focus event that opens the list.
    const field = page.locator('.pdf-search-input');
    await field.click();
    const recents = page.getByTestId('pdf-search-recent');
    await expect(recents).toHaveCount(2);
    await expect(recents.nth(0)).toContainText('U8100');       // newest first
    await expect(recents.nth(1)).toContainText('PPBUS_G3H');

    await field.fill('PPB');                                    // typing filters
    await expect(recents).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const doc = await page.evaluate(() => (window as unknown as Win).__pdfStore.activeDoc);
    expect(doc?.searchQuery).toBe('PPBUS_G3H');
    expect(doc?.activeMatchIndex).toBeGreaterThanOrEqual(0);
    await expect(page.getByTestId('pdf-search-recents')).toHaveCount(0);
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
