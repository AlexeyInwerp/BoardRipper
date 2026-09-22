/**
 * Library panel while the backend is unreachable.
 *
 * Report (2026-09-22): with the server down, the Library flashes "Library is
 * empty — no files indexed yet" before settling on the unreachable notice. An
 * empty library and an unreachable server are different facts and the panel
 * must never claim the first while it only knows the second. This spec aborts
 * every /api request (the browser sees a connection failure, like a stopped
 * container) and samples the panel's text for a while: no sample may ever
 * read "empty", and once the notice is up it must stay up.
 */
import { test, expect } from '@playwright/test';

/** Three ways a backend is unreachable in the field: the port refuses at once
 *  (server stopped, same host), the connection hangs and then fails (a NAS
 *  rebooting, a Tailscale route down), and a reverse proxy that answers 502
 *  for a container that is not there. The panel must tell the same story in
 *  all three. */
const FLAVOURS: Record<string, (route: import('@playwright/test').Route) => Promise<void>> = {
  'refused at once': route => route.abort('connectionrefused'),
  'hangs 1.5 s, then fails': async route => { await new Promise(r => setTimeout(r, 1500)); await route.abort('connectionfailed'); },
  'proxy answers 502': route => route.fulfill({ status: 502, contentType: 'text/html', body: '<h1>502 Bad Gateway</h1>' }),
};

for (const [flavour, handler] of Object.entries(FLAVOURS)) test(`an unreachable backend never reads as an empty library (${flavour})`, async ({ page }) => {
  await page.route('**/api/**', handler);
  await page.addInitScript(() => {
    try { localStorage.setItem('boardripper-welcome-done', '1'); } catch { /* ignore */ }
  });
  await page.goto('/');
  const content = page.locator('.library-content');
  if (!(await content.isVisible())) await page.locator('[data-sidebar-tab="library"]').first().click();
  await expect(content).toBeVisible();

  // Sample for 3 s at 50 ms: every distinct message the panel showed, in order.
  const seen: string[] = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    const text = (await content.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (text && seen[seen.length - 1] !== text) seen.push(text);
    await page.waitForTimeout(50);
  }
  console.log('library-content states:', JSON.stringify(seen));
  expect(seen.some(s => /library is empty/i.test(s)), `saw an "empty" claim: ${JSON.stringify(seen)}`).toBe(false);
  // One transient at most before the notice; the notice never yields to another state.
  const noticeAt = seen.findIndex(s => /reachable|unreachable/i.test(s));
  expect(noticeAt, `no unreachable notice in ${JSON.stringify(seen)}`).toBeGreaterThanOrEqual(0);
  expect(seen.slice(noticeAt + 1), 'the unreachable notice was replaced by another state').toEqual([]);
});

test('the notice reconnects on its own button and the library then loads', async ({ page }) => {
  // Backend down for the whole boot …
  let up = false;
  const json = (route: import('@playwright/test').Route, body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', route => {
    if (!up) return route.abort('connectionrefused');
    const url = route.request().url();
    if (url.includes('/api/databank/files/stream')) {
      return route.fulfill({ status: 200, contentType: 'application/x-ndjson',
        body: '{"type":"begin","total":0,"signature":"t"}\n{"type":"done"}\n' });
    }
    if (url.includes('/api/databank/stats')) return json(route, { boards: 0, pdfs: 0, total_files: 0, total_size: 0, last_file_scan_at: 1, db_size: 0 });
    if (url.includes('/api/databank/scan/status')) return json(route, { running: false, scanned: 0, total: 0, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 1 });
    if (url.includes('/api/databank/tree')) return json(route, { name: '/', path: '' });
    if (url.includes('/api/databank/donors')) return json(route, []);
    if (url.includes('/api/databank/files')) return json(route, []);
    if (url.includes('/api/config')) return json(route, { _scan_root: '/library' });
    return json(route, {});
  });
  await page.addInitScript(() => { try { localStorage.setItem('boardripper-welcome-done', '1'); } catch { /* ignore */ } });
  await page.goto('/');
  const content = page.locator('.library-content');
  if (!(await content.isVisible())) await page.locator('[data-sidebar-tab="library"]').first().click();
  const notice = page.locator('.library-backend-warn');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/retrying every \d+ s/i);

  // "Retry now" probes at once instead of waiting out the back-off …
  const probe = page.waitForRequest(req => req.url().includes('/api/health'), { timeout: 3000 });
  await notice.getByRole('button', { name: 'Retry now' }).click();
  await probe;
  await expect(notice).toBeVisible(); // still down: the notice stays

  // … and when the backend does come back, the timer finds it without a reload
  // (back-off is 2 s, 4 s, 8 s — well inside this budget).
  up = true;
  await expect(notice).toBeHidden({ timeout: 20000 });
  // Now — and only now — the library is provably empty: the stream completed with no rows.
  await expect(content).toContainText(/library is empty/i, { timeout: 5000 });
});
