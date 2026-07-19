import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// SwiftShader so PixiJS gets a real (software) WebGL context in headless.
test.use({
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

// ESM scope (project is "type": "module") has no __dirname — derive it the
// same way drag-to-zoom.spec.ts does.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');

// Skip (not fail) when the gitignored, proprietary sample is absent — same
// idiom as drag-to-zoom.spec.ts.
const haveSample = fs.existsSync(SAMPLE);

async function measureFps(page: import('@playwright/test').Page, ms: number): Promise<number> {
  return page.evaluate(async (durationMs) => {
    const r = (window as any).__boardRenderer;
    const ticker = r.app.ticker;
    let frames = 0;
    const onTick = () => { frames++; };
    ticker.add(onTick);
    await new Promise(res => setTimeout(res, durationMs));
    ticker.remove(onTick);
    return frames / (durationMs / 1000);
  }, ms);
}

test('perf probe: pan + zoom FPS with labels visible', async ({ page }) => {
  test.skip(!haveSample, 'samples/820-02016/820-02016.bvr not present (proprietary fixture)');
  test.setTimeout(120_000);
  await page.goto('/');
  const input = page.locator('input[type="file"]').first();
  await input.setInputFiles(SAMPLE);
  // Board scene ready: canvas present and renderer exposed
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;

  // Zoom in until pin labels are visible (LoD: fontSize * scale >= labelMinScreenPx)
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }

  // Measure during continuous pan (mouse drag loop)
  const panPromise = (async () => {
    for (let rep = 0; rep < 4; rep++) {
      await page.mouse.move(cx - 200, cy);
      await page.mouse.down();
      for (let i = 0; i <= 20; i++) {
        await page.mouse.move(cx - 200 + i * 20, cy + Math.sin(i / 3) * 60, { steps: 1 });
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
    }
  })();
  const panFps = await measureFps(page, 3_000);
  await panPromise;

  // Measure during wheel zoom bursts
  const zoomPromise = (async () => {
    for (let i = 0; i < 20; i++) {
      await page.mouse.wheel(0, i % 2 ? -180 : 180);
      await page.waitForTimeout(140);
    }
  })();
  const zoomFps = await measureFps(page, 2_500);
  await zoomPromise;

  console.log('PERF ' + JSON.stringify({ panFps: +panFps.toFixed(1), zoomFps: +zoomFps.toFixed(1) }));
  expect(panFps).toBeGreaterThan(0);
});
