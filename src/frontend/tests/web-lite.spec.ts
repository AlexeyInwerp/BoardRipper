import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tracked synthetic fixture (10 parts: U1, R1-R4, C1-C3, U2, J1) — same file
// comprehensive.spec.ts uses. Not proprietary; ships in public/samples/.
const TEST_BVR1 = path.resolve(__dirname, '../public/samples/test-board.bvr');

/** Record every request whose path contains /api/, for the whole test. */
function trackApi(page: Page): string[] {
  const calls: string[] = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      if (u.pathname.includes('/api/')) calls.push(`${req.method()} ${u.pathname}`);
    } catch { /* non-URL scheme, ignore */ }
  });
  return calls;
}

/** Record every failed (>=400) response — catches /-rooted asset misses under the sub-path. */
function trackFailures(page: Page): string[] {
  const bad: string[] = [];
  page.on('response', (res) => {
    if (res.status() >= 400) bad.push(`${res.status()} ${res.url()}`);
  });
  return bad;
}

// NOTE: goto('.') everywhere — goto('/') would escape the sub-path baseURL of
// the lite-dist-subpath project.

test('cold load: zero /api requests, zero failed responses', async ({ page }) => {
  const api = trackApi(page);
  const bad = trackFailures(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Let mount effects and the first tick of any interval settle.
  await page.waitForTimeout(1500);
  expect(api, `unexpected /api calls: ${api.join(', ')}`).toEqual([]);
  expect(bad, `failed requests: ${bad.join(', ')}`).toEqual([]);
});

test('board opens locally and stays network-silent', async ({ page }) => {
  const api = trackApi(page);
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Upload through the real hidden file input. Rename the fixture to an
  // Apple-style board number so the OBD board-open path (obdStore.loadMatches
  // from BoardViewerPanel) would fire if it were ungated.
  await page.getByTestId('file-input').setInputFiles({
    name: '820-00281.bvr',
    mimeType: 'application/octet-stream',
    buffer: fs.readFileSync(TEST_BVR1),
  });
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
  await page.waitForTimeout(1000);
  expect(api, `unexpected /api calls after board open: ${api.join(', ')}`).toEqual([]);
});

test('backend-only UI is absent', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  // Self-update badge — gated off in the lite build.
  await expect(page.getByTestId('update-badge')).toHaveCount(0);
  // Library sidebar tab — filtered out of the TABS registry.
  await expect(page.locator('.sidebar-tab', { hasText: 'Library' })).toHaveCount(0);
  // Backend settings tabs — filtered out of TAB_ORDER (sidebar opens on the
  // Settings tab by default in the lite build, so the pills are rendered).
  await expect(page.locator('.library-tab', { hasText: 'Integrations' })).toHaveCount(0);
  await expect(page.locator('.library-tab', { hasText: /^Library$/ })).toHaveCount(0);
});

test('lite build offers the offline-copy download (where the update badge was)', async ({ page }) => {
  await page.goto('.');
  await page.waitForLoadState('networkidle');
  const dl = page.getByTestId('download-offline');
  await expect(dl).toHaveCount(1);
  await expect(dl).toHaveAttribute('href', './boardripper-lite.html');
  await expect(dl).toHaveAttribute('download', /boardripper-lite\.html/);
});

test('PWA manifest is linked', async ({ page }) => {
  await page.goto('.');
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(1);
});
