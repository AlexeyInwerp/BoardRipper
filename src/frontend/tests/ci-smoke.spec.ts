/**
 * CI Smoke Test — fast check that the app loads, opens a board, and opens a PDF.
 * Uses only tracked sample files (samples/820-02016.bvr, samples/820-02016.pdf).
 * No WebGL-dependent assertions (headless Chromium has no GPU).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');
const PDF_FILE = path.resolve(__dirname, '../../../samples/820-02016.pdf');

test('app loads and shows toolbar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('open-btn')).toBeVisible();
});

test('open BVR board — tab appears', async ({ page }) => {
  await page.goto('/');
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(BVR_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
});

test('open PDF — tab appears', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(PDF_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });
});

test('open board + PDF together', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([BVR_FILE, PDF_FILE]);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });
});
