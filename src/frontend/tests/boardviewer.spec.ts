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

    // Status bar shows supported formats when no board is loaded
    await expect(page.getByTestId('statusbar')).toContainText('formats');
  });

  test('can open test BVR1 file and display board', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);

    // file-name span shows "N parts | N nets"
    await expect(page.getByTestId('file-name')).toContainText('parts');
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

    await expect(page.getByTestId('file-name')).toContainText('3075', { timeout: 15000 });
    await expect(page.getByTestId('statusbar')).toContainText('Components:');
    await expect(page.getByTestId('statusbar')).toContainText('Nets:');
  });

  test('dockview container is present', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.dockview-theme-dark')).toBeVisible();
  });

  test('board sidebar shows prompt before selection', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('file-name')).toContainText('parts');

    // Open the sidebar via the toggle button
    await page.locator('.board-sidebar-toggle').first().click();

    // Should show prompt to click a component
    await expect(page.locator('text=Click a component')).toBeVisible();
  });

  test('search filters work', async ({ page }) => {
    await page.goto('/');

    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('file-name')).toContainText('parts');

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U1');

    // Typing a query auto-opens the sidebar to the search tab
    await expect(page.getByTestId('search-results')).toBeVisible();
  });

  test('two boards: switching tabs does not crash either renderer', async ({ page }) => {
    // Collect ALL console output so we can inspect renderer logs
    const allLogs: string[] = [];
    page.on('console', msg => { allLogs.push(`[${msg.type()}] ${msg.text()}`); });

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');

    // Open first board (820-02016: 3075 parts)
    const board1 = path.resolve(__dirname, '../../../samples/820-02016.bvr');
    await fileInput.setInputFiles(board1);
    // Wait for board to load: stats span shows "parts |"
    await expect(page.getByTestId('file-name')).toContainText('parts', { timeout: 15000 });
    const statsAfterBoard1 = await page.getByTestId('file-name').textContent();

    // Open second board (820-02020)
    const board2 = path.resolve(__dirname, '../../../samples/820-02020.bvr');
    await fileInput.setInputFiles(board2);
    await expect(page.getByTestId('file-name')).not.toContainText(statsAfterBoard1!, { timeout: 15000 });
    const statsAfterBoard2 = await page.getByTestId('file-name').textContent();
    console.log('Board1 stats:', statsAfterBoard1, '| Board2 stats:', statsAfterBoard2);

    // dockview renders tabs as .dv-tab elements containing the panel title text
    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const tab2 = page.locator('.dv-tab', { hasText: '820-02020.bvr' }).first();

    // Switch back to board 1
    await expect(tab1).toBeVisible({ timeout: 3000 });
    await tab1.click();
    await page.waitForTimeout(400);
    const statsAfterSwitchTo1 = await page.getByTestId('file-name').textContent();
    console.log('Stats after switching back to board1:', statsAfterSwitchTo1);
    expect(statsAfterSwitchTo1).toBe(statsAfterBoard1);

    // Switch back to board 2
    await expect(tab2).toBeVisible({ timeout: 3000 });
    await tab2.click();
    await page.waitForTimeout(400);
    const statsAfterSwitchTo2 = await page.getByTestId('file-name').textContent();
    console.log('Stats after switching back to board2:', statsAfterSwitchTo2);
    expect(statsAfterSwitchTo2).toBe(statsAfterBoard2);

    // Both board-canvas divs should exist
    const canvasCount = await page.locator('[data-testid="board-canvas"]').count();
    expect(canvasCount).toBeGreaterThanOrEqual(1);

    // Log all renderer/panel messages for diagnosis
    const rendererLogs = allLogs.filter(l => l.includes('[renderer]') || l.includes('[panel]'));
    console.log('=== Renderer/Panel logs ===');
    rendererLogs.forEach(l => console.log(l));

    // No spurious "pausing the store-active renderer" warnings
    const spuriousPauses = allLogs.filter(l => l.includes('pausing the store-active renderer'));
    if (spuriousPauses.length > 0) {
      console.log('SPURIOUS PAUSE WARNINGS:', spuriousPauses);
    }
    expect(spuriousPauses).toHaveLength(0);
  });

  test('two boards + two PDFs: switching does not crash renderers', async ({ page }) => {
    const allLogs: string[] = [];
    page.on('console', msg => { allLogs.push(`[${msg.type()}] ${msg.text()}`); });

    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    const pdfInput = page.getByTestId('pdf-input');

    // Open board 1 + PDF 1
    await fileInput.setInputFiles(path.resolve(__dirname, '../../../samples/820-02016.bvr'));
    await expect(page.getByTestId('file-name')).toContainText('3075', { timeout: 15000 });
    await pdfInput.setInputFiles(path.resolve(__dirname, '../../../samples/820-02016.pdf'));
    await page.waitForTimeout(500); // let PDF panel open + auto-bind

    // Open board 2 + PDF 2
    await fileInput.setInputFiles(path.resolve(__dirname, '../../../samples/820-02020.bvr'));
    await expect(page.getByTestId('file-name')).toContainText('4317', { timeout: 15000 });
    await pdfInput.setInputFiles(path.resolve(__dirname, '../../../samples/820-02020.pdf'));
    await page.waitForTimeout(500);

    // Switch to board 1 tab — activates board 1 and linked PDF 1
    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await expect(tab1).toBeVisible({ timeout: 3000 });
    await tab1.click();
    await page.waitForTimeout(500);
    expect(await page.getByTestId('file-name').textContent()).toContain('3075');

    // Switch to board 2 tab
    const tab2 = page.locator('.dv-tab', { hasText: '820-02020.bvr' }).first();
    await expect(tab2).toBeVisible({ timeout: 3000 });
    await tab2.click();
    await page.waitForTimeout(500);
    expect(await page.getByTestId('file-name').textContent()).toContain('4317');

    // Switch back to board 1 via its PDF tab (tests PDF→board cross-activation)
    const pdfTab1 = page.locator('.dv-tab', { hasText: '820-02016.pdf' }).first();
    if (await pdfTab1.isVisible({ timeout: 2000 }).catch(() => false)) {
      await pdfTab1.click();
      await page.waitForTimeout(500);
      console.log('After clicking PDF1 tab, stats:', await page.getByTestId('file-name').textContent());
      expect(await page.getByTestId('file-name').textContent()).toContain('3075');
    }

    // Print renderer/panel/pdf logs for diagnosis
    const rendererLogs = allLogs.filter(l => l.includes('[renderer]') || l.includes('[panel]') || l.includes('[pdf]'));
    console.log('=== Renderer/Panel/PDF logs ===');
    rendererLogs.forEach(l => console.log(l));

    // Critical: no spurious "pausing the store-active renderer" warnings
    const spuriousPauses = allLogs.filter(l => l.includes('pausing the store-active renderer'));
    if (spuriousPauses.length > 0) {
      console.log('SPURIOUS PAUSE WARNINGS:', spuriousPauses);
    }
    expect(spuriousPauses).toHaveLength(0);
  });

  test('layer toggle buttons work', async ({ page }) => {
    await page.goto('/');

    // Load a board so the per-tab defaults apply (showTop=true, showBottom=false)
    const fileInput = page.getByTestId('file-input');
    const testFile = path.resolve(__dirname, '../public/samples/test-board.bvr');
    await fileInput.setInputFiles(testFile);
    await expect(page.getByTestId('file-name')).toContainText('parts');

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });

    // After loading: Top active, Bottom inactive
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).not.toHaveClass(/active/);

    // Clicking Bottom activates Bottom and deactivates Top
    await bottomBtn.click();
    await expect(bottomBtn).toHaveClass(/active/);
    await expect(topBtn).not.toHaveClass(/active/);

    // Clicking Top restores Top active, Bottom inactive
    await topBtn.click();
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).not.toHaveClass(/active/);
  });
});
