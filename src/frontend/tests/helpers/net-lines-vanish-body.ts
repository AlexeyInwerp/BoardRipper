/**
 * Shared body of net-lines-vanish.spec.ts (Chromium) and
 * net-lines-vanish.webkit.spec.ts (WebKit, iPad descriptor).
 *
 * Field report 2026-10-13 (iPad Safari): the net/connection lines
 * (1) sometimes vanish, especially on zoom and pan, (2) mostly after the
 * ribbon button has switched their mode, (3) a mode switch does not redraw
 * them until the part is re-selected.
 *
 * A per-frame recorder (requestAnimationFrame, in the page) samples the line
 * Graphics for the WHOLE gesture, so "never zero while a net is lit and the
 * mode is on" is checked on every frame, not at one sample. Each scenario
 * starts from a lit mid-sized net in star mode, cycles to the target mode
 * with `cycleNetLineMode()` (the ribbon button's action), optionally
 * re-selects, then runs the gesture.
 *
 * Checks per scenario:
 *  - `drawn`:   while net lit and mode ≠ off, netLinesGfx has instructions,
 *               is attached to the viewport, visible up the chain, not culled.
 *  - `settled`: ≤ 500 ms after the gesture, netLinesHiddenForZoom is false and
 *               the last stroke is at netLineWidth ÷ current scale.
 *  - `mode`:    the drawn segments are the ones the current mode produces
 *               (compared with a side-effect-free fresh recompute) — report (3).
 *  - `off`:     while mode = off, nothing is drawn.
 *
 * On HEAD 7d2fab7 (Chromium and WebKit alike, deterministic; 26 of 55 fail):
 *  - every non-reselect chain / chain-adjacent scenario, (f) chain*, (g), (g2),
 *    (i), (j), (n) fail `mode`: a press of the button never recomputes the
 *    segments — netLineMode is in neither onBoardUpdate's lastRenderedSel
 *    compare nor renderSelection's selKey, so the previous mode's lines stay.
 *  - (h), (k), (n), (o) fail `off`: switching to off leaves the lines drawn.
 *  - (o): those leftover lines vanish on the next segment recompute (here a
 *    keyboard zoom, which sets netLinesDirty) and the press back to star then
 *    draws nothing — no lines through the whole following zoom.
 *  - (m), (m2) fail `drawn`: with rotation unlocked, any pinch that twists
 *    past the 2° dead zone clears the lines (onZoomFrame, liveRotate.engaged)
 *    from that moment until the fingers lift.
 *  - Not reproduced: a vanish with mode on and rotation locked, under wheel,
 *    drag pan + glide, pointer pinch, gesture stream, pulse, dashed, focus
 *    loss, visibilitychange or a scene rebuild.
 */
import { test, expect, type Page, type CDPSession, type TestInfo } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BOARD = path.resolve(here, '../../public/samples/tomu-fpga.kicad_pcb');

type Pt = { x: number; y: number };
export type Mode = 'star' | 'chain' | 'chain-adjacent';
export type Engine = 'chromium' | 'webkit';

// ─── page-side recorder ──────────────────────────────────────────────────────

/** Installed once per page: window.__nlSample() and a rAF loop pushing into
 *  window.__nlTrace while window.__nlRec is true. */
async function installRecorder(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__nlSample = (label?: string) => {
      const r = w.__boardRenderer;
      const st = w.__boardStore;
      const g = r.netLinesGfx;
      const p = r.netLinesPulseGfx;
      let vis = true;
      for (let o = g; o; o = o.parent) if (o.visible === false || o.alpha === 0 || o.renderable === false) vis = false;
      const ins = g.context.instructions as any[];
      let width = 0;
      for (let i = ins.length - 1; i >= 0; i--) if (ins[i].action === 'stroke') { width = ins[i].data.style.width; break; }
      const scale = Math.abs(r.viewport.scale.x);
      return {
        t: Math.round(performance.now()),
        label: label ?? '',
        mode: st.netLineMode as string,
        net: st.selection.highlightedNet as string | null,
        instr: ins.length,
        pulseInstr: p ? p.context.instructions.length : -1,
        pulseAlpha: p ? p.alpha : -1,
        attached: g.parent === r.viewport && !g.destroyed,
        vis,
        culled: !!g.culled,
        cullable: !!g.cullable,
        segments: r.netLineSegments.length as number,
        dirty: r.netLinesDirty as boolean,
        hidden: r.netLinesHiddenForZoom as boolean,
        sig: r.netLineBakeSig as string,
        settleTimer: r.zoomSettleTimer != null,
        movingFor: Math.max(0, Math.round(r.viewportMovingUntil - performance.now())),
        hasFocus: document.hasFocus(),
        docHidden: document.hidden,
        scale,
        width,
        wantWidth: w.__renderSettings.settings.netLineWidth / scale,
        selKey: r.lastNetLinesSelKey as string | null,
      };
    };
    /** Segments the CURRENT mode/selection would produce, computed without
     *  leaving a trace (state saved and restored around the private call). */
    w.__nlExpected = () => {
      const r = w.__boardRenderer;
      const saved = [r.netLineSegments, r.netLineSegmentsByColor, r.netLineFadeDist, r.netLinesDirty];
      r.netLineSegmentsByColor = new Map();
      r.recomputeNetLineSegments();
      const fresh = r.netLineSegments.map((s: any) => `${s.start.x.toFixed(1)},${s.start.y.toFixed(1)}>${s.end.x.toFixed(1)},${s.end.y.toFixed(1)}`).sort();
      [r.netLineSegments, r.netLineSegmentsByColor, r.netLineFadeDist, r.netLinesDirty] = saved;
      const cur = r.netLineSegments.map((s: any) => `${s.start.x.toFixed(1)},${s.start.y.toFixed(1)}>${s.end.x.toFixed(1)},${s.end.y.toFixed(1)}`).sort();
      return { fresh: fresh.length, cur: cur.length, same: fresh.join('|') === cur.join('|') };
    };
    w.__nlTrace = [];
    w.__nlRec = false;
    const loop = () => {
      if (w.__nlRec) w.__nlTrace.push(w.__nlSample());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
}

type Sample = Awaited<ReturnType<typeof sample>>;
const sample = (page: Page, label?: string) =>
  page.evaluate((l) => (window as any).__nlSample(l), label) as Promise<{
    t: number; label: string; mode: string; net: string | null; instr: number; pulseInstr: number; pulseAlpha: number;
    attached: boolean; vis: boolean; culled: boolean; cullable: boolean; segments: number; dirty: boolean; hidden: boolean;
    sig: string; settleTimer: boolean; movingFor: number; hasFocus: boolean; docHidden: boolean; scale: number; width: number;
    wantWidth: number; selKey: string | null;
  }>;
const expected = (page: Page) => page.evaluate(() => (window as any).__nlExpected()) as Promise<{ fresh: number; cur: number; same: boolean }>;
const startRec = (page: Page) => page.evaluate(() => { (window as any).__nlTrace = []; (window as any).__nlRec = true; });
const stopRec = (page: Page) => page.evaluate(() => { (window as any).__nlRec = false; return (window as any).__nlTrace; }) as Promise<Sample[]>;

// ─── setup ───────────────────────────────────────────────────────────────────

let litPin: [number, number] | null = null;

/** `netName` picks the net to light (default: the largest non-GND net of
 *  4–30 pins, +3V3 on tomu-fpga — it has no one-hop neighbours, so
 *  chain-adjacent draws exactly what chain draws there). */
export async function setup(page: Page, netName?: string): Promise<Pt> {
  await page.goto('/');
  const dev = await page.evaluate(() => '__boardStore' in window);
  test.skip(!dev, 'DEV-only globals');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1200);
  litPin = await page.evaluate((netName) => {
    const st = (window as any).__boardStore;
    while (st.netLineMode !== 'star') st.cycleNetLineMode();
    const b = st.board;
    let best: [number, number] | null = null; let bestN = 0;
    b.parts.forEach((p: any, pi: number) => p.pins.forEach((pin: any, i: number) => {
      if (netName) { if (pin.net === netName && !best) best = [pi, i]; return; }
      const n = pin.net && b.nets.get(pin.net)?.pinIndices.length;
      if (n && n >= 4 && n <= 30 && !/GND/i.test(pin.net) && n > bestN) { bestN = n; best = [pi, i]; }
    }));
    st.selectPin(best![0], best![1]);
    return best;
  }, netName);
  await page.waitForTimeout(400);
  await installRecorder(page);
  const s = await sample(page);
  expect(s.instr, 'baseline: star lines drawn').toBeGreaterThan(0);
  const b = (await page.locator('.board-panel-canvas').boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Cycle the ribbon's mode until `mode`. From star: chain = 1 press,
 *  chain-adjacent = 2, star = the full lap (star→chain→ca→off→star). */
export async function switchTo(page: Page, mode: Mode, reselect: boolean) {
  await page.evaluate((mode) => {
    const st = (window as any).__boardStore;
    st.cycleNetLineMode();
    while (st.netLineMode !== mode) st.cycleNetLineMode();
  }, mode);
  if (reselect) {
    await page.evaluate((pin) => {
      const st = (window as any).__boardStore;
      st.selectPart(null);
      st.selectPin(pin![0], pin![1]);
    }, litPin);
  }
  await page.waitForTimeout(150);
}

export async function reselect(page: Page) {
  await page.evaluate((pin) => {
    const st = (window as any).__boardStore;
    st.selectPart(null);
    st.selectPin(pin![0], pin![1]);
  }, litPin);
}

// ─── input drivers ───────────────────────────────────────────────────────────

async function cdpTouch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
}

/** Synthetic touch PointerEvents (WebKit: no multi-touch injection). */
async function ptr(page: Page, type: string, id: number, p: Pt) {
  await page.evaluate(({ type, id, p }) => {
    const el = document.querySelector('.board-panel-canvas')!;
    el.dispatchEvent(new PointerEvent(type, {
      pointerId: 100 + id, pointerType: 'touch', isPrimary: id === 0, clientX: p.x, clientY: p.y,
      bubbles: true, cancelable: true, composed: true, buttons: type === 'pointerup' ? 0 : 1, button: 0,
    }));
  }, { type, id, p });
}

let ENGINE: Engine = 'chromium';
let lastMouse: Pt = { x: 0, y: 0 };

/** One wheel notch at the last mouse position. Mobile WebKit refuses
 *  page.mouse.wheel, so there it is a synthetic WheelEvent on the canvas —
 *  which is also what the renderer's handlers read. */
async function wheel(page: Page, dy: number) {
  if (ENGINE === 'chromium') { await page.mouse.wheel(0, dy); return; }
  await page.evaluate(({ dy, at }) => {
    const el = document.querySelector('.board-panel-canvas')!;
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, composed: true }));
  }, { dy, at: lastMouse });
}

export async function wheelZoom(page: Page, at: Pt, notches = 6) {
  await page.mouse.move(at.x, at.y); lastMouse = at;
  for (let i = 0; i < notches; i++) { await wheel(page, -120); await page.waitForTimeout(40); }
  for (let i = 0; i < notches; i++) { await wheel(page, 120); await page.waitForTimeout(40); }
}

export async function dragPan(page: Page, at: Pt, dx = 300, dy = 0) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) { await page.mouse.move(at.x + dx * i / steps, at.y + dy * i / steps); await page.waitForTimeout(8); }
  await page.mouse.up(); // fast last moves → inertia glide
  lastMouse = { x: at.x + dx, y: at.y + dy };
}

export async function pinch(page: Page, engine: Engine, at: Pt) {
  const d0 = 200;
  const seq = [...Array.from({ length: 10 }, (_, i) => d0 * (1 + 0.8 * (i + 1) / 10)), ...Array.from({ length: 10 }, (_, i) => d0 * (1.8 - 1.2 * (i + 1) / 10))];
  if (engine === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdpTouch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }]);
    await cdpTouch(cdp, 'touchStart', [{ x: at.x - d0, y: at.y }, { x: at.x + d0, y: at.y }]);
    for (const d of seq) { await cdpTouch(cdp, 'touchMove', [{ x: at.x - d, y: at.y }, { x: at.x + d, y: at.y }]); await page.waitForTimeout(16); }
    const last = seq[seq.length - 1];
    await cdpTouch(cdp, 'touchEnd', [{ x: at.x - last, y: at.y }]);
    await cdpTouch(cdp, 'touchEnd', []);
    await cdp.detach();
  } else {
    await ptr(page, 'pointerdown', 0, { x: at.x - d0, y: at.y });
    await ptr(page, 'pointerdown', 1, { x: at.x + d0, y: at.y });
    for (const d of seq) {
      await ptr(page, 'pointermove', 0, { x: at.x - d, y: at.y });
      await ptr(page, 'pointermove', 1, { x: at.x + d, y: at.y });
      await page.waitForTimeout(16);
    }
    const last = seq[seq.length - 1];
    await ptr(page, 'pointerup', 1, { x: at.x + last, y: at.y });
    await ptr(page, 'pointerup', 0, { x: at.x - last, y: at.y });
  }
}

/** WebKit gesture stream, synthesised as a MouseEvent carrying scale/rotation
 *  (a real GestureEvent cannot be constructed). */
export async function gestureStream(page: Page, at: Pt) {
  const fire = (type: string, scale: number, rotation = 0) => page.evaluate(({ type, scale, rotation, at }) => {
    const r = (window as any).__boardRenderer;
    const target = r.containerEl ?? document.querySelector('.board-panel-canvas')!.parentElement!;
    const ev = new MouseEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'scale', { value: scale });
    Object.defineProperty(ev, 'rotation', { value: rotation });
    target.dispatchEvent(ev);
  }, { type, scale, rotation, at });
  await fire('gesturestart', 1);
  for (let i = 1; i <= 12; i++) { await fire('gesturechange', 1 + 1.0 * i / 12, 2 * Math.sin(i)); await page.waitForTimeout(16); }
  for (let i = 1; i <= 12; i++) { await fire('gesturechange', 2 - 1.4 * i / 12, 2 * Math.sin(i)); await page.waitForTimeout(16); }
  await fire('gestureend', 0.6);
}

// ─── analysis ────────────────────────────────────────────────────────────────

function firstBad(trace: Sample[]) {
  for (const s of trace) {
    if (s.mode === 'off' || !s.net) continue;
    if (s.instr === 0 || !s.attached || !s.vis || s.culled) return s;
  }
  return null;
}

function lastBadT(trace: Sample[]) {
  let t = -1;
  for (const s of trace) if (s.mode !== 'off' && s.net && (s.instr === 0 || !s.attached || !s.vis || s.culled)) t = s.t;
  return t;
}

let offDrawn = 0;
function countBad(trace: Sample[]) {
  offDrawn = 0;
  let on = 0, bad = 0;
  for (const s of trace) {
    if (s.mode === 'off' && s.instr > 0) offDrawn++;
    if (s.mode === 'off' || !s.net) continue;
    on++;
    if (s.instr === 0 || !s.attached || !s.vis || s.culled) bad++;
  }
  return { on, bad, offDrawn };
}

/** Run `gesture` under the recorder and assert the three properties. */
export async function runScenario(page: Page, info: TestInfo, name: string, gesture: () => Promise<void>) {
  const pre = await sample(page, 'pre');
  const preExp = await expected(page);
  await startRec(page);
  await gesture();
  const tEnd = await page.evaluate(() => Math.round(performance.now()));
  await page.waitForTimeout(500);
  const trace = await stopRec(page);
  const post = await sample(page, 'post+500');
  const postExp = await expected(page);
  const bad = firstBad(trace);
  const { on, bad: nBad, offDrawn: nOff } = countBad(trace);
  const summary = { name, offDrawn: nOff, pre, preExp, frames: trace.length, onFrames: on, badFrames: nBad, firstBad: bad, tEnd, post, postExp };
  await info.attach(`${name}.json`, { body: JSON.stringify({ summary, trace }, null, 1), contentType: 'application/json' });
  // One line for the console report — enough to tell the failures apart.
  // eslint-disable-next-line no-console
  console.log(`[nl] ${name}: frames=${trace.length} on=${on} bad=${nBad} offDrawn=${nOff}` +
    (bad ? ` firstBad@${bad.t - trace[0].t}ms lastBad@${lastBadT(trace) - trace[0].t}ms gestureEnd@${tEnd - trace[0].t}ms ${JSON.stringify(bad)}` : '') +
    ` | post=${JSON.stringify(post)} exp=${JSON.stringify(postExp)} pre=${JSON.stringify({ instr: pre.instr, seg: pre.segments, mode: pre.mode })} preExp=${JSON.stringify(preExp)}`);

  expect.soft(nBad, `${name}: frames with no drawn lines while a net is lit and mode=${post.mode} (first: ${JSON.stringify(bad)})`).toBe(0);
  expect.soft(nOff, `${name}: frames with lines still drawn while mode=off`).toBe(0);
  expect.soft(post.hidden, `${name}: netLinesHiddenForZoom still set 500 ms after the gesture`).toBe(false);
  if (post.mode !== 'off' && post.net) {
    expect.soft(post.instr, `${name}: lines drawn 500 ms after the gesture`).toBeGreaterThan(0);
    expect.soft(Math.abs(post.width - post.wantWidth) / post.wantWidth, `${name}: stroke at the current scale's width`).toBeLessThan(0.02);
    expect.soft(postExp.same, `${name}: drawn segments are the current mode's (${postExp.cur} drawn vs ${postExp.fresh} fresh)`).toBe(true);
  }
  return summary;
}

// ─── scenario table ──────────────────────────────────────────────────────────

export function defineScenarios(engine: Engine) {
  ENGINE = engine;
  const MODES: Mode[] = ['star', 'chain', 'chain-adjacent'];
  for (const mode of MODES) {
    for (const re of [false, true]) {
      const tag = `${mode}${re ? ' +reselect' : ''}`;
      test.describe(`mode ${tag}`, () => {
        test(`(0) the switch itself draws the new mode [report 3]`, async ({ page }, info) => {
          await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} idle`, async () => { await page.waitForTimeout(300); });
        });
        test(`(a) wheel zoom in 6, out 6`, async ({ page }, info) => {
          const at = await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} wheel`, () => wheelZoom(page, at));
        });
        test(`(b) mouse drag pan 300 px with inertia`, async ({ page }, info) => {
          const at = await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} pan`, () => dragPan(page, at));
        });
        test(`(c) two-finger pinch in then out`, async ({ page }, info) => {
          const at = await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} pinch`, () => pinch(page, engine, at));
        });
        test(`(d) WebKit gesture stream`, async ({ page }, info) => {
          const at = await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} gesture`, () => gestureStream(page, at));
        });
        test(`(e) pan then zoom, zoom then pan, no idle gap`, async ({ page }, info) => {
          const at = await setup(page);
          await switchTo(page, mode, re);
          await runScenario(page, info, `${tag} pan+zoom`, async () => {
            await dragPan(page, at, 200, 60);
            await wheel(page, -120); await wheel(page, -120);
            await page.waitForTimeout(20);
            await wheel(page, 120);
            await dragPan(page, at, -200, -60);
          });
        });
      });
    }
  }

  test.describe('settings', () => {
    for (const key of ['netLinePulse', 'netLineDashed'] as const) {
      for (const mode of MODES) {
        test(`(f) ${key} on, ${mode}: pan + wheel zoom`, async ({ page }, info) => {
          const at = await setup(page);
          await page.evaluate((key) => { const rs = (window as any).__renderSettings; rs.applyGlobal({ ...rs.globalSettings, [key]: true }); }, key);
          await page.waitForTimeout(400);
          await switchTo(page, mode, false);
          await runScenario(page, info, `${key} ${mode}`, async () => {
            await dragPan(page, at, 250, 0);
            await wheelZoom(page, at, 4);
            await pinch(page, engine, at);
          });
        });
      }
    }
  });

  test('(g) mode switch DURING a wheel zoom', async ({ page }, info) => {
    const at = await setup(page);
    await runScenario(page, info, 'switch mid-zoom', async () => {
      await page.mouse.move(at.x, at.y); lastMouse = at;
      for (let i = 0; i < 8; i++) {
        await wheel(page, i < 4 ? -120 : 120);
        await page.waitForTimeout(25);
        await page.evaluate(() => { const st = (window as any).__boardStore; st.cycleNetLineMode(); if (st.netLineMode === 'off') st.cycleNetLineMode(); });
      }
    });
  });

  test('(g2) mode switch DURING a pinch', async ({ page }, info) => {
    const at = await setup(page);
    await runScenario(page, info, 'switch mid-pinch', async () => {
      const p = pinch(page, engine, at);
      for (let i = 0; i < 4; i++) {
        await page.waitForTimeout(60);
        await page.evaluate(() => { const st = (window as any).__boardStore; st.cycleNetLineMode(); if (st.netLineMode === 'off') st.cycleNetLineMode(); });
      }
      await p;
    });
  });

  test('(h) off and back during a pan', async ({ page }, info) => {
    const at = await setup(page);
    await runScenario(page, info, 'off+back mid-pan', async () => {
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      for (let i = 1; i <= 12; i++) {
        await page.mouse.move(at.x + 25 * i, at.y);
        await page.waitForTimeout(16);
        if (i === 4) await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'off') st.cycleNetLineMode(); });
        if (i === 8) await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'star') st.cycleNetLineMode(); });
      }
      await page.mouse.up();
      await wheelZoom(page, at, 3);
    });
  });

  test('(h2) off, zoom while off, back on (no reselect), zoom', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'off') st.cycleNetLineMode(); });
    await wheelZoom(page, at, 3);
    await page.waitForTimeout(300);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'star') st.cycleNetLineMode(); });
    await page.waitForTimeout(150);
    await runScenario(page, info, 'off-zoom-on', () => wheelZoom(page, at, 3));
  });

  test('(h3) select while off, switch on, re-select, zoom', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'off') st.cycleNetLineMode(); });
    await reselect(page);
    await page.waitForTimeout(150);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'star') st.cycleNetLineMode(); });
    await reselect(page);
    await page.waitForTimeout(150);
    await runScenario(page, info, 'select-off-on-reselect', async () => {
      await page.waitForTimeout(200);
      await dragPan(page, at, 120, 0);
      await wheelZoom(page, at, 3);
    });
  });

  test('(i) no focus (hasFocus=false) and a visibilitychange round trip', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false }); });
    await runScenario(page, info, 'no-focus', async () => {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(200);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await switchTo(page, 'chain', false);
      await wheelZoom(page, at, 4);
      await dragPan(page, at, 200, 0);
      await pinch(page, engine, at);
    });
  });

  test('(j) a settings rebuild while lit, then zoom', async ({ page }, info) => {
    const at = await setup(page);
    await runScenario(page, info, 'rebuild-then-zoom', async () => {
      await page.evaluate(() => { const rs = (window as any).__renderSettings; rs.applyGlobal({ ...rs.globalSettings, pinSizeScale: (rs.globalSettings.pinSizeScale ?? 1) * 1.1 }); });
      await page.waitForTimeout(400);
      await wheelZoom(page, at, 4);
      await switchTo(page, 'chain', false);
      await dragPan(page, at, 150, 0);
      await wheelZoom(page, at, 3);
    });
  });
  // A net WITH one-hop neighbours (USB_P: 5 pins, 2 adjacent nets), so the
  // chain-adjacent ↔ chain/off transitions change adjacentNets.size — the one
  // mode transition onBoardUpdate's lastRenderedSel compare does notice.
  test('(k) adjacency net: star→chain→chain-adjacent→off→star with gestures between', async ({ page }, info) => {
    const at = await setup(page, 'USB_P');
    await runScenario(page, info, 'adjacency lap', async () => {
      for (let i = 0; i < 4; i++) {
        await page.evaluate(() => (window as any).__boardStore.cycleNetLineMode());
        await page.waitForTimeout(120);
        await info.attach(`lap-${i}.json`, { body: JSON.stringify({ s: await sample(page, `after cycle ${i}`), e: await expected(page) }), contentType: 'application/json' });
        // eslint-disable-next-line no-console
        console.log(`[nl] adjacency lap step ${i}: ${JSON.stringify(await sample(page))} exp=${JSON.stringify(await expected(page))}`);
        await wheelZoom(page, at, 2);
        await dragPan(page, at, i % 2 ? -120 : 120, 0);
      }
    });
  });

  // The ribbon button pressed for real (tap on touch, click on desktop), and
  // the board then driven by touch, ending with a tap during the glide —
  // which is how an iPad user stops a fling.
  test('(l) real ribbon button + touch pan + tap during the glide', async ({ page }, info) => {
    const at = await setup(page);
    const btn = page.locator('.board-netlines-toggle').first();
    await runScenario(page, info, 'ribbon+touch', async () => {
      for (let i = 0; i < 4; i++) {
        if (ENGINE === 'webkit') await btn.tap(); else await btn.click();
        await page.waitForTimeout(150);
        if (ENGINE === 'chromium') {
          const cdp = await page.context().newCDPSession(page);
          await cdpTouch(cdp, 'touchStart', [at]);
          for (let k = 1; k <= 8; k++) { await cdpTouch(cdp, 'touchMove', [{ x: at.x + 30 * k, y: at.y }]); await page.waitForTimeout(8); }
          await cdpTouch(cdp, 'touchEnd', []);
          await page.waitForTimeout(60);
          // the stopping tap, on empty board near the corner
          await cdpTouch(cdp, 'touchStart', [{ x: at.x - 400, y: at.y - 300 }]);
          await cdpTouch(cdp, 'touchEnd', []);
          await cdp.detach();
        } else {
          await ptr(page, 'pointerdown', 0, at);
          for (let k = 1; k <= 8; k++) { await ptr(page, 'pointermove', 0, { x: at.x + 30 * k, y: at.y }); await page.waitForTimeout(8); }
          await ptr(page, 'pointerup', 0, { x: at.x + 240, y: at.y });
        }
        await page.waitForTimeout(200);
      }
    });
  });
  // Rotation unlocked (session state; one 12° turn unlocks it, and nothing
  // re-locks it but a two-finger double-tap), then an ordinary pinch whose
  // fingers twist a few degrees, as a hand's do. A live rotation clears the
  // lines on every zoom frame (onZoomFrame, liveRotate.engaged branch).
  test('(m) rotation unlocked: a pinch with a 6° twist', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(async () => { const m = await import('/src/store/rotation-lock-store.ts'); m.rotationLockStore.setLocked(false); });
    const d0 = 200;
    const pts = (d: number, deg: number): Pt[] => {
      const a = deg * Math.PI / 180;
      return [{ x: at.x - d * Math.cos(a), y: at.y - d * Math.sin(a) }, { x: at.x + d * Math.cos(a), y: at.y + d * Math.sin(a) }];
    };
    await runScenario(page, info, 'unlocked twist pinch', async () => {
      const steps = 20;
      if (ENGINE === 'chromium') {
        const cdp = await page.context().newCDPSession(page);
        await cdpTouch(cdp, 'touchStart', [pts(d0, 0)[0]]);
        await cdpTouch(cdp, 'touchStart', pts(d0, 0));
        for (let i = 1; i <= steps; i++) { await cdpTouch(cdp, 'touchMove', pts(d0 * (1 + 0.6 * i / steps), 6 * i / steps)); await page.waitForTimeout(16); }
        await cdpTouch(cdp, 'touchEnd', [pts(d0 * 1.6, 6)[0]]);
        await cdpTouch(cdp, 'touchEnd', []);
        await cdp.detach();
      } else {
        const [a0, b0] = pts(d0, 0);
        await ptr(page, 'pointerdown', 0, a0); await ptr(page, 'pointerdown', 1, b0);
        for (let i = 1; i <= steps; i++) { const [a, b] = pts(d0 * (1 + 0.6 * i / steps), 6 * i / steps); await ptr(page, 'pointermove', 0, a); await ptr(page, 'pointermove', 1, b); await page.waitForTimeout(16); }
        const [a1, b1] = pts(d0 * 1.6, 6);
        await ptr(page, 'pointerup', 1, b1); await ptr(page, 'pointerup', 0, a1);
      }
    });
  });

  test('(m2) rotation unlocked: WebKit gesture stream with a 6° twist', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(async () => { const m = await import('/src/store/rotation-lock-store.ts'); m.rotationLockStore.setLocked(false); });
    const fire = (type: string, scale: number, rotation: number) => page.evaluate(({ type, scale, rotation, at }) => {
      const r = (window as any).__boardRenderer;
      const ev = new MouseEvent(type, { clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'scale', { value: scale });
      Object.defineProperty(ev, 'rotation', { value: rotation });
      r.containerEl.dispatchEvent(ev);
    }, { type, scale, rotation, at });
    await runScenario(page, info, 'unlocked twist gesture', async () => {
      await fire('gesturestart', 1, 0);
      for (let i = 1; i <= 20; i++) { await fire('gesturechange', 1 + 0.6 * i / 20, 6 * i / 20); await page.waitForTimeout(16); }
      await fire('gestureend', 1.6, 6);
    });
  });

  // The user's sequence: press the ribbon button through a full lap while a
  // net is lit. Every press should change the drawing at once.
  test('(n) each mode press changes the drawing at once (off clears, on draws)', async ({ page }, info) => {
    await setup(page, 'USB_P');
    const seen: string[] = [];
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => (window as any).__boardStore.cycleNetLineMode());
      await page.waitForTimeout(120);
      const s = await sample(page); const e = await expected(page);
      seen.push(`${s.mode}: instr=${s.instr} seg=${s.segments} fresh=${e.fresh} same=${e.same}`);
      if (s.mode === 'off') expect.soft(s.instr, `press ${i}: mode off but lines still drawn`).toBe(0);
      else {
        expect.soft(s.instr, `press ${i}: mode ${s.mode} but nothing drawn`).toBeGreaterThan(0);
        expect.soft(e.same, `press ${i}: mode ${s.mode} drawn with another mode's segments`).toBe(true);
      }
    }
    await info.attach('presses.txt', { body: seen.join('\n'), contentType: 'text/plain' });
    // eslint-disable-next-line no-console
    console.log('[nl] presses:\n  ' + seen.join('\n  '));
  });

  // Phantom lines in 'off' (left over from the previous mode) are dropped by
  // the first segment recompute — which a gesture can cause. That is a
  // vanish "on zoom" that the user did not ask for at that moment.
  test('(o) lines left on screen after switching to off vanish on the next recompute (keyboard zoom)', async ({ page }, info) => {
    const at = await setup(page);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'off') st.cycleNetLineMode(); });
    await page.waitForTimeout(150);
    const phantom = await sample(page, 'off');
    // eslint-disable-next-line no-console
    console.log(`[nl] off right after the press: instr=${phantom.instr} seg=${phantom.segments}`);
    expect.soft(phantom.instr, 'mode off: lines should be cleared at the press').toBe(0);
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() => (window as any).__boardRenderer.zoomKeyboard('in'));
    await page.waitForTimeout(400);
    const after = await sample(page, 'after keyboard zoom');
    // eslint-disable-next-line no-console
    console.log(`[nl] off after keyboard zoom: instr=${after.instr} seg=${after.segments}`);
    await page.evaluate(() => { const st = (window as any).__boardStore; while (st.netLineMode !== 'star') st.cycleNetLineMode(); });
    await page.waitForTimeout(150);
    const back = await sample(page, 'star again');
    // eslint-disable-next-line no-console
    console.log(`[nl] star again, no reselect: instr=${back.instr} seg=${back.segments}`);
    expect.soft(back.instr, 'star again: lines drawn without a re-selection').toBeGreaterThan(0);
    await runScenario(page, info, 'star after off', () => wheelZoom(page, at, 3));
  });
}
