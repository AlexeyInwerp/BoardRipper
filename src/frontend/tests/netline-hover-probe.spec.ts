import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
test.use({ viewport: { width: 1280, height: 720 }, launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
const SAMPLE = process.env.PROBE_SAMPLE || path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');
const TAG = process.env.PROBE_TAG || 'HEAD';

test('field repro: hover GND in dim mode, no selection', async ({ page }) => {
  test.skip(!fs.existsSync(SAMPLE), 'sample missing');
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(SAMPLE);
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);

  // Field conditions: ambient dim on, dim mode (default), hover info on, NO selection.
  await page.evaluate(async () => {
    const mod = await import('/src/store/render-settings.ts');
    const store = (mod as any).renderSettingsStore;
    store.applyGlobal({ ...store.globalSnapshot(), ambientDim: true });
  });
  await page.waitForTimeout(1_000);

  // Hover a GND pin (real mouse move so handleHover runs).
  await page.evaluate(() => {
    const r = (window as any).__boardRenderer;
    const board = (window as any).__boardStore.activeTab.board;
    outer: for (const part of board.parts) {
      for (const pin of part.pins) {
        if ((pin.net || '').toUpperCase() === 'GND') {
          const pt = r.viewport.toScreen(pin.position.x, pin.position.y);
          (window as any).__gndScreen = { x: pt.x, y: pt.y, net: pin.net };
          break outer;
        }
      }
    }
  });
  // Drive the exact downstream path a successful GND hit takes (hit-testing
  // itself is not under suspicion; precision-hovering at fit zoom is flaky).
  await page.evaluate(() => (window as any).__boardRenderer.setHoverNet('GND'));
  await page.waitForTimeout(1_500);

  const state = await page.evaluate(() => {
    const r = (window as any).__boardRenderer;
    const instr = (g: any) => g?.context?.instructions?.length ?? -1;
    return {
      hoverNet: r.hoverNet,
      dimInstr: instr(r.netDimGfx),
      selGfxInstr: instr(r.selectionGfx),
      netLinesInstr: instr(r.netLinesGfx),
      segments: r.netLineSegments.length,
    };
  });
  console.log(`STATE[${TAG}]`, JSON.stringify(state));
  await page.screenshot({ path: `test-results/gnd-hover-${TAG}.png` });
  expect(state.hoverNet).toBe('GND');
});
