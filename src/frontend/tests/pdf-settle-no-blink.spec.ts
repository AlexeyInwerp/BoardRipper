/**
 * A zoom that settles where sharp pixels already exist must not blink blurry
 * (reported 2026-10-03, "mostly Safari").
 *
 * Two ways the viewer did it. Tiled path: every settle re-ran the tile pass
 * and, for each cached tile, assigned `canvas.width` and redrew — but
 * assigning `width` clears a canvas even to the same value, and Safari can
 * put that cleared tile on screen for a frame, with the blurrier layer
 * beneath showing through. Full-page path: while the exact tier rendered it
 * blitted the sharpest cached copy and then the tier-1 preview ON TOP of it.
 *
 * The flash itself is one composited frame in WebKit and cannot be sampled
 * from here, so this asserts the cause: no clear of a tile canvas that
 * already shows its bitmap, and the main canvas never drops to a coarser
 * backing store while the page is unchanged.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(HERE, 'fixtures/two-page-text.pdf');

async function openPdf(page: Page, renderMode: 'auto' | 'standard', likeSafari = false) {
  // Safari has no requestIdleCallback, so the viewer's idle prefetch runs on
  // a 200 ms timer there and the tier-1 preview is reliably cached — the
  // reason the blink was "mostly Safari".
  if (likeSafari) await page.addInitScript(() => { delete (window as { requestIdleCallback?: unknown }).requestIdleCallback; });
  await page.addInitScript((mode) => {
    try {
      const raw = localStorage.getItem('boardripper-render-settings');
      localStorage.setItem('boardripper-render-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), pdfRenderMode: mode }));
    } catch { /* ignore */ }
    // Count every width/height assignment on a tile canvas that already has
    // pixels at that size — a pure clear.
    const w = window as unknown as { __tileClears: number };
    w.__tileClears = 0;
    for (const prop of ['width', 'height'] as const) {
      const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, prop)!;
      Object.defineProperty(HTMLCanvasElement.prototype, prop, {
        configurable: true,
        get() { return d.get!.call(this); },
        set(v: number) {
          if (this.classList?.contains('pdf-tile') && d.get!.call(this) === v && v > 1) w.__tileClears++;
          d.set!.call(this, v);
        },
      });
    }
  }, renderMode);
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.pdf-page-wrapper canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const b = (await page.locator('.pdf-canvas-container').boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 3);
}

/** One Ctrl+wheel notch (a pinch to the viewer), then wait out the settle. */
async function zoomStep(page: Page, dy: number) {
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, dy);
  await page.keyboard.up('Control');
  await page.waitForTimeout(900);
}

test('tiled: settling at a zoom whose tiles are already drawn clears none of them', async ({ page }) => {
  await openPdf(page, 'auto');
  await zoomStep(page, -60);                                   // into the tiled path
  await expect.poll(() => page.locator('.pdf-tile').count(), { timeout: 5000 }).toBeGreaterThan(0);
  // Another settle at the same tiles: a tiny wheel each way, back to the same tier.
  await page.evaluate(() => { (window as unknown as { __tileClears: number }).__tileClears = 0; });
  await zoomStep(page, -2);
  await zoomStep(page, 2);
  const clears = await page.evaluate(() => (window as unknown as { __tileClears: number }).__tileClears);
  expect(clears).toBe(0);
});

test('full page: no stand-in coarser than what the canvas already shows', async ({ page }) => {
  await openPdf(page, 'standard', true);
  const mainWidth = () => page.evaluate(() => (document.querySelector('.pdf-page-wrapper canvas:has(+ .pdf-highlight-canvas)') as HTMLCanvasElement).width);
  const tier1 = await mainWidth();
  await zoomStep(page, -60);                                   // a higher tier, cached
  await page.waitForTimeout(2500);                             // idle prefetch caches the tier-1 preview
  const sharp = await mainWidth();
  expect(sharp).toBeGreaterThan(tier1);
  // The main canvas is the one right before the highlight canvas (adjacent
  // pages are canvases in the same wrapper). Record every backing width it
  // is given from here on — a
  // stand-in drawn and replaced inside one frame never shows up in frame
  // sampling, but it does here.
  await page.evaluate(() => {
    const c = document.querySelector('.pdf-page-wrapper canvas:has(+ .pdf-highlight-canvas)') as HTMLCanvasElement;
    const w = window as unknown as { __mainWidths: number[] };
    w.__mainWidths = [];
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width')!;
    Object.defineProperty(c, 'width', {
      configurable: true,
      get() { return d.get!.call(this); },
      set(v: number) { w.__mainWidths.push(v); d.set!.call(this, v); },
    });
  });
  await zoomStep(page, -60);                                   // further in: a tier not cached yet
  const widths = await page.evaluate(() => (window as unknown as { __mainWidths: number[] }).__mainWidths);
  // The blurry tier-1 preview must never be put up over the sharp page.
  expect(widths.filter(w => w <= tier1)).toEqual([]);
});
