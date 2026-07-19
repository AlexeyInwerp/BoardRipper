/**
 * Visual parity + lifecycle coverage for "Text fast mode" (textFastMode): a
 * Canvas2D label overlay (LabelOverlay) that can replace in-scene BitmapText
 * part/pin labels. Captures a fixed screenshot set for manual side-by-side
 * review (per project practice: no automated pixel-diff — the controller
 * looks at the PNGs) plus structural DOM assertions (canvas count on/off).
 *
 * Board loading follows the fileURLToPath + skip-guard idiom in
 * tests/drag-to-zoom.spec.ts; the settings-toggle mechanism (dynamic import +
 * applyGlobal) also matches tests/drag-to-zoom.spec.ts:42-48.
 *
 * Zoom mechanics — two things that are NOT obvious from a first read of the
 * app and were confirmed by instrumenting `__boardRenderer.viewport` while
 * developing this spec:
 *
 *  1. `twoFingerPan` defaults to true, which routes a bare `page.mouse.wheel`
 *     to pixi-viewport's drag-plugin PAN path, not zoom (see
 *     BoardRenderer.installShiftWheelHandler / applyViewportPlugins). Zoom
 *     requires Shift held (`e.shiftKey && s.twoFingerPan` branch) — matching
 *     the documented "Shift+Scroll = slow zoom" binding in CLAUDE.md. Without
 *     the modifier, 10 unmodified wheel notches just pan the board off-frame
 *     and every screenshot comes out solid black.
 *  2. Repeatedly wheeling over one FIXED screen pixel anchors the zoom to
 *     whatever world point was under the cursor at the first notch — an
 *     anchor that happens to sit between components (as the board's on-screen
 *     center does here) drifts into empty board background after ~8+ notches
 *     of zoom-in. Anchoring on a specific part's world-space center (via
 *     `viewport.toScreen`, recomputed each notch) keeps the same real content
 *     centered no matter how deep the zoom goes.
 */
import { test, expect, type Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

const SAMPLE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');
const haveSample = fs.existsSync(SAMPLE);

interface PartAnchor {
  i: number;
  name: string;
  cx: number;
  cy: number;
  pins: number;
}

async function loadBoard(page: Page) {
  test.skip(!haveSample, 'samples/820-02016/820-02016.bvr not present (proprietary fixture)');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(SAMPLE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 60_000 });
  await page.waitForTimeout(2_000);
}

// Same settings-toggle mechanism tests/drag-to-zoom.spec.ts:42-48 uses:
// dynamic-import the store module inside the page and applyGlobal a patch.
async function setOverlay(page: Page, on: boolean) {
  await page.evaluate(async (v) => {
    const mod = await import('/src/store/render-settings.ts');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (mod as any).renderSettingsStore;
    store.applyGlobal({ ...store.globalSnapshot(), textFastMode: v });
  }, on);
}

/**
 * Picks two stable zoom/selection anchors from the live board:
 *  - mainPart: the largest top-side part among the 40 closest to the board's
 *    overall center — big enough that a selection highlight reads clearly,
 *    central enough that zooming toward it stays on-screen.
 *  - smallPart: the nearest 2-pin part to mainPart (not to the board center)
 *    — guarantees it is still within the viewport once we're zoomed in
 *    around mainPart, for the final "deep zoom" shot.
 */
async function pickAnchors(page: Page): Promise<{ mainPart: PartAnchor; smallPart: PartAnchor }> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__boardStore;
    const board = store.activeTab.board;
    const bb = board.bounds;
    const ccx = (bb.minX + bb.maxX) / 2, ccy = (bb.minY + bb.maxY) / 2;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cand: (PartAnchor & { dist: number; area: number })[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    board.parts.forEach((p: any, i: number) => {
      if (p.hidden) return;
      if (p.side !== 'top' && p.side !== 'both') return;
      const cx = (p.bounds.minX + p.bounds.maxX) / 2, cy = (p.bounds.minY + p.bounds.maxY) / 2;
      const dist = Math.hypot(cx - ccx, cy - ccy);
      const area = (p.bounds.maxX - p.bounds.minX) * (p.bounds.maxY - p.bounds.minY);
      cand.push({ i, name: p.name, cx, cy, pins: p.pins.length, dist, area });
    });
    cand.sort((a, b) => a.dist - b.dist);
    const nearestToCenter = cand.slice(0, 40);
    const mainPart = [...nearestToCenter].sort((a, b) => b.area - a.area)[0];
    const smallPart = cand
      .filter(c => c.pins === 2)
      .map(c => ({ ...c, distToMain: Math.hypot(c.cx - mainPart.cx, c.cy - mainPart.cy) }))
      .sort((a, b) => a.distToMain - b.distToMain)[0];
    return { mainPart, smallPart };
  });
}

/** Shift+wheel-zoom `notches` times, anchored on a fixed world-space point
 *  (re-projected to screen coords every notch so the anchor tracks correctly
 *  as the viewport transform changes). See file-header note on why Shift is
 *  required and why a world anchor (not a fixed screen pixel) is used. */
async function zoomAt(page: Page, box: { x: number; y: number; width: number; height: number }, wx: number, wy: number, notches: number, delta = -240) {
  await page.keyboard.down('Shift');
  for (let i = 0; i < notches; i++) {
    const scr = await page.evaluate(({ wx, wy }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = (window as any).__boardRenderer;
      const pt = r.viewport.toScreen(wx, wy);
      return { x: pt.x, y: pt.y };
    }, { wx, wy });
    // Clamp into the canvas bounds as a safety net in case the anchor is near an edge.
    const cx = Math.min(Math.max(scr.x, 4), box.width - 4);
    const cy = Math.min(Math.max(scr.y, 4), box.height - 4);
    await page.mouse.move(box.x + cx, box.y + cy);
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(120);
  }
  await page.keyboard.up('Shift');
}

test('overlay on/off visual parity + selection/side/zoom variants', async ({ page }) => {
  test.setTimeout(180_000);
  await loadBoard(page);

  // Baseline canvas count with the overlay off (just the PixiJS board canvas).
  const baselineCanvasCount = await page.locator('canvas').count();

  const anchors = await pickAnchors(page);
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;

  await zoomAt(page, box, anchors.mainPart.cx, anchors.mainPart.cy, 6);
  await page.waitForTimeout(1_000);

  // 1. textFastMode OFF (pristine, never toggled) at label-visible zoom —
  // in-scene BitmapText labels.
  await page.screenshot({ path: 'test-results/labels-bitmaptext.png' });

  // 2. textFastMode ON, same viewport/zoom — Canvas2D overlay labels.
  await setOverlay(page, true);
  await page.waitForTimeout(2_500); // rebuild + overlay draw
  await page.screenshot({ path: 'test-results/labels-overlay.png' });

  const onCanvasCount = await page.locator('canvas').count();
  expect(onCanvasCount).toBeGreaterThanOrEqual(2);
  expect(onCanvasCount).toBeGreaterThan(baselineCanvasCount);

  // 3. textFastMode ON + a large part selected — elevated/selected labels.
  await page.evaluate((idx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__boardStore.selectPart(idx);
  }, anchors.mainPart.i);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: 'test-results/labels-overlay-selected.png' });

  // 4. textFastMode ON, Bottom side.
  await page.locator('.toolbar-btn', { hasText: 'Bottom' }).click();
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: 'test-results/labels-overlay-bottom.png' });

  // 5. textFastMode ON, 4 more wheel notches in (deep zoom, pin-net labels).
  // Restore Top so the deep-zoom shot lines up with the earlier top-side view.
  await page.locator('.toolbar-btn', { hasText: 'Top' }).click();
  await page.waitForTimeout(1_000);
  await zoomAt(page, box, anchors.smallPart.cx, anchors.smallPart.cy, 4);
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: 'test-results/labels-overlay-deep.png' });

  // Toggling OFF removes the overlay canvas from the DOM — count returns to
  // baseline. This is the lifecycle guard: LabelOverlay.destroy() must run.
  await setOverlay(page, false);
  await page.waitForTimeout(1_000);
  const offCanvasCount = await page.locator('canvas').count();
  expect(offCanvasCount).toBe(baselineCanvasCount);
});
