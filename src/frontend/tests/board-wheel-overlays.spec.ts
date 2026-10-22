/**
 * Scrolling over the board panel's overlays still moves the board, and the
 * minimap only drives the view when the drag began on it (2026-10-22).
 *
 * The ribbon, the minimap and the slide sheet are siblings of the canvas
 * host, so a wheel that drifted onto one never reached pixi-viewport: "the
 * scroll stops when the mouse goes beyond the rendering area". And the map
 * fades in under the very pan being made, then took any pointermove with a
 * button down as a drag of its own: "jumps as if the map were being used".
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');

type Win = { __boardRenderer?: { viewport: { x: number; y: number } } };
const pose = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as Win).__boardRenderer!;
  return { x: r.viewport.x, y: r.viewport.y };
});

async function load(page: Page) {
  test.skip(!fs.existsSync(BOARD), 'needs samples/kicad/tomu-fpga.kicad_pcb');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.locator('.dv-tab', { hasText: 'tomu-fpga' })).toBeVisible({ timeout: 20000 });
  await expect.poll(() => page.evaluate(() => !!(window as unknown as Win).__boardRenderer), { timeout: 15000 }).toBe(true);
  await page.waitForTimeout(800);
}

test('Shift+wheel over the ribbon pans the board', async ({ page }) => {
  await load(page);
  const bar = (await page.locator('.board-status-indicators').boundingBox())!;
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  const before = await pose(page);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 60);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  const after = await pose(page);
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(50);
});

test('a board drag that crosses the minimap does not jump to the map point; a wheel over it pans', async ({ page }) => {
  await load(page);
  // Slide mode keeps the minimap up.
  await page.getByTestId('slide-mode-toggle').click();
  // The select tool: a press on the empty board pans (the arrow tool draws).
  await page.getByTestId('slide-tool-select').click();
  const map = page.getByTestId('board-minimap');
  await expect(map).toHaveAttribute('data-visible', 'true');
  const m = (await map.boundingBox())!;
  const canvas = (await page.locator('.board-panel-canvas').boundingBox())!;

  // Drag from the board, through the map, out the other side.
  const y = m.y + m.height / 2;
  const x0 = Math.max(canvas.x + 20, m.x - 120), x1 = m.x + m.width + 60;
  await page.mouse.move(x0, y);
  const before = await pose(page);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) { await page.mouse.move(x0 + ((x1 - x0) * i) / 12, y); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await pose(page);
  // The board moved with the pointer, not to wherever the map was touched.
  expect(after.x - before.x).toBeGreaterThan((x1 - x0) * 0.6);
  expect(after.x - before.x).toBeLessThan((x1 - x0) * 1.4);
  expect(Math.abs(after.y - before.y)).toBeLessThan(40);

  // A wheel over the map scrolls the board.
  await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2);
  const p0 = await pose(page);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 60);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  const p1 = await pose(page);
  expect(Math.hypot(p1.x - p0.x, p1.y - p0.y)).toBeGreaterThan(50);

  // A click on the map still recentres.
  const q0 = await pose(page);
  await page.mouse.click(m.x + 4, m.y + 4);
  await page.waitForTimeout(300);
  const q1 = await pose(page);
  expect(Math.hypot(q1.x - q0.x, q1.y - q0.y)).toBeGreaterThan(20);
});

test('a mouse drag keeps panning after the pointer leaves the board panel, until the button is released', async ({ page }) => {
  await load(page);
  const canvas = (await page.locator('.board-panel-canvas').boundingBox())!;
  const toolbar = (await page.getByTestId('toolbar').boundingBox())!;
  // From the middle of the board straight up onto the app toolbar, well
  // outside the panel, and on from there.
  const x0 = canvas.x + canvas.width / 2, y0 = canvas.y + canvas.height / 2;
  const y1 = toolbar.y + toolbar.height / 2;
  const dx = 180;
  await page.mouse.move(x0, y0);
  const before = await pose(page);
  await page.mouse.down();
  const steps = 16;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x0 + (dx * i) / steps, y0 + ((y1 - y0) * i) / steps);
    await page.waitForTimeout(16);
  }
  // Still outside: more travel must still move the board.
  const mid = await pose(page);
  for (let i = 1; i <= 6; i++) { await page.mouse.move(x0 + dx + i * 20, y1); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await pose(page);
  expect(after.x - before.x).toBeGreaterThan((dx + 120) * 0.8);
  expect(after.x - mid.x).toBeGreaterThan(120 * 0.6);
  expect(before.y - after.y).toBeGreaterThan((y0 - y1) * 0.8);
});
