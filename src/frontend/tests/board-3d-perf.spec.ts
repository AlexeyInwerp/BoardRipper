/**
 * 3D view performance on real boards, on the real GPU (Metal through ANGLE).
 * Opt-in: BR_3D_PERF=1, and boards missing from samples/ are skipped.
 *   BR_3D_PERF=1 npx playwright test tests/board-3d-perf.spec.ts --workers=1
 * Prints per board: parts, triangles, draw calls, build time, the settled frame's
 * cost (full resolution, 4× MSAA, timed to completion with a read-back) and the
 * frame rate actually delivered while moving (the 1× target the drag draws into).
 */
import { test } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = path.resolve(HERE, '../../../samples');
test.use({ launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] }, viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const BOARDS: [string, string][] = [
  ['tomu', path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb')],
  ['m1-xzz', `${R}/3d-compare/m1air/820-02016.pcb`], ['m1-bvr', `${R}/3d-compare/m1air/820-02016.bvr`],
  ['LA-P161', `${R}/LA-P161PR1B.brd`], ['NVIDIA4090', `${R}/cad/NVIDIA4090.cad`],
  ['iMacPro', `${R}/XZZ PCB SAMPLES/A18xx/A1862 820-00967 IMac Pro 27 late 2017/A1862 820-00967.pcb`],
];
type W = { __board3d: { renderer: { drawnParts: number; bench(n: number, pr?: number): Record<string, number>; fps(ms: number, pr?: number, viaLow?: boolean): Promise<{ fps: number; worstMs: number }>; dragBench(ms: number): Promise<Record<string, number>> } } };
for (const [name, file] of BOARDS) test(`3D perf ${name}`, async ({ page }) => {
  test.skip(!process.env.BR_3D_PERF, 'opt-in: BR_3D_PERF=1');
  test.skip(!fs.existsSync(file), `missing ${file}`);
  test.setTimeout(300000);
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', file);
  await page.waitForFunction(() => (window as unknown as { __boardStore?: { board: unknown } }).__boardStore?.board, null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 200000 });
  await page.waitForTimeout(800);
  const settled = await page.evaluate(() => (window as unknown as W).__board3d.renderer.bench(60));
  const moving = await page.evaluate(() => (window as unknown as W).__board3d.renderer.fps(3000, undefined, true));
  const drag = await page.evaluate(() => (window as unknown as W).__board3d.renderer.dragBench(2000));
  console.log(`3D-PERF ${name} parts=${await page.evaluate(() => (window as unknown as W).__board3d.renderer.drawnParts)} ${JSON.stringify({ ...settled, moving, drag })}`);
});
