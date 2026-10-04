import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

// Space flips the board; holding it past SPACE_HOLD_PEEK_MS "peeks" (flips
// back on release). The first flip after a board renders does heavy work
// inside the keydown handler, so the keyup waits in the queue. The press used
// to be timed at handler time, which turned that quick tap into a peek — "it
// peeks even on a short press, the first time" (2026-10-05). It is timed with
// the events' own timestamps now.
//
// Reproduced with CDP: the flip is made to block for 800 ms, and the key
// events carry explicit platform timestamps 80 ms (a tap) or 900 ms (a hold)
// apart — the keyup is only handled after the block either way.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KICAD = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

async function open(page: Page) {
  await page.goto('/');
  const prompt = page.getByTestId('session-restore-prompt');
  if (await prompt.count()) await page.getByTestId('session-discard').click();
  await page.getByTestId('file-input').setInputFiles(KICAD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  // Make the next flip as slow as a first flip on a dense board.
  await page.evaluate(() => {
    const s = (window as unknown as { __boardStore: Record<string, () => void> }).__boardStore;
    for (const k of ['selectBottom', 'selectTop']) {
      const orig = s[k].bind(s);
      let once = true;
      s[k] = () => { if (once) { once = false; const t = performance.now(); while (performance.now() - t < 800) { /* busy */ } } orig(); };
    }
  });
  // Focus the board, where Space means "flip".
  const canvas = page.locator('.board-panel-canvas canvas').first();
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

const side = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as { __boardStore: { showTop: boolean; showBottom: boolean } }).__boardStore;
  return s.showTop && !s.showBottom ? 'top' : !s.showTop && s.showBottom ? 'bottom' : 'both';
});

async function press(page: Page, heldMs: number) {
  const cdp = await page.context().newCDPSession(page);
  const t = Date.now() / 1000;
  const key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', timestamp: t, ...key });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', timestamp: t + heldMs / 1000, ...key });
  await page.waitForTimeout(300);
}

test('a quick tap during a slow first flip stays flipped', async ({ page }) => {
  await open(page);
  const before = await side(page);
  await press(page, 80);
  expect(await side(page)).not.toBe(before);
});

test('a real hold still peeks back on release', async ({ page }) => {
  await open(page);
  const before = await side(page);
  await press(page, 900);
  expect(await side(page)).toBe(before);
});
