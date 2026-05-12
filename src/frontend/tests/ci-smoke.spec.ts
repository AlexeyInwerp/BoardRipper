/**
 * CI Smoke Test — fast check that the app loads, opens a board, and opens a PDF.
 *
 * The board-open / PDF-open tests need real-world sample files. The historical
 * fixtures (samples/820-02016.{bvr,pdf}) were untracked from the public repo
 * during the AGPL-3.0 release because they're proprietary Apple boardview /
 * schematic content with no redistribution license. Until a synthetic
 * BVR + PDF fixture pair is generated (tracked as a follow-up issue), the
 * sample-dependent tests skip when the files are absent — this keeps the
 * "app loads" smoke test running on CI while leaving the door open for a
 * developer with the samples on disk to exercise the full path locally.
 *
 * No WebGL-dependent assertions here (headless Chromium has no GPU).
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BVR_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');
const PDF_FILE = path.resolve(__dirname, '../../../samples/820-02016.pdf');

const haveBvr = fs.existsSync(BVR_FILE);
const havePdf = fs.existsSync(PDF_FILE);

test('app loads and shows toolbar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('open-btn')).toBeVisible();
});

test('open BVR board — tab appears', async ({ page }) => {
  test.skip(!haveBvr, `samples/820-02016.bvr not present (proprietary fixture, untracked from public repo)`);
  await page.goto('/');
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(BVR_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
});

test('open PDF — tab appears', async ({ page }) => {
  test.skip(!havePdf, `samples/820-02016.pdf not present (proprietary fixture, untracked from public repo)`);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(PDF_FILE);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });
});

test('open board + PDF together', async ({ page }) => {
  test.skip(!haveBvr || !havePdf, `samples/820-02016.{bvr,pdf} not both present (proprietary fixtures, untracked from public repo)`);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles([BVR_FILE, PDF_FILE]);
  await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' })).toBeVisible({ timeout: 10000 });
});
