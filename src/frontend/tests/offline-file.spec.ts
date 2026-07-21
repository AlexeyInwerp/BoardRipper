import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HTML = path.resolve(__dirname, '../dist-offline/boardripper-lite.html');
const FIXTURE = path.resolve(__dirname, '../public/samples/test-board.bvr');
const FILE_URL = 'file://' + HTML;

test.beforeAll(() => {
  if (!fs.existsSync(HTML)) {
    throw new Error('dist-offline/boardripper-lite.html missing — run `npm run build:offline` first');
  }
});

test('single-file offline build runs from file:// with no external loads', async ({ page }) => {
  const consoleErrors: string[] = [];
  const failed: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + e.message));
  page.on('requestfailed', (r) => failed.push(`${r.failure()?.errorText} ${r.url().slice(-70)}`));

  await page.goto(FILE_URL, { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // React mounted from the inlined bundle (no external module fetch).
  expect(await page.evaluate(() => document.getElementById('root')?.childElementCount ?? 0)).toBeGreaterThan(0);

  // A local board parses + loads — no server, no worker file (main-thread parse).
  await page.getByTestId('file-input').setInputFiles({
    name: '820-00281.bvr',
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(FIXTURE),
  });
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
  await page.waitForTimeout(500);

  // The point of a single file: NOTHING is fetched externally (any external
  // ref would fail under file:// and land here), and it runs error-free.
  expect(failed, `failed loads: ${failed.join(', ')}`).toEqual([]);
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);

  // Offline build ships no service worker / PWA manifest (can't register on file://).
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);

  // The "download offline copy" button hides itself in the offline file.
  await expect(page.getByTestId('download-offline')).toHaveCount(0);
});
