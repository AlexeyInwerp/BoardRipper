/**
 * Issue #20 — a PDF's view must survive switching to another tab and back.
 *
 * Root cause: Dockview's `onlyWhenVisible` renderer collapses a hidden panel's
 * container to 0×0, firing the panel's ResizeObserver → syncTransform →
 * clampPan while containerW=0. clampPan's "page fits → centre" X branch then
 * computed pageW = 0*zoom = 0 ≤ containerW=0 and snapped pan.x to 0, silently
 * losing the horizontal scroll position. (Zoom and vertical pan survived by
 * luck, so the symptom looked like "page jumps to the left edge".)
 *
 * This zooms a PDF in (which offsets pan.x via zoom-to-cursor), records the
 * wrapper transform, switches to a second PDF and back, and asserts the
 * horizontal pan is restored rather than snapped to 0.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_A = path.resolve(__dirname, '../../../samples/view-state-a.pdf');
const PDF_B = path.resolve(__dirname, '../../../samples/view-state-b.pdf');
const haveFixtures = fs.existsSync(PDF_A) && fs.existsSync(PDF_B);

async function dispatchWheel(page: Page, x: number, y: number, deltaY: number, ctrlKey = false) {
  await page.evaluate(({ x, y, deltaY, ctrlKey }) => {
    const el = document.elementFromPoint(x, y);
    if (el) el.dispatchEvent(new WheelEvent('wheel', {
      clientX: x, clientY: y, deltaY, ctrlKey, bubbles: true, cancelable: true,
    }));
  }, { x, y, deltaY, ctrlKey });
}

async function readView(page: Page): Promise<{ zoom: number; panX: number; panY: number }> {
  const zoomTxt = (await page.locator('.pdf-zoom-info').first().textContent()) ?? '0';
  const pan = await page.evaluate(() => {
    const w = document.querySelector('.pdf-page-wrapper') as HTMLElement | null;
    const m = w ? getComputedStyle(w).transform : 'none';
    if (!m.startsWith('matrix(')) return { x: 0, y: 0 };
    const n = m.slice(7, -1).split(',').map(s => parseFloat(s.trim()));
    return { x: n[4], y: n[5] };
  });
  return { zoom: parseInt(zoomTxt.replace('%', '').trim(), 10), panX: pan.x, panY: pan.y };
}

test('PDF view (zoom + horizontal pan) survives a tab switch (#20)', async ({ page }) => {
  test.skip(!haveFixtures, 'view-state PDF fixtures not present');
  test.setTimeout(120000);

  await page.goto('/');
  await page.getByTestId('toolbar').waitFor({ timeout: 10000 });
  await page.getByTestId('file-input').setInputFiles([PDF_A, PDF_B]);
  await page.waitForTimeout(1200);

  await page.locator('.dv-tab', { hasText: 'view-state-a.pdf' }).click();
  const container = page.locator('.pdf-canvas-container');
  await expect(container).toBeVisible();
  await page.waitForTimeout(2000);

  // Zoom in at the canvas centre — zoom-to-cursor offsets pan.x off zero.
  const box = await container.boundingBox();
  if (!box) throw new Error('no canvas bbox');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  for (let i = 0; i < 6; i++) { await dispatchWheel(page, cx, cy, -240, true); await page.waitForTimeout(120); }
  await page.waitForTimeout(800);

  const before = await readView(page);
  expect(before.zoom).toBeGreaterThan(160);           // actually zoomed in
  expect(Math.abs(before.panX)).toBeGreaterThan(200); // actually has horizontal pan

  // Switch to PDF B (hides A → container 0×0 → the bug), then back to A.
  await page.locator('.dv-tab', { hasText: 'view-state-b.pdf' }).click();
  await page.waitForTimeout(1500);
  await page.locator('.dv-tab', { hasText: 'view-state-a.pdf' }).click();
  await expect(container).toBeVisible();
  await page.waitForTimeout(1500);

  const after = await readView(page);
  // Zoom and BOTH pan axes must be restored — not snapped to the left edge.
  expect(after.zoom).toBe(before.zoom);
  expect(Math.abs(after.panX - before.panX)).toBeLessThanOrEqual(50);
  expect(Math.abs(after.panY - before.panY)).toBeLessThanOrEqual(50);
});
