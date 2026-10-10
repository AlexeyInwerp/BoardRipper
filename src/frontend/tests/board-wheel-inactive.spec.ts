/**
 * Wheel over a board that is not the active panel (a PDF beside it is).
 *
 * An inactive board's renderer is paused; a wheel event has to wake it
 * (#6). The wake listener sits on the canvas, and since the smooth wheel
 * zoom (2026-07-19) our own capture handler on the container takes every
 * zoom-bound wheel and stops it — so with the wheel set to zoom, the most
 * common mouse setup, the event never reached the wake and the board sat
 * still. Each case here leaves the board paused first, then scrolls over it.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const PDF = path.resolve(HERE, 'fixtures/two-page-text.pdf');

async function setup(page: Page, settings: Record<string, unknown>) {
  await page.addInitScript((s) => {
    try {
      const raw = localStorage.getItem('boardripper-render-settings');
      localStorage.setItem('boardripper-render-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), ...s }));
      localStorage.setItem('boardripper-scroll-slots-v2', '1');
    } catch { /* ignore */ }
  }, settings);
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', BOARD);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __boardRenderer?: { activeScene?: unknown } }).__boardRenderer?.activeScene), { timeout: 15000 }).toBe(true);
  await page.setInputFiles('[data-testid="file-input"]', PDF);
  await expect(page.locator('.pdf-canvas-container').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('board-canvas')).toBeVisible();
}

const pose = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __boardRenderer: { viewport: { x: number; y: number; scale: { x: number } } } }).__boardRenderer;
  return { s: r.viewport.scale.x, x: r.viewport.x, y: r.viewport.y };
});

/** Pause the board as losing the active panel does, then scroll over it. */
async function wheelOverPausedBoard(page: Page, opts: { shift?: boolean } = {}) {
  // Pause, and count the frames actually drawn from here on: a pose that
  // changes while nothing renders is the bug, not a fix.
  await page.evaluate(() => {
    const w = window as unknown as { __boardRenderer: { pause(): void; app: { render(): void } }; __renders: number };
    const r = w.__boardRenderer;
    r.pause();
    w.__renders = 0;
    const orig = r.app.render.bind(r.app);
    r.app.render = () => { w.__renders++; orig(); };
  });
  const box = (await page.getByTestId('board-canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await pose(page);
  if (opts.shift) await page.keyboard.down('Shift');
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(40); }
  if (opts.shift) await page.keyboard.up('Shift');
  await page.waitForTimeout(500);
  const renders = await page.evaluate(() => (window as unknown as { __renders: number }).__renders);
  expect(renders).toBeGreaterThan(0);
  return { before, after: await pose(page) };
}

test.describe('wheel over a board that is not the active panel', () => {
  test('wheel bound to zoom: the board zooms', async ({ page }) => {
    await setup(page, { twoFingerPan: false, smoothZoom: true, wheelDetection: false });
    const { before, after } = await wheelOverPausedBoard(page);
    expect(after.s).toBeGreaterThan(before.s * 1.05);
  });

  test('wheel bound to pan: the board pans', async ({ page }) => {
    await setup(page, { twoFingerPan: true, wheelDetection: false });
    const { before, after } = await wheelOverPausedBoard(page);
    expect(Math.abs(after.y - before.y)).toBeGreaterThan(100);
  });

  test('Shift+wheel (a modifier slot): the board moves', async ({ page }) => {
    await setup(page, { twoFingerPan: false, smoothZoom: true, wheelDetection: false, wheelShiftAction: 'pan' });
    const { before, after } = await wheelOverPausedBoard(page, { shift: true });
    expect(Math.abs(after.y - before.y) + Math.abs(after.x - before.x)).toBeGreaterThan(100);
  });
});
