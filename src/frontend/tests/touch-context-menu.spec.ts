/**
 * Touch "right click" and touch page zoom (2026-10-02).
 *
 * 1. Hold a finger on a part and tap a second finger: the board menu opens
 *    under the held finger, the way a trackpad's two-finger click does. The
 *    long press stays as the other way in. What must NOT open it: two
 *    fingers landing together (that is the two-finger tap that toggles the
 *    rotation lock) and a hold whose second finger pinches.
 * 2. The menu closes on a touch anywhere outside it. iOS Safari dispatches
 *    no `click` for a tap on a non-interactive area, and a pan produces none
 *    anywhere, so the old click-only close left the menu open over the board.
 * 3. A double-tap must not zoom the page — opening a board from the Library
 *    is a double-tap, and Chrome and Safari zoomed the whole app on it.
 *
 * Real multi-touch through CDP (Chromium only), on the public KiCad sample.
 */
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);
const SUBJECT = 'U1';

test.use({ hasTouch: true });

type Pt = { x: number; y: number };
type Cam = { x: number; y: number; s: number };

interface Win { __boardStore: { selection: { partIndex: number | null }; focusPart(n: string): void; selectPart(i: number | null): void } }

async function load(page: Page): Promise<Pt> {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const devHooks = await page.evaluate(() => '__boardStore' in window);
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate(n => (window as unknown as Win).__boardStore.focusPart(n), SUBJECT);
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as unknown as Win).__boardStore.selectPart(null));
  const b = (await page.locator('canvas').first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Finger ids are the index unless a point carries its own. `touchEnd`
 *  lifts the points it LISTS (CDP), so lifting the second finger alone is
 *  `touchEnd` with `{ ...p, id: 1 }`; an empty list lifts every finger. */
async function touch(cdp: CDPSession, type: string, points: (Pt & { id?: number })[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i })) });
}
const lift2 = (p: Pt) => ({ ...p, id: 1 });

const menuOpen = (page: Page) => page.evaluate(() => !!document.querySelector('.context-menu'));
const menuTitle = (page: Page) => page.evaluate(() => document.querySelector('.context-menu')?.textContent ?? '');
/** The board pose, read through the navigation history's camera provider. */
const camera = (page: Page): Promise<Cam> => page.evaluate(() => {
  const w = window as unknown as { __navHistory: { store: { cameraOf(p: unknown): { x: number; y: number; scaleX: number } | undefined } }; __boardStore: { activeTabId: number } };
  const c = w.__navHistory.store.cameraOf({ kind: 'board', tabId: w.__boardStore.activeTabId });
  return { x: c?.x ?? 0, y: c?.y ?? 0, s: c?.scaleX ?? 0 };
});

test.describe('touch context menu', () => {
  test.skip(!have, 'sample board not present');

  test('hold a part and tap a second finger: the menu opens under the held finger, and nothing else happens', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const before = await camera(page);

    await touch(cdp, 'touchStart', [c]);
    await page.waitForTimeout(300);                                   // the hold
    const second = { x: c.x + 140, y: c.y + 60 };
    await touch(cdp, 'touchStart', [c, second]);
    await touch(cdp, 'touchMove', [{ x: c.x + 2, y: c.y + 1 }, { x: second.x + 3, y: second.y - 2 }]);
    await page.waitForTimeout(120);
    await touch(cdp, 'touchEnd', [lift2(second)]);                    // second finger up, first still down
    await page.waitForTimeout(150);

    expect(await menuOpen(page), 'menu after hold + tap').toBe(true);
    expect(await menuTitle(page)).toContain(SUBJECT);
    const during = await camera(page);
    expect(Math.abs(during.s - before.s) / before.s, 'the tap did not zoom').toBeLessThan(1e-3);

    await touch(cdp, 'touchEnd', []);                                 // lift the held finger
    await page.waitForTimeout(300);
    expect(await menuOpen(page), 'lifting the held finger leaves the menu open').toBe(true);
    expect(await page.evaluate(() => (window as unknown as Win).__boardStore.selection.partIndex),
      'the release selected nothing under the menu').toBeNull();
  });

  test('two fingers landing together is not a hold — no menu', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const second = { x: c.x + 140, y: c.y + 60 };
    await touch(cdp, 'touchStart', [c, second]);
    await page.waitForTimeout(100);
    await touch(cdp, 'touchEnd', [lift2(second)]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect(await menuOpen(page)).toBe(false);
  });

  test('a hold whose second finger pinches is a pinch — no menu', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await touch(cdp, 'touchStart', [c]);
    await page.waitForTimeout(300);
    const second = { x: c.x + 140, y: c.y + 60 };
    await touch(cdp, 'touchStart', [c, second]);
    for (let i = 1; i <= 6; i++) await touch(cdp, 'touchMove', [c, { x: second.x + i * 15, y: second.y + i * 8 }]);
    await touch(cdp, 'touchEnd', [lift2({ x: second.x + 90, y: second.y + 48 })]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect(await menuOpen(page)).toBe(false);
  });

  test('the menu closes on a touch outside it — a tap on the board, or the start of a pan', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const open = async () => {
      await touch(cdp, 'touchStart', [c]);
      await page.waitForTimeout(300);
      await touch(cdp, 'touchStart', [c, { x: c.x + 140, y: c.y + 60 }]);
      await page.waitForTimeout(100);
      await touch(cdp, 'touchEnd', [lift2({ x: c.x + 140, y: c.y + 60 })]);
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(300);
      expect(await menuOpen(page)).toBe(true);
    };

    await open();
    const away = { x: c.x - 200, y: c.y - 150 };
    await touch(cdp, 'touchStart', [away]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(200);
    expect(await menuOpen(page), 'a tap outside closes it').toBe(false);

    await open();
    await touch(cdp, 'touchStart', [away]);
    for (let i = 1; i <= 5; i++) await touch(cdp, 'touchMove', [{ x: away.x + i * 20, y: away.y }]);
    expect(await menuOpen(page), 'a pan closes it as it starts').toBe(false);
    await touch(cdp, 'touchEnd', []);

    // A tap on a menu row still works: the outside rule ignores the menu itself.
    // (The pan above moved the part; bring it back under the finger.)
    await page.evaluate(n => { const s = (window as unknown as Win).__boardStore; s.focusPart(n); s.selectPart(null); }, SUBJECT);
    await page.waitForTimeout(900);
    await open();
    const row = page.locator('.context-menu [data-testid^="qa-copy-"]').first();   // Copy runs and closes
    await row.tap();
    await page.waitForTimeout(200);
    expect(await menuOpen(page), 'a row tap runs its action and closes').toBe(false);
  });
});

test.describe('touch page zoom', () => {
  test('a double-tap does not zoom the page, and the root forbids touch page zoom', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    const ta = await page.evaluate(() => [getComputedStyle(document.documentElement).touchAction, getComputedStyle(document.body).touchAction]);
    expect(ta).toEqual(['pan-x pan-y', 'pan-x pan-y']);
    const sb = (await page.getByTestId('statusbar').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const p = { x: sb.x + sb.width / 2, y: sb.y + sb.height / 2 };
    for (let i = 0; i < 2; i++) {
      await touch(cdp, 'touchStart', [p]);
      await touch(cdp, 'touchEnd', []);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(1);
  });
});
