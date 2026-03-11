import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('Boardviewer', () => {
  test('app loads with toolbar, canvas, and statusbar', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('app')).toBeVisible();
    await expect(page.getByTestId('toolbar')).toBeVisible();
    await expect(page.getByTestId('statusbar')).toBeVisible();
    await expect(page.getByTestId('open-btn')).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();

    // Status bar shows initial message
    await expect(page.getByTestId('statusbar')).toContainText('Open a .bvr file');
  });

  test('can open test BVR1 file and display board', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    await expect(page.getByTestId('file-name')).toContainText('test-board.bvr');
    await expect(page.getByTestId('statusbar')).toContainText('Components:');
    await expect(page.getByTestId('statusbar')).toContainText('Nets:');

    await expect(page.getByTestId('board-canvas')).toBeVisible();
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
  });

  test('can open real BVR3 file (820-02016.bvr)', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const realFile = path.resolve(__dirname, '../../../samples/820-02016.bvr');
    await fileInput.setInputFiles(realFile);

    await expect(page.getByTestId('file-name')).toContainText('820-02016.bvr', { timeout: 15000 });
    await expect(page.getByTestId('statusbar')).toContainText('Components:');
    await expect(page.getByTestId('statusbar')).toContainText('Nets:');
  });

  test('dockview panels are present', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.dockview-theme-dark')).toBeVisible();
    await expect(page.locator('text=Board View')).toBeVisible();
    await expect(page.locator('text=Component Info')).toBeVisible();
  });

  test('component info panel shows prompt before selection', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('file-name')).toContainText('test-board.bvr');

    // Should show prompt to click
    await expect(page.locator('text=Click a component')).toBeVisible();
  });

  test('search filters work', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('file-name')).toContainText('test-board.bvr');

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U1');

    // Click Search tab
    await page.locator('text=Search').click();
    await expect(page.getByTestId('search-results')).toBeVisible();
  });

  test('layer toggle buttons work', async ({ page }) => {
    await page.goto('/');

    // Wait for app to load
    await expect(page.getByTestId('toolbar')).toBeVisible();

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });

    // Should start with active class
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).toHaveClass(/active/);

    // Toggle off
    await topBtn.click();
    await expect(topBtn).not.toHaveClass(/active/);

    // Toggle on
    await topBtn.click();
    await expect(topBtn).toHaveClass(/active/);
  });
});
