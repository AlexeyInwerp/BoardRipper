/**
 * 3D view (three3d/): the ribbon's cube button swaps a board tab to 3D, parts
 * are drawn from the package estimator, and a click in 3D selects through the
 * ordinary store action — so the 2D view and the sidebar follow. Back to 2D
 * removes the WebGL view. Public KiCad sample, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
// headless Chromium gives three.js no WebGL 2 context without SwiftShader
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

async function openBoard(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await page.waitForFunction(() => (window as unknown as { __boardStore?: { board: unknown } }).__boardStore?.board, null, { timeout: 30000 });
}

type Cam = { dist: number; target: [number, number, number]; pos: [number, number, number]; leftDrag: 'orbit' | 'pan' };
type W = { __board3d?: { renderer: { cameraState(): Cam; screenOfPin(a: number, b: number): [number, number] | null; focusPart(i: number): void; drawnParts: number; screenOf(i: number): [number, number] | null; part(i: number): { name: string; est: { family: string } } | undefined } }; __boardStore?: { selection: { partIndex: number | null }; board: { parts: { name: string; pins: unknown[] }[] } } };

test('3D view: toggle, draws estimated parts, a click selects, back to 2D', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await expect(page.getByTestId('board-3d')).toBeVisible();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  const drawn = await page.evaluate(() => (window as unknown as W).__board3d!.renderer.drawnParts);
  expect(drawn).toBeGreaterThan(20);   // tomu-fpga: 52 parts, test points draw nothing
  await expect(page.locator('.board-3d-canvas')).toHaveCount(1);

  // click the biggest part (the FPGA) from straight above, where nothing covers it
  await page.getByTestId('board-3d-top').click();
  await page.waitForTimeout(700);
  const target = await page.evaluate(() => {
    const w = window as unknown as W; const parts = w.__boardStore!.board.parts;
    let best = -1; parts.forEach((p, i) => { if (w.__board3d!.renderer.part(i) && (best < 0 || p.pins.length > parts[best].pins.length)) best = i; });
    return { index: best, xy: w.__board3d!.renderer.screenOf(best) };
  });
  expect(target.xy).not.toBeNull();
  await page.mouse.click(target.xy![0], target.xy![1]);
  await expect.poll(() => page.evaluate(() => (window as unknown as W).__boardStore!.selection.partIndex)).toBe(target.index);

  await page.getByTestId('view3d-btn').click();
  await expect(page.getByTestId('board-3d')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('3D view: zoom, pan and drag-mode controls', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const cam = () => page.evaluate(() => (window as unknown as W).__board3d!.renderer.cameraState());
  const d0 = (await cam()).dist;
  await page.getByTestId('board-3d-zoom-in').click(); await page.waitForTimeout(600);
  const d1 = (await cam()).dist; expect(d1).toBeLessThan(d0 * 0.8);
  await page.getByTestId('board-3d-zoom-out').click(); await page.waitForTimeout(600);
  expect((await cam()).dist).toBeGreaterThan(d1 * 1.2);
  const t0 = (await cam()).target;
  const hostBox = (await page.locator('.board-3d-host').boundingBox())!;
  await page.mouse.move(hostBox.x + hostBox.width / 2, hostBox.y + hostBox.height / 2);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(600);
  const t1 = (await cam()).target; expect(Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2])).toBeGreaterThan(0.5);
  await page.getByTestId('board-3d-fit').click(); await page.waitForTimeout(600);
  expect(Math.hypot(...(await cam()).target)).toBeLessThan(0.01);
  // keys while the pointer is over the view
  const box = (await page.locator('.board-3d-host').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const d2 = (await cam()).dist; await page.keyboard.press('+'); await page.waitForTimeout(600);
  expect((await cam()).dist).toBeLessThan(d2 * 0.8);
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(600);
  expect(Math.hypot(...(await cam()).target)).toBeGreaterThan(0.5);
  expect((await cam()).leftDrag).toBe('orbit');
  await page.getByTestId('board-3d-drag-mode').click();
  expect((await cam()).leftDrag).toBe('pan');
});

test('3D view: the ribbon carries the 3D controls; a click on a land lights its net', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  // 2D-only ribbon buttons step aside, the Side switch turns into the camera switch
  await expect(page.getByTestId('side-switch-3d')).toBeVisible();
  await expect(page.getByTestId('side-switch')).toHaveCount(0);
  await expect(page.getByTestId('butterfly-btn')).toHaveCount(0);
  await expect(page.locator('.board-3d-toolbar')).toHaveCount(0);
  // a test point (a land with no body), else a two-pin chip's end cap (a body over its own land), on either side
  const pick = await page.evaluate(() => {
    const st = (window as unknown as { __boardStore: { board: { parts: { name: string; side: string; pins: { net: string }[] }[] } } }).__boardStore;
    let i = st.board.parts.findIndex(p => p.pins.length === 1 && p.pins[0].net && /^TP/.test(p.name));
    if (i < 0) i = st.board.parts.findIndex(p => p.pins.length === 2 && p.pins.every(q => q.net) && /^[RC]\d/.test(p.name));
    return { i, side: st.board.parts[i]?.side, net: st.board.parts[i]?.pins[0].net };
  });
  test.skip(pick.i < 0, 'no test point or chip on this board');
  const sideBtn = pick.side === 'bottom' ? 'board-3d-bottom' : 'board-3d-top';
  await page.getByTestId(sideBtn).click(); await page.waitForTimeout(700);
  await expect(page.getByTestId(sideBtn)).toHaveAttribute('aria-pressed', 'true');
  // centre the part first: at this viewport the ribbon wraps onto a second row, and a land near the top edge sits under it
  await page.evaluate(i => (window as unknown as W).__board3d!.renderer.focusPart(i), pick.i); await page.waitForTimeout(700);
  const target = { ...pick, xy: await page.evaluate(i => (window as unknown as W).__board3d!.renderer.screenOfPin(i, 0), pick.i) };
  expect(target.xy).not.toBeNull();
  await page.mouse.click(target.xy![0], target.xy![1]);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __boardStore: { selection: { highlightedNet: string | null } } }).__boardStore.selection.highlightedNet)).toBe(target.net);
  // back to 2D: the ribbon is the 2D one again
  await page.getByTestId('view3d-btn').click();
  await expect(page.getByTestId('side-switch')).toBeVisible();
});

test('3D view: a scroll pans, Ctrl+scroll zooms', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  await page.waitForTimeout(600);
  const cam = () => page.evaluate(() => (window as unknown as W).__board3d!.renderer.cameraState());
  const box = (await page.locator('.board-3d-host').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const a = await cam(); await page.mouse.wheel(0, 150); await page.waitForTimeout(400);
  const b = await cam();
  expect(Math.hypot(b.target[0] - a.target[0], b.target[1] - a.target[1], b.target[2] - a.target[2])).toBeGreaterThan(0.2);
  expect(Math.abs(b.dist - a.dist)).toBeLessThan(a.dist * 0.02);   // a pan, not a zoom
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -300); await page.keyboard.up('Control'); await page.waitForTimeout(500);
  expect((await cam()).dist).toBeLessThan(b.dist * 0.95);
});

test('3D view: turning is free — a drag carries on over the top to the underside', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  await page.getByTestId('board-3d-top').click(); await page.waitForTimeout(700);
  const cam = () => page.evaluate(() => (window as unknown as W).__board3d!.renderer.cameraState());
  expect((await cam()).pos[1]).toBeGreaterThan(0);
  const box = (await page.locator('.board-3d-host').boundingBox())!;
  const x = box.x + box.width / 2, y0 = box.y + box.height * 0.15;
  await page.mouse.move(x, y0); await page.mouse.down();
  for (let k = 1; k <= 30; k++) await page.mouse.move(x, y0 + box.height * 0.7 * k / 30);
  await page.mouse.up(); await page.waitForTimeout(1200);
  // an orbit control stops at the pole; a trackball goes over it and below the board
  expect((await cam()).pos[1]).toBeLessThan(0);
});

test('3D view: a drag turns about the point pressed, and circles never tilt the board', async ({ page }) => {
  test.setTimeout(90000);
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  await page.waitForTimeout(700);
  const box = (await page.locator('.board-3d-host').boundingBox())!;
  // press off-centre on the board and drag: that point is the pivot and stays where it was pressed
  const x0 = box.x + box.width * 0.42, y0 = box.y + box.height * 0.55;
  await page.mouse.move(x0, y0); await page.mouse.down();
  for (let k = 1; k <= 15; k++) await page.mouse.move(x0 + k * 14, y0 + k * 5);
  await page.mouse.up(); await page.waitForTimeout(300);
  const pivot = await page.evaluate(() => (window as unknown as { __board3d: { renderer: { lastPivot: [number, number, number] | null } } }).__board3d.renderer.lastPivot);
  expect(pivot).not.toBeNull();
  const at = await page.evaluate(p => (window as unknown as { __board3d: { renderer: { project(p: [number, number, number]): [number, number] } } }).__board3d.renderer.project(p), pivot!);
  expect(Math.hypot(at[0] - x0, at[1] - y0)).toBeLessThan(3);
  // three circles of the pointer: a turntable has no roll to accumulate
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx + 120, cy); await page.mouse.down();
  for (let k = 1; k <= 3 * 24; k++) { const a = k * Math.PI / 12; await page.mouse.move(cx + 120 * Math.cos(a), cy + 120 * Math.sin(a)); }
  await page.mouse.up(); await page.waitForTimeout(300);
  const roll = await page.evaluate(() => (window as unknown as { __board3d: { renderer: { cameraState(): { roll: number } } } }).__board3d.renderer.cameraState().roll);
  expect(Math.abs(roll)).toBeLessThan(0.01);
});

test('3D view: net lines follow the ribbon mode; the settings menu changes colours and persists', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  type R = { selectionStats(): { netLineSegments: number; markers: number; outlines: number; litLands: number } };
  const stats = () => page.evaluate(() => (window as unknown as { __board3d: { renderer: R } }).__board3d.renderer.selectionStats());
  // light a net with several parts on it (not GND: lines are skipped there)
  await page.evaluate(() => {
    const st = (window as unknown as { __boardStore: { board: { parts: { pins: { net: string }[] }[] }; selectPin(i: number, k: number): void } }).__boardStore;
    const cnt = new Map<string, number>(); st.board.parts.forEach(p => p.pins.forEach(q => q.net && cnt.set(q.net, (cnt.get(q.net) ?? 0) + 1)));
    const net = [...cnt.entries()].filter(([n, c]) => c >= 4 && c <= 40 && !/GND/i.test(n)).sort((a, b) => b[1] - a[1])[0][0];
    const i = st.board.parts.findIndex(p => p.pins.some(q => q.net === net)); st.selectPin(i, st.board.parts[i].pins.findIndex(q => q.net === net));
  });
  await page.waitForTimeout(400);
  const off = await stats(); expect(off.netLineSegments).toBe(0); expect(off.litLands).toBeGreaterThan(1); expect(off.outlines).toBeGreaterThan(1);
  await page.getByTestId('netlines-btn').click(); await page.waitForTimeout(400);   // star
  expect((await stats()).netLineSegments).toBeGreaterThan(0);
  await page.getByTestId('netlines-btn').click(); await page.waitForTimeout(400);   // chain
  expect((await stats()).netLineSegments).toBeGreaterThan(0);
  // the settings menu: pick a net colour, it persists across a reload of the store
  await page.getByTestId('board-3d-settings').click();
  await expect(page.getByTestId('view3d-settings-menu')).toBeVisible();
  await page.getByTestId('view3d-netColour-magenta').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('boardripper-view3d') ?? '{}').netColour)).toBe('magenta');
  await page.keyboard.press('Escape');
  await page.evaluate(() => localStorage.removeItem('boardripper-view3d'));
});

test('3D view: hidden-side ghosts show the lit net\'s parts on the face the camera does not see', async ({ page }) => {
  await openBoard(page);
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 30000 });
  type R = { selectionStats(): { ghosts: number; ghostsVisible: number } };
  const stats = () => page.evaluate(() => (window as unknown as { __board3d: { renderer: R } }).__board3d.renderer.selectionStats());
  // a net with parts on both sides, not ground
  const pick = await page.evaluate(() => {
    const st = (window as unknown as { __boardStore: { board: { parts: { side: string; pins: { net: string }[] }[] }; selectPin(i: number, k: number): void } }).__boardStore;
    const sides = new Map<string, Set<string>>(); st.board.parts.forEach(p => p.pins.forEach(q => { if (!q.net || /GND/i.test(q.net)) return; let s = sides.get(q.net); if (!s) sides.set(q.net, (s = new Set())); s.add(p.side); }));
    const net = [...sides.entries()].find(([, s]) => s.size === 2)?.[0]; if (!net) return null;
    const i = st.board.parts.findIndex(p => p.pins.some(q => q.net === net)); st.selectPin(i, st.board.parts[i].pins.findIndex(q => q.net === net));
    return { net, side: st.board.parts[i].side };
  });
  test.skip(!pick, 'no net crosses the board on this fixture');
  await page.waitForTimeout(300);
  // the ribbon's ghost button cycles off → ghosts → disco; the app starts in ghosts
  const mode = () => page.evaluate(() => (window as unknown as { __boardStore: { ghostMode: string } }).__boardStore.ghostMode);
  while ((await mode()) !== 'off') { await page.getByTestId('ghosts-btn').click(); await page.waitForTimeout(200); }
  expect((await stats()).ghosts).toBe(0);                       // ghosts off: nothing drawn
  await page.getByTestId('ghosts-btn').click(); await page.waitForTimeout(300);
  expect(await mode()).toBe('ghosts');
  const on = await stats(); expect(on.ghosts).toBeGreaterThan(0);
  // each ghost shows from exactly one face — the one the camera does not see
  await page.getByTestId(pick!.side === 'bottom' ? 'board-3d-bottom' : 'board-3d-top').click(); await page.waitForTimeout(800);
  const fromOwn = (await stats()).ghostsVisible; expect(fromOwn).toBeGreaterThan(0);
  await page.getByTestId(pick!.side === 'bottom' ? 'board-3d-top' : 'board-3d-bottom').click(); await page.waitForTimeout(800);
  const fromFar = await stats(); expect(fromOwn + fromFar.ghostsVisible).toBe(fromFar.ghosts);
});

