// Geometry assertion — toBeVisible() is not enough for a portaled/fixed
// dropdown (it passed even when the menu rendered off-screen). Assert the
// dropdown's bounding box is on-screen AND positioned right under its button.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRD = path.resolve(__dirname, '../../../samples/820-02935-05 Kopie.brd');
const PDF = path.resolve(__dirname, '../../../samples/820-02935 051-08286 Rev 5.0.3 copy.pdf');
const have = fs.existsSync(BRD) && fs.existsSync(PDF);

test('board-tab dropdown opens on-screen, anchored under its button', async ({ page }) => {
  test.skip(!have, 'samples missing');
  const vp = page.viewportSize()!;
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('file-input').setInputFiles(BRD);
  await expect(page.locator('.dv-tab', { hasText: '.brd' }).first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect(page.locator('.dv-tab', { hasText: '.pdf' }).first()).toBeVisible({ timeout: 15000 });

  const btn = page.locator('.dv-tab .board-tab-bindlink .bind-link-btn').first();
  await expect(btn).toBeVisible();
  const bb = (await btn.boundingBox())!;
  await btn.click();

  const dropdown = page.locator('.bind-link-dropdown');
  await expect(dropdown).toBeVisible();
  const db = (await dropdown.boundingBox())!;

  // (1) fully within the viewport — the bug was it rendering off to the side
  expect(db.x).toBeGreaterThanOrEqual(0);
  expect(db.y).toBeGreaterThanOrEqual(0);
  expect(db.x + db.width).toBeLessThanOrEqual(vp.width + 1);
  expect(db.y + db.height).toBeLessThanOrEqual(vp.height + 1);

  // (2) anchored to the button: left edges roughly aligned, top just below it
  expect(Math.abs(db.x - bb.x)).toBeLessThan(20);
  expect(db.y).toBeGreaterThanOrEqual(bb.y + bb.height - 2);
  expect(db.y).toBeLessThan(bb.y + bb.height + 24);

  // (3) contains the PDF option and clicking it doesn't dismiss prematurely
  await expect(dropdown.locator('.bind-link-option', { hasText: '.pdf' }).first()).toBeVisible();
  // eslint-disable-next-line no-console
  console.log(`button @ (${Math.round(bb.x)},${Math.round(bb.y)}) ${Math.round(bb.width)}x${Math.round(bb.height)} | dropdown @ (${Math.round(db.x)},${Math.round(db.y)}) ${Math.round(db.width)}x${Math.round(db.height)} | viewport ${vp.width}x${vp.height}`);
});
