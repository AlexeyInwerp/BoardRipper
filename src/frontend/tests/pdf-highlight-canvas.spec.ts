/**
 * The search-highlight canvas is page-sized only while it has something to
 * draw. It used to be reallocated at the page's full backing size on every
 * settle, search or no search (PDF performance review 2026-10-03, 3.4); now it
 * is 1×1 while hidden and gets its size when a search lands on the page.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(HERE, 'fixtures/two-page-text.pdf');

test('highlight canvas: 1×1 without matches, page-sized and drawn with them', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.pdf-page-wrapper canvas').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1200);
  const hl = () => page.evaluate(() => {
    const c = document.querySelector('.pdf-highlight-canvas') as HTMLCanvasElement;
    const main = document.querySelector('.pdf-page-wrapper canvas:has(+ .pdf-highlight-canvas)') as HTMLCanvasElement;
    let ink = 0;
    if (c.width > 1) {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 16) if (d[i] > 0) ink++;
    }
    return { w: c.width, h: c.height, display: c.style.display, ink, mainW: main.width };
  });
  await expect.poll(async () => (await hl()).w).toBe(1);

  const input = page.locator('.pdf-search-input');
  await input.fill('PP3V3_S5');
  await input.press('Enter');
  await expect.poll(async () => (await hl()).ink, { timeout: 10000 }).toBeGreaterThan(0);
  const on = await hl();
  expect(on.w).toBe(on.mainW);
  expect(on.display).not.toBe('none');

  await input.fill('');
  await input.press('Enter');
  await expect.poll(async () => (await hl()).w, { timeout: 10000 }).toBe(1);
});
