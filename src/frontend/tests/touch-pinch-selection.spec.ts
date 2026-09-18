/**
 * A pinch on a touch screen must not select anything, and a tap must.
 *
 * pixi-viewport decides what a click was from its own InputManager, and on a
 * tablet that record is wrong in two ways at once. It clears `clickedAvailable`
 * when a second pointer arrives — but it routes `pointercancel` straight into
 * `up()`, indistinguishably from a release, and iPadOS hands two-finger
 * gestures to its own recogniser freely, cancelling the pointers it takes. The
 * first finger's cancel then arrives as "a release, no other pointer
 * registered, no travel" and `clicked` fires in the middle of the pinch. No
 * distance test catches that one: at cancel time the finger has barely moved.
 *
 * So the renderer keeps its own record of the gesture — was it ever
 * multi-touch, was it ever cancelled — and this spec drives real multi-touch
 * through CDP to exercise it. The tap case is here for the same reason the
 * shift+click case is in shift-drag-worklist.spec.ts: a guard that swallows
 * everything would pass the bug test and break the product.
 */
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);

/** A part big enough on screen that a touch at the canvas centre lands on it. */
const SUBJECT = 'U1';

test.use({ hasTouch: true });

type Pt = { x: number; y: number };

async function selectedPart(page: Page): Promise<number | null> {
  return page.evaluate(() =>
    (window as unknown as { __boardStore: { selection: { partIndex: number | null } } })
      .__boardStore.selection.partIndex);
}

async function load(page: Page): Promise<Pt> {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  const devHooks = await page.evaluate(
    () => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.evaluate((name) =>
    (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(name),
    SUBJECT);
  await page.waitForTimeout(1200);
  const b = (await page.locator('canvas').first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** CDP emits one event per *changed* point, so a staggered two-finger lift is
 *  expressed by shrinking the active set one entry at a time. */
async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

test.describe('touch input', () => {
  test.skip(!have, 'sample board not present');

  test('a two-finger pinch selects nothing', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));
    expect(await selectedPart(page)).toBeNull();

    // Both fingers start on the part, then spread — the gesture is centred on
    // exactly the spot a stray click would select.
    await touch(cdp, 'touchStart', [{ x: c.x - 20, y: c.y }]);
    await touch(cdp, 'touchStart', [{ x: c.x - 20, y: c.y }, { x: c.x + 20, y: c.y }]);
    for (let i = 1; i <= 8; i++) {
      const d = 20 + i * 12;
      await touch(cdp, 'touchMove', [{ x: c.x - d, y: c.y }, { x: c.x + d, y: c.y }]);
      await page.waitForTimeout(16);
    }
    await touch(cdp, 'touchEnd', [{ x: c.x - 116, y: c.y }]);   // second finger up
    await touch(cdp, 'touchEnd', []);                            // first finger up
    await page.waitForTimeout(400);

    expect(await selectedPart(page)).toBeNull();
  });

  /** The iPadOS shape, and the one pixi-viewport gets wrong on its own: the
   *  second finger's pointerdown never reaches the page at all, because WebKit
   *  claimed the sequence for its own gesture recogniser and cancelled the
   *  first pointer instead. InputManager.up() takes that cancel for a release,
   *  finds no other pointer registered and no travel, and emits `clicked`. */
  test('a cancelled touch — the second finger never arrives — selects nothing', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));

    await touch(cdp, 'touchStart', [c]);
    await page.waitForTimeout(16);
    await touch(cdp, 'touchCancel', []);
    await page.waitForTimeout(400);

    expect(await selectedPart(page)).toBeNull();
  });

  test('a single-finger tap still selects the part under it', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));

    await touch(cdp, 'touchStart', [c]);
    // A finger wanders while it rests: this is inside the touch tolerance and
    // must still read as a tap.
    await touch(cdp, 'touchMove', [{ x: c.x + 3, y: c.y + 2 }]);
    await page.waitForTimeout(16);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);

    expect(await selectedPart(page)).not.toBeNull();
  });

  test('a tap right after a pinch still selects — the guard does not stay armed', async ({ page }) => {
    const c = await load(page);
    const cdp = await page.context().newCDPSession(page);

    await page.evaluate(() =>
      (window as unknown as { __boardStore: { selectPart(i: number | null): void } })
        .__boardStore.selectPart(null));

    await touch(cdp, 'touchStart', [{ x: c.x - 20, y: c.y }]);
    await touch(cdp, 'touchStart', [{ x: c.x - 20, y: c.y }, { x: c.x + 20, y: c.y }]);
    await touch(cdp, 'touchMove', [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }]);
    await page.waitForTimeout(16);
    await touch(cdp, 'touchEnd', [{ x: c.x - 40, y: c.y }]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(300);
    expect(await selectedPart(page)).toBeNull();

    // Re-centre: the pinch zoomed the view, so aim at the part again.
    await page.evaluate((name) =>
      (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(name),
      SUBJECT);
    await page.waitForTimeout(800);
    const b = (await page.locator('canvas').first().boundingBox())!;
    const c2 = { x: b.x + b.width / 2, y: b.y + b.height / 2 };

    await touch(cdp, 'touchStart', [c2]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(400);
    expect(await selectedPart(page)).not.toBeNull();
  });
});
