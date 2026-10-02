/**
 * Slide mode (arrows / boxes / text over the view, saved as a PNG) and the
 * pan minimap (fades in when zoomed to 2× the fit view or more and panned 12 %
 * of the screen, out once panning stops). Public KiCad sample, so it runs on a clean checkout.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');

async function openBoard(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('slide-mode-toggle')).toBeVisible();
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { __boardRenderer?: { activeScene?: unknown } }).__boardRenderer?.activeScene), { timeout: 15000 }).toBe(true);
}

async function canvasBox(page: Page) {
  const box = await page.getByTestId('board-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  return box;
}

async function annotations(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __slideStore: { list(t: number): Array<{ kind: string; text?: string }> }; __boardStore: { activeTabId: number } };
    return w.__slideStore.list(w.__boardStore.activeTabId).map(a => ({ kind: a.kind, text: a.text }));
  });
}

async function viewPose(page: Page) {
  return page.evaluate(() => {
    const r = (window as unknown as { __boardRenderer: { viewport: { x: number; y: number; scale: { x: number } } } }).__boardRenderer;
    return { x: r.viewport.x, y: r.viewport.y, s: r.viewport.scale.x };
  });
}

test.describe('slide mode', () => {
  test('draws an arrow, a box and text, keeps them on the board, and saves a PNG', async ({ page }) => {
    await openBoard(page);
    await page.getByTestId('slide-mode-toggle').click();
    await expect(page.getByTestId('slide-toolbar')).toBeVisible();
    // Slide mode keeps the minimap up.
    await expect(page.getByTestId('board-minimap')).toHaveAttribute('data-visible', 'true');

    const b = await canvasBox(page);
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const before = await viewPose(page);

    // Arrow: a drag draws and does NOT pan the board.
    await page.getByTestId('slide-tool-arrow').click();
    await page.mouse.move(cx - 120, cy - 80);
    await page.mouse.down();
    await page.mouse.move(cx - 40, cy - 20, { steps: 6 });
    await page.mouse.up();
    expect(await viewPose(page)).toEqual(before);

    // A click without a drag makes nothing.
    await page.mouse.click(cx + 150, cy + 100);

    await page.getByTestId('slide-tool-rect').click();
    await page.mouse.move(cx + 20, cy + 20);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 90, { steps: 6 });
    await page.mouse.up();

    await page.getByTestId('slide-tool-text').click();
    await page.mouse.click(cx - 150, cy + 60);
    await page.getByTestId('slide-text-editor').fill('Check C12');
    await page.keyboard.press('Enter');

    expect(await annotations(page)).toEqual([
      { kind: 'arrow', text: undefined },
      { kind: 'rect', text: undefined },
      { kind: 'text', text: 'Check C12' },
    ]);

    // Select tool: a drag on empty board still pans.
    await page.getByTestId('slide-tool-select').click();
    await page.mouse.move(cx + 200, cy - 150);
    await page.mouse.down();
    await page.mouse.move(cx + 260, cy - 110, { steps: 6 });
    await page.mouse.up();
    await expect.poll(async () => (await viewPose(page)).x).not.toBe(before.x);

    // Undo takes the text back.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    expect((await annotations(page)).map(a => a.kind)).toEqual(['arrow', 'rect']);

    // Save PNG: a real, non-empty image of the panel size.
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('slide-save-png').click()]);
    expect(dl.suggestedFilename()).toMatch(/^tomu-fpga-.*\.png$/);
    const file = await dl.path();
    const buf = fs.readFileSync(file!);
    expect(buf.subarray(1, 4).toString()).toBe('PNG');
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    expect(w).toBeGreaterThanOrEqual(Math.floor(b.width));
    expect(h).toBeGreaterThanOrEqual(Math.floor(b.height));

    // The exported image has board content (not a blank frame): sample it.
    const distinct = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      return seen.size;
    }, buf.toString('base64'));
    expect(distinct).toBeGreaterThan(8);

    // Esc leaves slide mode; the annotations are kept for the next time.
    await page.mouse.click(cx + 300, cy + 200);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('slide-toolbar')).toHaveCount(0);
    expect((await annotations(page)).length).toBe(2);
  });
});

test.describe('pan minimap', () => {
  async function panGesture(page: Page, x: number, y: number, dx: number) {
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y, { steps: 8 });
    await page.mouse.up();
  }

  test('shows only when zoomed in and after real travel; hides when panning stops', async ({ page }) => {
    await page.addInitScript(() => {
      // Inertia would keep the board moving after each release; this test measures travel.
      try {
        const raw = localStorage.getItem('boardripper-render-settings');
        const s = raw ? JSON.parse(raw) : {};
        localStorage.setItem('boardripper-render-settings', JSON.stringify({ ...s, disableInertia: true }));
      } catch { /* ignore */ }
    });
    await openBoard(page);
    const map = page.getByTestId('board-minimap');
    await expect(map).toHaveAttribute('data-visible', 'false');
    const b = await canvasBox(page);
    const x = b.x + b.width / 2, y = b.y + b.height / 2;

    // At the fit view a long pan is not enough: nothing is lost off screen.
    await panGesture(page, x, y, 300);
    await page.waitForTimeout(300);
    await expect(map).toHaveAttribute('data-visible', 'false');

    // Zoom in to 4× around the centre, then wait out the chain gap.
    await page.evaluate(() => {
      const r = (window as unknown as { __boardRenderer: { viewport: { scale: { x: number }; setZoom(s: number, c: boolean): void } } }).__boardRenderer;
      r.viewport.setZoom(r.viewport.scale.x * 4, true);
    });
    await page.waitForTimeout(1700);

    // A small nudge (well under 12 % of the width) does not show it …
    await panGesture(page, x, y, Math.round(b.width * 0.05));
    await page.waitForTimeout(300);
    await expect(map).toHaveAttribute('data-visible', 'false');
    // … but carrying on past 12 % does.
    await panGesture(page, x, y, Math.round(b.width * 0.1));
    await expect(map).toHaveAttribute('data-visible', 'true');
    // … and it leaves once panning stops.
    await expect(map).toHaveAttribute('data-visible', 'false', { timeout: 3000 });
  });

  test('the ribbon toggle turns it off', async ({ page }) => {
    await openBoard(page);
    await page.getByTestId('minimap-toggle').click();
    await expect(page.getByTestId('board-minimap')).toHaveCount(0);
    await page.getByTestId('minimap-toggle').click();
    await expect(page.getByTestId('board-minimap')).toHaveCount(1);
  });
});
