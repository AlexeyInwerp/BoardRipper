/**
 * Switching the net-line mode must redraw the lines at once.
 *
 * Field report 2026-10-13 (iPad Safari): "switching its mode does not cause
 * it to re-render instantly — needs re-selection", and the lines "sometimes
 * vanish, mostly after switching the mode". The ribbon button calls
 * `boardStore.cycleNetLineMode()` (off → star → chain → chain-adjacent → off);
 * after each call, with nothing but a couple of animation frames in between —
 * no re-selection, no zoom, no pan — the drawn lines must be the new mode's:
 * star/chain draw segments (and differ from each other on a net of ≥ 3 parts),
 * chain-adjacent adds the adjacent-net colour, off leaves nothing on screen.
 * Run plain, with the pulse and with dashed lines (the last two take the
 * per-frame ticker path), and once through the real button.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../public/samples/tomu-fpga.kicad_pcb');

test.use({ viewport: { width: 1200, height: 900 } });

type LineState = {
  mode: string;
  segments: number;
  instr: number;
  vis: boolean;
  colors: number[];
  sig: string;
  adjacent: number;
  adjColor: number;
};

/** Drawn net-line geometry (as in net-lines-touch-unzoom.spec.ts) plus the
 *  segment set itself, so two modes can be told apart. */
const lineState = (page: Page): Promise<LineState> => page.evaluate(() => {
  const w = window as unknown as { __boardRenderer: Record<string, any>; __boardStore: Record<string, any>; __renderSettings: Record<string, any> };
  const r = w.__boardRenderer;
  const g = r.netLinesGfx;
  let vis = true;
  for (let o = g; o; o = o.parent) if (o.visible === false || o.alpha === 0) vis = false;
  const segs = r.netLineSegments as Array<{ start: { x: number; y: number }; end: { x: number; y: number }; color: number }>;
  const key = (p: { x: number; y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  return {
    mode: w.__boardStore.netLineMode as string,
    segments: segs.length,
    instr: (g.context.instructions.length as number) + ((r.netLinesPulseGfx?.context.instructions.length as number) ?? 0),
    vis,
    colors: [...new Set(segs.map(s => s.color))],
    sig: segs.map(s => [key(s.start), key(s.end)].sort().join('>')).sort().join('|'),
    adjacent: w.__boardStore.selection.adjacentNets.size as number,
    adjColor: w.__renderSettings.settings.adjacentNetLineColor as number,
  };
});

const frames = (page: Page, n = 3) => page.evaluate((n) => new Promise<void>(res => {
  let i = 0;
  const step = () => { if (++i >= n) res(); else requestAnimationFrame(step); };
  requestAnimationFrame(step);
}), n);

/** Load tomu, pick a non-GND net of ≥ 3 parts that has adjacent nets through
 *  2-pin parts (falling back to any ≥ 3-part net), light it via selectPin with
 *  the mode at 'off'. Returns what was chosen. */
async function setup(page: Page, extra: Record<string, unknown> = {}) {
  await page.goto('/');
  const dev = await page.evaluate(() => '__boardStore' in window);
  test.skip(!dev, 'DEV-only globals');
  await page.evaluate((extra) => {
    const rs = (window as unknown as { __renderSettings: Record<string, any> }).__renderSettings;
    rs.applyGlobal({ ...rs.globalSnapshot(), netLinePulse: false, netLineDashed: false, ...extra });
  }, extra);
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const pick = await page.evaluate(() => {
    const st = (window as unknown as { __boardStore: Record<string, any> }).__boardStore;
    // Search in chain-adjacent so selection.adjacentNets is populated.
    while (st.netLineMode !== 'chain-adjacent') st.cycleNetLineMode();
    const b = st.board;
    type C = { pi: number; i: number; net: string; parts: number; adj: number };
    let best: C | null = null;
    const seen = new Set<string>();
    b.parts.forEach((p: any, pi: number) => p.pins.forEach((pin: any, i: number) => {
      const net = pin.net as string | undefined;
      if (!net || seen.has(net) || /GND/i.test(net)) return;
      seen.add(net);
      const ni = b.nets.get(net);
      if (!ni || ni.pinIndices.length < 3 || ni.pinIndices.length > 40) return;
      const parts = new Set(ni.pinIndices.map((r: any) => r.partIndex)).size;
      if (parts < 3) return;
      st.selectPin(pi, i);
      const adj = st.selection.adjacentNets.size as number;
      const score = (c: C) => (c.adj > 0 ? 1000 : 0) + c.parts;
      const c = { pi, i, net, parts, adj };
      if (!best || score(c) > score(best)) best = c;
    }));
    // Back to off, then light the chosen net fresh with the mode off.
    while (st.netLineMode !== 'off') st.cycleNetLineMode();
    st.selectPart(null);
    return best as C | null;
  });
  expect(pick, 'a ≥ 3-part non-GND net on tomu').not.toBeNull();
  await page.waitForTimeout(300);
  await page.evaluate(({ pi, i }) => {
    (window as unknown as { __boardStore: Record<string, any> }).__boardStore.selectPin(pi, i);
  }, pick!);
  await page.waitForTimeout(400);
  const base = await lineState(page);
  expect(base.mode).toBe('off');
  expect(base.segments, 'baseline: mode off draws nothing').toBe(0);
  expect(base.instr).toBe(0);
  return pick!;
}

async function cycleAndCheck(page: Page, label: string, pick: { net: string; parts: number; adj: number }) {
  const states: Record<string, LineState> = {};
  for (const expected of ['star', 'chain', 'chain-adjacent', 'off']) {
    await page.evaluate(() => (window as unknown as { __boardStore: Record<string, any> }).__boardStore.cycleNetLineMode());
    await frames(page, 3);
    const st = await lineState(page);
    states[expected] = st;
    const at = `${label}: after switching to ${expected} (net ${pick.net}, ${pick.parts} parts, ${pick.adj} adjacent)`;
    expect.soft(st.mode, at).toBe(expected);
    if (expected === 'off') {
      expect.soft(st.segments, `${at} — no segments left`).toBe(0);
      expect.soft(st.instr, `${at} — old lines must not stay on screen`).toBe(0);
    } else {
      expect.soft(st.segments, `${at} — segments computed`).toBeGreaterThan(0);
      expect.soft(st.instr, `${at} — lines drawn`).toBeGreaterThan(0);
      expect.soft(st.vis, `${at} — layer visible`).toBe(true);
    }
    if (expected === 'chain' && pick.parts >= 3) {
      expect.soft(st.sig, `${at} — chain segment set differs from star`).not.toBe(states.star.sig);
    }
    if (expected === 'chain-adjacent') {
      if (st.adjacent > 0) {
        expect.soft(st.colors, `${at} — adjacent-net coloured segments`).toContain(st.adjColor);
      } else {
        test.info().annotations.push({ type: 'note', description: `${pick.net} has no adjacent nets on tomu; only segments > 0 asserted` });
      }
    }
  }
  return states;
}

for (const [label, extra] of [
  ['plain', {}],
  ['pulse', { netLinePulse: true }],
  ['dashed', { netLineDashed: true }],
] as const) {
  test(`net lines follow every mode switch at once (${label})`, async ({ page }) => {
    const pick = await setup(page, extra);
    await cycleAndCheck(page, label, pick);
  });
}

test('the ribbon button draws the lines without any further interaction', async ({ page }) => {
  await setup(page);
  // NetLinesButton has no test id; .board-netlines-toggle is shared by every
  // ribbon toggle, so locate it by its title ("Net lines: …").
  const btn = page.locator('button.board-netlines-toggle[title^="Net lines:"]').first();
  await expect(btn).toBeVisible();
  await btn.click();
  await frames(page, 3);
  const st = await lineState(page);
  expect(st.mode).toBe('star');
  expect.soft(st.segments, 'segments after one click').toBeGreaterThan(0);
  expect.soft(st.instr, 'lines drawn after one click').toBeGreaterThan(0);
});

/** The other half of the report: lines that ARE on screen must follow the
 *  switch too, and "off" must take them away. Light the net with the mode
 *  already at star (lines drawn by the selection itself), then cycle. */
test('lines already drawn follow star → chain → chain-adjacent → off', async ({ page }) => {
  const pick = await setup(page);
  await page.evaluate(({ pi, i }) => {
    const st = (window as unknown as { __boardStore: Record<string, any> }).__boardStore;
    st.cycleNetLineMode(); // off → star (not drawn, see the tests above)
    st.selectPart(null);
    st.selectPin(pi, i);   // re-selection draws star
  }, pick);
  await frames(page, 3);
  const star = await lineState(page);
  expect(star.mode).toBe('star');
  expect(star.segments, 'control: re-selection draws star').toBeGreaterThan(0);
  expect(star.instr).toBeGreaterThan(0);
  const states: Record<string, LineState> = { star };
  for (const expected of ['chain', 'chain-adjacent', 'off']) {
    await page.evaluate(() => (window as unknown as { __boardStore: Record<string, any> }).__boardStore.cycleNetLineMode());
    await frames(page, 3);
    const st = await lineState(page);
    states[expected] = st;
    const at = `drawn: after switching to ${expected} (net ${pick.net}, ${pick.parts} parts, ${pick.adj} adjacent)`;
    expect.soft(st.mode, at).toBe(expected);
    if (expected === 'chain') expect.soft(st.sig, `${at} — segment set changed from star`).not.toBe(star.sig);
    if (expected === 'chain-adjacent' && st.adjacent > 0) expect.soft(st.colors, `${at} — adjacent colour`).toContain(st.adjColor);
    if (expected === 'off') {
      expect.soft(st.segments, `${at} — no segments left`).toBe(0);
      expect.soft(st.instr, `${at} — old lines must not stay on screen`).toBe(0);
    }
  }
});
