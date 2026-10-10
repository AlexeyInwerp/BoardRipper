/**
 * Net (connection) lines must survive a two-finger unzoom on a touch screen.
 *
 * Field report 2026-10-07 (iPad): "when unzooming the connections overlay
 * vanishes completely". The lines were cleared on the first frame of any
 * scale change and redrawn 32 ms after the scale stopped changing — gone for
 * a moment on a wheel notch, gone for the whole gesture on a pinch, which
 * changes the scale for as long as the fingers move. They now stay drawn and
 * are re-stroked at the new width as the zoom runs. Checked mid-gesture,
 * fingers still down, for the pointer pinch and for WebKit's gesture stream
 * (the one iPadOS often hands a pinch to), and after release.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../public/samples/tomu-fpga.kicad_pcb');

type Pt = { x: number; y: number };
test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } });

async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
}

/** Drawn net-line geometry: instructions in the line Graphics and its pulse
 *  sibling, plus whether the layer is visible all the way up. */
const lineState = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __boardRenderer: Record<string, any> }).__boardRenderer;
  const g = r.netLinesGfx;
  let vis = true;
  for (let o = g; o; o = o.parent) if (o.visible === false || o.alpha === 0) vis = false;
  return {
    segments: r.netLineSegments.length as number,
    instr: (g.context.instructions.length as number) + ((r.netLinesPulseGfx?.context.instructions.length as number) ?? 0),
    attached: !!g.parent,
    vis,
    hidden: r.netLinesHiddenForZoom as boolean,
    scale: Math.abs(r.viewport.scale.x) as number,
    // World stroke width of the last stroke issued (screen px ÷ scale at the time).
    width: (() => { const ins = g.context.instructions as any[]; for (let i = ins.length - 1; i >= 0; i--) if (ins[i].action === 'stroke') return ins[i].data.style.width as number; return 0; })(),
  };
});

async function setup(page: Page): Promise<Pt> {
  await page.goto('/');
  const dev = await page.evaluate(() => '__boardStore' in window);
  test.skip(!dev, 'DEV-only globals');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1200);
  // Light a mid-sized net, star lines on, with a part selected.
  await page.evaluate(() => {
    const st = (window as unknown as { __boardStore: Record<string, any> }).__boardStore;
    while (st.netLineMode !== 'star') st.cycleNetLineMode();
    const b = st.board;
    let best: [number, number] | null = null; let bestN = 0;
    b.parts.forEach((p: any, pi: number) => p.pins.forEach((pin: any, i: number) => {
      const n = pin.net && b.nets.get(pin.net)?.pinIndices.length;
      if (n && n >= 4 && n <= 30 && !/GND/i.test(pin.net) && n > bestN) { bestN = n; best = [pi, i]; }
    }));
    st.selectPin(best![0], best![1]);
  });
  await page.waitForTimeout(500);
  const b = (await page.locator('.board-panel-canvas').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test('net lines stay drawn through a two-finger unzoom', async ({ page }) => {
  const at = await setup(page);
  const before = await lineState(page);
  expect(before.segments).toBeGreaterThan(0);
  expect(before.instr).toBeGreaterThan(0);

  const cdp = await page.context().newCDPSession(page);
  for (const factor of [0.5, 0.4]) {
    const d0 = 220;
    await touch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }]);
    await touch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }, { x: at.x + d0, y: at.y }]);
    for (let i = 1; i <= 12; i++) {
      const d = d0 + (d0 * factor - d0) * (i / 12);
      await touch(cdp, 'touchMove', [{ x: at.x - d, y: at.y }, { x: at.x + d, y: at.y }]);
      await page.waitForTimeout(16);
      if (i === 8) {
        const mid = await lineState(page);
        expect(mid.scale, 'the pinch is zooming').toBeLessThan(before.scale * 0.95);
        expect(mid.instr, 'lines drawn while the fingers are still moving').toBeGreaterThan(0);
      }
    }
    await touch(cdp, 'touchEnd', [{ x: at.x - d0 * factor, y: at.y }]);
    await touch(cdp, 'touchEnd', []);
    await page.waitForTimeout(600);
    const after = await lineState(page);
    expect(after.scale).toBeLessThan(before.scale);
    expect(after.hidden).toBe(false);
    expect(after.segments).toBeGreaterThan(0);
    expect(after.instr).toBeGreaterThan(0);
    expect(after.attached && after.vis).toBe(true);
  }
});

test('net lines come back after a wheel unzoom (control)', async ({ page }) => {
  const at = await setup(page);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 200); await page.waitForTimeout(40); }
  await page.waitForTimeout(800);
  const after = await lineState(page);
  expect(after.instr).toBeGreaterThan(0);
  expect(after.hidden).toBe(false);
});

/** iPadOS: WebKit's own gesture stream (synthesised here — a real
 *  GestureEvent cannot be constructed; the handlers read scale, rotation and
 *  clientX/Y, which a MouseEvent carrying `scale`/`rotation` provides). */
test('net lines stay drawn through a WebKit gesture-stream unzoom', async ({ page }) => {
  const at = await setup(page);
  const before = await lineState(page);
  const fire = (type: string, scale: number, rotation = 0) => page.evaluate(({ type, scale, rotation, at }) => {
    const el = document.querySelector('.board-panel-canvas')!.parentElement!;
    const target = (window as unknown as { __boardRenderer: { containerEl: HTMLElement } }).__boardRenderer.containerEl ?? el;
    const ev = new MouseEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
    Object.assign(ev, {});
    Object.defineProperty(ev, 'scale', { value: scale });
    Object.defineProperty(ev, 'rotation', { value: rotation });
    target.dispatchEvent(ev);
  }, { type, scale, rotation, at });
  await fire('gesturestart', 1);
  for (let i = 1; i <= 12; i++) {
    await fire('gesturechange', 1 - 0.5 * i / 12, 2 * Math.sin(i));
    await page.waitForTimeout(16);
    if (i === 8) {
      const mid = await lineState(page);
      expect(mid.scale).toBeLessThan(before.scale * 0.95);
      expect(mid.instr, 'lines drawn mid-gesture').toBeGreaterThan(0);
      expect(mid.width, 'stroke follows the zoom, not stale').toBeGreaterThan(before.width * 1.2);
    }
  }
  await fire('gestureend', 0.5);
  await page.waitForTimeout(800);
  const after = await lineState(page);
  expect(after.scale).toBeLessThan(before.scale);
  expect(after.hidden).toBe(false);
  expect(after.instr).toBeGreaterThan(0);
  expect(after.attached && after.vis).toBe(true);
});
