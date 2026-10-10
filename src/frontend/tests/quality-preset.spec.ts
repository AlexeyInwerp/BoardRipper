/**
 * Board quality preset (start page + Settings ▸ Performance).
 *
 * One click writes several render settings; the lit button is derived from
 * them, so a hand edit shows Custom. The resolution switches on an open
 * board without reopening it, and simple trace corners rebuild the traces
 * with less geometry. Public KiCad sample, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

// SwiftShader: without a WebGL context PixiJS falls back to its canvas
// renderer, which has no draw calls to count.
test.use({
  deviceScaleFactor: 2,
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

const global = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __renderSettings: { globalSettings: Record<string, unknown> } }).__renderSettings.globalSettings;
  return { cap: s.boardResolutionCap, corners: s.traceCorners, fps: s.cap60Fps, msaa: s.boardAntialiasing, labels: s.labelMinScreenPx };
});

/** Indices the GPU is asked to draw for one full frame of the board. */
const frameIndices = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __boardRenderer: { app: { render(): void; renderer: { gl: WebGL2RenderingContext } } } }).__boardRenderer;
  const rr = r.app.renderer as unknown as { gl?: WebGL2RenderingContext; context?: { gl?: WebGL2RenderingContext }; name?: string; type?: number };
  const gl = (rr.gl ?? rr.context?.gl)!;
  if (!gl) throw new Error(`no gl: ${rr.name} ${rr.type}`);
  const de = gl.drawElements, da = gl.drawArrays;
  let n = 0;
  gl.drawElements = function (m: number, c: number, t: number, o: number) { n += c; de.call(gl, m, c, t, o); };
  gl.drawArrays = function (m: number, f: number, c: number) { n += c; da.call(gl, m, f, c); };
  try { r.app.render(); } finally { gl.drawElements = de; gl.drawArrays = da; }
  return n;
});

test('start page preset writes its settings, persists, and shows Custom after a hand edit', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('quality-preset-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('quality-preset-balanced')).toHaveAttribute('aria-checked', 'true');

  await page.getByTestId('quality-preset-fast').click();
  await expect(page.getByTestId('quality-preset-fast')).toHaveAttribute('aria-checked', 'true');
  expect(await global(page)).toEqual({ cap: 1, corners: 'simple', fps: true, msaa: true, labels: 5 });
  await expect(card).toContainText('1× · 60 fps');

  await page.reload();
  await expect(page.getByTestId('quality-preset-fast')).toHaveAttribute('aria-checked', 'true');

  await page.evaluate(() => {
    const rs = (window as unknown as { __renderSettings: { globalSnapshot(): Record<string, unknown>; applyGlobal(s: unknown): void } }).__renderSettings;
    const s = rs.globalSnapshot(); s.labelMinScreenPx = 4; rs.applyGlobal(s);
  });
  await expect(page.locator('[data-testid^="quality-preset-"][aria-checked="true"]')).toHaveCount(0);
  await expect(card).toContainText('Custom');

  await page.getByTestId('quality-preset-balanced').click();
  expect(await global(page)).toEqual({ cap: 0, corners: 'round', fps: false, msaa: true, labels: 3 });
});

test('an open board takes the new resolution and lighter traces without reopening', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await page.waitForFunction(() => !!(window as unknown as { __boardRenderer?: { board?: unknown } }).__boardRenderer?.board, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  const res = () => page.evaluate(() => (window as unknown as { __boardRenderer: { app: { renderer: { resolution: number } } } }).__boardRenderer.app.renderer.resolution);
  expect(await res()).toBe(2);
  const roundIdx = await frameIndices(page);
  expect(roundIdx).toBeGreaterThan(0);

  await page.evaluate(() => {
    const rs = (window as unknown as { __renderSettings: { globalSnapshot(): Record<string, unknown>; applyGlobal(s: unknown): void } }).__renderSettings;
    const s = rs.globalSnapshot(); s.boardResolutionCap = 1; s.traceCorners = 'simple'; rs.applyGlobal(s);
  });
  await expect.poll(res).toBe(1);
  await expect.poll(() => frameIndices(page), { timeout: 10000 }).toBeLessThan(roundIdx * 0.85);
  const canvas = await page.evaluate(() => (window as unknown as { __boardRenderer: { app: { canvas: HTMLCanvasElement } } }).__boardRenderer.app.canvas.width
    / (window as unknown as { __boardRenderer: { app: { canvas: HTMLCanvasElement } } }).__boardRenderer.app.canvas.getBoundingClientRect().width);
  expect(canvas).toBeCloseTo(1, 1);
});
