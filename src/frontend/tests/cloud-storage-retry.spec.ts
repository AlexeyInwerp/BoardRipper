/**
 * Cloud-storage retry behavior.
 *
 * Mocks the backend's /api/files/path/* endpoint via page.route to return
 * 503 + Retry-After for the first N attempts, then 200. Verifies:
 *   1. The frontend retries automatically.
 *   2. Eventual success delivers the file content correctly.
 *   3. A "Downloading from cloud storage…" toast appears on retry.
 *   4. A persistently-failing endpoint surfaces an error toast.
 *
 * The test injects routes BEFORE page.goto so the mock is in place when
 * the frontend's first fetch fires.
 */
import { test, expect } from '@playwright/test';

// Minimal DatabankFile shape — only the fields fetchFileBuffer actually
// reads in the browser (non-Electron) branch.
interface MinimalDatabankFile {
  path: string;
  filename: string;
  mod_time: number;
  // Required by the DatabankFile type but not read in the browser fetch path:
  id: number;
  extension: string;
  file_type: 'board' | 'pdf';
  size: number;
  scan_time: number;
  board_number: string;
  manufacturer: string;
  model: string;
  format_id: string;
  part_count: number | null;
  net_count: number | null;
  donor_pool: boolean;
  has_preview: boolean;
  board_manufacturer: string;
  resolution_status: 'resolved' | 'pattern_matched' | 'unresolved' | '';
}

function makeFile(overrides: { path: string; filename: string }): MinimalDatabankFile {
  return {
    id: 1,
    path: overrides.path,
    filename: overrides.filename,
    extension: 'bvr',
    file_type: 'board',
    size: 100,
    mod_time: Date.now() / 1000,
    scan_time: Date.now() / 1000,
    board_number: '',
    manufacturer: '',
    model: '',
    format_id: 'BVR3',
    part_count: null,
    net_count: null,
    donor_pool: false,
    has_preview: false,
    board_manufacturer: '',
    resolution_status: '',
  };
}

test.describe('cloud-storage retry', () => {

  test('frontend retries on 503 then succeeds; toast appears', async ({ page }) => {
    // Use a short Retry-After so the test completes quickly.
    let attempts = 0;
    await page.route('**/api/files/path/**', (route) => {
      attempts++;
      if (attempts < 3) {
        route.fulfill({
          status: 503,
          headers: { 'Retry-After': '1' },
          body: 'File is materializing from cloud storage; retry shortly',
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/octet-stream',
          body: 'fake-board-content',
        });
      }
    });

    await page.goto('/');

    // Wait for the dev hook to be installed by App.tsx mount.
    await page.waitForFunction(() => {
      const w = window as unknown as { __databankStore?: unknown };
      return w.__databankStore != null;
    }, undefined, { timeout: 5000 });

    // Trigger via __databankStore.fetchFileBuffer directly.
    const result = await page.evaluate(async (fileArg: MinimalDatabankFile) => {
      const w = window as unknown as {
        __databankStore?: {
          fetchFileBuffer: (f: MinimalDatabankFile) => Promise<File>;
        };
      };
      try {
        const file = await w.__databankStore!.fetchFileBuffer(fileArg);
        const text = await file.text();
        return { ok: true, text };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }, makeFile({ path: 'fake/path/test.bvr', filename: 'test.bvr' }));

    expect(result.ok).toBe(true);
    expect(result.text).toBe('fake-board-content');
    expect(attempts).toBe(3);

    // The "Downloading from cloud storage…" info toast fires on attempt === 2.
    const toast = page.locator('.toast-info', { hasText: /downloading.*cloud storage/i }).first();
    await expect(toast).toBeVisible({ timeout: 5000 });
  });

  test('persistent 503 surfaces error toast', async ({ page }) => {
    // Use a short Retry-After (1 s) and the default maxAttempts=6, so this
    // test finishes in ~5 s total (5 gaps × 1 s between 6 attempts).
    let attempts = 0;
    await page.route('**/api/files/path/**', (route) => {
      attempts++;
      route.fulfill({
        status: 503,
        headers: { 'Retry-After': '1' },
        body: 'File is materializing from cloud storage; retry shortly',
      });
    });

    await page.goto('/');
    await page.waitForFunction(() => {
      const w = window as unknown as { __databankStore?: unknown };
      return w.__databankStore != null;
    }, undefined, { timeout: 5000 });

    // Trigger the fetch — expect it to throw after exhausting retries.
    // Uses page.evaluate's two-argument form (fn, arg); test timeout is
    // set at the test level via test.setTimeout to accommodate ~6s wait.
    test.setTimeout(30000);
    const result = await page.evaluate(async (fileArg: MinimalDatabankFile) => {
      const w = window as unknown as {
        __databankStore?: {
          fetchFileBuffer: (f: MinimalDatabankFile) => Promise<File>;
        };
      };
      try {
        await w.__databankStore!.fetchFileBuffer(fileArg);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    }, makeFile({ path: 'never/works.bvr', filename: 'works.bvr' }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/HTTP 503/);
    // Should have made > 1 attempt before giving up.
    expect(attempts).toBeGreaterThan(1);

    // The error toast should become visible (boardStore.addToast fires
    // synchronously inside fetchFileBuffer before it throws).
    const errorToast = page.locator('.toast-error', { hasText: /couldn't download/i }).first();
    await expect(errorToast).toBeVisible({ timeout: 10000 });
  });

});
