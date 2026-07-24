import { test, expect } from '@playwright/test';
import fs from 'fs';

// Interactive mode: clicking a (dense, BGA-like) pin should highlight its net.
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';

test('interactive-mode click on a many-pin part selects the net', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Enable interactive mode; pick a pin from the part with the most pins that
  // has a net, and compute its client coords via the viewport transform.
  const target = await page.evaluate(() => {
    (window as any).__resizeModeStore.setEnabled(true);
    const r: any = (window as any).__boardRenderer;
    const bs: any = (window as any).__boardStore;
    const vp = r.viewport;
    // most-pins part
    let bestPart = -1, bestN = -1;
    bs.board.parts.forEach((p: any, i: number) => { if (p.pins.length > bestN) { bestN = p.pins.length; bestPart = i; } });
    const part = bs.board.parts[bestPart];
    const canvas = r.containerEl.querySelector('canvas');
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // find a pin with a net whose screen pos is inside the canvas
    for (let j = 0; j < part.pins.length; j++) {
      const pin = part.pins[j];
      if (!pin.net) continue;
      const sp = vp.toScreen(pin.position.x, pin.position.y);
      const cx = rect.left + sp.x / dpr, cy = rect.top + sp.y / dpr;
      if (cx > rect.left + 4 && cx < rect.right - 4 && cy > rect.top + 4 && cy < rect.bottom - 4) {
        return { cx, cy, net: pin.net, refdes: part.name, pins: bestN };
      }
    }
    return null;
  });
  expect(target, 'a netted pin should be on-screen').not.toBeNull();
  console.log(`clicking ${target!.refdes} (${target!.pins} pins) pin on net ${target!.net} at ${Math.round(target!.cx)},${Math.round(target!.cy)}`);

  await page.mouse.click(target!.cx, target!.cy);
  await page.waitForTimeout(300);

  const sel = await page.evaluate(() => {
    const s = (window as any).__boardStore.selection;
    return { highlightedNet: s.highlightedNet, pinIndex: s.pinIndex, partIndex: s.partIndex };
  });
  console.log('selection after click:', JSON.stringify(sel));
  expect(sel.highlightedNet, 'a net should be highlighted after clicking a pin').not.toBeNull();
});
