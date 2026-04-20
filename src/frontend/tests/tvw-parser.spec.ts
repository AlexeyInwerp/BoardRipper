import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('TVW Parser', () => {
  test('can parse and render NM-D711 TVW file', async ({ page }) => {
    await page.goto('/');

    // Upload TVW file via the file input
    const fileInput = page.getByTestId('file-input');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    await fileInput.setInputFiles(tvwFile);

    // Wait for parsing — status bar should show component/net counts
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });
    await expect(page.getByTestId('statusbar')).toContainText('Components:');
    await expect(page.getByTestId('statusbar')).toContainText('Nets:');

    // Canvas should be visible
    await expect(page.getByTestId('board-canvas')).toBeVisible();
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('TVW file shows correct component and net counts', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    await fileInput.setInputFiles(tvwFile);

    // Wait for parsing
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });

    // Status bar should show significant component/net counts for the NM-D711 board
    const statusText = await page.getByTestId('statusbar').textContent();
    expect(statusText).toBeTruthy();

    // Extract component count from status bar (format: "Components: N")
    const compMatch = statusText!.match(/Components:\s*(\d+)/);
    expect(compMatch).toBeTruthy();
    const compCount = parseInt(compMatch![1]);
    expect(compCount).toBeGreaterThan(5000); // NM-D711 has ~6000+ parts

    // Extract net count
    const netMatch = statusText!.match(/Nets:\s*(\d+)/);
    expect(netMatch).toBeTruthy();
    const netCount = parseInt(netMatch![1]);
    expect(netCount).toBeGreaterThan(3000); // NM-D711 has ~3500+ nets
  });

  test('simple TVW file (NSE562R10) parses with traces', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    await fileInput.setInputFiles(tvwFile);

    // Wait for parsing
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });

    const statusText = await page.getByTestId('statusbar').textContent();
    expect(statusText).toBeTruthy();

    // NSE562R10 is a simple board: 2 parts, 8 nets
    const compMatch = statusText!.match(/Components:\s*(\d+)/);
    expect(compMatch).toBeTruthy();
    expect(parseInt(compMatch![1])).toBeGreaterThanOrEqual(2);

    const netMatch = statusText!.match(/Nets:\s*(\d+)/);
    expect(netMatch).toBeTruthy();
    expect(parseInt(netMatch![1])).toBeGreaterThanOrEqual(5);

    // Canvas should be visible
    await expect(page.getByTestId('board-canvas').locator('canvas')).toBeVisible();
  });

  test('TVW parser produces traces for simple board', async () => {
    // Direct parser test — no browser needed
    const { parseTVW } = await import('../src/parsers/tvw-parser');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    const buf = fs.readFileSync(tvwFile);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseTVW(ab);

    // Basic structure checks
    expect(board.format).toBe('TVW');
    expect(board.parts.length).toBe(2);
    expect(board.nets.size).toBeGreaterThanOrEqual(5);

    // Traces should be present — NSE562R10 has 38 lines on TOP layer
    expect(board.traces).toBeDefined();
    expect(board.traces!.length).toBeGreaterThanOrEqual(30);

    // All traces should have valid coordinates and positive width
    for (const t of board.traces!) {
      expect(Number.isFinite(t.start.x)).toBe(true);
      expect(Number.isFinite(t.start.y)).toBe(true);
      expect(Number.isFinite(t.end.x)).toBe(true);
      expect(Number.isFinite(t.end.y)).toBe(true);
      expect(t.width).toBeGreaterThan(0);
    }
  });

  test('TVW file shows Traces button and traces are toggleable', async ({ page }) => {
    await page.goto('/');

    // Traces button should NOT be visible before loading a TVW file
    await expect(page.getByTestId('traces-btn')).not.toBeVisible();

    // Load a TVW file with traces
    const fileInput = page.getByTestId('file-input');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    await fileInput.setInputFiles(tvwFile);

    // Wait for parsing
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 30000 });

    // Traces button should now be visible and active (traces on by default)
    const tracesBtn = page.getByTestId('traces-btn');
    await expect(tracesBtn).toBeVisible();
    await expect(tracesBtn).toHaveClass(/active/);

    // Toggle traces off
    await tracesBtn.click();
    await expect(tracesBtn).not.toHaveClass(/active/);

    // Toggle traces back on
    await tracesBtn.click();
    await expect(tracesBtn).toHaveClass(/active/);
  });

  test('NM-D711 TVW parser produces valid board data', async () => {
    const { parseTVW } = await import('../src/parsers/tvw-parser');
    const tvwFile = path.resolve(__dirname, '../../../samples/TVW/NSE562R10_View_0402.tvw');
    const buf = fs.readFileSync(tvwFile);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const board = parseTVW(ab);

    expect(board.format).toBe('TVW');
    expect(board.parts.length).toBeGreaterThan(5000);
    expect(board.nets.size).toBeGreaterThan(3000);
    expect(Number.isFinite(board.bounds.minX)).toBe(true);
    expect(Number.isFinite(board.bounds.maxX)).toBe(true);
  });
});
