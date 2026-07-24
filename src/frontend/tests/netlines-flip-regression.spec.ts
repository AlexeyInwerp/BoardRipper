import { test, expect } from '@playwright/test';
import fs from 'fs';

// Net-line segments are cached in WORLD space (clipToRectEdge → sceneToWorld
// bakes each part's root transform). Flipping the board moves the parts, so the
// cache must be recomputed — otherwise the lines render stuck in the pre-flip
// positions ("connection lines not redrawn, stuck in the old state").
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';

test('net lines are recomputed when the board is flipped', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Turn net lines on and highlight a multi-pin, non-GND net (GND is skipped).
  const lit = await page.evaluate(() => {
    const bs: any = (window as any).__boardStore;
    if (bs.netLineMode === 'off') bs.cycleNetLineMode();
    const counts = new Map<string, number>();
    for (const p of bs.board.parts) for (const pin of p.pins) {
      if (pin.net && !pin.net.toUpperCase().includes('GND')) {
        counts.set(pin.net, (counts.get(pin.net) ?? 0) + 1);
      }
    }
    let best = '', n = 0;
    for (const [net, c] of counts) if (c > n && c < 40) { n = c; best = net; }
    bs.highlightNet(best);
    return { net: best, pins: n, mode: bs.netLineMode };
  });
  console.log(`net=${lit.net} pins=${lit.pins} mode=${lit.mode}`);
  await page.waitForTimeout(600);

  const snap = () => page.evaluate(() =>
    ((window as any).__boardRenderer.netLineSegments as any[])
      .map(s => `${s.start.x.toFixed(2)},${s.start.y.toFixed(2)}->${s.end.x.toFixed(2)},${s.end.y.toFixed(2)}`));

  const before = await snap();
  expect(before.length, 'net lines should be drawn before the flip').toBeGreaterThan(0);

  // Flip the board — parts move in world space.
  await page.evaluate(() => (window as any).__boardStore.flipHorizontal());
  await page.waitForTimeout(700);

  const after = await snap();
  console.log(`segments before=${before.length} after=${after.length}`);
  expect(after.length, 'net lines should still be drawn after the flip').toBeGreaterThan(0);
  expect(after.join('|'), 'segments must be recomputed for the flipped orientation, not reused')
    .not.toBe(before.join('|'));
});
