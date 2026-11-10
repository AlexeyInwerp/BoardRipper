/**
 * The minimap header under rotation and Butterfly: the map takes the board's
 * shape, so a turn changes its width. Whatever the angle, every header button
 * stays inside the map on one row, the map stays inside the board panel, and
 * the trail keeps marking the visited parts.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARDS = [
  path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb'),
  path.resolve(HERE, '../../../samples/kicad/starfish.kicad_pcb'),
].filter(f => fs.existsSync(f));
const SHOTS = process.env.MINIMAP_SHOTS;

type B = { board: { parts: { name: string }[] }; selectPart(i: number | null): void; setRotation(d: number): void; toggleButterfly(): void; butterfly: boolean };

async function checkLayout(page: Page, label: string) {
  const map = page.getByTestId('board-minimap');
  await page.waitForTimeout(250);                       // repaint + resize settle
  const m = (await map.boundingBox())!;
  const panel = (await page.locator('.board-panel-root').first().boundingBox())!;
  expect(m.x, `${label}: map left inside panel`).toBeGreaterThanOrEqual(panel.x - 1);
  expect(m.x + m.width, `${label}: map right inside panel`).toBeLessThanOrEqual(panel.x + panel.width + 1);
  const head = page.getByTestId('minimap-head');
  const h = (await head.boundingBox())!;
  const fits = await head.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
  expect(fits, `${label}: header does not overflow`).toBe(true);
  for (const id of ['minimap-history-back', 'minimap-history-forward', 'minimap-nav-history', 'minimap-nav-worklist', 'minimap-open-tab']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x, `${label}: ${id} left`).toBeGreaterThanOrEqual(m.x - 0.5);
    expect(b.x + b.width, `${label}: ${id} right`).toBeLessThanOrEqual(m.x + m.width + 0.5);
    // One row: every button vertically inside the header strip.
    expect(b.y, `${label}: ${id} top`).toBeGreaterThanOrEqual(h.y - 0.5);
    expect(b.y + b.height, `${label}: ${id} bottom`).toBeLessThanOrEqual(h.y + h.height + 0.5);
  }
  // The canvas sits under the header, inside the map.
  const c = (await map.locator('canvas').boundingBox())!;
  expect(c.y).toBeGreaterThanOrEqual(h.y + h.height - 0.5);
  expect(c.x).toBeGreaterThanOrEqual(m.x - 0.5);
  expect(c.x + c.width).toBeLessThanOrEqual(m.x + m.width + 0.5);
  if (SHOTS) await map.screenshot({ path: `${SHOTS}/${label}.png` });
}

for (const file of BOARDS) {
  test(`header layout holds under rotation and Butterfly — ${path.basename(file)}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.setInputFiles('[data-testid="file-input"]', file);
    const map = page.getByTestId('board-minimap');
    await expect(map).toHaveAttribute('data-visible', 'true');
    await page.evaluate(() => {
      const b = (window as unknown as { __boardStore: B }).__boardStore;
      for (const i of [0, Math.floor(b.board.parts.length / 2)]) b.selectPart(i);
    });
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    for (const deg of [0, 90, 180, 270, 37]) {
      await page.evaluate(d => (window as unknown as { __boardStore: B }).__boardStore.setRotation(d), deg);
      await checkLayout(page, `${stem}-rot${deg}`);
      expect(Number(await map.getAttribute('data-trail'))).toBeGreaterThan(0);
    }
    await page.evaluate(() => { const b = (window as unknown as { __boardStore: B }).__boardStore; b.setRotation(90); if (!b.butterfly) b.toggleButterfly(); });
    await checkLayout(page, `${stem}-butterfly90`);
    await page.getByTestId('minimap-nav-worklist').click();
    await checkLayout(page, `${stem}-butterfly90-worklist`);
    expect(errors).toEqual([]);
  });
}
