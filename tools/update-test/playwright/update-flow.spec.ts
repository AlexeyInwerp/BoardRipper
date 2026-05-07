/**
 * End-to-end self-update test.
 *
 * Drives a real OLD boardripper container through a real signed-manifest
 * update to a real NEW image, screenshotting every 2-3s. Asserts the
 * contract the user actually cares about:
 *
 *   - Clicking "Update & Restart" surfaces progress *in the frontend*.
 *   - The frontend stays alive while the backend restarts (overlay shows,
 *     no white-screen).
 *   - After the new container reports healthy, the page reloads and
 *     /api/update/status reports the new version with has_update=false.
 *
 * Backend death is the expected mid-flow state; the harness never asserts
 * against the dying backend, only against what the browser shows + what
 * the *new* backend reports once it's up.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const URL          = process.env.BR_HARNESS_URL!;
const OLD_VERSION  = process.env.BR_HARNESS_OLD_VERSION!;
const NEW_VERSION  = process.env.BR_HARNESS_NEW_VERSION!;
const RESULTS_DIR  = process.env.BR_HARNESS_RESULTS_DIR!;

if (!URL || !OLD_VERSION || !NEW_VERSION || !RESULTS_DIR) {
  throw new Error('harness env vars missing — run via tools/update-test/run.sh');
}

fs.mkdirSync(RESULTS_DIR, { recursive: true });

interface ScreenSample {
  t: number;             // ms since flow start
  file: string;          // screenshot filename
  url: string;
  badgeText: string | null;
  badgeIsUpdating: boolean;
  overlayVisible: boolean;
  progressLines: string[];
  apiCurrentVersion: string | null;
  apiHasUpdate: boolean | null;
  storeUpdating: boolean | null;
  storeRestarting: boolean | null;
  storeProgressCount: number | null;
  consoleErrorsSinceLast: string[];
  fetchFailures: number;
}

async function probeStore(page: Page): Promise<{ updating: boolean; restarting: boolean; progressCount: number } | null> {
  try {
    return await page.evaluate(() => {
      // updateStore is exported on window in DEV via vite HMR globals; in
      // production it isn't, so we walk through the React fiber to find the
      // overlay component and read its hook output. Cheap fallback: locate
      // the module's singleton via a tiny shim we inject below.
      const w = window as unknown as { __brUpdateStore?: { updating: boolean; restarting: boolean; progress: { length: number }[] } };
      if (!w.__brUpdateStore) return null;
      const s = w.__brUpdateStore;
      return { updating: !!s.updating, restarting: !!s.restarting, progressCount: (s as unknown as { progress: { length: number } }).progress.length };
    });
  } catch { return null; }
}

async function probeStatus(page: Page): Promise<{ current_version?: string; has_update?: boolean } | null> {
  try {
    // Short timeout — during the backend swap the proxy serves 502 fast and
    // we don't want to block the snapshot cadence on it.
    const r = await page.request.get('/api/update/status', { timeout: 2000 });
    if (!r.ok()) return null;
    return await r.json();
  } catch { return null; }
}

async function snapshot(page: Page, label: string, t: number, sink: ScreenSample[], errorBuf: string[], failuresAt: () => number): Promise<ScreenSample> {
  const file = path.join(RESULTS_DIR, `frame-${String(t).padStart(6, '0')}-${label}.png`);
  let badgeText: string | null = null;
  let badgeIsUpdating = false;
  let overlayVisible = false;
  let progressLines: string[] = [];
  let url = '';
  try { await page.screenshot({ path: file, fullPage: false, timeout: 5_000 }); } catch { /* page may be navigating */ }
  try {
    url = page.url();
    const badge = page.locator('.toolbar-update-badge').first();
    badgeText = await badge.textContent({ timeout: 800 }).catch(() => null);
    const cls = await badge.getAttribute('class', { timeout: 800 }).catch(() => '') || '';
    badgeIsUpdating = /\bis-updating\b/.test(cls);
    overlayVisible = await page.locator('.update-progress-overlay').first().isVisible().catch(() => false);
    progressLines = await page.locator('.update-progress-line').allTextContents().catch(() => []);
  } catch { /* still navigating */ }
  const status = await probeStatus(page);
  const store = await probeStore(page);
  const sample: ScreenSample = {
    t, file: path.basename(file), url,
    badgeText: badgeText ? badgeText.trim() : null,
    badgeIsUpdating, overlayVisible, progressLines,
    apiCurrentVersion: status?.current_version ?? null,
    apiHasUpdate: status?.has_update ?? null,
    storeUpdating: store?.updating ?? null,
    storeRestarting: store?.restarting ?? null,
    storeProgressCount: store?.progressCount ?? null,
    consoleErrorsSinceLast: errorBuf.splice(0),
    fetchFailures: failuresAt(),
  };
  sink.push(sample);
  return sample;
}

test('OLD → NEW self-update keeps the frontend coherent', async ({ page }, testInfo) => {
  testInfo.setTimeout(5 * 60 * 1000);

  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });
  let fetchFailures = 0;
  page.on('requestfailed', () => { fetchFailures++; });
  const failuresAt = () => fetchFailures;

  const samples: ScreenSample[] = [];
  const t0 = Date.now();
  const tick = () => Date.now() - t0;

  // 1. Open OLD container UI.
  await page.goto(URL);
  await snapshot(page, 'opened', tick(), samples, consoleErrors, failuresAt);

  // 2. Wait for the badge to render. fetchStatus runs at module load, so the
  //    first paint already has the right version (post-bootstrap).
  await expect(page.locator('.toolbar-update-badge')).toBeVisible({ timeout: 30_000 });
  const initialBadge = await page.locator('.toolbar-update-badge').textContent();
  console.log(`[harness] initial badge: ${initialBadge?.trim()}`);

  // 3. Click the badge to open the dropdown — this also triggers updateStore.check()
  //    which forces the manifest fetch (otherwise we'd wait 30 s for the
  //    background ticker).
  await page.locator('.toolbar-update-badge').click();
  await snapshot(page, 'badge-opened', tick(), samples, consoleErrors, failuresAt);

  // 4. Poll until the dropdown shows the available update.
  await expect.poll(async () => {
    const txt = await page.locator('.update-dropdown').textContent().catch(() => '');
    return /Update available|Important update/i.test(txt || '');
  }, { timeout: 30_000, intervals: [500, 1000] }).toBeTruthy();
  await snapshot(page, 'update-detected', tick(), samples, consoleErrors, failuresAt);

  // 5. Click "Update & Restart"
  const applyBtn = page.locator('.update-dropdown-btn', { hasText: /Update & Restart/i }).first();
  await expect(applyBtn).toBeVisible();
  await applyBtn.click();
  console.log(`[harness] clicked Update & Restart at t=${tick()}ms`);

  // 6. Stream snapshots every 2.5s for up to 4 minutes. Three signals to track:
  //    - sawUpdating: badge.is-updating class while SSE is alive
  //    - sawOverlay:  .update-progress-overlay while waiting for new container
  //    - postReloadConfirmed: /api/update/status reports new version & no update
  const POLL_MS = 2_500;
  const DEADLINE = 4 * 60 * 1000;
  let sawUpdating = false;
  let sawOverlay = false;
  let sawErrorEntry = false;
  let postReloadConfirmed = false;
  while (tick() < DEADLINE && !postReloadConfirmed) {
    await page.waitForTimeout(POLL_MS);
    const s = await snapshot(page, 'progress', tick(), samples, consoleErrors, failuresAt);
    if (s.badgeIsUpdating || s.storeUpdating) sawUpdating = true;
    if (s.overlayVisible || s.storeRestarting) sawOverlay = true;
    if (s.progressLines.some(l => /error|fail/i.test(l))) sawErrorEntry = true;
    if (s.apiCurrentVersion === NEW_VERSION && s.apiHasUpdate === false) postReloadConfirmed = true;
    console.log(
      `[harness] t=${s.t} badge=${JSON.stringify(s.badgeText)} ` +
      `updatingCls=${s.badgeIsUpdating} overlay=${s.overlayVisible} ` +
      `store={u:${s.storeUpdating},r:${s.storeRestarting},p:${s.storeProgressCount}} ` +
      `apiVer=${s.apiCurrentVersion} apiHasUpdate=${s.apiHasUpdate} ` +
      `progress=${s.progressLines.length} fetchFails=${s.fetchFailures}`
    );
  }
  await snapshot(page, 'final', tick(), samples, consoleErrors, failuresAt);

  fs.writeFileSync(
    path.join(RESULTS_DIR, 'timeline.json'),
    JSON.stringify({ url: URL, oldVersion: OLD_VERSION, newVersion: NEW_VERSION, samples }, null, 2),
  );

  // -- Assertions, ranked by how cleanly they verify the user-visible contract --
  // a. The new container is up and reports the new version.
  expect(postReloadConfirmed,
    `/api/update/status never reported {current_version=${NEW_VERSION}, has_update=false}`).toBeTruthy();

  // b. Update progress was visible to the user — either via the badge "is-updating"
  //    state (apply phase, before backend died) or the overlay (post-disconnect).
  expect.soft(sawUpdating || sawOverlay,
    'frontend showed no progress signal during the update — user would think nothing is happening').toBeTruthy();

  // c. The overlay specifically appeared during the restart window.
  expect.soft(sawOverlay,
    'overlay never showed — frontend may have crashed or post-disconnect logic regressed').toBeTruthy();

  // d. SSE never delivered a terminal error entry.
  expect.soft(sawErrorEntry, 'SSE stream delivered an error entry').toBeFalsy();

  // e. No JS crashes during the restart window. Network errors are expected.
  const crashes = samples.flatMap(s => s.consoleErrorsSinceLast).filter(line =>
    /TypeError|ReferenceError|Cannot read|is not a function|Uncaught \(in promise\)/i.test(line)
    && !/Failed to fetch|NetworkError|ERR_CONNECTION|ERR_FAILED|HTTP \d{3}|aborted|status of 50\d/i.test(line));
  expect.soft(crashes, `unexpected JS errors during update: ${crashes.join(' | ')}`).toEqual([]);
});
