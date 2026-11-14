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

type Cam = { dist: number; target: [number, number, number]; leftDrag: 'orbit' | 'pan' };
type W = { __board3d?: { renderer: { cameraState(): Cam; drawnParts: number; screenOf(i: number): [number, number] | null; part(i: number): { name: string; est: { family: string } } | undefined } }; __boardStore?: { selection: { partIndex: number | null }; board: { parts: { name: string; pins: unknown[] }[] } } };

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

test('3D view: zoom, pan and drag-mode controls', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const cam = () => page.evaluate(() => (window as unknown as W).__board3d!.renderer.cameraState());
  const d0 = (await cam()).dist;
  await page.getByTestId('board-3d-zoom-in').click(); await page.waitForTimeout(600);
  const d1 = (await cam()).dist; expect(d1).toBeLessThan(d0 * 0.8);
  await page.getByTestId('board-3d-zoom-out').click(); await page.waitForTimeout(600);
  expect((await cam()).dist).toBeGreaterThan(d1 * 1.2);
  const t0 = (await cam()).target;
  await page.getByTestId('board-3d-pan-right').click(); await page.waitForTimeout(600);
  const t1 = (await cam()).target; expect(Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2])).toBeGreaterThan(0.5);
  await page.getByTestId('board-3d-fit').click(); await page.waitForTimeout(600);
  expect(Math.hypot(...(await cam()).target)).toBeLessThan(0.01);
  // keys while the pointer is over the view
  const box = (await page.locator('.board-3d-host').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const d2 = (await cam()).dist; await page.keyboard.press('+'); await page.waitForTimeout(600);
  expect((await cam()).dist).toBeLessThan(d2 * 0.8);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(600);
  expect(Math.hypot(...(await cam()).target)).toBeGreaterThan(0.5);
  expect((await cam()).leftDrag).toBe('orbit');
  await page.getByTestId('board-3d-drag-mode').click();
  expect((await cam()).leftDrag).toBe('pan');
});
