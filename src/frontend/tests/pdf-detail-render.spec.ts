/**
 * Once the view settles, the visible area is rendered at the exact zoom over
 * the full-page canvas (PdfViewerPanel.renderDetail, 2026-10-10). The preset's
 * canvas cap decides only the moving picture; this makes every preset sharp
 * at any zoom and keeps canvas memory near one screen — the full-page canvas
 * at deep zoom on 'max' was ~700 MB, enough for Chrome to draw it black.
 *
 * Checked here: the detail exists at deep zoom on the lowest preset, its
 * backing store matches its on-screen size × DPR (sharp, not stretched), and it
 * sits exactly over the page — the ink lands in the same place with the
 * detail shown and hidden — unrotated and rotated.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(HERE, 'fixtures/two-page-text.pdf');

async function inkCentroid(page: Page): Promise<{ x: number; y: number; n: number }> {
  const shot = await page.locator('.pdf-canvas-container').first().screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d')!; x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < c.height; y += 2) for (let xx = 0; xx < c.width; xx += 2) {
      const i = (y * c.width + xx) * 4;
      if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) { sx += xx; sy += y; n++; }
    }
    return { x: sx / Math.max(1, n), y: sy / Math.max(1, n), n };
  }, shot.toString('base64'));
}

for (const rotate of [false, true]) {
  test(`deep zoom on Fastest settles sharp and in place${rotate ? ' (rotated)' : ''}`, async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('boardripper-pdf-render-quality', 'low'));
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('file-input').setInputFiles(PDF);
    await expect(page.locator('.pdf-page-wrapper canvas').first()).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(1200);
    if (rotate) { await page.getByTestId('pdf-rotate').click(); await page.waitForTimeout(1200); }
    const box = (await page.locator('.pdf-canvas-container').boundingBox())!;
    // Zoom where the text is: top left, or top right once turned 90°.
    await page.mouse.move(box.x + box.width * (rotate ? 0.84 : 0.3), box.y + box.height * 0.25);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('Control'); await page.mouse.wheel(0, -60); await page.keyboard.up('Control');
      await page.waitForTimeout(60);
    }
    // Settle: the main render, then the detail 150 ms after the last change.
    const detail = page.locator('.pdf-detail');
    await expect(detail).toHaveCount(1, { timeout: 10000 });
    await page.waitForTimeout(800);
    const geo = await detail.evaluate((c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect();
      return { w: c.width, cssW: r.width, dpr: window.devicePixelRatio || 1 };
    });
    // Sharp: one backing pixel per device pixel (within rounding).
    expect(Math.abs(geo.w - geo.cssW * geo.dpr) / geo.w).toBeLessThan(0.02);
    // In place: the ink barely moves when the detail is hidden.
    const withDetail = await inkCentroid(page);
    await detail.evaluate((c: HTMLCanvasElement) => { c.style.visibility = 'hidden'; });
    const without = await inkCentroid(page);
    expect(withDetail.n).toBeGreaterThan(50);
    expect(without.n).toBeGreaterThan(50);
    expect(Math.abs(withDetail.x - without.x)).toBeLessThan(4);
    expect(Math.abs(withDetail.y - without.y)).toBeLessThan(4);
  });
}
