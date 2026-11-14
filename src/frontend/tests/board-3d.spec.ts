/**
 * 3D view (three3d/): the ribbon's cube button swaps a board tab to 3D, parts
 * are drawn from the package estimator, and a click in 3D selects through the
 * ordinary store action — so the 2D view and the sidebar follow. Back to 2D
 * removes the WebGL view. Public KiCad sample, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
// headless Chromium gives three.js no WebGL 2 context without SwiftShader
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

async function openBoard(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as { __boardStore?: { board: unknown } }).__boardStore?.board, null, { timeout: 30000 });
}

type W = { __board3d?: { renderer: { drawnParts: number; screenOf(i: number): [number, number] | null; part(i: number): { name: string; est: { family: string } } | undefined } }; __boardStore?: { selection: { partIndex: number | null }; board: { parts: { name: string; pins: unknown[] }[] } } };

test('3D view: toggle, draws estimated parts, a click selects, back to 2D', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await expect(page.getByTestId('board-3d')).toBeVisible();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  const drawn = await page.evaluate(() => (window as unknown as W).__board3d!.renderer.drawnParts);
  expect(drawn).toBeGreaterThan(20);   // tomu-fpga: 52 parts, test points draw nothing
  await expect(page.locator('.board-3d-canvas')).toHaveCount(1);

  // click the biggest part (the FPGA) from straight above, where nothing covers it
  await page.getByTestId('board-3d-top').click();
  await page.waitForTimeout(700);
  const target = await page.evaluate(() => {
    const w = window as unknown as W; const parts = w.__boardStore!.board.parts;
    let best = -1; parts.forEach((p, i) => { if (w.__board3d!.renderer.part(i) && (best < 0 || p.pins.length > parts[best].pins.length)) best = i; });
    return { index: best, xy: w.__board3d!.renderer.screenOf(best) };
  });
  expect(target.xy).not.toBeNull();
  await page.mouse.click(target.xy![0], target.xy![1]);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__boardStore!.selection.partIndex)).toBe(target.index);

  await page.getByTestId('view3d-btn').click();
  await expect(page.getByTestId('board-3d')).toHaveCount(0);
  expect(errors).toEqual([]);
});
