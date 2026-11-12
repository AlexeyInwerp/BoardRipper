/**
 * Settings ▸ Integrations ▸ AI assistants — the connect sheet.
 *
 * Backend-free: all /api/mcp/* and /api/agents endpoints are stubbed with
 * page.route, so this runs in the default Vite-only harness. Asserts:
 *  1. The connect snippet carries this browser's pairing token by default.
 *  2. Advanced ▸ "Use the shared token" swaps it for the install token, which
 *     is only fetched on that explicit reveal.
 *  3. The browser-name field reflects the backend-echoed pairing label, and
 *     Rotate replaces the token in the snippet.
 *  4. Picking an assistant waits for its first call and then says it is
 *     connected; the per-assistant board-control choice is posted.
 * The Go tests (mcpserver/agents_test.go, scope_http_test.go) cover the backend.
 */

import { test, expect, type Page } from '@playwright/test';

async function openIntegrations(page: Page) {
  await page.goto('/');
  await page.locator('[data-sidebar-tab="settings"]').first().click();
  await page.locator('[data-settings-tab="integrations"]').click();
}

test.describe('AI assistants connect sheet', () => {
  let agents: unknown[] = [];
  let tokenFetches = 0;
  let updates: unknown[] = [];

  test.beforeEach(async ({ page }) => {
    agents = []; tokenFetches = 0; updates = [];
    await page.route('**/api/mcp/status', (r) =>
      r.fulfill({ json: { enabled: true, drive_ui: false, clients: 1, auth_mode: 'token' } }));
    await page.route('**/api/mcp/token', (r) => { tokenFetches++; return r.fulfill({ json: { token: 'shared-token-abcdef' } }); });
    await page.route('**/api/mcp/pair', (r) =>
      r.fulfill({ json: { token: 'pair-token-123456', label: 'Bench A' } }));
    await page.route('**/api/mcp/pair/rotate', (r) =>
      r.fulfill({ json: { token: 'rotated-token-999' } }));
    await page.route('**/api/agents', (r) => r.fulfill({ json: { agents } }));
    await page.route('**/api/agents/update', async (r) => {
      updates.push(JSON.parse(r.request().postData() || '{}'));
      return r.fulfill({ status: 204 });
    });
  });

  test('the snippet carries this browser’s token; the shared one only on reveal', async ({ page }) => {
    await openIntegrations(page);
    await page.locator('[data-ai-client="claude-code"]').click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('pair-token-123456');
    // Mounting the bridge may read the install token; the sheet itself must not add a read.
    const before = tokenFetches;

    await page.getByTestId('ai-advanced').click();
    await expect(page.getByTestId('mcp-pair-label')).toHaveValue('Bench A');
    expect(tokenFetches).toBe(before);
    // Ticks only once the token has arrived, so click and wait rather than check().
    await page.getByTestId('mcp-use-shared').click();
    await expect(page.getByTestId('mcp-use-shared')).toBeChecked();
    expect(tokenFetches).toBe(before + 1);
    await expect(page.locator('.mcp-connect-cmd')).toContainText('shared-token-abcdef');
    await page.getByTestId('mcp-use-shared').click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('pair-token-123456');
  });

  test('rotate replaces the browser token', async ({ page }) => {
    await openIntegrations(page);
    await page.locator('[data-ai-client="gemini"]').click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('pair-token-123456');
    await page.getByTestId('ai-advanced').click();
    await page.getByRole('button', { name: /^rotate$/i }).click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('rotated-token-999');
  });

  test('editors get a deep link and the smaller tool set', async ({ page }) => {
    await openIntegrations(page);
    await page.locator('[data-ai-client="vscode"]').click();
    const href = await page.getByTestId('ai-open-link').getAttribute('href');
    expect(href).toMatch(/^vscode:mcp\/install\?/);
    expect(decodeURIComponent(href!)).toContain('tools=board,drive,pdf,worklist');
  });

  test('waits for the first call, then lists the assistant with its own switch', async ({ page }) => {
    await openIntegrations(page);
    await page.locator('[data-ai-client="cursor"]').click();
    await expect(page.getByTestId('ai-waiting')).toBeVisible();

    const me = await page.evaluate(() => localStorage.getItem('br-mcp-client-id'));
    agents = [{
      key: 'browser:x|cursor', name: 'Cursor', client_name: 'cursor', credential: 'browser',
      browser_id: me ?? 'unknown', last_seen_ms: Date.now() + 1000, first_seen: new Date().toISOString(),
      last_tool: 'board_overview', calls: 3,
    }];
    await expect(page.getByTestId('ai-connected')).toContainText('Cursor is connected', { timeout: 8000 });

    await page.getByRole('combobox', { name: /board control for cursor/i }).selectOption('on');
    await expect.poll(() => updates).toContainEqual({ key: 'browser:x|cursor', drive: 'on' });
  });
});
