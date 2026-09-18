/**
 * Pinch fidelity: what the fingers do is what the board does.
 *
 * pixi-viewport's pinch plugin adds `(1 - old/new) * percent * scale` per
 * pointermove — a first-order approximation of a multiplicative zoom, so the
 * total depends on how many move events the browser delivered rather than on
 * where the fingers ended up. Measured on this board before the fix: the same
 * 4x finger spread came out as 1.8x zoom over three move events and 2.7x over
 * eight, and a pinch in followed by a pinch out did not return to the start.
 * That is the "inconsistent, sometimes jumps" report, and no `percent` value
 * fixes it — hence `BoardRenderer.installTouchPinch`.
 *
 * The three properties below are the whole contract, and each one fails
 * against the plugin: the zoom is a function of finger *distance* alone, the
 * gesture is reversible, and the point under the fingers does not move.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);
const SUBJECT = 'U1';

type Pt = { x: number; y: number };

test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } });

async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

/** The board HUD reads "NN% · …". Rounded to whole percent, which is why the
 *  ratio assertions below carry a small tolerance. */
async function zoom(page: Page): Promise<number> {
  const txt = await page.locator('.board-hud').first().textContent();
  const m = /(\d+)%/.exec(txt ?? '');
  if (!m) throw new Error(`no zoom in HUD: ${JSON.stringify(txt)}`);
  return Number(m[1]);
}

async function load(page: Page): Promise<Pt> {
  test.skip(!have, 'sample board not present');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  const devHooks = await page.evaluate(
    () => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const b = (await page.locator('.board-panel-canvas').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** A pinch centred on `at` that changes the finger separation by `factor`,
 *  delivered in `steps` move events. Both halves move, so the midpoint — and
 *  therefore the anchor — stays exactly at `at`. */
async function pinch(page: Page, cdp: CDPSession, at: Pt, factor: number, steps: number) {
  const d0 = 60;
  await touch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }]);
  await touch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }, { x: at.x + d0, y: at.y }]);
  for (let i = 1; i <= steps; i++) {
    const d = d0 + (d0 * factor - d0) * (i / steps);
    await touch(cdp, 'touchMove', [{ x: at.x - d, y: at.y }, { x: at.x + d, y: at.y }]);
    await page.waitForTimeout(8);
  }
  await touch(cdp, 'touchEnd', [{ x: at.x - d0 * factor, y: at.y }]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(400);
}

async function tap(page: Page, cdp: CDPSession, p: Pt) {
  await touch(cdp, 'touchStart', [p]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(250);
}

const selected = (page: Page) => page.evaluate(() =>
  (window as unknown as { __boardStore: { selection: { partIndex: number | null } } })
    .__boardStore.selection.partIndex);
const clearSelection = (page: Page) => page.evaluate(() =>
  (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
    .__boardStore.selectPart(null));
const focus = (page: Page, name: string) => page.evaluate((n) =>
  (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(n), name);

test.describe('board pinch', () => {
  test('the zoom follows the finger distance, not the event count', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    // Three move events or sixty: a 2x spread is a 2x zoom either way. This is
    // the property the plugin cannot have.
    for (const steps of [3, 8, 60]) {
      const before = await zoom(page);
      await pinch(page, cdp, c, 2, steps);
      const after = await zoom(page);
      expect(after / before, `${steps} move events`).toBeGreaterThan(1.97);
      expect(after / before, `${steps} move events`).toBeLessThan(2.03);
      await pinch(page, cdp, c, 0.5, 20);   // back to where we started
    }
  });

  test('a pinch in and back out returns to the same zoom', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    const before = await zoom(page);
    await pinch(page, cdp, c, 3, 20);
    expect(await zoom(page)).toBeGreaterThan(before * 2.9);
    await pinch(page, cdp, c, 1 / 3, 20);
    expect(await zoom(page)).toBe(before);
  });

  test('two fingers carry the board with them', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await focus(page, SUBJECT);
    await page.waitForTimeout(1000);
    await clearSelection(page);
    await tap(page, cdp, c);
    const subject = await selected(page);
    expect(subject, `tapping the centre after focusPart(${SUBJECT}) should hit it`).not.toBeNull();

    // Both fingers translate by the same amount and keep their separation, so
    // this is a pure pan: the zoom must not move and the part must.
    const zoomBefore = await zoom(page);
    const DX = 180, d = 60;
    await clearSelection(page);
    await touch(cdp, 'touchStart', [{ x: c.x - d, y: c.y }]);
    await touch(cdp, 'touchStart', [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }]);
    for (let i = 1; i <= 18; i++) {
      const dx = (DX * i) / 18;
      await touch(cdp, 'touchMove', [{ x: c.x - d + dx, y: c.y }, { x: c.x + d + dx, y: c.y }]);
      await page.waitForTimeout(8);
    }
    await touch(cdp, 'touchEnd', [{ x: c.x - d + DX, y: c.y }]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);

    expect(await zoom(page)).toBe(zoomBefore);
    await tap(page, cdp, { x: c.x + DX, y: c.y });
    expect(await selected(page)).toBe(subject);
  });

  test('the point between the fingers does not move while zooming', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await focus(page, SUBJECT);
    await page.waitForTimeout(1000);
    await clearSelection(page);
    await tap(page, cdp, c);
    const subject = await selected(page);
    expect(subject).not.toBeNull();

    // Anchor the pinch away from the part, so a wrong anchor cannot pass by
    // accident: a 2x zoom about `anchor` must move the part to exactly
    // anchor + 2*(part - anchor).
    const anchor = { x: c.x + 150, y: c.y - 80 };
    await clearSelection(page);
    await pinch(page, cdp, anchor, 2, 18);

    await tap(page, cdp, { x: anchor.x + 2 * (c.x - anchor.x), y: anchor.y + 2 * (c.y - anchor.y) });
    expect(await selected(page)).toBe(subject);
  });
});
