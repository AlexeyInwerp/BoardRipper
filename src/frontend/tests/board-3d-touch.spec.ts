/**
 * Touch in the 3D view, driven with real multi-touch through CDP (Chromium is
 * the only engine that injects it): one finger turns, two fingers pinch-zoom
 * about their midpoint and pan with it, a tap selects, a pinch never selects,
 * and WebKit's gesture stream (synthesised here, as in the 2D specs) zooms
 * when the pointer stream has not seen both fingers. Public KiCad sample.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/samples/tomu-fpga.kicad_pcb');
test.use({ hasTouch: true, viewport: { width: 1200, height: 900 }, launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
test.describe.configure({ timeout: 120000 }); // the 3D build under SwiftShader can take most of the default budget
type Pt = { x: number; y: number };
type Cam = { dist: number; target: number[]; pos: number[] };
type W = { __boardStore: { board: { parts: { pins: unknown[] }[] }; selection: { partIndex: number | null } }; __board3d?: { renderer: { drawnParts: number; cameraState(): Cam; screenOf(i: number): [number, number] | null; part(i: number): unknown; view(p: string, a?: boolean): void } } };

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
}
async function open3D(page: Page): Promise<CDPSession> {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 60000 });
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 60000 });
  await page.waitForTimeout(600);
  return page.context().newCDPSession(page);
}
const cam = (page: Page) => page.evaluate(() => (window as unknown as W).__board3d!.renderer.cameraState());
const sel = (page: Page) => page.evaluate(() => (window as unknown as W).__boardStore.selection.partIndex);
async function centre(page: Page): Promise<Pt> { const b = (await page.locator('.board-3d-canvas').boundingBox())!; return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }

test('one finger turns the board, and its release selects nothing', async ({ page }) => {
  const cdp = await open3D(page); const c = await centre(page); const c0 = await cam(page);
  await touch(cdp, 'touchStart', [c]);
  for (let i = 1; i <= 5; i++) { await touch(cdp, 'touchMove', [{ x: c.x + i * 20, y: c.y + i * 6 }]); await page.waitForTimeout(30); }
  await touch(cdp, 'touchEnd', []); await page.waitForTimeout(300);
  const c1 = await cam(page);
  expect(Math.hypot(c1.pos[0] - c0.pos[0], c1.pos[1] - c0.pos[1], c1.pos[2] - c0.pos[2])).toBeGreaterThan(1);
  expect(Math.abs(c1.dist - c0.dist)).toBeLessThan(c0.dist * 0.02);
  expect(await sel(page)).toBeNull();
});

test('two fingers pinch-zoom, pan with their midpoint, and never select', async ({ page }) => {
  const cdp = await open3D(page); const c = await centre(page); const c0 = await cam(page);
  const a0 = { x: c.x - 60, y: c.y }, b0 = { x: c.x + 60, y: c.y };
  await touch(cdp, 'touchStart', [a0]); await touch(cdp, 'touchStart', [a0, b0]);
  for (let i = 1; i <= 6; i++) { await touch(cdp, 'touchMove', [{ x: c.x - 60 - i * 25, y: c.y + i * 10 }, { x: c.x + 60 + i * 25, y: c.y + i * 10 }]); await page.waitForTimeout(30); }
  const mid = await cam(page);
  expect(mid.dist).toBeLessThan(c0.dist * 0.6);                        // spread 120 → 420 px: a zoom of about 3.5×
  expect(Math.hypot(mid.target[0] - c0.target[0], mid.target[2] - c0.target[2])).toBeGreaterThan(0.5); // the midpoint moved 60 px down
  await touch(cdp, 'touchEnd', [{ x: c.x - 210, y: c.y + 60 }]); await touch(cdp, 'touchEnd', []); await page.waitForTimeout(300);
  expect(await sel(page)).toBeNull();
});

test('a tap selects the part under it', async ({ page }) => {
  const cdp = await open3D(page);
  await page.evaluate(() => (window as unknown as W).__board3d!.renderer.view('top', false)); await page.waitForTimeout(300);
  const t = await page.evaluate(() => { const w = window as unknown as W; const parts = w.__boardStore.board.parts; let best = -1; parts.forEach((p, i) => { if (w.__board3d!.renderer.part(i) && (best < 0 || p.pins.length > parts[best].pins.length)) best = i; }); return { i: best, xy: w.__board3d!.renderer.screenOf(best)! }; });
  await touch(cdp, 'touchStart', [{ x: t.xy[0], y: t.xy[1] }]); await page.waitForTimeout(60); await touch(cdp, 'touchEnd', []);
  await expect.poll(() => sel(page)).toBe(t.i);
});

test("WebKit's gesture stream zooms when the pointer stream saw one finger at most", async ({ page }) => {
  await open3D(page); const c = await centre(page); const c0 = await cam(page);
  const fire = (type: string, scale: number, x: number, y: number) => page.evaluate(([type, scale, x, y]) => {
    const ev = new MouseEvent(type as string, { bubbles: true, cancelable: true, clientX: x as number, clientY: y as number }); Object.defineProperty(ev, 'scale', { value: scale });
    document.querySelector('.board-3d-canvas')!.dispatchEvent(ev);
  }, [type, scale, x, y] as const);
  await fire('gesturestart', 1, c.x, c.y);
  for (let i = 1; i <= 8; i++) { await fire('gesturechange', 1 + i * 0.25, c.x + i * 5, c.y); await page.waitForTimeout(20); }
  await fire('gestureend', 3, c.x + 40, c.y); await page.waitForTimeout(200);
  const c1 = await cam(page);
  expect(c1.dist).toBeLessThan(c0.dist * 0.5);
});
