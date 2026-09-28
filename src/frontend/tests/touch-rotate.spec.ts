/**
 * Two-finger rotation on the board: turning the pair turns the board, live,
 * about the point between the fingers; the angle is committed when the
 * fingers lift — snapped to a right angle when within 10°, kept otherwise —
 * and the point between the fingers stays where it was through the commit.
 *
 * Rotation starts LOCKED: a turn under 12° does nothing (every pinch turns a
 * little), a turn past it unlocks with a toast and the board turns on from
 * there, no catch-up. A two-finger double-tap locks again and squares the
 * board. So the first 45° gesture leaves the board at 33°; every later one
 * turns the full amount.
 *
 * Real touches through CDP, like touch-pinch-zoom.spec.ts: the pointer pair
 * is what iPadOS delivers when it does not claim the gesture itself; the
 * WebKit gesture stream has its own case in touch-webkit.webkit.spec.ts.
 */
import { test, expect, type Page, type CDPSession } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const have = fs.existsSync(BOARD);

type Pt = { x: number; y: number };

test.use({ hasTouch: true, viewport: { width: 1200, height: 900 } });

async function touch(cdp: CDPSession, type: string, points: Pt[]) {
  await cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i })),
  });
}

async function zoom(page: Page): Promise<number> {
  const txt = await page.locator('.board-hud').first().textContent();
  const m = /(\d+)%/.exec(txt ?? '');
  if (!m) throw new Error(`no zoom in HUD: ${JSON.stringify(txt)}`);
  return Number(m[1]);
}

async function load(page: Page): Promise<Pt> {
  test.skip(!have, 'sample board not present');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  const devHooks = await page.evaluate(
    () => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const b = (await page.locator('.board-panel-canvas').boundingBox())!;
  return { x: b.x + b.width / 2 + 120, y: b.y + b.height / 2 + 60 };   // off-centre on purpose
}

const storeRotation = (page: Page) => page.evaluate(
  () => (window as unknown as { __boardStore: { rotation: number } }).__boardStore.rotation);
const rootDeg = (page: Page) => page.evaluate(() => {
  const r = (window as unknown as { __boardRenderer?: { activeScene?: { root: { rotation: number } } } }).__boardRenderer;
  return (r?.activeScene?.root.rotation ?? 0) * 180 / Math.PI;
});

/** Board-local point under a page position, and where that local point is
 *  on the page now — the pair that says whether the anchor held. */
const localUnder = (page: Page, at: Pt) => page.evaluate((at) => {
  const el = document.querySelector('.board-panel-canvas')!.getBoundingClientRect();
  const r = (window as unknown as { __boardRenderer: { activeScene: { root: { toLocal(p: Pt): Pt } } } }).__boardRenderer;
  return r.activeScene.root.toLocal({ x: at.x - el.left, y: at.y - el.top });
}, at);
const pageOf = (page: Page, local: Pt) => page.evaluate((local) => {
  const el = document.querySelector('.board-panel-canvas')!.getBoundingClientRect();
  const r = (window as unknown as { __boardRenderer: { activeScene: { root: { toGlobal(p: Pt): Pt } } } }).__boardRenderer;
  const g = r.activeScene.root.toGlobal(local);
  return { x: g.x + el.left, y: g.y + el.top };
}, local);

/** Two fingers on a circle of radius `r0` about `at`, turned by `deg`
 *  (clockwise on screen positive) while the radius goes to r0·spread. */
async function turn(page: Page, cdp: CDPSession, at: Pt, deg: number, steps: number, spread = 1, hold = 0) {
  const r0 = 90;
  const fingers = (a: number, r: number): Pt[] => [
    { x: at.x + r * Math.cos(a), y: at.y + r * Math.sin(a) },
    { x: at.x - r * Math.cos(a), y: at.y - r * Math.sin(a) },
  ];
  await touch(cdp, 'touchStart', [fingers(0, r0)[0]]);
  await touch(cdp, 'touchStart', fingers(0, r0));
  for (let i = 1; i <= steps; i++) {
    const a = (deg * Math.PI / 180) * (i / steps);
    const r = r0 + (r0 * spread - r0) * (i / steps);
    await touch(cdp, 'touchMove', fingers(a, r));
    await page.waitForTimeout(8);
  }
  if (hold) await page.waitForTimeout(hold);
  await touch(cdp, 'touchEnd', [fingers(deg * Math.PI / 180, r0 * spread)[0]]);
  await touch(cdp, 'touchEnd', []);
  await page.waitForTimeout(400);
}

const locked = (page: Page) => page.evaluate(
  () => (window as unknown as { __rotationLock: { locked: boolean } }).__rotationLock.locked);

async function twoFingerTap(page: Page, cdp: CDPSession, at: Pt) {
  const a = { x: at.x - 40, y: at.y }, b = { x: at.x + 40, y: at.y };
  await touch(cdp, 'touchStart', [a]);
  await touch(cdp, 'touchStart', [a, b]);
  await page.waitForTimeout(40);
  await touch(cdp, 'touchEnd', [a]);
  await touch(cdp, 'touchEnd', []);
}

const UNLOCK = 12;
/** The unlock fires on the first move EVENT past 12°, and a CDP step of
 *  deg/steps arrives as two pointer moves (one per finger), so the board
 *  turns on from somewhere within one step past 12°. */
const slack = (deg: number, steps: number) => Math.abs(deg) / steps + 0.3;

test.describe('two-finger rotation', () => {
  test('locked at first: a 10° turn does nothing, a turn past 12° unlocks and says so', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    expect(await locked(page)).toBe(true);
    await turn(page, cdp, at, 10, 8);
    expect(await storeRotation(page)).toBe(0);
    expect(await locked(page)).toBe(true);
    // 30°, not 20: what is left after the 12° unlock must clear the ±10°
    // snap window around 0, or the release squares it back — correctly.
    await turn(page, cdp, at, 30, 8);
    expect(await locked(page)).toBe(false);
    await expect(page.locator('.toast', { hasText: /Rotation unlocked/ })).toBeVisible();
    expect(Math.abs((await storeRotation(page)) - (30 - UNLOCK))).toBeLessThanOrEqual(slack(30, 8));
  });

  test('a two-finger double-tap locks again and squares the board', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 45, 12);                  // unlocks, 33°
    expect(await locked(page)).toBe(false);
    await twoFingerTap(page, cdp, at);
    await page.waitForTimeout(120);
    await twoFingerTap(page, cdp, at);
    await page.waitForTimeout(300);
    expect(await locked(page)).toBe(true);
    expect(await storeRotation(page)).toBe(0);          // 33 → nearest right angle
    await expect(page.locator('.toast', { hasText: /Rotation locked/ })).toBeVisible();
    await turn(page, cdp, at, 10, 8);                   // locked again: nothing
    expect(await storeRotation(page)).toBe(0);
  });

  test('a single two-finger tap, or two far apart, do not toggle the lock', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await twoFingerTap(page, cdp, at);
    await page.waitForTimeout(700);
    await twoFingerTap(page, cdp, at);
    await page.waitForTimeout(300);
    expect(await locked(page)).toBe(true);
  });

  test('turning the fingers 45° turns the board 45°, live, and keeps it when they lift', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    expect(await storeRotation(page)).toBe(0);
    const local = await localUnder(page, at);

    await turn(page, cdp, at, 45, 12);
    const first = await storeRotation(page);
    expect(Math.abs(first - (45 - UNLOCK))).toBeLessThanOrEqual(slack(45, 12));
    expect(Math.abs((await rootDeg(page)) - first)).toBeLessThanOrEqual(0.2);
    // The point that was between the fingers is still there.
    const now = await pageOf(page, local);
    expect(Math.hypot(now.x - at.x, now.y - at.y)).toBeLessThan(4);
    // Unlocked now: the next gesture turns the full amount.
    await turn(page, cdp, at, 45, 12);
    expect(Math.abs((await storeRotation(page)) - first - 45)).toBeLessThanOrEqual(1);
  });

  test('the board follows the fingers while they are still down', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 30, 8);                   // unlock (→ ~18°)
    const base = await storeRotation(page);
    const r0 = 90;
    await touch(cdp, 'touchStart', [{ x: at.x + r0, y: at.y }]);
    await touch(cdp, 'touchStart', [{ x: at.x + r0, y: at.y }, { x: at.x - r0, y: at.y }]);
    for (let i = 1; i <= 8; i++) {
      const a = (30 * Math.PI / 180) * (i / 8);
      await touch(cdp, 'touchMove', [
        { x: at.x + r0 * Math.cos(a), y: at.y + r0 * Math.sin(a) },
        { x: at.x - r0 * Math.cos(a), y: at.y - r0 * Math.sin(a) },
      ]);
      await page.waitForTimeout(8);
    }
    // Chromium delivers touch moves frame-aligned, so the last one may land a
    // frame after the dispatch resolves — poll rather than read once.
    await expect.poll(async () => Math.abs((await rootDeg(page)) - base - 30), { timeout: 2000 }).toBeLessThanOrEqual(1);   // live …
    expect(await storeRotation(page)).toBe(base);                                            // … nothing committed yet
    await touch(cdp, 'touchEnd', []);
  });

  test('close to a right angle snaps to it', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 45, 12);                  // unlock (→ 33°)
    await turn(page, cdp, at, 51, 12);                  // 84° → snaps to 90
    expect(await storeRotation(page)).toBe(90);
    await turn(page, cdp, at, -84, 16);                 // 6° → snaps to 0
    expect(await storeRotation(page)).toBe(0);
  });

  test('a pinch-zoom that wobbles a few degrees does not rotate', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    const z0 = await zoom(page);
    await turn(page, cdp, at, 3, 10, 1.8);
    expect(await storeRotation(page)).toBe(0);
    expect(Math.abs((await rootDeg(page)))).toBeLessThan(0.01);
    expect((await zoom(page)) / z0).toBeGreaterThan(1.5);
  });

  test('the rotate buttons step to the next right angle from a free angle', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await turn(page, cdp, at, 45, 12);                  // unlock (→ 33°)
    await page.evaluate(() => (window as unknown as { __boardStore: { rotateCW(): void } }).__boardStore.rotateCW());
    expect(await storeRotation(page)).toBe(90);
    await turn(page, cdp, at, 45, 12);                  // 135°
    expect(await storeRotation(page)).toBe(135);
    await page.evaluate(() => (window as unknown as { __boardStore: { rotateCCW(): void } }).__boardStore.rotateCCW());
    expect(await storeRotation(page)).toBe(90);
  });

  /** The screen rotation the root's transform gained between two readings,
   *  degrees CW — a mirror in the transform cancels out, so a 180° turn of
   *  the bottom view's hinge shows up as 180 here. */
  const screenTurn = (m0: M, m1: M) => {
    const det = m0.a * m0.d - m0.b * m0.c;
    const inv = { a: m0.d / det, b: -m0.b / det, c: -m0.c / det, d: m0.a / det };
    const a = m1.a * inv.a + m1.c * inv.b;
    const b = m1.b * inv.a + m1.d * inv.b;
    return Math.atan2(b, a) * 180 / Math.PI;
  };
  type M = { a: number; b: number; c: number; d: number };
  const rootMatrix = (page: Page) => page.evaluate(() => {
    const r = (window as unknown as { __boardRenderer: { activeScene: { root: { worldTransform: M } } } }).__boardRenderer;
    type M = { a: number; b: number; c: number; d: number };
    const m = r.activeScene.root.worldTransform;
    return { a: m.a, b: m.b, c: m.c, d: m.d };
  });

  test('on the bottom side, turning past 45° and 135° never turns the view over', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('side-bottom').click();
    await page.waitForTimeout(300);
    // Three gestures of 45° each: the first unlocks (33°), then 78°, then
    // 123°. Each must be that turn of the picture on screen, never + 180.
    for (const [expected, tol] of [[45 - UNLOCK, slack(45, 12)], [45, 1.5], [45, 1.5]]) {
      const before = await rootMatrix(page);
      await turn(page, cdp, at, 45, 12);
      const d = screenTurn(before, await rootMatrix(page));
      expect(Math.abs(d - expected), `gesture turned the view by ${d.toFixed(1)}°`).toBeLessThanOrEqual(tol);
    }
    expect(Math.abs((await storeRotation(page)) - 123)).toBeLessThanOrEqual(slack(45, 12));
  });

  /** The bottom half's transform in the top half's frame: root⁻¹ · broot.
   *  A rigid turn of the whole spread multiplies both by the same matrix on
   *  the left and leaves this invariant; a re-layout changes it. */
  type M6 = { a: number; b: number; c: number; d: number; tx: number; ty: number };
  const halvesRelation = (page: Page) => page.evaluate(() => {
    type M6 = { a: number; b: number; c: number; d: number; tx: number; ty: number };
    const S = (window as unknown as { __boardRenderer: { activeScene: { root: { worldTransform: M6 }; butterflyRoot: { worldTransform: M6 } | null } } }).__boardRenderer.activeScene;
    const t = S.root.worldTransform, b = S.butterflyRoot?.worldTransform;
    if (!b) return null;
    const det = t.a * t.d - t.b * t.c;
    const i = { a: t.d / det, b: -t.b / det, c: -t.c / det, d: t.a / det };
    const itx = -(i.a * t.tx + i.c * t.ty), ity = -(i.b * t.tx + i.d * t.ty);
    return {
      a: i.a * b.a + i.c * b.b, b: i.b * b.a + i.d * b.b,
      c: i.a * b.c + i.c * b.d, d: i.b * b.c + i.d * b.d,
      tx: i.a * b.tx + i.c * b.ty + itx, ty: i.b * b.tx + i.d * b.ty + ity,
    };
  });
  const sameRelation = (p: M6, q: M6) =>
    ['a', 'b', 'c', 'd'].every(k => Math.abs(p[k as keyof M6] - q[k as keyof M6]) < 1e-3)
    && Math.abs(p.tx - q.tx) < 1 && Math.abs(p.ty - q.ty) < 1;

  test('in Butterfly, a free angle turns the whole spread rigidly — the halves keep their relation', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    await page.waitForTimeout(400);
    const before = await halvesRelation(page);
    expect(before).not.toBeNull();
    await turn(page, cdp, at, 45, 12);                  // unlock → ~33°, committed
    expect(await storeRotation(page)).toBeGreaterThan(20);
    const after = await halvesRelation(page);
    expect(sameRelation(before!, after!), `halves relation changed: ${JSON.stringify(before)} → ${JSON.stringify(after)}`).toBe(true);
    // And past 45°, where the nearest right angle changes: still the same spread.
    await turn(page, cdp, at, 40, 12);                  // ~73°
    const later = await halvesRelation(page);
    // Past 45° the nearest right angle is 90: a layout that follows it swaps
    // the separation axis and the bottom half's mirror hinge here.
    expect(sameRelation(before!, later!), `halves relation changed past 45°: before ${JSON.stringify(before)} → ${JSON.stringify(later)} at rotation ${await storeRotation(page)}`).toBe(true);
  });

  test('off in Settings, two fingers only zoom and pan', async ({ page }) => {
    const at = await load(page);
    const cdp = await page.context().newCDPSession(page);
    type RS = { globalSettings: object; settings: { twoFingerRotate: boolean }; applyGlobal(p: object): void };
    await page.evaluate(() => {
      const rs = (window as unknown as { __renderSettings?: RS }).__renderSettings;
      rs?.applyGlobal({ ...rs.globalSettings, twoFingerRotate: false });
    });
    const off = await page.evaluate(() => (window as unknown as { __renderSettings?: RS }).__renderSettings?.settings.twoFingerRotate);
    test.skip(off !== false, 'render settings store is not exposed for tests');
    await turn(page, cdp, at, 45, 12);
    expect(await storeRotation(page)).toBe(0);
  });
});
