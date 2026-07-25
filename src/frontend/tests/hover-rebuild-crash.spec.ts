/**
 * Regression: hovering a huge net (GND) across a scene REBUILD used to leave
 * the chunk-pool graphics destroyed, so the next renderSelection called
 * .clear() on them and threw, from inside app.render():
 *   TypeError: null is not an object (evaluating 'this.context[...]')
 *     _callContextMethod → renderSelection → setHoverNet → handleHover
 * handleRenderCrash then stopped the ticker, freezing the canvas on a stale
 * frame with every click apparently ignored (field report 2026-07-25).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});
const SAMPLE = path.resolve(__dirname2, '../../../samples/NM-G611/NM-G611-Intel.tvw');

test('hover + repeated scene rebuilds never crash the renderer', async ({ page }) => {
  test.skip(!fs.existsSync(SAMPLE), 'sample missing');
  test.setTimeout(180_000);

  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (/render crash|is not an object|persistent overlay was destroyed/i.test(t)) errors.push(t.slice(0, 160));
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(SAMPLE);
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 90_000 });
  await page.waitForTimeout(2_500);

  // Hover a huge net so the chunk pools are populated, then force scene
  // rebuilds (theme/settings churn) while the hover is still active.
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => (window as any).__boardRenderer.setHoverNet('GND'));
    await page.waitForTimeout(700);
    await page.evaluate(async (n) => {
      const mod = await import('/src/store/render-settings.ts');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (mod as any).renderSettingsStore;
      // partBorderWidth is a visual key → full scheduleRebuild path.
      store.applyGlobal({ ...store.globalSnapshot(), partBorderWidth: 1 + (n % 2) * 0.5 });
    }, i);
    await page.waitForTimeout(1_400);
    await page.evaluate(() => (window as any).__boardRenderer.setHoverNet('GND'));
    await page.waitForTimeout(900);
  }

  const state = await page.evaluate(() => {
    const r = (window as any).__boardRenderer;
    return {
      tickerStarted: r.app.ticker.started,
      contextLost: r.contextLost,
      selectionDestroyed: r.selectionGfx.destroyed,
      poolAlive: r.selectionChunkPool.filter((g: any) => !g.destroyed).length,
      poolDead: r.selectionChunkPool.filter((g: any) => g.destroyed).length,
    };
  });

  expect(errors, `renderer errors: ${errors.slice(0, 3).join(' | ')}`).toEqual([]);
  expect(state.tickerStarted, 'ticker must stay running (a stopped ticker = frozen canvas + dead clicks)').toBe(true);
  expect(state.contextLost).toBe(false);
  expect(state.selectionDestroyed).toBe(false);
  expect(state.poolDead, 'no destroyed graphics may linger in the pool').toBe(0);
});
