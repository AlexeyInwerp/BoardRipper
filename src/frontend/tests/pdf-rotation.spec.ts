/**
 * PDF rotation + single/continuous page mode.
 *
 * Verifies:
 *  1. Rotating 90° swaps the rendered page aspect ratio (portrait↔landscape).
 *  2. Rotation forces single-page mode (the mode toggle becomes disabled).
 *  3. Returning to 0° re-enables the mode toggle.
 *  4. Toggling single mode tears down adjacent-page canvases; continuous
 *     mode brings them back (multi-page docs only).
 *
 * Uses whichever proprietary sample PDF happens to be present (gitignored);
 * skips cleanly when none exist — same idiom as ci-smoke.spec.ts.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES = path.resolve(__dirname, '../../../samples');

function firstSamplePdf(): string | null {
  if (!fs.existsSync(SAMPLES)) return null;
  const pdf = fs.readdirSync(SAMPLES).find(f => f.toLowerCase().endsWith('.pdf'));
  return pdf ? path.join(SAMPLES, pdf) : null;
}

/** Read the main page canvas's CSS-pixel height/width ratio. */
async function pageAspect(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector('.pdf-page-wrapper canvas') as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const w = parseFloat(canvas.style.width) || canvas.clientWidth;
    const h = parseFloat(canvas.style.height) || canvas.clientHeight;
    return w > 0 ? h / w : 0;
  });
}

test('PDF rotate swaps aspect, forces single page; mode toggle controls adjacency', async ({ page }) => {
  const PDF_FILE = firstSamplePdf();
  test.skip(!PDF_FILE, 'no sample PDF present (proprietary, gitignored)');
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForTimeout(800);

  await page.getByTestId('file-input').setInputFiles(PDF_FILE!);
  await page.waitForTimeout(500);
  // Activate the PDF tab (filename tab text varies — match the .pdf suffix).
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();

  const container = page.locator('.pdf-canvas-container');
  await expect(container).toBeVisible();
  await page.waitForTimeout(2500);

  const aspectBefore = await pageAspect(page);
  expect(aspectBefore).toBeGreaterThan(0);

  // --- Rotate 90° CW ---
  const rotateBtn = page.getByTestId('pdf-rotate');
  await expect(rotateBtn).toBeVisible();
  await rotateBtn.click();
  await page.waitForTimeout(2000);

  const aspectAfter = await pageAspect(page);
  expect(aspectAfter).toBeGreaterThan(0);
  // 90° rotation inverts the aspect ratio: after ≈ 1 / before.
  expect(Math.abs(aspectAfter - 1 / aspectBefore)).toBeLessThan(0.15);

  // --- Rotation forces single page: mode toggle disabled (if present) ---
  const modeBtn = page.getByTestId('pdf-page-mode');
  const hasModeBtn = (await modeBtn.count()) > 0;
  if (hasModeBtn) {
    await expect(modeBtn).toBeDisabled();
    // No adjacent pages while rotated.
    expect(await page.locator('.pdf-adjacent-page').count()).toBe(0);
  }

  // --- Rotate back to 0° (3 more CW clicks) → mode toggle re-enabled ---
  await rotateBtn.click();
  await page.waitForTimeout(800);
  await rotateBtn.click();
  await page.waitForTimeout(800);
  await rotateBtn.click();
  await page.waitForTimeout(2000);

  const aspectBack = await pageAspect(page);
  expect(Math.abs(aspectBack - aspectBefore)).toBeLessThan(0.1);

  if (hasModeBtn) {
    await expect(modeBtn).toBeEnabled();

    // Continuous (default) on a multi-page doc renders adjacent canvases.
    const adjContinuous = await page.locator('.pdf-adjacent-page').count();

    // Toggle to single → adjacency torn down.
    await modeBtn.click();
    await page.waitForTimeout(1500);
    expect(await page.locator('.pdf-adjacent-page').count()).toBe(0);

    // Toggle back to continuous → adjacency returns (if it was there before).
    await modeBtn.click();
    await page.waitForTimeout(2000);
    if (adjContinuous > 0) {
      expect(await page.locator('.pdf-adjacent-page').count()).toBeGreaterThan(0);
    }
  }
});

test('keyboard E/Q rotate the PDF when its panel is active', async ({ page }) => {
  const PDF_FILE = firstSamplePdf();
  test.skip(!PDF_FILE, 'no sample PDF present (proprietary, gitignored)');
  test.setTimeout(60000);

  await page.goto('/');
  await page.waitForTimeout(800);
  await page.getByTestId('file-input').setInputFiles(PDF_FILE!);
  await page.waitForTimeout(500);
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible();
  await page.waitForTimeout(2500);

  const aspectBefore = await pageAspect(page);
  expect(aspectBefore).toBeGreaterThan(0);

  // 'e' = rotate CW (positional code KeyE).
  await page.locator('.pdf-canvas-container').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('e');
  await page.waitForTimeout(2000);

  const aspectAfter = await pageAspect(page);
  expect(Math.abs(aspectAfter - 1 / aspectBefore)).toBeLessThan(0.15);
});

test('mirror flips the page wrapper without changing aspect; controls sit right of page nav', async ({ page }) => {
  const PDF_FILE = firstSamplePdf();
  test.skip(!PDF_FILE, 'no sample PDF present (proprietary, gitignored)');
  test.setTimeout(60000);

  await page.goto('/');
  await page.waitForTimeout(800);
  await page.getByTestId('file-input').setInputFiles(PDF_FILE!);
  await page.waitForTimeout(500);
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible();
  await page.waitForTimeout(2500);

  const wrapperTransform = () => page.evaluate(() => {
    const w = document.querySelector('.pdf-page-wrapper') as HTMLElement | null;
    return w?.style.transform ?? '';
  });

  const aspectBefore = await pageAspect(page);
  expect(await wrapperTransform()).not.toContain('scaleX(-1)');

  // Toggle mirror → wrapper transform gains the horizontal flip, dims unchanged.
  const mirrorBtn = page.getByTestId('pdf-mirror');
  await expect(mirrorBtn).toBeVisible();
  await mirrorBtn.click();
  await page.waitForTimeout(800);

  expect(await wrapperTransform()).toContain('scaleX(-1)');
  const aspectMirrored = await pageAspect(page);
  expect(Math.abs(aspectMirrored - aspectBefore)).toBeLessThan(0.05); // mirror keeps dims

  // Toggle off.
  await mirrorBtn.click();
  await page.waitForTimeout(600);
  expect(await wrapperTransform()).not.toContain('scaleX(-1)');

  // Control block placement: rotate/mirror buttons come AFTER the page-number
  // input and BEFORE the search box in DOM order (i.e. right of page switching).
  const order = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('.pdf-toolbar *'));
    const idx = (sel: string) => all.findIndex(el => el.matches(sel));
    return {
      pageInput: idx('.pdf-page-input'),
      rotate: idx('[data-testid="pdf-rotate"]'),
      mirror: idx('[data-testid="pdf-mirror"]'),
      search: idx('.pdf-search-wrapper'),
    };
  });
  expect(order.pageInput).toBeGreaterThanOrEqual(0);
  expect(order.rotate).toBeGreaterThan(order.pageInput);
  expect(order.mirror).toBeGreaterThan(order.rotate);
  if (order.search >= 0) expect(order.search).toBeGreaterThan(order.mirror);
});

test('keyboard ⌘↑ mirrors the PDF when its panel is active', async ({ page }) => {
  const PDF_FILE = firstSamplePdf();
  test.skip(!PDF_FILE, 'no sample PDF present (proprietary, gitignored)');
  test.setTimeout(60000);

  await page.goto('/');
  await page.waitForTimeout(800);
  await page.getByTestId('file-input').setInputFiles(PDF_FILE!);
  await page.waitForTimeout(500);
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible();
  await page.waitForTimeout(2500);

  await page.locator('.pdf-canvas-container').click({ position: { x: 5, y: 5 } });
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+ArrowUp`);
  await page.waitForTimeout(800);

  const tf = await page.evaluate(() => (document.querySelector('.pdf-page-wrapper') as HTMLElement | null)?.style.transform ?? '');
  expect(tf).toContain('scaleX(-1)');
});
