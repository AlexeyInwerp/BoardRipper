import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// The selection outline is dynamic: padded out to a minimum on-screen size
// when the part is tiny (so it never shrinks to a dot), and exactly the part
// border once the part is big enough. Stroke is constant in screen px.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(__dirname, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const haveBoard = fs.existsSync(BOARD);

test.use({
  viewport: { width: 1400, height: 900 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

test('selection outline: minimum size zoomed out, exact border zoomed in', async ({ page }) => {
  test.skip(!haveBoard, 'samples/kicad/tomu-fpga.kicad_pcb not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  await page.waitForTimeout(1500);

  // Select a small 2-pin part and measure the selection Graphics on screen at
  // two zooms, against the part's own drawn box at the same zoom.
  const measure = async (zoom: number) => page.evaluate(async (zoom) => {
    const bs = (window as any).__boardStore, r = (window as any).__boardRenderer;
    const parts = bs.board.parts;
    const idx = parts.findIndex((p: any) => p.pins.length === 2 && !p.hidden);
    // Fresh selection at the target zoom: selecting an already-selected part
    // is a no-op in the store, and the outline is repainted on selection
    // change or zoom settle — so clear first to measure "select at this zoom".
    bs.selectPart(null);
    r.viewport.setZoom(zoom, true);
    r.viewport.emit('zoomed', { viewport: r.viewport, type: 'wheel' });
    await new Promise(res => setTimeout(res, 200));
    bs.selectPart(idx);
    await new Promise(res => setTimeout(res, 900));
    // Measure the primary outline's own Graphics (a child of selectionGfx).
    // The parent's getBounds() would fold its empty context's origin (0,0)
    // into the box — a PixiJS quirk, not a drawing — and member boxes when a
    // net is lit; neither is the outline under test.
    const g = r.primarySelGfx.getBounds();                      // screen px (global)
    const rs = (window as any).__renderSettings.settings;
    const rb = (window as any).__computePartRenderBounds
      ? (window as any).__computePartRenderBounds(parts[idx], rs) : null;
    const scale = r.viewport.scale.x;
    return { selW: g.width, selH: g.height, scale, partW: rb ? rb.pw * scale : null, partH: rb ? rb.ph * scale : null, minPx: rs.selectionMinScreenPx, stroke: rs.selectionWidth };
  }, zoom);

  const far = await measure(0.08);
  // Zoomed far out: the part is a few px, the outline is not — at least the minimum.
  expect(far.selW).toBeGreaterThanOrEqual(far.minPx - 1);
  expect(far.selH).toBeGreaterThanOrEqual(far.minPx - 1);

  const near = await measure(6);
  // Zoomed in: the outline equals the part's drawn box, plus the stroke —
  // and nothing else. (Both sides: no more than ~1.7× the stroke each way.)
  if (near.partW != null) {
    const slack = near.stroke * 1.7 + 2;
    expect(Math.abs(near.selW - near.partW)).toBeLessThan(slack * 2);
    expect(Math.abs(near.selH - near.partH)).toBeLessThan(slack * 2);
  }
  console.log('SELOUT ' + JSON.stringify({ far, near }));
});
