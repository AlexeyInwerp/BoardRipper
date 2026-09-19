/**
 * A finger that is gesturing is not hovering.
 *
 * Hover runs `hitTest` and then `traceHitTest` on every pointermove, and both
 * pointers of a pinch deliver moves — so a pinch used to fire 90 hover
 * hit-tests, each one walking the trace set, while the zoom itself was already
 * rebuilding the scene. Measured on a 3369-part / 39319-trace Allegro board:
 * the pinch ran at a median of 30 fps (min 20) with hover on and 60 (min 30)
 * with it gated. It is also wrong on its own terms — there is no cursor, the
 * tooltip sits under the fingers, and the lit net changes every frame.
 *
 * What must survive: a single *resting* finger IS a hover. Reading a pin's net
 * and diode value is the main reason to touch a pin, and a guard that killed
 * that would trade one bug for another — so both directions are asserted here.
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

/** The tooltip is hidden with `display: none`, so "is it showing" is exactly
 *  "does it have a layout box". */
const tooltipShowing = (page: Page) => page.evaluate(() => {
  const el = document.querySelector('.pin-net-tooltip') as HTMLElement | null;
  return !!el && el.style.display !== 'none' && el.offsetParent !== null;
});

async function load(page: Page): Promise<Pt> {
  test.skip(!have, 'sample board not present');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  const devHooks = await page.evaluate(
    () => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1200);
  await page.evaluate((n) =>
    (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(n),
    SUBJECT);
  await page.waitForTimeout(1500);
  const b = (await page.locator('.board-panel-canvas').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Find a screen point where a resting finger opens the tooltip — i.e. a pin.
 *  Which CSS pixel that is depends on the fitted zoom, so it is searched for
 *  rather than assumed, and the pinch test below anchors a finger on it so a
 *  hover, if one ran, could not miss. */
async function findPinUnderFinger(page: Page, cdp: CDPSession, c: Pt): Promise<Pt | null> {
  for (let i = 0; i < 14; i++) {
    const p = { x: c.x - 70 + i * 10, y: c.y };
    await touch(cdp, 'touchStart', [p]);
    await touch(cdp, 'touchMove', [{ x: p.x + 2, y: p.y }]);   // inside the tap tolerance
    await page.waitForTimeout(120);
    const hit = await tooltipShowing(page);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(80);
    if (hit) return p;
  }
  return null;
}

test.describe('touch hover', () => {
  test('a resting finger still reads the pin under it', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);
    expect(await findPinUnderFinger(page, cdp, c),
      'a resting finger over a pin should show the tooltip').not.toBeNull();
  });

  test('a pinch never opens the tooltip', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    // One finger stays parked on a known pin while the other does the
    // spreading. Without that anchor the test proves nothing: two fingers
    // flying outward leave the pin field within a few moves, so it passes
    // whether hover ran or not.
    const pin = await findPinUnderFinger(page, cdp, c);
    test.skip(pin === null, 'no pin found under the sweep');
    const anchor = pin!;

    await touch(cdp, 'touchStart', [anchor]);
    await touch(cdp, 'touchStart', [anchor, { x: anchor.x + 60, y: anchor.y }]);
    for (let i = 1; i <= 20; i++) {
      await touch(cdp, 'touchMove', [anchor, { x: anchor.x + 60 + i * 6, y: anchor.y }]);
      await page.waitForTimeout(16);
      expect(await tooltipShowing(page), `tooltip opened on pinch move ${i}`).toBe(false);
    }
    await touch(cdp, 'touchEnd', [anchor]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect(await tooltipShowing(page)).toBe(false);
  });

  test('a pan never opens the tooltip', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await touch(cdp, 'touchStart', [c]);
    for (let i = 1; i <= 20; i++) {
      await touch(cdp, 'touchMove', [{ x: c.x + i * 8, y: c.y + i * 4 }]);
      await page.waitForTimeout(16);
      // The first couple of moves are still inside the tap tolerance and may
      // legitimately hover; past it, never.
      if (i > 3) expect(await tooltipShowing(page), `tooltip opened on pan move ${i}`).toBe(false);
    }
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect(await tooltipShowing(page)).toBe(false);
  });
});
