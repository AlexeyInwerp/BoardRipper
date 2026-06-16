// PDF tab ∞ link control: lives in the dockview tab (not the toolbar), and its
// dropdown opens on-screen anchored under the button — the same fixedDropdown
// portal fix the board tab needed (boardtab-dropdown-geometry.spec.ts).
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES = path.resolve(__dirname, '../../../samples');

function firstSample(re: RegExp): string | null {
  if (!fs.existsSync(SAMPLES)) return null;
  const f = fs.readdirSync(SAMPLES).find(n => re.test(n));
  return f ? path.join(SAMPLES, f) : null;
}

test('PDF tab hosts the link control in-tab (not toolbar), dropdown on-screen', async ({ page }) => {
  const BOARD = firstSample(/\.(brd|bvr|bdv|cad)$/i);
  const PDF = firstSample(/\.pdf$/i);
  test.skip(!BOARD || !PDF, 'sample board + PDF required (proprietary, gitignored)');
  test.setTimeout(60000);

  const vp = page.viewportSize()!;
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('file-input').setInputFiles(BOARD!);
  await expect(page.locator('.dv-tab').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('file-input').setInputFiles(PDF!);

  const pdfTab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  await expect(pdfTab).toBeVisible({ timeout: 15000 });
  await pdfTab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible();
  await page.waitForTimeout(1500);

  // (1) The link button is in the PDF tab, and NOT in the PDF toolbar.
  const tabBtn = pdfTab.locator('.board-tab-bindlink .bind-link-btn');
  await expect(tabBtn).toBeVisible();
  expect(await page.locator('.pdf-toolbar .bind-link-btn').count()).toBe(0);

  // (2) Dropdown opens on-screen, anchored under the button (the portal fix).
  const bb = (await tabBtn.boundingBox())!;
  await tabBtn.click();
  const dropdown = page.locator('.bind-link-dropdown');
  await expect(dropdown).toBeVisible();
  const db = (await dropdown.boundingBox())!;

  expect(db.x).toBeGreaterThanOrEqual(0);
  expect(db.y).toBeGreaterThanOrEqual(0);
  expect(db.x + db.width).toBeLessThanOrEqual(vp.width + 1);
  expect(db.y + db.height).toBeLessThanOrEqual(vp.height + 1);
  expect(Math.abs(db.x - bb.x)).toBeLessThan(24);
  expect(db.y).toBeGreaterThanOrEqual(bb.y + bb.height - 2);
  expect(db.y).toBeLessThan(bb.y + bb.height + 24);

  // (3) Offers the open board under the "Boardview" section.
  await expect(dropdown.locator('.bind-link-section-label', { hasText: /Boardview/i })).toBeVisible();
});
