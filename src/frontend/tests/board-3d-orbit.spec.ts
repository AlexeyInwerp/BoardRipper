/**
 * Turning the board in 3D follows the pointer from either face: the same drag
 * spins the picture the same way seen from above (Top) and from underneath
 * (Bottom), where the board is seen mirrored. And a pan moves the board by
 * exactly the pointer's travel at any interface scale. Public KiCad sample.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
type R = { drawnParts: number; view(p: 'top' | 'bottom' | 'iso', animate?: boolean): void; turnBy(dx: number, dy: number, pivot: { x: number; y: number; z: number }): void; screenOf(i: number): [number, number] | null; part(i: number): unknown; panBy(dx: number, dy: number): void; cameraState(): { dist: number; target: number[] } };
type W = { __boardStore: { board: { parts: { pins: unknown[] }[] } }; __board3d?: { renderer: R } };

async function open3D(page: Page) {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 60000 });
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 60000 });
}
/** The signed screen angle swept by the vector between two drawn parts under a horizontal drag about the board centre. */
const sweep = (page: Page, preset: 'top' | 'bottom') => page.evaluate(preset => {
  const w = window as unknown as W; const R = w.__board3d!.renderer; const drawn: number[] = []; w.__boardStore.board.parts.forEach((_, i) => { if (R.part(i)) drawn.push(i); });
  R.view(preset, false); const THREEPivot = { x: 0, y: 0, z: 0 };
  const [a, b] = [drawn[0], drawn[drawn.length - 1]]; const a0 = R.screenOf(a)!, b0 = R.screenOf(b)!;
  R.turnBy(60, 0, THREEPivot);
  const a1 = R.screenOf(a)!, b1 = R.screenOf(b)!;
  const ang = (p: number[], q: number[]) => Math.atan2(q[1] - p[1], q[0] - p[0]);
  let d = ang(a1, b1) - ang(a0, b0); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d;
}, preset);

test('a horizontal drag spins the picture the same way from above and from underneath', async ({ page }) => {
  await open3D(page);
  const top = await sweep(page, 'top'), bottom = await sweep(page, 'bottom');
  expect(Math.abs(top)).toBeGreaterThan(0.1);
  expect(Math.sign(top)).toBe(Math.sign(bottom));
});

test('a pan moves the board by the pointer travel at 125 % interface scale too', async ({ page }) => {
  await page.goto('/'); await page.evaluate(() => localStorage.setItem('boardripper-ui-scale', '1.25'));
  await open3D(page);
  const r = await page.evaluate(() => {
    const R = (window as unknown as W).__board3d!.renderer; R.view('top', false);
    const cv = document.querySelector('.board-3d-canvas') as HTMLCanvasElement; const rect = cv.getBoundingClientRect();
    const c0 = R.cameraState(); R.panBy(200, 0); const c1 = R.cameraState();
    const perPx = 2 * c0.dist * Math.tan(35 * Math.PI / 360) / rect.height; // the on-screen pixel, not the CSS one
    return { moved: Math.hypot(c1.target[0] - c0.target[0], c1.target[2] - c0.target[2]), expected: perPx * 200, zoomed: rect.height / cv.clientHeight };
  });
  expect(r.moved).toBeCloseTo(r.expected, 3);
});
