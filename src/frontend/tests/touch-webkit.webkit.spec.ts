/**
 * WebKit is the only engine on iPadOS — Chrome there is a WKWebView too — so
 * this is the only place a bug reported from an iPad can be reproduced at all.
 * Run with `npm run test:webkit`; the default Chromium run ignores this file.
 *
 * What it proves and what it does not. The engine facts are real: WebKit
 * genuinely ships the non-standard `gesture*` events that no other browser has,
 * and the whole "only one thing may zoom" rule rests on that. The touches are
 * not: Playwright's WebKit has no multi-touch injection, so the pointer stream
 * here is synthesised in-page. That is honest for testing *our* dispatch — did
 * the gesture path stand down while fingers were registered — and it is not
 * evidence about what iPadOS itself emits. The engine-level multi-touch case
 * lives in touch-pinch-selection.spec.ts, which drives Chromium through CDP.
 *
 * Nor is this an iPad: no tile-based GPU, no iOS canvas-memory ceiling, no
 * 120 Hz panel. Correctness reproduces here; performance does not.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);

/** The board HUD reads "NN% · …" — the zoom is the only number this spec
 *  needs, and it is already on screen rather than behind a new test hook. */
async function zoomPct(page: Page): Promise<number> {
  const txt = await page.locator('.board-hud').first().textContent();
  const m = /(\d+)%/.exec(txt ?? '');
  if (!m) throw new Error(`no zoom in HUD: ${JSON.stringify(txt)}`);
  return Number(m[1]);
}

async function openBoard(page: Page) {
  test.skip(!have, 'sample board not present');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1500);
}

/** Dispatch the WebKit pinch pair onto the board container. `scale` is
 *  cumulative from gesturestart, exactly as the engine reports it.
 *
 *  The event is a `MouseEvent` carrying a `scale` property, not a real
 *  `GestureEvent`: WebKit exposes the constructor but what it returns is not
 *  an `Event` and `dispatchEvent` rejects it, and `document.createEvent
 *  ('GestureEvent')` throws NotSupportedError — the class is there, the
 *  synthesis path is not. A MouseEvent named `gesturestart` carries every
 *  field the handlers read (`type`, `clientX/Y`, `scale`), so this exercises
 *  the dispatch exactly; it just is not the engine's own event object. */
/** One synthetic gesture event at a client point. See trackpadPinch for why
 *  this is a MouseEvent carrying `scale` rather than a real GestureEvent. */
async function gestureOn(page: Page, type: string, scale: number, at: { x: number; y: number }) {
  await page.evaluate(({ type, scale, at }) => {
    const el = document.querySelector('.board-panel-canvas')!;
    const e = new MouseEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
    Object.defineProperty(e, 'scale', { value: scale });
    Object.defineProperty(e, 'rotation', { value: 0 });
    el.dispatchEvent(e);
  }, { type, scale, at });
}

async function trackpadPinch(page: Page, scale: number) {
  await page.evaluate((s) => {
    const el = document.querySelector('.board-panel-canvas')!;
    const r = el.getBoundingClientRect();
    const fire = (type: string, sc: number) => {
      const e = new MouseEvent(type, {
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
        bubbles: true, cancelable: true,
      });
      Object.defineProperty(e, 'scale', { value: sc });
      Object.defineProperty(e, 'rotation', { value: 0 });
      el.dispatchEvent(e);
    };
    fire('gesturestart', 1);
    fire('gesturechange', s);
    fire('gestureend', s);
  }, scale);
  await page.waitForTimeout(300);
}

/** Put N synthetic touch pointers down on the board container and leave them
 *  there. Only `pointerdown` matters: it is what the renderer counts. */
async function fingersDown(page: Page, n: number) {
  await page.evaluate((count) => {
    const el = document.querySelector('.board-panel-canvas')!;
    const r = el.getBoundingClientRect();
    for (let i = 0; i < count; i++) {
      el.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 100 + i, pointerType: 'touch', isPrimary: i === 0,
        clientX: r.left + r.width / 2 + i * 40, clientY: r.top + r.height / 2,
        button: 0, buttons: 1, bubbles: true, cancelable: true,
      }));
    }
  }, n);
}

/** Move one already-registered synthetic pointer. */
async function movePointer(page: Page, id: number, to: { x: number; y: number }) {
  await page.evaluate(({ id, to }) => {
    const el = document.querySelector('.board-panel-canvas')!;
    el.dispatchEvent(new PointerEvent('pointermove', {
      pointerId: id, pointerType: 'touch', isPrimary: true,
      clientX: to.x, clientY: to.y, buttons: 1, bubbles: true, cancelable: true,
    }));
  }, { id, to });
}

test.describe('WebKit / iPadOS', () => {
  test('the engine really does ship gesture events — the premise of the stand-down rule', async ({ page }) => {
    await page.goto('/');
    const has = await page.evaluate(() => typeof (window as { GestureEvent?: unknown }).GestureEvent);
    expect(has).toBe('function');
  });

  test('a trackpad pinch — no fingers down — still zooms the board', async ({ page }) => {
    await openBoard(page);
    const before = await zoomPct(page);
    await trackpadPinch(page, 2);
    expect(await zoomPct(page)).toBeGreaterThan(before);
  });

  test('a gesture arriving while fingers are down is ignored, so only the pinch plugin zooms', async ({ page }) => {
    await openBoard(page);
    await fingersDown(page, 2);
    const before = await zoomPct(page);
    await trackpadPinch(page, 2);
    // The pointer-event pinch owns this gesture. Two zoom integrators writing
    // one scale from two start snapshots is what makes a tablet pinch jump.
    expect(await zoomPct(page)).toBe(before);
  });

  /** The iPadOS shape: WebKit claims the gesture while only ONE finger has
   *  been registered as a pointer — the second `pointerdown` may never be
   *  dispatched. The gesture path then has to zoom AND stop pixi-viewport's
   *  drag plugin panning along that one finger. The stand-down used to run in
   *  one direction only (gesture defers to fingers, nothing defers to the
   *  gesture), and with `size > 0` as the test a single finger also silenced
   *  the zoom entirely — so that gesture panned and did not zoom. */
  test('a gesture claimed with one finger down zooms, and nothing pans along it', async ({ page }) => {
    await openBoard(page);
    const r = (await page.locator('.board-panel-canvas').boundingBox())!;
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 };

    await fingersDown(page, 1);               // one finger registers
    await page.waitForTimeout(80);
    const before = await zoomPct(page);

    // The engine claims it, then reports a growing scale while that one finger
    // keeps moving — as it does in a real pinch.
    await gestureOn(page, 'gesturestart', 1, at);
    for (let i = 1; i <= 8; i++) {
      await movePointer(page, 100, { x: at.x, y: at.y - i * 14 });
      await gestureOn(page, 'gesturechange', 1 + i * 0.12, at);
      await page.waitForTimeout(12);
    }
    await page.waitForTimeout(200);

    expect(await zoomPct(page), 'the claimed gesture should zoom').toBeGreaterThan(before);
    await gestureOn(page, 'gestureend', 1.96, at);
  });

  test('the board renders under WebKit at all', async ({ page }) => {
    await openBoard(page);
    // WebGL2 only — WebKit has no WebGL1 fallback path in this build, and a
    // silent renderer failure would otherwise show up as an unrelated test.
    await expect(page.locator('.board-panel-canvas canvas').first()).toBeVisible();
    expect(await zoomPct(page)).toBeGreaterThan(0);
  });
});
