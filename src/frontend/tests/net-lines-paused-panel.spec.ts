/**
 * A store change must draw while the board panel is paused.
 *
 * Field report 2026-10-14 (iPad): "open a board, select a net from the
 * schematic, switch the net-line mode — nothing happens until the next net is
 * clicked". With a PDF panel active the board panel is paused (its ticker is
 * stopped by BoardViewerPanel on onDidActiveChange), so the ribbon's mode
 * button updated the geometry and nobody ever drew a frame. The word lookup
 * from the PDF only showed because its camera animation starts the ticker,
 * and a canvas click wakes it too — which is why a re-selection "fixed" it.
 * A notify that changes what is on screen now wakes the ticker for the
 * frames it needs and pauses it again.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const PDF = path.resolve(HERE, 'fixtures/two-page-text.pdf');

type W = { __boardRenderer: Record<string, any>; __boardStore: Record<string, any>; __renders: number };

const state = (page: Page) => page.evaluate(() => {
  const w = window as unknown as W; const r = w.__boardRenderer;
  return {
    mode: w.__boardStore.netLineMode as string,
    net: w.__boardStore.selection.highlightedNet as string | null,
    segments: r.netLineSegments.length as number,
    instr: r.netLinesGfx.context.instructions.length as number,
    ticker: r.app.ticker.started as boolean,
    renders: w.__renders,
    // Why a paused panel's ticker may still be running (see the end of onTick).
    pending: {
      needsRender: r.needsRender, zoomTween: !!r.zoomTween, zoomAnim: !!r.zoomAnim, blink: r.selectionBlinkPhase,
      blinkTimer: !!r.selectionBlinkTimer, cull: r.cullRefreshFrames, wheelIdle: !!r.wheelIdleTimer,
      decel: !!r.viewport?.plugins.get('decelerate')?.isActive?.(), panelPaused: r.panelPaused,
    },
  };
});

async function setup(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  test.skip(!(await page.evaluate(() => '__boardStore' in window)), 'DEV-only globals');
  await page.setInputFiles('[data-testid="file-input"]', BOARD);
  await expect.poll(() => page.evaluate(() => !!(window as unknown as W).__boardRenderer?.activeScene), { timeout: 15000 }).toBe(true);
  // A PDF beside the board: the PDF panel is the active one, the board is paused.
  await page.setInputFiles('[data-testid="file-input"]', PDF);
  await expect(page.locator('.pdf-canvas-container').first()).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('board-canvas')).toBeVisible();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const w = window as unknown as W; const r = w.__boardRenderer;
    w.__renders = 0;
    const orig = r.app.render.bind(r.app);
    r.app.render = () => { w.__renders++; orig(); };
  });
  // What a word tap in the schematic does: focusNet on the board store.
  await page.evaluate(() => {
    const w = window as unknown as W; const b = w.__boardStore.board;
    let best = ''; let bestN = 0;
    for (const [name, net] of b.nets) {
      const n = net.pinIndices.length;
      if (n >= 4 && n <= 30 && !/GND/i.test(name) && n > bestN) { bestN = n; best = name; }
    }
    w.__boardStore.focusNet(best);
  });
  await page.waitForTimeout(1200);   // the focus animation lands
  // Then the user taps the schematic: the board panel loses activation and
  // BoardViewerPanel pauses its renderer. The same call, made directly, so
  // the test does not depend on how dockview hands activation around.
  await page.evaluate(() => (window as unknown as W).__boardRenderer.pause());
}

test('the mode button draws while the board panel is paused, then pauses again', async ({ page }) => {
  await setup(page);
  const s0 = await state(page);
  expect(s0.net).not.toBeNull();
  expect(s0.mode).toBe('off');
  // Paused for real — otherwise this test would not be testing the paused panel at all.
  await expect.poll(() => state(page).then(s => s.ticker), { timeout: 3000, message: JSON.stringify(s0.pending) }).toBe(false);
  const rendersBefore = (await state(page)).renders;

  await page.getByTestId('netlines-btn').click();
  // Drawn at once: geometry AND a real GPU frame, with no click on the canvas.
  await expect.poll(() => state(page).then(s => s.instr), { timeout: 1500 }).toBeGreaterThan(0);
  const s1 = await state(page);
  expect(s1.mode).toBe('star');
  expect(s1.renders).toBeGreaterThan(rendersBefore);
  // And the ticker is not left running for good on a paused panel. (A click
  // on the ribbon may hand dockview's activation to the board panel; then the
  // renderer was resumed and a running ticker is the active panel's.)
  const rest = () => state(page).then(s => (s.pending.panelPaused ? !s.ticker : 'active'));
  await expect.poll(rest, { timeout: 3000, message: 'after the press: ' + JSON.stringify((await state(page)).pending) }).not.toBe(false);

  // Each further press draws too — chain, chain-adjacent, and off clears.
  const r1 = (await state(page)).renders;
  await page.getByTestId('netlines-btn').click();
  await expect.poll(() => state(page).then(s => s.renders), { timeout: 1500 }).toBeGreaterThan(r1);
  expect((await state(page)).mode).toBe('chain');
  await page.getByTestId('netlines-btn').click();
  await page.getByTestId('netlines-btn').click();
  await expect.poll(() => state(page).then(s => s.mode), { timeout: 1500 }).toBe('off');
  await expect.poll(() => state(page).then(s => s.instr), { timeout: 1500 }).toBe(0);
  await expect.poll(rest, { timeout: 3000, message: 'at the end: ' + JSON.stringify((await state(page)).pending) }).not.toBe(false);
  console.log('[paused-panel] end state', JSON.stringify((await state(page)).pending));
});

// On the iPad the tap on the ribbon did not hand activation to the board
// panel (in Chromium it does, which is why the test above cannot tell the wake
// from a resume). The store call the button makes, with the panel left paused:
// the frame must come from the wake alone, and the ticker must rest again.
test('the mode change draws without the panel being activated', async ({ page }) => {
  await setup(page);
  await expect.poll(() => state(page).then(s => s.ticker), { timeout: 3000 }).toBe(false);
  const before = await state(page);
  await page.evaluate(() => (window as unknown as W).__boardStore.cycleNetLineMode());
  await expect.poll(() => state(page).then(s => s.instr), { timeout: 1500 }).toBeGreaterThan(0);
  const s1 = await state(page);
  expect(s1.mode).toBe('star');
  expect(s1.renders).toBeGreaterThan(before.renders);
  expect(s1.pending.panelPaused).toBe(true);
  await expect.poll(() => state(page).then(s => s.ticker), { timeout: 3000, message: JSON.stringify(s1.pending) }).toBe(false);
  // off clears, again without a frame from anyone else
  for (let i = 0; i < 3; i++) await page.evaluate(() => (window as unknown as W).__boardStore.cycleNetLineMode());
  await expect.poll(() => state(page).then(s => s.mode), { timeout: 1500 }).toBe('off');
  await expect.poll(() => state(page).then(s => s.instr), { timeout: 1500 }).toBe(0);
  await expect.poll(() => state(page).then(s => s.ticker), { timeout: 3000 }).toBe(false);
});
