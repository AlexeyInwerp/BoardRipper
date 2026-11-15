/**
 * Layered board in 3D: a multi-layer file gets a stack — copper per layer in
 * the Layers tab's colours, pours, via barrels, dielectric slices — that
 * X-ray sees through and Explode pulls apart, with the parts riding on the
 * outer faces. Public 4-layer KiCad sample, so it always runs.
 * BR_3D_SHOT=<dir> also writes screenshots for review.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

type Stack = { layers: number; copperMeshes: number; pourMeshes: number; vias: number; slices: number; sideOffset: number; layerY: number[]; partsVisible: boolean; xray: boolean };
type W = { __boardStore: { board: unknown; layerStates: { visible: boolean }[]; toggleLayer(i: number): void }; __board3d?: { renderer: { drawnParts: number; stackInfo(): Stack | null; cameraState(): { dist: number } } } };

async function open3D(page: Page) {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.evaluate(() => localStorage.removeItem('boardripper-view3d'));
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 60000 });
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 60000 });
}
const stack = (page: Page) => page.evaluate(() => (window as unknown as W).__board3d!.renderer.stackInfo());

test('a 4-layer board gets a stack; X-ray and Explode act on it; the Layers tab hides a layer', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open3D(page);
  // the stack is built for every multi-layer board; its copper shows once *Copper layers* is on (off by default)
  await page.getByTestId('board-3d-settings').click(); await page.getByTestId('view3d-copperLayers').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const s0 = (await stack(page))!;
  expect(s0.layers).toBe(4); expect(s0.copperMeshes).toBeGreaterThanOrEqual(2); expect(s0.vias).toBeGreaterThan(100); expect(s0.slices).toBe(3);
  expect(s0.sideOffset).toBe(0); expect(s0.layerY[0]).toBeGreaterThan(s0.layerY[3]);
  expect(s0.xray).toBe(true); // showing the copper layers makes the board see-through on its own
  // the ribbon's parts button cycles solid → ghost → hidden
  await page.getByTestId('board-3d-parts').click(); await page.waitForTimeout(200);
  expect((await stack(page))!.partsVisible).toBe(true);
  if (process.env.BR_3D_SHOT) await page.screenshot({ path: path.join(process.env.BR_3D_SHOT, 'app-3d-parts-ghost.png') });
  await page.getByTestId('board-3d-parts').click(); await page.waitForTimeout(200);
  expect((await stack(page))!.partsVisible).toBe(false);
  await page.getByTestId('board-3d-parts').click(); await page.waitForTimeout(200);
  expect((await stack(page))!.partsVisible).toBe(true);
  const dir = process.env.BR_3D_SHOT;
  // explode: the stack spreads, the faces (and their parts) move apart
  await page.getByTestId('board-3d-settings').click();
  await expect(page.getByTestId('view3d-settings-menu')).toBeVisible();
  await page.getByTestId('view3d-explode').fill('100');
  await expect.poll(() => stack(page).then(s => s!.sideOffset)).toBeGreaterThan(1);
  const s1 = (await stack(page))!;
  expect(s1.layerY[0] - s1.layerY[3]).toBeGreaterThan((s0.layerY[0] - s0.layerY[3]) * 5);
  await expect(page.getByTestId('view3d-xray')).toBeDisabled(); // X-ray is implied while the copper layers show
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  if (dir) await page.screenshot({ path: path.join(dir, 'app-3d-layers-exploded.png') });
  // the Layers tab: hiding layer 2 hides its copper and pours
  const visibleBefore = await page.evaluate(() => (window as unknown as W).__boardStore.layerStates.map(l => l.visible));
  expect(visibleBefore.length).toBe(4);
  await page.evaluate(() => (window as unknown as W).__boardStore.toggleLayer(1));
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__boardStore.layerStates[1].visible)).toBe(!visibleBefore[1]);
  await page.waitForTimeout(300);
  if (dir) await page.screenshot({ path: path.join(dir, 'app-3d-layers-toggled.png') });
  expect(errors).toEqual([]);
});
