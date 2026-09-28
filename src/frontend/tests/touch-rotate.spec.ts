/**
 * Two-finger rotation on the board: turning the pair turns the board, live,
 * about the point between the fingers; the angle is committed when the
 * fingers lift — snapped to a right angle when within 10°, kept otherwise
 * ("unlocked") — and the point between the fingers stays where it was
 * through the commit. A dead zone keeps a pinch-zoom from wobbling.
 *
 * Real touches through CDP, like touch-pinch-zoom.spec.ts: the pointer pair
 * is what iPadOS delivers when it does not claim the gesture itself; the
 * WebKit gesture stream has its own case in touch-webkit.webkit.spec.ts.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);

type Pt = { x: number; y: number };

test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } });

async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

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
  return { x: b.x + b.width / 2 + 120, y: b.y + b.height / 2 + 60 };   // off-centre on purpose
}

const storeRotation = (page: Page) => page.evaluate(
  () => (window as unknown as { __boardStore: { rotation: number } }).__boardStore.rotation);
const rootDeg = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __boardRenderer?: { activeScene?: { root: { rotation: number } } } }).__boardRenderer;
  return (r?.activeScene?.root.rotation ?? 0) * 180 / Math.PI;
});

/** Board-local point under a page position, and where that local point is
 *  on the page now — the pair that says whether the anchor held. */
const localUnder = (page: Page, at: Pt) => page.evaluate((at) => {
  const el = document.querySelector('.board-panel-canvas')!.getBoundingClientRect();
  const r = (window as unknown as { __boardRenderer: { activeScene: { root: { toLocal(p: Pt): Pt } } } }).__boardRenderer;
  return r.activeScene.root.toLocal({ x: at.x - el.left, y: at.y - el.top });
}, at);
const pageOf = (page: Page, local: Pt) => page.evaluate((local) => {
  const el = document.querySelector('.board-panel-canvas')!.getBoundingClientRect();
  const r = (window as unknown as { __boardRenderer: { activeScene: { root: { toGlobal(p: Pt): Pt } } } }).__boardRenderer;
  const g = r.activeScene.root.toGlobal(local);
  return { x: g.x + el.left, y: g.y + el.top };
}, local);

/** Two fingers on a circle of radius `r0` about `at`, turned by `deg`
 *  (clockwise on screen positive) while the radius goes to r0·spread. */
async function turn(page: Page, cdp: CDPSession, at: Pt, deg: number, steps: number, spread = 1, hold = 0) {
  const r0 = 90;
  const fingers = (a: number, r: number): Pt[] => [
    { x: at.x + r * Math.cos(a), y: at.y + r * Math.sin(a) },
    { x: at.x - r * Math.cos(a), y: at.y - r * Math.sin(a) },
  ];
  await touch(cdp, 'touchStart', [fingers(0, r0)[0]]);
  await touch(cdp, 'touchStart', fingers(0, r0));
  for (let i = 1; i <= steps; i++) {
    const a = (deg * Math.PI / 180) * (i / steps);
    const r = r0 + (r0 * spread - r0) * (i / steps);
    await touch(cdp, 'touchMove', fingers(a, r));
    await page.waitForTimeout(8);
  }
  if (hold) await page.waitForTimeout(hold);
  await touch(cdp, 'touchEnd', [fingers(deg * Math.PI / 180, r0 * spread)[0]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(400);
}

test.describe('two-finger rotation', () => {
  test('turning the fingers 45° turns the board 45°, live, and keeps it when they lift', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    expect(await storeRotation(page)).toBe(0);
    const local = await localUnder(page, at);

    await turn(page, cdp, at, 45, 12);
    expect(Math.abs((await storeRotation(page)) - 45)).toBeLessThanOrEqual(1);
    expect(Math.abs((await rootDeg(page)) - 45)).toBeLessThanOrEqual(1);
    // The point that was between the fingers is still there.
    const now = await pageOf(page, local);
    expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(4);
  });

  test('the board follows the fingers while they are still down', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const r0 = 90;
    await touch(cdp, 'touchStart', [{ x: at.x + r0, y: at.y }]);
    await touch(cdp, 'touchStart', [{ x: at.x + r0, y: at.y }, { x: at.x - r0, y: at.y }]);
    for (let i = 1; i <= 8; i++) {
      const a = (30 * Math.PI / 180) * (i / 8);
      await touch(cdp, 'touchMove', [
        { x: at.x + r0 * Math.cos(a), y: at.y + r0 * Math.sin(a) },
        { x: at.x - r0 * Math.cos(a), y: at.y - r0 * Math.sin(a) },
      ]);
      await page.waitForTimeout(8);
    }
    // Chromium delivers touch moves frame-aligned, so the last one may land a
    // frame after the dispatch resolves — poll rather than read once.
    await expect.poll(() => rootDeg(page), { timeout: 2000 }).toBeGreaterThan(29);   // live …
    expect(Math.abs((await rootDeg(page)) - 30)).toBeLessThanOrEqual(1);
    expect(await storeRotation(page)).toBe(0);                                        // … nothing committed yet
    await touch(cdp, 'touchEnd', []);
  });

  test('close to a right angle snaps to it', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 84, 16);
    expect(await storeRotation(page)).toBe(90);
    await turn(page, cdp, at, -84, 16);
    expect(await storeRotation(page)).toBe(0);
  });

  test('a pinch-zoom that wobbles a few degrees does not rotate', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const z0 = await zoom(page);
    await turn(page, cdp, at, 3, 10, 1.8);
    expect(await storeRotation(page)).toBe(0);
    expect(Math.abs((await rootDeg(page)))).toBeLessThan(0.01);
    expect((await zoom(page)) / z0).toBeGreaterThan(1.5);
  });

  test('the rotate buttons step to the next right angle from a free angle', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 45, 12);
    await page.evaluate(() => (window as unknown as { __boardStore: { rotateCW(): void } }).__boardStore.rotateCW());
    expect(await storeRotation(page)).toBe(90);
    await turn(page, cdp, at, -45, 12);
    expect(await storeRotation(page)).toBe(45);
    await page.evaluate(() => (window as unknown as { __boardStore: { rotateCCW(): void } }).__boardStore.rotateCCW());
    expect(await storeRotation(page)).toBe(0);
  });

  test('off in Settings, two fingers only zoom and pan', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    type RS = { globalSettings: object; settings: { twoFingerRotate: boolean }; applyGlobal(p: object): void };
    await page.evaluate(() => {
      const rs = (window as unknown as { __renderSettings?: RS }).__renderSettings;
      rs?.applyGlobal({ ...rs.globalSettings, twoFingerRotate: false });
    });
    const off = await page.evaluate(() => (window as unknown as { __renderSettings?: RS }).__renderSettings?.settings.twoFingerRotate);
    test.skip(off !== false, 'render settings store is not exposed for tests');
    await turn(page, cdp, at, 45, 12);
    expect(await storeRotation(page)).toBe(0);
  });
});
