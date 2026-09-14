/**
 * First-run library setup modal (components/FirstRunSetup.tsx).
 *
 * The modal is gated on BACKEND state — a library that was never indexed —
 * so the backend is mocked at the route level; no Go process is needed.
 * Under WebDriver the auto-show is suppressed unless the force key is set,
 * which is what keeps every other spec unblocked.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

interface Calls { configPuts: Record<string, string>; scanPosts: number; obdSync: number; obdFetchAll: number; }

async function mockBackend(page: Page, opts: { boards?: number; pdfs?: number; lastScan?: number } = {}): Promise<Calls> {
  const calls: Calls = { configPuts: {}, scanPosts: 0, obdSync: 0, obdFetchAll: 0 };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // Catch-all first: Playwright matches routes in reverse registration order.
  await page.route('**/api/**', route => json(route, { error: 'not mocked' }, 404));
  await page.route('**/api/config', route => {
    if (route.request().method() === 'PUT') {
      const b = route.request().postDataJSON() as { key: string; value: string };
      calls.configPuts[b.key] = b.value;
      return json(route, { status: 'ok' });
    }
    return json(route, { _scan_root: '/library' });
  });
  await page.route('**/api/databank/stats', route => json(route, {
    boards: opts.boards ?? 0, pdfs: opts.pdfs ?? 0, bindings: 0, db_size_bytes: 1, last_file_scan_at: opts.lastScan ?? 0,
  }));
  await page.route('**/api/databank/scan/status', route => json(route, {
    running: false, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0,
  }));
  await page.route('**/api/databank/scan', route => {
    calls.scanPosts++;
    return json(route, { running: true, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 });
  });
  await page.route('**/api/databank/browse?path=', route => json(route, {
    path: '', entries: [{ name: 'MacBooks', is_dir: true }, { name: 'iPhones', is_dir: true }],
  }));
  await page.route('**/api/databank/files/stream', route => route.fulfill({
    status: 200, contentType: 'application/x-ndjson',
    body: '{"type":"begin","total":0,"signature":"t"}\n{"type":"done"}\n',
  }));
  await page.route('**/api/databank/files', route => json(route, []));
  await page.route('**/api/databank/tree', route => json(route, { name: '/', path: '' }));
  await page.route('**/api/databank/donors', route => json(route, []));
  await page.route('**/api/obd/index/sync', route => { calls.obdSync++; return json(route, { synced_at: '2026-09-14T00:00:00Z', board_count: 3 }); });
  await page.route('**/api/obd/match?board_number=', route => json(route, {
    matches: [], index: { synced: calls.obdSync > 0, board_count: 3, cached: 0 },
  }));
  await page.route('**/api/obd/fetch-all', route => {
    calls.obdFetchAll++;
    return json(route, { running: true, total: 3, done: 0, fetched: 0, skipped: 0, failed: 0 });
  });
  await page.route('**/api/obd/fetch-all/progress', route => json(route, { running: false, total: 3, done: 3, fetched: 3, skipped: 0, failed: 0 }));
  return calls;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('boardripper-welcome-done', '1');   // gesture wizard out of the way
    localStorage.setItem('boardripper-firstrun-force', '1'); // allow auto-show under WebDriver
  });
});

test('never-indexed library shows the setup; Start writes config, scans and downloads OBD', async ({ page }) => {
  const calls = await mockBackend(page);
  await page.goto('/');
  const modal = page.getByTestId('firstrun-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('firstrun-folders')).toContainText('MacBooks, iPhones');
  await expect(page.getByTestId('firstrun-bind')).toBeChecked();
  await expect(page.getByTestId('firstrun-obd')).toBeChecked();
  await expect(page.getByTestId('firstrun-rescan')).toBeChecked();

  await page.getByTestId('firstrun-start').click();
  await expect(modal).toBeHidden();
  await expect.poll(() => calls.scanPosts).toBe(1);
  await expect.poll(() => calls.obdFetchAll).toBe(1);
  expect(calls.obdSync, 'index synced before the download').toBe(1);
  expect(calls.configPuts).toMatchObject({ auto_bind: 'true', auto_scan: 'true' });
});

test('unticked options are written as off and OBD is not fetched', async ({ page }) => {
  const calls = await mockBackend(page);
  await page.goto('/');
  await expect(page.getByTestId('firstrun-modal')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('firstrun-bind').uncheck();
  await page.getByTestId('firstrun-obd').uncheck();
  await page.getByTestId('firstrun-rescan').uncheck();
  await page.getByTestId('firstrun-start').click();
  await expect.poll(() => calls.scanPosts).toBe(1);
  await page.waitForTimeout(300);
  expect(calls.obdFetchAll).toBe(0);
  expect(calls.configPuts).toMatchObject({ auto_bind: '', auto_scan: '' });
});

test('an indexed library never shows it, Settings can still open it', async ({ page }) => {
  await mockBackend(page, { boards: 12, pdfs: 3, lastScan: 1700000000 });
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('firstrun-modal')).toHaveCount(0);

  await page.click('[data-sidebar-tab="settings"]');
  await page.click('[data-settings-tab="library"]');
  await page.getByTestId('firstrun-show-btn').click();
  await expect(page.getByTestId('firstrun-modal')).toBeVisible();
  // Forced from Settings there is no "Don't show again" — that only makes
  // sense for the automatic case.
  await expect(page.getByRole('button', { name: /Don't show again/ })).toHaveCount(0);
});

test('Skip hides it for the session; a reset (never-indexed again) brings it back after reload', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await expect(page.getByTestId('firstrun-modal')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByTestId('firstrun-modal')).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('firstrun-modal')).toHaveCount(0);

  // What databankStore.resetAll() does before it reloads.
  await page.evaluate(() => { sessionStorage.removeItem('boardripper-firstrun-skipped'); localStorage.removeItem('boardripper-firstrun-never'); });
  await page.reload();
  await expect(page.getByTestId('firstrun-modal')).toBeVisible({ timeout: 10000 });
});
