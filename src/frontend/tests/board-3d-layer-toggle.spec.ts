/**
 * The Layers tab's on/off dot switches the same layer in 3D. The tab speaks the file's layer order; the 3D stack is
 * ordered from the user's Top and reads a primary-bottom board upside down, so a missing mapping toggled another layer
 * (2026-11-17). Public 4-layer KiCad sample, and the primary-bottom Allegro LA-P161P when it is present.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARDS = [path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb'), path.resolve(HERE, '../../../samples/LA-P161PR1B.brd')];
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
test.describe.configure({ timeout: 300000 });
type W = { __boardStore: { board: { primarySide?: string }; layerStates: { name: string; visible: boolean }[] }; __board3d?: { renderer: { drawnParts: number; layerVisibility(): { name: string; visible: boolean }[] } } };

async function open3D(page: Page, file: string) {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.evaluate(() => localStorage.setItem('boardripper-view3d', JSON.stringify({ copperLayers: true })));
  await page.reload(); await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', file);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 240000 });
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 240000 });
  await page.locator('.board-sidebar-toggle').click();
  await page.locator('[data-board-tab="layers"]').click();
}
const state = (page: Page) => page.evaluate(() => { const w = window as unknown as W; return { tab: w.__boardStore.layerStates.map(l => ({ name: l.name, visible: l.visible })), view: w.__board3d!.renderer.layerVisibility() }; });

for (const file of BOARDS) {
  test(`each layer dot switches the same layer in 3D — ${path.basename(file)}`, async ({ page }) => {
    test.skip(!fs.existsSync(file), 'sample not present');
    await open3D(page, file);
    const dots = page.locator('.layer-list-container .layer-visibility');
    const n = await dots.count(); expect(n).toBeGreaterThan(1);
    for (let i = 0; i < n; i++) {
      await dots.nth(i).click(); await page.waitForTimeout(200);
      const s = await state(page);
      for (const v of s.view) expect(v.visible, `${v.name} after hiding row ${i}`).toBe(s.tab.find(t => t.name === v.name)!.visible);
      expect(s.view.find(v => v.name === s.tab[i].name)!.visible).toBe(false);
      await dots.nth(i).click(); await page.waitForTimeout(200);
      expect((await state(page)).view.every(v => v.visible)).toBe(true);
    }
  });
}
