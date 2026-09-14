/**
 * BindPicker (LibraryPanel) must never render the whole PDF library as rows:
 * measured 251 ms to open and ~90 ms per keystroke at 7.5 k candidates,
 * linear in library size. It renders 200, offers "Show all", and the filter
 * is debounced. Backend mocked at the route level (dev-server store handle).
 */
import { test, expect, type Route } from '@playwright/test';

const PDFS = 3000;

test('bind picker renders at most 200 candidates, filter narrows, Show all expands', async ({ page }) => {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const file = (id: number, name: string, type: 'board' | 'pdf') => ({
    id, path: `Lib/${name}`, filename: name, extension: name.slice(name.lastIndexOf('.')), file_type: type,
    size: 1000, mod_time: 1, scan_time: 1, donor_pool: false, has_preview: false,
  });
  const files = [file(1, '820-00165-A.brd', 'board')];
  for (let i = 0; i < PDFS; i++) files.push(file(100 + i, `doc-${String(i).padStart(4, '0')}.pdf`, 'pdf'));

  await page.route('**/api/**', route => json(route, { error: 'not mocked' }, 404));
  await page.route('**/api/config', route => json(route, route.request().method() === 'PUT' ? { status: 'ok' } : { _scan_root: '/library' }));
  await page.route('**/api/databank/stats', route => json(route, { boards: 1, pdfs: PDFS, bindings: 0, db_size_bytes: 1, last_file_scan_at: 1700000000 }));
  await page.route('**/api/databank/scan/status', route => json(route, { running: false, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 }));
  await page.route('**/api/databank/files/stream', route => route.fulfill({
    status: 200, contentType: 'application/x-ndjson',
    body: `{"type":"begin","total":${files.length},"signature":"s1"}\n` + files.map(f => JSON.stringify({ type: 'file', ...f })).join('\n') + '\n{"type":"done"}\n',
  }));
  await page.route('**/api/databank/files', route => json(route, files));
  await page.route('**/api/databank/files/1', route => json(route, { ...files[0], bindings: [] }));
  await page.route('**/api/databank/tree', route => json(route, { name: '/', path: '', children: [{ name: 'Lib', path: 'Lib', file_ids: files.map(f => f.id) }] }));
  await page.route('**/api/databank/donors', route => json(route, []));
  await page.route('**/api/obd/match**', route => json(route, { matches: [], index: { synced: false, board_count: 0, cached: 0 } }));

  await page.goto('/');
  await page.click('[data-sidebar-tab="library"]');
  if (!(await page.locator('.library-panel').isVisible())) await page.click('[data-sidebar-tab="library"]');
  await page.waitForFunction(() => {
    const s = (window as unknown as { __databankStore?: { files: unknown[] } }).__databankStore;
    return !!s && s.files.length >= 3001;
  }, null, { timeout: 15000 });

  await page.evaluate(() => (window as unknown as { __databankStore: { fetchFileDetail(id: number): Promise<unknown> } }).__databankStore.fetchFileDetail(1));
  const plus = page.locator('.library-detail-bind-btn');
  await expect(plus).toBeVisible({ timeout: 10000 });
  await plus.click();

  const rows = page.locator('.library-bind-candidate');
  await expect(rows).toHaveCount(200);
  await expect(page.getByTestId('bind-picker-more')).toContainText('2,800 more');

  await page.locator('.library-bind-picker-filter').fill('doc-2999');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('bind-picker-more')).toHaveCount(0);

  await page.locator('.library-bind-picker-filter').fill('');
  await expect(rows).toHaveCount(200);
  await page.getByTestId('bind-picker-more').getByRole('button', { name: 'Show all' }).click();
  await expect(rows).toHaveCount(PDFS);
});
