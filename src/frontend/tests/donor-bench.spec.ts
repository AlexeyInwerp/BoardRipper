/**
 * Bench tab — donor manager e2e proof.
 *
 * SCOPE NOTES (read before adding tests):
 *
 * ─ What IS tested here:
 *   1. The Bench tab itself renders (geometry check, empty-state copy, Export
 *      link, Import input present).
 *   2. With a live backend: mark a PDF as donor via the API → the Bench tab
 *      shows a donor-row + donor-status badge; remove via × deletes the row.
 *   3. With a live backend that already has a backup: donor-restore-btn appears
 *      and its label encodes the donor count from the backup metadata.
 *
 * ─ What is NOT tested (and why):
 *   • Mark → "Indexed" badge advancement (requires pdfium/wazero running in
 *     the test container; the Vite-only harness does not start the Go backend
 *     let alone its pdfium worker — we never observe index_status='indexed').
 *   • PDF text search scoped to donors (same dependency — requires a seeded
 *     pdfindex.db with real text).
 *   • Reset-DB → Restore round-trip (Reset wipes donor rows, Restore needs a
 *     pre-existing backup; both are destructive ops on a shared DB that could
 *     interfere with other parallel tests or the user's dev instance).
 *
 * The dedup.spec.ts pattern is reused: every test that touches the backend
 * probes the API first and calls test.skip() when it is unreachable, so the
 * suite never fakes a pass in the Vite-only CI environment.
 */

import { test, expect } from '@playwright/test';

const BACKEND_PORTS = [11336, 8080];

/** Returns the first reachable backend base URL, or null. */
async function findBackend(page: import('@playwright/test').Page): Promise<string | null> {
  for (const port of BACKEND_PORTS) {
    try {
      const res = await page.request.get(`http://localhost:${port}/api/config`, { timeout: 2000 });
      if (res.ok()) return `http://localhost:${port}`;
    } catch { /* not on this port */ }
  }
  return null;
}

/** Navigate to the app root and wait for the Library panel tabs row. */
async function openLibrary(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.waitForSelector('.library-tabs-row', { timeout: 10_000 });
}

/** Click the Bench tab and assert the bench container renders inside the
 *  viewport before returning. Throws if the tab is not found or if the bench
 *  area is not in the viewport (guards against portaled / display:none bugs). */
async function openBenchTab(page: import('@playwright/test').Page) {
  const tab = page.getByTestId('bench-tab');
  await expect(tab).toBeVisible({ timeout: 5_000 });
  await tab.click();

  const bench = page.locator('.library-bench');
  await expect(bench).toBeVisible({ timeout: 3_000 });

  // Geometry check: must be within the viewport (guards against display:none
  // false-positives that toBeVisible() misses for position:fixed/portaled UI).
  const box = await bench.boundingBox();
  expect(box, 'library-bench must have a bounding box').not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  expect(box!.x, 'bench left edge in viewport').toBeGreaterThanOrEqual(0);
  expect(box!.y, 'bench top edge in viewport').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'bench right edge in viewport').toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height, 'bench bottom edge in viewport').toBeLessThanOrEqual(vp.height + 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Bench tab renders without a backend (Vite-only CI)
// ─────────────────────────────────────────────────────────────────────────────

test('Bench tab renders the donor manager structure', async ({ page }) => {
  await openLibrary(page);
  await openBenchTab(page);

  // Header must mention "Donors"
  const header = page.locator('.library-bench-header');
  await expect(header).toBeVisible();
  await expect(header).toContainText('Donors');

  // With no backend / no donors: empty-state copy
  const emptyMsg = page.locator('.library-empty');
  const donorRows = page.getByTestId('donor-row');
  const rowCount = await donorRows.count();
  if (rowCount === 0) {
    await expect(emptyMsg).toBeVisible();
    await expect(emptyMsg).toContainText(/donor/i);
  }

  // Export link: must be an <a> pointing at the donor export endpoint.
  const exportLink = page.getByTestId('donor-export-link');
  await expect(exportLink).toBeVisible();
  const href = await exportLink.getAttribute('href');
  expect(href).toBe('/api/databank/donors/export');

  // Import input: exists in DOM (hidden file input — toBeAttached, not toBeVisible)
  const importInput = page.getByTestId('donor-import-input');
  await expect(importInput).toBeAttached();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Mark via API → donor-row appears with status badge; × removes row
// (requires live backend)
// ─────────────────────────────────────────────────────────────────────────────

test('marking a PDF as donor shows a row with status badge; × removes it', async ({ page }) => {
  const base = await findBackend(page);
  if (!base) {
    test.skip(true,
      'No Go backend found on ports 11336 / 8080 — ' +
      'start the backend with a seeded library to run this test.');
    return;
  }

  // Find any PDF in the databank to use as our donor target.
  const filesRes = await page.request.get(`${base}/api/databank/files`, { timeout: 5_000 });
  if (!filesRes.ok()) {
    test.skip(true, '/api/databank/files returned non-OK — need a seeded library.');
    return;
  }
  const allFiles = await filesRes.json() as { id: number; file_type: string; filename: string }[];
  const pdf = allFiles.find(f => f.file_type === 'pdf');
  if (!pdf) {
    test.skip(true, 'No PDF in the library — seed a PDF to run this test.');
    return;
  }

  // Ensure the PDF is NOT a donor before the test starts (idempotent cleanup).
  await page.request.delete(`${base}/api/databank/donors/${pdf.id}`, { timeout: 3_000 });

  // Mark as donor via the API.
  const markRes = await page.request.put(`${base}/api/databank/donors/${pdf.id}`, { timeout: 5_000 });
  expect(markRes.ok(), `PUT /api/databank/donors/${pdf.id} → ${markRes.status()}`).toBeTruthy();

  try {
    // Open the app, navigate to Bench tab.
    await openLibrary(page);
    await openBenchTab(page);

    // Donor row must be visible with a status badge.
    const rows = page.getByTestId('donor-row');
    await expect(rows.first()).toBeVisible({ timeout: 5_000 });

    const badge = rows.first().getByTestId('donor-status');
    await expect(badge).toBeVisible();
    // The badge text is one of: Indexed, Indexing…, Pending, Failed, No text,
    // Duplicate, Unknown — all are non-empty strings.
    const badgeText = await badge.textContent();
    expect(badgeText?.trim().length, 'badge must have non-empty text').toBeGreaterThan(0);

    // Geometry sanity: the donor row must be in the viewport.
    const rowBox = await rows.first().boundingBox();
    expect(rowBox, 'donor-row must have a bounding box').not.toBeNull();

    // Remove via the × button.
    const countBefore = await rows.count();
    const removeBtn = rows.first().locator('button.library-donor-remove');
    await expect(removeBtn).toBeVisible();
    await removeBtn.click();

    // Row should disappear (either the list shrinks or the empty-state appears).
    if (countBefore === 1) {
      await expect(page.locator('.library-empty')).toBeVisible({ timeout: 5_000 });
    } else {
      await expect(rows).toHaveCount(countBefore - 1, { timeout: 5_000 });
    }
  } finally {
    // Cleanup: ensure the donor is removed regardless of test outcome.
    await page.request.delete(`${base}/api/databank/donors/${pdf.id}`, { timeout: 3_000 });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: donor-restore-btn appears when a backup exists, with correct count
// (requires live backend that has at least one backup)
// ─────────────────────────────────────────────────────────────────────────────

test('donor-restore-btn appears when a backup exists', async ({ page }) => {
  const base = await findBackend(page);
  if (!base) {
    test.skip(true, 'No Go backend found — start the backend to run this test.');
    return;
  }

  // Check if any backups exist.
  const backupsRes = await page.request.get(`${base}/api/databank/donors/backups`, { timeout: 3_000 });
  if (!backupsRes.ok()) {
    test.skip(true, '/api/databank/donors/backups returned non-OK.');
    return;
  }
  const backups = await backupsRes.json() as { name: string; created_at: number; count: number }[];
  if (!backups || backups.length === 0) {
    test.skip(true,
      'No donor backups found — trigger a backup (e.g. via DB reset) to run this test.');
    return;
  }

  const latestBackup = backups[0];

  await openLibrary(page);
  await openBenchTab(page);

  // Restore button must be present and encode the donor count.
  const restoreBtn = page.getByTestId('donor-restore-btn');
  await expect(restoreBtn).toBeVisible({ timeout: 5_000 });
  await expect(restoreBtn).toContainText(String(latestBackup.count));
});
