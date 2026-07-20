/**
 * MCP per-browser pairing — Settings UI spec.
 *
 * Backend-free: all /api/mcp/* endpoints are stubbed with page.route, so this
 * runs in the default Vite-only harness. Asserts:
 *  1. Token source defaults to "This browser's agent"; the connect snippet
 *     embeds the pairing token (not the shared install token).
 *  2. Switching to "Shared (all sessions)" swaps the snippet to the shared token.
 *  3. The label input reflects the backend-echoed pairing label.
 *  4. Rotate replaces the browser token in the snippet.
 * The Go tests (mcpserver/scope_http_test.go) cover the backend scoping.
 */

import { test, expect, type Page } from '@playwright/test';

async function openIntegrations(page: Page) {
  await page.goto('/');
  await page.locator('.sidebar-tab', { hasText: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Integrations' }).click();
}

test.describe('MCP per-browser pairing UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/mcp/status', (r) =>
      r.fulfill({ json: { enabled: true, drive_ui: false, clients: 1, auth_mode: 'token' } }));
    await page.route('**/api/mcp/token', (r) =>
      r.fulfill({ json: { token: 'shared-token-abcdef' } }));
    await page.route('**/api/mcp/pair', (r) =>
      r.fulfill({ json: { token: 'pair-token-123456', label: 'Bench A' } }));
    await page.route('**/api/mcp/pair/rotate', (r) =>
      r.fulfill({ json: { token: 'rotated-token-999' } }));
  });

  test('browser token is default source and feeds the connect snippet', async ({ page }) => {
    await openIntegrations(page);

    const browserTab = page.getByRole('button', { name: /this browser's agent/i });
    await expect(browserTab).toBeVisible();
    await expect(browserTab).toHaveClass(/active/);

    await expect(page.locator('.mcp-connect-cmd')).toContainText('pair-token-123456');
    await expect(page.getByTestId('mcp-pair-label')).toHaveValue('Bench A');

    await page.getByRole('button', { name: /shared \(all sessions\)/i }).click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('shared-token-abcdef');
  });

  test('rotate replaces the browser token', async ({ page }) => {
    await openIntegrations(page);
    await expect(page.locator('.mcp-connect-cmd')).toContainText('pair-token-123456');
    await page.getByRole('button', { name: /^rotate$/i }).click();
    await expect(page.locator('.mcp-connect-cmd')).toContainText('rotated-token-999');
  });
});
