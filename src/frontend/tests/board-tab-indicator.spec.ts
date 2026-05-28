/**
 * Verifies that the board tab header shows an ∞ link indicator when a PDF
 * is auto-bound to the board on open. Regression guard for the
 * autoBindPdf/addPdfBinding notify path — a missing notify() in autoBindPdf
 * caused the indicator to stay hidden even though the binding existed.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');
const PDF_FILE = path.resolve(__dirname, '../../../samples/820-02016.pdf');

// Skip (not fail) when the gitignored, proprietary samples/ fixtures are absent
// — same idiom as ci-smoke.spec.ts.
const haveFixtures = fs.existsSync(BVR_FILE) && fs.existsSync(PDF_FILE);

test('board tab shows ∞ indicator when PDF is linked', async ({ page }) => {
  test.skip(!haveFixtures, 'samples/820-02016.{bvr,pdf} not present (proprietary fixtures)');
  await page.goto('/');

  await page.getByTestId('file-input').setInputFiles(BVR_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });

  await page.getByTestId('pdf-input').setInputFiles(PDF_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });

  const boardTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' });
  const indicator = boardTab.locator('.board-tab-link-indicator');
  await expect(indicator).toBeVisible({ timeout: 3000 });
  await expect(indicator).toHaveText('∞');
});
