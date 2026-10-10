/**
 * A neighbour page you can see is as sharp as the page you are on.
 *
 * Phase 1 of the PDF performance work (2026-10-09) capped neighbour pages
 * that are not on screen at a low tier — they were most of a zoom's cost —
 * and a page edge brought into view by a pan then looked soft until the page
 * flipped. Now a neighbour within the preset's near margin gets the full
 * neighbour tier, and a pan that brings one near upgrades it; a neighbour
 * far away stays light. Default preset (Balanced / 'high'), 3× zoom.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(HERE, 'fixtures/many-page-text.pdf');

async function canvases(page: Page) {
  return page.evaluate(() => {
    const container = document.querySelector('.pdf-canvas-container') as HTMLElement;
    const cr = container.getBoundingClientRect();
    const main = document.querySelector('.pdf-page-wrapper canvas:has(+ .pdf-highlight-canvas)') as HTMLCanvasElement;
    const adj = ([...document.querySelectorAll('.pdf-adjacent-page')] as HTMLCanvasElement[])
      .filter(c => c.width > 1)
      .map(c => {
        const r = c.getBoundingClientRect();
        return { w: c.width, onScreen: r.bottom > cr.top && r.top < cr.bottom, top: r.top - cr.top };
      });
    return { mainW: main.width, adj };
  });
}

test('the neighbour page that comes into view is drawn as sharp as the current one', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.pdf-page-wrapper canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const box = (await page.locator('.pdf-canvas-container').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Zoom to ~3× (Ctrl+wheel = pinch), let it settle.
  for (let i = 0; i < 3; i++) {
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -40); await page.keyboard.up('Control');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(1500);
  // Scroll down until the next page's top edge is in the lower part of the view.
  for (let i = 0; i < 80; i++) {
    const c = await canvases(page);
    if (c.adj.some(a => a.onScreen && a.top > 0)) break;
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1500);
  await expect.poll(async () => {
    const c = await canvases(page);
    const visible = c.adj.filter(a => a.onScreen);
    return visible.length > 0 && visible.every(a => a.w >= c.mainW * 0.95);
  }, { timeout: 10000, message: 'a neighbour on screen should match the current page’s resolution' }).toBe(true);
});
