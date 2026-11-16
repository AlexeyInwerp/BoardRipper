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
test.describe.configure({ timeout: 240000 });

type Stack = { layers: number; copperMeshes: number; pourMeshes: number; vias: number; slices: number; sideOffset: number; layerY: number[]; partsVisible: boolean; xray: boolean; litNetId: number; litOnly: boolean; copperGroupsVisible: number; minTraceWidth: number; viaRadius: number; viaOpacity: number; litVias: number; litViaOpacity: number };
type W = { __boardStore: { board: { parts: { name: string; pins: { net: string }[] }[]; traces: { net: string; layer?: number; start: { x: number; y: number }; end: { x: number; y: number }; width: number }[] }; layerStates: { visible: boolean }[]; toggleLayer(i: number): void; highlightNet(n: string | null): void; setPartOverride(n: string, m: 'hide' | null): void; selectPart(i: number | null): void }; __board3d?: { renderer: { drawnParts: number; stackInfo(): Stack | null; cameraState(): { dist: number }; part(i: number): unknown; screenOf(i: number): [number, number] | null; project(p: [number, number, number]): [number, number]; view(p: string, a?: boolean): void; partsMode(): string } } };

/** three.js reports a shader that does not compile on the console and simply draws nothing: a GLSL typo passed every
 *  uniform-level check (2026-11-16). Every test here fails on such an error. */
const shaderErrors = new WeakMap<Page, string[]>();
async function open3D(page: Page) {
  const errs: string[] = []; shaderErrors.set(page, errs);
  page.on('console', m => { const t = m.text(); if (/Shader Error|WebGLProgram|ERROR: 0:/.test(t)) errs.push(t.slice(0, 300)); });
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.evaluate(() => localStorage.removeItem('boardripper-view3d'));
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 180000 }); // the first load after an edit pays Vite's re-transform of the three.js chunk
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 180000 }); // the first load after an edit pays Vite's re-transform of the three.js chunk
}
test.afterEach(async ({ page }) => { expect(shaderErrors.get(page) ?? []).toEqual([]); });
const stack = (page: Page) => page.evaluate(() => (window as unknown as W).__board3d!.renderer.stackInfo());

test('a 4-layer board gets a stack; X-ray and Explode act on it; the Layers tab hides a layer', async ({ page }) => {
  test.setTimeout(120000);
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

test('the lit net reaches the copper: on a plain board only its traces show, with the layers on they stand out', async ({ page }) => {
  await open3D(page);
  const net = await page.evaluate(() => { const b = (window as unknown as W).__boardStore.board; const counts = new Map<string, number>(); for (const t of b.traces) counts.set(t.net, (counts.get(t.net) ?? 0) + 1); return [...counts.entries()].filter(([n]) => n && !/GND|VCC|3V3|1V2/.test(n)).sort((a, b) => b[1] - a[1])[0][0]; });
  expect((await stack(page))!.copperGroupsVisible).toBe(0); // copper layers off: nothing of the stack shows
  await page.evaluate(n => (window as unknown as W).__boardStore.highlightNet(n), net);
  await expect.poll(() => stack(page).then(s => s!.litNetId)).toBeGreaterThan(0);
  const lit = (await stack(page))!; expect(lit.litOnly).toBe(true); expect(lit.copperGroupsVisible).toBeGreaterThan(0);
  await page.getByTestId('board-3d-settings').click(); await page.getByTestId('view3d-copperLayers').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const on = (await stack(page))!; expect(on.litOnly).toBe(false); expect(on.litNetId).toBe(lit.litNetId); expect(on.copperGroupsVisible).toBe(4);
  if (process.env.BR_3D_SHOT) await page.screenshot({ path: path.join(process.env.BR_3D_SHOT, 'app-3d-lit-net.png') });
});

test('a part hidden from the right-click menu leaves the 3D scene; the build shows its progress', async ({ page }) => {
  await open3D(page);
  const before = await page.evaluate(() => (window as unknown as W).__board3d!.renderer.drawnParts);
  // the right-click menu on a body opens the same menu as 2D
  await page.getByTestId('board-3d-top').click(); await page.waitForTimeout(700);
  const target = await page.evaluate(() => { const w = window as unknown as W; const parts = w.__boardStore.board.parts; let best = -1; parts.forEach((p, i) => { if (w.__board3d!.renderer.part(i) && (best < 0 || p.pins.length > parts[best].pins.length)) best = i; }); return { i: best, name: parts[best].name, xy: w.__board3d!.renderer.screenOf(best)! }; });
  await page.mouse.click(target.xy[0], target.xy[1], { button: 'right' });
  await expect(page.getByTestId('context-menu-header').first()).toBeVisible();
  await expect(page.getByTestId('context-menu-header').first()).toContainText(target.name);
  await page.keyboard.press('Escape');
  // hiding rebuilds the scene without the part, and the progress card shows while it does
  await page.evaluate(n => (window as unknown as W).__boardStore.setPartOverride(n, 'hide'), target.name);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__board3d!.renderer.drawnParts), { timeout: 30000 }).toBe(before - 1);
  await expect(page.getByTestId('board-3d-progress')).toHaveCount(0);
  expect(await page.evaluate(i => !!(window as unknown as W).__board3d!.renderer.part(i), target.i)).toBe(false);
  await page.evaluate(n => (window as unknown as W).__boardStore.setPartOverride(n, null), target.name);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__board3d!.renderer.drawnParts), { timeout: 30000 }).toBe(before);
});

test('vias: no wider than twice the thinnest trace, faint when unlit, flashing on the lit net', async ({ page }) => {
  await open3D(page);
  await page.getByTestId('board-3d-settings').click(); await page.getByTestId('view3d-copperLayers').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const s0 = (await stack(page))!;
  expect(s0.viaRadius).toBeLessThanOrEqual(s0.minTraceWidth + 1e-6); // diameter ≤ 2 × the thinnest trace
  expect(s0.viaOpacity).toBeLessThanOrEqual(0.3); expect(s0.litVias).toBe(0);
  const net = await page.evaluate(() => { const b = (window as unknown as W).__boardStore.board; const byNet = new Map<string, number>(); for (const t of b.traces) byNet.set(t.net, (byNet.get(t.net) ?? 0) + 1); return [...byNet.entries()].filter(([n]) => n && !/GND|VCC|3V3|1V2/.test(n)).sort((a, b) => b[1] - a[1])[0][0]; });
  await page.evaluate(n => (window as unknown as W).__boardStore.highlightNet(n), net);
  await expect.poll(() => stack(page).then(s => s!.litVias)).toBeGreaterThan(0);
  const seen = new Set<number>(); for (let i = 0; i < 10; i++) { seen.add(Math.round((await stack(page))!.litViaOpacity * 100)); await page.waitForTimeout(120); }
  expect(seen.size).toBeGreaterThan(1); // the lit vias flash
  // the size slider is a multiple of the thinnest trace
  await page.getByTestId('board-3d-settings').click(); await page.getByTestId('view3d-viaScale').fill('200'); await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  const r2 = (await stack(page))!.viaRadius; // a via limited by its own drill does not grow; none passes twice the cap
  expect(r2).toBeGreaterThanOrEqual(s0.viaRadius - 1e-6); expect(r2).toBeLessThanOrEqual(s0.minTraceWidth * 2 + 1e-6);
});

test('a click on an inner layer\'s trace lights its net, and the lit trace is the highlight', async ({ page }) => {
  await open3D(page);
  await page.getByTestId('board-3d-settings').click(); await page.getByTestId('view3d-copperLayers').click(); await page.keyboard.press('Escape');
  await page.evaluate(() => (window as unknown as W).__board3d!.renderer.view('top', false)); await page.waitForTimeout(400);
  // the longest segment on an inner layer whose cell holds nothing else of another net, by the model's own geometry
  const pick = await page.evaluate(() => {
    const R = (window as unknown as W).__board3d!.renderer; const info = R.stackInfo()!; const m = (R as unknown as { model: { copper: { layer: number; x1: number; z1: number; x2: number; z2: number; w: number; net: string }[] } }).model;
    const inner = m.copper.filter(c => c.layer === 1 && c.net).sort((a, b) => Math.hypot(b.x2 - b.x1, b.z2 - b.z1) - Math.hypot(a.x2 - a.x1, a.z2 - a.z1))[0];
    const mid: [number, number, number] = [(inner.x1 + inner.x2) / 2, info.layerY[1], (inner.z1 + inner.z2) / 2];
    return { net: inner.net, xy: R.project(mid) };
  });
  await page.mouse.click(pick.xy[0], pick.xy[1]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __boardStore: { selection: { highlightedNet: string | null } } }).__boardStore.selection.highlightedNet)).toBe(pick.net);
  // everything else steps back: parts ghosted while the net is lit, back to solid when it is not
  expect(await page.evaluate(() => (window as unknown as W).__board3d!.renderer.partsMode())).toBe('solid'); // the setting stays solid…
  const ghosted = await page.evaluate(() => { const R = (window as unknown as { __board3d: { renderer: { partsRoot?: unknown } } }).__board3d.renderer as unknown as { partsRoot: { children: { material?: { opacity?: number; transparent?: boolean } }[] } }; return R.partsRoot.children.some(c => c.material?.transparent && (c.material.opacity ?? 1) < 0.3); });
  expect(ghosted).toBe(true); // …but the bodies draw ghosted
  await page.evaluate(() => (window as unknown as W).__boardStore.highlightNet(null)); await page.waitForTimeout(200);
  const solid = await page.evaluate(() => { const R = (window as unknown as { __board3d: { renderer: unknown } }).__board3d.renderer as unknown as { partsRoot: { children: { material?: { opacity?: number; transparent?: boolean } }[] } }; return R.partsRoot.children.every(c => !c.material?.transparent || (c.material.opacity ?? 1) >= 0.9); });
  expect(solid).toBe(true);
});
