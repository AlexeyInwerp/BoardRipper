/**
 * ⌘F / Ctrl+F routing (2026-10-20).
 *
 * Board panel: the shortcut lands in the ribbon's find field — Find part
 * with the selected part's name, Find net with a lit net's or a selected
 * pin's net — and the sidebar search follows the ribbon. It used to hand a
 * selection to the linked PDF, so finding the selected part on the board
 * itself took a detour through the schematic.
 *
 * PDF panel: a word clicked since the last ⌘F becomes the query. Without a
 * new click the shortcut only focuses the find field — it neither replaces
 * the text nor re-runs the search (a re-run jumps to another occurrence),
 * which is what "pan to another page, ⌘F, the search box is overwritten"
 * came down to.
 *
 * Public fixtures only: the KiCad sample and the hand-written two-page PDF.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const PDF = path.resolve(here, 'fixtures/two-page-text.pdf');
const FIND = process.platform === 'darwin' ? 'Meta+f' : 'Control+f';

type BoardStoreHook = {
  board: { parts: { name: string; pins: { net: string | null }[] }[]; nets: Map<string, unknown> } | null;
  selectPart: (i: number | null) => void;
  selectPin: (p: number, i: number) => void;
  highlightNet: (n: string | null) => void;
};
const bs = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __boardStore?: BoardStoreHook }).__boardStore;
  if (!s?.board) throw new Error('no board');
  return {
    parts: s.board.parts.map(p => ({ name: p.name, nets: p.pins.map(x => x.net) })),
    nets: [...s.board.nets.keys()],
  };
});

test.describe('⌘F on a board panel', () => {
  test.skip(!fs.existsSync(BOARD), 'needs samples/kicad/tomu-fpga.kicad_pcb');

  test('lands in the ribbon find field with the selected part, net or pin net; the sidebar follows', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    const hooks = await page.evaluate(() => !!(window as unknown as { __boardStore?: unknown }).__boardStore);
    test.skip(!hooks, '__boardStore exists only in a DEV bundle');
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.locator('.dv-tab', { hasText: 'tomu-fpga' })).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1500);

    const { parts, nets } = await bs(page);
    const partIdx = parts.findIndex(p => p.name === 'U1');
    expect(partIdx).toBeGreaterThanOrEqual(0);
    const partField = page.getByTestId('parts-filter-input');
    const netField = page.getByTestId('nets-filter-input');

    // Part selected → Find part, with the part's name.
    await page.evaluate(i => (window as unknown as { __boardStore: BoardStoreHook }).__boardStore.selectPart(i), partIdx);
    await page.keyboard.press(FIND);
    await expect(partField).toHaveValue('U1');
    await expect(partField).toBeFocused();

    // The sidebar search shows the same query.
    await page.locator('.board-sidebar-toggle').first().click();
    await page.locator('[data-board-tab="search"]').click();
    const sidebar = page.locator('.search-tab-input');
    await expect(sidebar).toHaveValue('U1');
    // …and follows what is typed in the ribbon.
    await partField.fill('R1');
    await expect(sidebar).toHaveValue('R1');

    // Net lit, no part → Find net, with the net's name.
    const net = nets.find(n => n && n !== 'GND') ?? nets[0];
    await page.evaluate(n => {
      const s = (window as unknown as { __boardStore: BoardStoreHook }).__boardStore;
      s.selectPart(null);
      s.highlightNet(n);
    }, net);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(FIND);
    await expect(netField).toHaveValue(net);
    await expect(netField).toBeFocused();
    await expect(sidebar).toHaveValue(net);

    // Pin selected → its net, not the part.
    const pinIdx = parts[partIdx].nets.findIndex(n => !!n);
    expect(pinIdx).toBeGreaterThanOrEqual(0);
    await page.evaluate(([p, i]) => (window as unknown as { __boardStore: BoardStoreHook }).__boardStore.selectPin(p, i), [partIdx, pinIdx]);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press(FIND);
    await expect(netField).toHaveValue(parts[partIdx].nets[pinIdx]!);
    await expect(netField).toBeFocused();
  });
});

/** Press and release a mouse at one point on the PDF touch surface: a tap. */
async function tapAt(page: Page, x: number, y: number) {
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('.pdf-touch-surface')!;
    const opts = (type: string, buttons: number) => new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
    });
    el.dispatchEvent(opts('pointerdown', 1));
    el.dispatchEvent(opts('pointerup', 0));
  }, { x, y });
}

async function dragMouse(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  const ev = (type: string, x: number, y: number, buttons: number) => page.evaluate(({ type, x, y, buttons }) => {
    document.querySelector('.pdf-touch-surface')!.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons, bubbles: true, cancelable: true,
    }));
  }, { type, x, y, buttons });
  await ev('pointerdown', from.x, from.y, 1);
  for (let i = 1; i <= 6; i++) await ev('pointermove', from.x + (dx * i) / 6, from.y + (dy * i) / 6, 1);
  await ev('pointerup', from.x + dx, from.y + dy, 0);
  await page.waitForTimeout(400);
}

const clickedWord = (page: Page) => page.evaluate(() =>
  (window as unknown as { __pdfStore?: { lastClickedWord: string | null } }).__pdfStore?.lastClickedWord ?? null);

/** Sweep the top of the page for a word other than `not`; the fixture's words
 *  are refdes-shaped so any hit is a plausible lookup. */
async function clickSomeWord(page: Page, not: string | null): Promise<string> {
  const b = (await page.locator('.pdf-canvas-container').boundingBox())!;
  for (let fy = 0.03; fy < 0.97; fy += 0.012) {
    for (let fx = 0.08; fx < 0.8; fx += 0.03) {
      await tapAt(page, b.x + b.width * fx, b.y + b.height * fy);
      const w = await clickedWord(page);
      if (w && w !== not) return w;
    }
  }
  throw new Error('no word hit in the sweep');
}

const transform = (page: Page) => page.evaluate(() =>
  (document.querySelector('.pdf-page-wrapper') as HTMLElement | null)?.style.transform ?? '');

/** The synthetic drag arms the inertia glide; wait until the view stops. */
async function settled(page: Page): Promise<string> {
  let prev = await transform(page);
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(300);
    const cur = await transform(page);
    if (cur === prev) return cur;
    prev = cur;
  }
  return prev;
}

test('⌘F on a PDF takes a fresh click, and otherwise only focuses the field', async ({ page }) => {
  test.setTimeout(60000);
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const hooks = await page.evaluate(() => !!(window as unknown as { __pdfStore?: unknown }).__pdfStore);
  test.skip(!hooks, '__pdfStore exists only in a DEV bundle');
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.pdf-canvas-container')).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(2000);

  const field = page.locator('.pdf-search-input');
  const first = await clickSomeWord(page, null);
  await page.keyboard.press(FIND);
  await expect(field).toHaveValue(first);
  await expect(field).toBeFocused();
  await page.waitForTimeout(600);
  const home = await transform(page);

  // Pan away with the field unfocused, as a click on the page leaves it.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const b = (await page.locator('.pdf-canvas-container').boundingBox())!;
  await dragMouse(page, { x: b.x + b.width / 2, y: b.y + b.height / 2 }, -200, -240);
  const away = await settled(page);
  expect(away).not.toBe(home);

  // No new click: the field keeps its text, gets the focus, and the view stays.
  await page.keyboard.press(FIND);
  await expect(field).toHaveValue(first);
  await expect(field).toBeFocused();
  await page.waitForTimeout(600);
  expect(await transform(page)).toBe(away);

  // A new click is a new request. (Space fits the page to width again — the
  // lookup zoomed in, and the glide left blank paper under the sweep.)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.getByTitle('Fit to page width (Space)').click();
  await settled(page);
  const second = await clickSomeWord(page, first);
  await page.keyboard.press(FIND);
  await expect(field).toHaveValue(second);
  await expect(field).toBeFocused();
});
