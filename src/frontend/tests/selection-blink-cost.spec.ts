/**
 * A lookup that lights a huge net must not stall the app for seconds.
 *
 * The selection blink used to re-run the whole renderSelection() — every
 * member pin of the lit net, full geometry rebuild — thirteen times, 250 ms
 * apart, for three seconds, to animate the colour of the primary outline. On
 * a desktop that is ~28 ms a pass and invisible. On an A12Z iPad in WebKit,
 * with a 4077-pin GND lit from a PDF tap, each pass is several hundred ms and
 * the twelve of them saturate the main thread for the whole window: "tap
 * lookup blocks pan and zoom for 5–10 seconds". The blink now redraws only
 * the primary outline, which is the only thing its phase ever changed.
 *
 * This runs Chromium at 6x CPU throttle as a stand-in for the tablet and
 * samples main-thread latency after focusing the board's biggest net. Before
 * the fix that showed 200–300 ms stalls every ~300 ms for the full 3 s;
 * after, the initial draw remains and then nothing. Needs the proprietary
 * Allegro sample — a board small enough to ship cannot produce the cost.
 */
import { test, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/LA-P161PR1B.brd');

test('lighting the biggest net does not stall the main thread beyond its first draw', async ({ page, browserName }) => {
  test.skip(!fs.existsSync(BOARD), 'proprietary Allegro sample not present');
  test.skip(browserName !== 'chromium', 'CPU throttling is a CDP feature');
  test.setTimeout(240000);

  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  const devHooks = await page.evaluate(() => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 180000 });
  await page.waitForTimeout(3000);

  const rail = await page.evaluate(() => {
    const bd = (window as unknown as { __boardStore: { board: { nets: Map<string, { pinIndices: unknown[] }> } } }).__boardStore.board;
    let best = '', max = 0;
    for (const [k, v] of bd.nets) if (v.pinIndices.length > max) { max = v.pinIndices.length; best = k; }
    return { name: best, pins: max };
  });
  expect(rail.pins).toBeGreaterThan(1000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });

  await page.evaluate((n) =>
    (window as unknown as { __boardStore: { focusNet(n: string): void } }).__boardStore.focusNet(n), rail.name);

  // The first draw of a 4000-pin net, the 400 ms focus animation (five
  // ~200 ms frames at 6x throttle, to about +1.5 s) and the one settle
  // repaint at its end (~+2.0 s: a last render plus the React update of the
  // info panels) are all legitimate, one-off work. What must be quiet is
  // everything after that — the blink used to keep forcing full renders
  // until +3.4 s. Sample from +2.5 s.
  const t0 = Date.now();
  await page.waitForTimeout(2500);
  const stalls: string[] = [];
  while (Date.now() - t0 < 5500) {
    const a = Date.now();
    await page.evaluate(() => 0);
    const lat = Date.now() - a;
    if (lat > 150) stalls.push(`+${((a - t0) / 1000).toFixed(1)}s:${lat}ms`);
    await page.waitForTimeout(50);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // The bug was a TRAIN of stalls, one every 250 ms for three seconds. A
  // single isolated one — the settle repaint drifting into the window, a GC —
  // is not the bug and comes and goes with throttling jitter, so the
  // assertion is on the count, not on silence.
  expect(stalls.length, `sustained main-thread stalls after settle: ${stalls.join(' ')}`).toBeLessThanOrEqual(1);
});

/** A part focus does blink — the red flash is the point of it — but each
 *  phase forces a full scene render, and on a board where a render is heavy
 *  twelve of them over three seconds is the sluggishness that follows a tap
 *  on a reference. On such a board the blink is a single flash. */
test('focusing a part on a heavy board flashes once instead of forcing twelve renders', async ({ page, browserName }) => {
  test.skip(!fs.existsSync(BOARD), 'proprietary Allegro sample not present');
  test.skip(browserName !== 'chromium', 'CPU throttling is a CDP feature');
  test.setTimeout(240000);

  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  const devHooks = await page.evaluate(() => '__boardStore' in (window as unknown as Record<string, unknown>));
  test.skip(!devHooks, 'board store is a DEV-only global');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 180000 });
  await page.waitForTimeout(3000);

  const part = await page.evaluate(() => {
    const bd = (window as unknown as { __boardStore: { board: { parts: { name: string; pins: unknown[] }[] } } }).__boardStore.board;
    return bd.parts.filter(q => q.pins.length >= 20).sort((a, b) => b.pins.length - a.pins.length)[0]?.name ?? bd.parts[0].name;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  // One render first so the renderer has measured what a frame costs here.
  await page.evaluate((n) =>
    (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(n), part);
  await page.waitForTimeout(2500);
  await page.evaluate(() =>
    (window as unknown as { __boardStore: { selectPart(i: number | null): void } }).__boardStore.selectPart(null));
  await page.waitForTimeout(500);

  await page.evaluate((n) =>
    (window as unknown as { __boardStore: { focusPart(n: string): void } }).__boardStore.focusPart(n), part);
  const t0 = Date.now();
  await page.waitForTimeout(2000);
  const stalls: string[] = [];
  while (Date.now() - t0 < 5000) {
    const a = Date.now();
    await page.evaluate(() => 0);
    const lat = Date.now() - a;
    if (lat > 150) stalls.push(`+${((a - t0) / 1000).toFixed(1)}s:${lat}ms`);
    await page.waitForTimeout(50);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  // Twelve blink renders would be a train of stalls; one flash is at most one.
  expect(stalls.length, `sustained main-thread stalls in the blink window: ${stalls.join(' ')}`).toBeLessThanOrEqual(1);
});
