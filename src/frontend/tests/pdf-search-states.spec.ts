/**
 * Library ▸ PDF search: how a search ended is what the panel says.
 *
 * Review 2026-10-14 (docs/specs/2026-10-14-pdf-index-search-review.md, U1/U2):
 * every failed, cut or index-less search rendered as `No results for "…"`,
 * so a server whose index was missing, a proxy that cut the stream, and a
 * search that had nothing to find all looked the same. Each case here is a
 * mocked server answer; "No results" may only appear for a stream that ended
 * with its `done` line and no rows. Runs with no backend and no samples.
 */
import { test, expect, type Route, type Page } from '@playwright/test';

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const ndjson = (route: Route, lines: unknown[]) =>
  route.fulfill({
    status: 200,
    contentType: 'application/x-ndjson',
    body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  });

const result = (id: number, name: string) => ({
  type: 'result', file_id: id, page_num: 3, snippet: 'see <b>PP3V3</b>_S5 here',
  filename: name, path: `boards/${name}`, is_donor: false, board_bindings: [], copies: [], hit_count: 1,
});

const PROGRESS = { running: false, total: 0, done: 0, errors: 0, current_file: '', started_at: 0, workers: 2, active_workers: 0 };
const STATS = { indexed: 10, empty: 0, failed: 0, pending: 0, indexing: 0, pages: 100, given_up: 0 };

/** Everything the app asks at boot, answered minimally; the index endpoints
 *  as a server with an index (unless `noIndex`), the stream by `stream`. */
async function mockServer(page: Page, stream: (route: Route) => Promise<void> | void, noIndex = false) {
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    if (url.includes('/api/databank/search/stream')) return stream(route);
    if (url.includes('/api/pdfindex/')) {
      if (noIndex) return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>BoardRipper</title>' });
      if (url.includes('/progress')) return json(route, PROGRESS);
      if (url.includes('/stats')) return json(route, STATS);
      return json(route, {});
    }
    if (url.includes('/api/databank/files/stream')) {
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
        body: '{"type":"begin","total":0,"signature":"t"}\n{"type":"done"}\n' });
    }
    if (url.includes('/api/databank/stats')) return json(route, { boards: 0, pdfs: 10, total_files: 10, total_size: 0, last_file_scan_at: 1, db_size: 0 });
    if (url.includes('/api/databank/scan/status')) return json(route, { running: false, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 1 });
    if (url.includes('/api/databank/tree')) return json(route, { name: '/', path: '' });
    if (url.includes('/api/databank/donors')) return json(route, []);
    if (url.includes('/api/databank/files')) return json(route, []);
    if (url.includes('/api/config')) return json(route, { _scan_root: '/library' });
    return json(route, {});
  });
  await page.addInitScript(() => {
    try { localStorage.setItem('boardripper-welcome-done', '1'); } catch { /* ignore */ }
  });
}

/** Open Library ▸ PDF, type a query, press Enter; returns the panel. */
async function search(page: Page, query: string) {
  await page.goto('/');
  const content = page.locator('.library-content');
  if (!(await content.isVisible())) await page.locator('[data-sidebar-tab="library"]').first().click();
  await page.locator('[data-library-tab="pdf"]').click();
  await page.keyboard.press('Escape');
  const input = page.getByPlaceholder(/Search PDF text/);
  await input.fill(query);
  await input.press('Enter');
  return page.locator('.library-panel, .library-content').first();
}

/** Samples the panel text until `until` matches, failing on any "No results"
 *  before it: the claim must never flash while the answer is still out. */
async function watch(page: Page, until: RegExp) {
  const panel = page.locator('.sidebar');
  const seen: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const text = (await panel.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (seen[seen.length - 1] !== text) seen.push(text);
    if (until.test(text)) break;
    await page.waitForTimeout(50);
  }
  return seen;
}

test('a stream cut before its done line is a failure, never "No results"', async ({ page }) => {
  await mockServer(page, (route) => ndjson(route, [])); // empty body: no done, no error
  await search(page, 'PP3V3');
  const seen = await watch(page, /Search failed/);
  expect(seen.some((s) => /No results for/.test(s)), JSON.stringify(seen)).toBe(false);
  await expect(page.getByTestId('pdf-search-failed')).toContainText(/cut off/);
  await expect(page.getByTestId('pdf-search-failed').getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('a server without a PDF index says so, in the search and its status', async ({ page }) => {
  await mockServer(page,
    (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>BoardRipper</title>' }),
    true);
  await search(page, 'PP3V3');
  await expect(page.getByTestId('pdf-search-failed')).toContainText(/no PDF text index/);
  await expect(page.getByTestId('pdf-search-empty')).toHaveCount(0);
});

test('a server error line is shown with its reason', async ({ page }) => {
  await mockServer(page, (route) => ndjson(route, [{ type: 'error', code: 'search', error: 'database is locked' }]));
  await search(page, 'PP3V3');
  await expect(page.getByTestId('pdf-search-failed')).toContainText('database is locked');
});

test('a query of only one-letter terms asks for longer ones', async ({ page }) => {
  await mockServer(page, (route) => ndjson(route, [{ type: 'error', code: 'too_short', error: 'too short' }]));
  await search(page, 'C');
  await expect(page.getByTestId('pdf-search-failed')).toContainText(/at least 2 letters/);
  await expect(page.getByTestId('pdf-search-failed').getByRole('button', { name: 'Retry' })).toHaveCount(0);
});

test('a capped search lists its rows and says more exist; counts reorder the rows', async ({ page }) => {
  await mockServer(page, (route) => ndjson(route, [
    result(1, 'few-hits.pdf'),
    result(2, 'many-hits.pdf'),
    { type: 'counts', counts: { 1: 2, 2: 40 } },
    { type: 'done', total: 2, partial: true, partial_reason: 'files', ignored: ['C'] },
  ]));
  await search(page, 'PP3V3 C');
  const partial = page.getByTestId('pdf-search-partial');
  await expect(partial).toContainText('Showing the first 2 files');
  await expect(partial).toContainText('Ignored (too short): C');
  const rows = page.locator('.library-search-result');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('many-hits.pdf');
  await expect(rows.first()).toContainText('40 hits');
});

test('"No results" is said for a finished search with no rows', async ({ page }) => {
  await mockServer(page, (route) => ndjson(route, [{ type: 'counts', counts: {} }, { type: 'done', total: 0 }]));
  await search(page, 'XYZZY');
  await expect(page.getByTestId('pdf-search-empty')).toContainText('No results');
  await expect(page.getByTestId('pdf-search-failed')).toHaveCount(0);
});

test('a search that does not answer can be cancelled, and is not reported empty', async ({ page }) => {
  await mockServer(page, () => new Promise<void>(() => { /* never answers */ }));
  await search(page, 'PP3V3');
  const btn = page.getByTestId('pdf-search-btn');
  await expect(btn).toHaveText('Cancel');
  await btn.click();
  await expect(btn).toHaveText('Search');
  await expect(page.getByTestId('pdf-search-empty')).toHaveCount(0);
});
