/**
 * Session restore — boot prompt e2e proof.
 *
 * SCOPE NOTES (read before adding tests):
 *
 * ─ What IS tested here:
 *   1. Prompt renders with geometry check when localStorage is pre-seeded with a
 *      non-empty session (board + PDF entries). The prompt body text names the
 *      board and PDF counts ("1 board and 1 PDF were open.").
 *   2. Discard clears the session: prompt disappears + localStorage key gone +
 *      a subsequent reload shows no prompt.
 *   3. Empty / absent session → prompt never appears.
 *
 * ─ What is NOT tested (and why):
 *   • Reopen → board actually loads round-trip: this requires a live Go backend
 *     with a seeded library so `restoreSession` can resolve the file via
 *     databankStore. The Vite-only harness (used in CI) starts no backend and has
 *     no IndexedDB board-cache pre-loaded, so the entry would land in "unavailable"
 *     and no board tab would open. A backend-gated stub is provided below (tests 4)
 *     that verifies the round-trip on the dev instance (ports 11336/8080) using the
 *     loadBoard helper from comprehensive.spec.ts (setInputFiles on file-input,
 *     then wait 900 ms for capture, then reload + Reopen).
 *
 * Approach: tests 1–3 use page.addInitScript to inject the session before any
 * React code runs, making them fully deterministic and backend-independent.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Page } from '@playwright/test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SESSION_KEY = 'boardripper-session';

/** The backend ports tried by other specs (donor-bench, dedup, etc.). */
const BACKEND_PORTS = [11336, 8080];

async function findBackend(page: Page): Promise<string | null> {
  for (const port of BACKEND_PORTS) {
    try {
      const res = await page.request.get(`http://localhost:${port}/api/config`, { timeout: 2000 });
      if (res.ok()) return `http://localhost:${port}`;
    } catch { /* not on this port */ }
  }
  return null;
}

/** Seed localStorage before any script on the page runs.
 *
 * Uses a sessionStorage sentinel so the init script only seeds on the FIRST
 * navigation. On subsequent navigations (e.g. reload after Discard) the key
 * is intentionally absent and the prompt will not re-appear — which is exactly
 * the behaviour the Discard test verifies.
 */
async function seedSession(page: Page, entries: object[]) {
  const value = JSON.stringify({ version: 1, savedAt: Date.now(), entries });
  const keyJson = JSON.stringify(SESSION_KEY);
  const valJson = JSON.stringify(value);
  // sessionStorage is cleared on reload, so this sentinel fires only on the
  // initial navigation per Playwright page context.
  await page.addInitScript(`
    if (!sessionStorage.getItem('_session_seeded')) {
      sessionStorage.setItem('_session_seeded', '1');
      localStorage.setItem(${keyJson}, ${valJson});
    }
  `);
}

/** Navigate to the app root and wait for the shell to mount. */
async function gotoApp(page: Page) {
  await page.goto('/');
  // Wait for any of: the toolbar (board loaded) or the statusbar (app shell ready).
  // The Library panel or toolbar always renders even with no board open.
  await page.waitForSelector('[data-testid="statusbar"], .toolbar, .library-tabs-row', { timeout: 12_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Prompt renders with correct geometry when session is non-empty
// ─────────────────────────────────────────────────────────────────────────────

test('session-restore prompt is visible with correct geometry for a board+PDF session', async ({ page }) => {
  const entries = [
    {
      kind: 'board',
      fileName: 'my-board.bvr',
      fileSize: 123456,
      fileLastModified: 1700000000000,
      active: true,
    },
    {
      kind: 'pdf',
      fileName: 'service-manual.pdf',
      fileSize: 654321,
      fileLastModified: 1700000001000,
      fileId: 42,
    },
  ];

  await seedSession(page, entries);
  await gotoApp(page);

  const prompt = page.getByTestId('session-restore-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });

  // Geometry: must be within viewport (guards against display:none false-positives
  // for position:fixed/portaled elements — same pattern as donor-bench.spec.ts).
  const box = await prompt.boundingBox();
  expect(box, 'session-restore-prompt must have a bounding box').not.toBeNull();
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  expect(box!.x, 'prompt left edge in viewport').toBeGreaterThanOrEqual(0);
  expect(box!.y, 'prompt top edge in viewport').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'prompt right edge in viewport').toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y + box!.height, 'prompt bottom edge in viewport').toBeLessThanOrEqual(vp.height + 1);

  // Body text must mention the board and PDF counts.
  await expect(prompt).toContainText('1 board');
  await expect(prompt).toContainText('1 PDF');

  // Both action buttons must be present and in viewport.
  const reopenBtn = page.getByTestId('session-reopen');
  const discardBtn = page.getByTestId('session-discard');
  await expect(reopenBtn).toBeVisible();
  await expect(discardBtn).toBeVisible();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1b: Checkbox picker — one row per entry, de-select updates the button
// ─────────────────────────────────────────────────────────────────────────────

test('checkbox picker lists every entry and de-selecting updates the Reopen button', async ({ page }) => {
  const entries = [
    { kind: 'board', fileName: 'alpha.bvr', fileSize: 100, fileLastModified: 1700000000000, active: true },
    { kind: 'pdf', fileName: 'beta-manual.pdf', fileSize: 200, fileLastModified: 1700000001000, fileId: 7 },
    { kind: 'board', fileName: 'gamma.brd', fileSize: 300, fileLastModified: 1700000002000 },
  ];

  await seedSession(page, entries);
  await gotoApp(page);

  const prompt = page.getByTestId('session-restore-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });

  // One checkbox per entry, all checked by default.
  const checks = page.getByTestId('session-restore-check');
  await expect(checks).toHaveCount(entries.length);
  for (let i = 0; i < entries.length; i++) {
    await expect(checks.nth(i)).toBeChecked();
  }

  // All checked → button reads the plain "Reopen" (no count suffix).
  const reopenBtn = page.getByTestId('session-reopen');
  await expect(reopenBtn).toHaveText('Reopen');
  await expect(reopenBtn).toBeEnabled();

  // Each entry's file name is shown.
  await expect(prompt).toContainText('alpha.bvr');
  await expect(prompt).toContainText('beta-manual.pdf');
  await expect(prompt).toContainText('gamma.brd');

  // Uncheck one → button switches to the count form "Reopen (2)".
  await checks.nth(1).uncheck();
  await expect(checks.nth(1)).not.toBeChecked();
  await expect(reopenBtn).toHaveText('Reopen (2)');
  await expect(reopenBtn).toBeEnabled();

  // Uncheck the rest → button disabled (nothing to reopen).
  await checks.nth(0).uncheck();
  await checks.nth(2).uncheck();
  await expect(reopenBtn).toBeDisabled();

  // Re-check one → enabled again with a count of 1.
  await checks.nth(0).check();
  await expect(reopenBtn).toHaveText('Reopen (1)');
  await expect(reopenBtn).toBeEnabled();

  // Discard is always available regardless of selection.
  await expect(page.getByTestId('session-discard')).toBeEnabled();
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Discard clears the session key + no prompt on subsequent reload
// ─────────────────────────────────────────────────────────────────────────────

test('Discard clears localStorage and subsequent reload shows no prompt', async ({ page }) => {
  const entries = [
    {
      kind: 'board',
      fileName: 'discard-test.bvr',
      fileSize: 111,
      fileLastModified: 1700000000000,
      active: true,
    },
  ];

  await seedSession(page, entries);
  await gotoApp(page);

  const prompt = page.getByTestId('session-restore-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });

  // Click Discard.
  await page.getByTestId('session-discard').click();

  // Prompt disappears immediately.
  await expect(prompt).toHaveCount(0);

  // The localStorage key must be gone NOW (before reload).
  const stored = await page.evaluate((key: string) => localStorage.getItem(key), SESSION_KEY);
  expect(stored, 'localStorage key must be cleared after Discard').toBeNull();

  // Reload — still no prompt (the key is gone, so React state initialises to null).
  await page.reload();
  await page.waitForSelector('[data-testid="statusbar"], .toolbar, .library-tabs-row', { timeout: 12_000 });
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: No session / empty entries → prompt never appears
// ─────────────────────────────────────────────────────────────────────────────

test('no prompt when no session is stored', async ({ page }) => {
  // Do NOT seed anything — localStorage starts empty.
  await gotoApp(page);
  // Give React time to mount fully.
  await page.waitForTimeout(500);
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
});

test('no prompt when session entries array is empty', async ({ page }) => {
  // Seed an explicit empty-entries session — the component must not render.
  await seedSession(page, []);
  await gotoApp(page);
  await page.waitForTimeout(500);
  await expect(page.getByTestId('session-restore-prompt')).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Reopen round-trip (board actually reloads) — requires live backend
// ─────────────────────────────────────────────────────────────────────────────

test('Reopen restores the board when a live backend + library is present', async ({ page }) => {
  const base = await findBackend(page);
  if (!base) {
    test.skip(true,
      'No Go backend found on ports 11336 / 8080 — ' +
      'start the backend with a seeded library to run this test. ' +
      'The core prompt behaviour (show/discard) is covered by tests 1–3 which are backend-independent.');
    return;
  }

  // Load the tracked public fixture (always present, no backend needed for the open itself).
  const TEST_BVR1 = path.resolve(__dirname, '../public/samples/test-board.bvr');

  await page.goto('/');
  await page.waitForSelector('[data-testid="statusbar"]', { timeout: 12_000 });

  // Open the board via the file-input (same helper as comprehensive.spec.ts).
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(TEST_BVR1);
  await expect(page.getByTestId('statusbar')).toContainText('parts', { timeout: 15_000 });

  // Wait for the debounced capture (500 ms) + a safety margin.
  await page.waitForTimeout(900);

  // The session should now be captured.
  const sessionJson = await page.evaluate((key: string) => localStorage.getItem(key), SESSION_KEY);
  expect(sessionJson, 'session must be captured before reload').not.toBeNull();
  const session = JSON.parse(sessionJson!) as { entries: { kind: string; fileName: string }[] };
  expect(session.entries.some(e => e.kind === 'board'), 'board entry in session').toBeTruthy();

  // Reload — the prompt must appear.
  await page.reload();
  await page.waitForSelector('[data-testid="statusbar"], .toolbar, .library-tabs-row', { timeout: 12_000 });

  const prompt = page.getByTestId('session-restore-prompt');
  await expect(prompt).toBeVisible({ timeout: 5_000 });

  // Click Reopen.
  await page.getByTestId('session-reopen').click();

  // Prompt disappears.
  await expect(prompt).toHaveCount(0);

  // Board is restored: the statusbar must again show 'parts'
  // (restore goes through databankStore + IndexedDB cache — the latter works
  // because the board was opened via file-input in the same Playwright session,
  // so board-cache.ts wrote a cache entry during the initial load).
  await expect(page.getByTestId('statusbar')).toContainText('parts', { timeout: 20_000 });
});
