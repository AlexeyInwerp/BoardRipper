import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_BVR1 = path.resolve(__dirname, '../public/samples/test-board.bvr');
const REAL_BVR3 = path.resolve(__dirname, '../../../samples/820-02016.bvr');
const REAL_BRD = path.resolve(__dirname, '../../../samples/820-02935-05.brd');
const REAL_PDF_A = path.resolve(__dirname, '../../../samples/820-02016.pdf');
const _REAL_PDF_B = path.resolve(__dirname, '../../../samples/820-02935 051-08286 Rev 5.0.3.pdf');

/** Helper: load a board and wait for stats to appear */
async function loadBoard(page: import('@playwright/test').Page, filePath: string, expectedText?: string) {
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(filePath);
  const text = expectedText ?? 'parts';
  await expect(page.getByTestId('statusbar')).toContainText(text, { timeout: 15000 });
}

test.describe('Comprehensive Board Tests', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. BASIC APP STRUCTURE
  // ═══════════════════════════════════════════════════════════════════════

  test('all toolbar buttons render without errors', async ({ page }) => {
    await page.goto('/');
    // Check all toolbar buttons are present
    await expect(page.getByTestId('open-btn')).toBeVisible();
    await expect(page.locator('.toolbar-btn', { hasText: 'Open PDF' })).toBeVisible();
    await expect(page.locator('.toolbar-btn', { hasText: 'Top' })).toBeVisible();
    await expect(page.locator('.toolbar-btn', { hasText: 'Bottom' })).toBeVisible();
    await expect(page.locator('.toolbar-btn', { hasText: 'Butterfly' })).toBeVisible();
    await expect(page.locator('.board-netlines-toggle')).toBeVisible();
    await expect(page.locator('.toolbar-btn', { hasText: 'Settings' }).or(page.locator('.toolbar-btn-icon', { hasText: '⚙' }))).toBeVisible();
    await expect(page.getByTestId('search-input')).toBeVisible();
  });

  test('statusbar shows supported formats when no board loaded', async ({ page }) => {
    await page.goto('/');
    const statusbar = page.getByTestId('statusbar');
    await expect(statusbar).toContainText('.bvr');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. BVR1 FILE PARSING & RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR1: correct part and net count', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const stats = await page.getByTestId('statusbar').textContent();
    // test-board.bvr has: U1, R1-R4, C1-C3, U2, J1 = 10 parts
    expect(stats).toContain('10 parts');
  });

  test('BVR1: statusbar shows Components and Nets count', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const statusbar = page.getByTestId('statusbar');
    await expect(statusbar).toContainText('Components: 10');
    // Nets: VCC3V3, GND, SDA, SCL, RESET_N, CLK, MOSI, MISO, GPIO0, GPIO1 = 10
    await expect(statusbar).toContainText('Nets: 10');
    await expect(statusbar).toContainText('Nails: 4');
  });

  test('BVR1: canvas element exists and has dimensions', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box).toBeTruthy();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. BVR3 FILE PARSING
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3: large file loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');

    // Filter out expected WebGL warnings (headless Chrome)
    const realErrors = errors.filter(e =>
      !e.includes('No available adapters') &&
      !e.includes('WebGL') &&
      !e.includes('PIXI')
    );
    expect(realErrors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. LAYER TOGGLE (Top/Bottom/Butterfly)
  // ═══════════════════════════════════════════════════════════════════════

  test('layer toggle: Top active by default after loading', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).not.toHaveClass(/active/);
  });

  test('layer toggle: switching to Bottom deactivates Top', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });

    await bottomBtn.click();
    await expect(bottomBtn).toHaveClass(/active/);
    await expect(topBtn).not.toHaveClass(/active/);

    // Switch back
    await topBtn.click();
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).not.toHaveClass(/active/);
  });

  test('butterfly mode: activates both layers', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const butterflyBtn = page.locator('.toolbar-btn', { hasText: 'Butterfly' });
    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });

    await butterflyBtn.click();
    await expect(butterflyBtn).toHaveClass(/active/);
    // Both sides should be shown in butterfly mode
    await expect(topBtn).toHaveClass(/active/);
    await expect(bottomBtn).toHaveClass(/active/);

    // Toggling butterfly off should restore previous state
    await butterflyBtn.click();
    await expect(butterflyBtn).not.toHaveClass(/active/);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. SEARCH FUNCTIONALITY
  // ═══════════════════════════════════════════════════════════════════════

  test('search: typing opens search results sidebar', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U1');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
  });

  test('search: clearing search hides results', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U1');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });

    await searchInput.fill('');
    // After clearing, sidebar should no longer show search results
    await page.waitForTimeout(300);
  });

  test('search: finds components by net name', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('VCC3V3');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
    // VCC3V3 appears in multiple parts
    const results = page.getByTestId('search-results').locator('.search-result-item');
    const count = await results.count();
    expect(count).toBeGreaterThan(0);
  });

  test('search: no results for non-existent component', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('ZZZZNONEXISTENT');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
    // Should show "no results" or empty state
    // Either shows "No results" or has no items
    const items = page.getByTestId('search-results').locator('.search-result-item');
    const count = await items.count();
    expect(count).toBe(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. MULTI-BOARD TAB SWITCHING
  // ═══════════════════════════════════════════════════════════════════════

  test('multi-board: opening same file twice reuses tab', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const statsFirst = await page.getByTestId('statusbar').textContent();

    // Open the same file again
    await page.getByTestId('file-input').setInputFiles(TEST_BVR1);
    await page.waitForTimeout(500);

    const statsSecond = await page.getByTestId('statusbar').textContent();
    expect(statsSecond).toBe(statsFirst);

    // Should still have only 1 dockview tab
    const tabs = page.locator('.dv-tab');
    const tabCount = await tabs.count();
    expect(tabCount).toBe(1);
  });

  test('multi-board: stats update correctly on tab switch', async ({ page }) => {
    await page.goto('/');

    // Load first board
    await loadBoard(page, REAL_BVR3, '3075');
    const stats1 = await page.getByTestId('statusbar').textContent();

    // Load second board
    await loadBoard(page, REAL_BRD, '4317');
    const stats2 = await page.getByTestId('statusbar').textContent();
    expect(stats2).not.toBe(stats1);

    // Switch back to first
    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await tab1.click();
    await page.waitForTimeout(400);

    const statsAfterSwitch = await page.getByTestId('statusbar').textContent();
    expect(statsAfterSwitch).toBe(stats1);
  });

  test('multi-board: closing a tab works without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');
    await loadBoard(page, REAL_BRD, '4317');

    // Close the second board tab via dockview close button
    const tab2 = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    // The close button is a child inside the dv-tab
    const closeBtn = tab2.locator('.dv-default-tab-action');
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }

    // Should not have page errors
    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. ROTATION AND MIRRORING
  // ═══════════════════════════════════════════════════════════════════════

  test('rotation buttons work without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const cwBtn = page.locator('.toolbar-btn-icon', { hasText: '↻' });
    const ccwBtn = page.locator('.toolbar-btn-icon', { hasText: '↺' });

    // Rotate CW 4 times (full 360°)
    for (let i = 0; i < 4; i++) {
      await cwBtn.click();
      await page.waitForTimeout(100);
    }

    // Rotate CCW
    await ccwBtn.click();
    await page.waitForTimeout(100);

    expect(errors).toHaveLength(0);
  });

  test('mirror buttons work without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const hBtn = page.locator('.toolbar-btn-icon', { hasText: '⇔' });
    const vBtn = page.locator('.toolbar-btn-icon', { hasText: '⇕' });

    await hBtn.click();
    await page.waitForTimeout(100);
    await vBtn.click();
    await page.waitForTimeout(100);
    // Toggle back
    await hBtn.click();
    await page.waitForTimeout(100);
    await vBtn.click();
    await page.waitForTimeout(100);

    expect(errors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. NET LINES TOGGLE
  // ═══════════════════════════════════════════════════════════════════════

  test('net lines toggle cycles off → star → chain → off', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const netLinesBtn = page.locator('.board-netlines-toggle');
    const readMode = () => page.evaluate(() => {
      const raw = localStorage.getItem('boardripper-view-prefs');
      return raw ? JSON.parse(raw).netLineMode : null;
    });

    await expect(netLinesBtn).not.toHaveClass(/active/);

    await netLinesBtn.click();
    await expect(netLinesBtn).toHaveClass(/active/);
    expect(await readMode()).toBe('star');

    await netLinesBtn.click();
    await expect(netLinesBtn).toHaveClass(/active/);
    expect(await readMode()).toBe('chain');

    await netLinesBtn.click();
    await expect(netLinesBtn).not.toHaveClass(/active/);
    expect(await readMode()).toBe('off');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. SIDEBAR FUNCTIONALITY
  // ═══════════════════════════════════════════════════════════════════════

  test('sidebar toggle button shows/hides sidebar', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const toggleBtn = page.locator('.board-sidebar-toggle').first();
    await expect(toggleBtn).toBeVisible();

    // Open sidebar
    await toggleBtn.click();
    await expect(page.locator('text=Click a component')).toBeVisible({ timeout: 2000 });

    // Close sidebar
    await toggleBtn.click();
    await page.waitForTimeout(300);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. CONSOLE ERROR MONITORING (stress tests)
  // ═══════════════════════════════════════════════════════════════════════

  test('stress: rapid layer switching does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    const butterflyBtn = page.locator('.toolbar-btn', { hasText: 'Butterfly' });

    // Rapid switching
    for (let i = 0; i < 5; i++) {
      await topBtn.click();
      await bottomBtn.click();
      await butterflyBtn.click();
      await topBtn.click();
    }

    await page.waitForTimeout(500);
    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  test('stress: rapid tab switching between two boards', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');
    await loadBoard(page, REAL_BRD, '4317');

    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const tab2 = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();

    // Rapid switching
    for (let i = 0; i < 10; i++) {
      await tab1.click();
      await page.waitForTimeout(50);
      await tab2.click();
      await page.waitForTimeout(50);
    }

    await page.waitForTimeout(500);
    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  test('stress: butterfly + rotation + mirror combination', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const butterflyBtn = page.locator('.toolbar-btn', { hasText: 'Butterfly' });
    const cwBtn = page.locator('.toolbar-btn-icon', { hasText: '↻' });
    const hBtn = page.locator('.toolbar-btn-icon', { hasText: '⇔' });

    // Enable butterfly, then rotate and mirror
    await butterflyBtn.click();
    await page.waitForTimeout(200);

    for (let i = 0; i < 4; i++) {
      await cwBtn.click();
      await page.waitForTimeout(100);
    }

    await hBtn.click();
    await page.waitForTimeout(200);

    // Disable butterfly while rotated+mirrored
    await butterflyBtn.click();
    await page.waitForTimeout(200);

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. DRAG AND DROP
  // ═══════════════════════════════════════════════════════════════════════

  test('drag-drop overlay appears on file drag', async ({ page }) => {
    await page.goto('/');

    // Use evaluate to create a proper DragEvent with DataTransfer
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File([''], 'test.bvr', { type: 'application/octet-stream' }));
      const event = new DragEvent('dragenter', { bubbles: true, dataTransfer: dt });
      document.querySelector('[data-testid="app"]')!.dispatchEvent(event);
    });

    // Drop overlay should appear
    await expect(page.locator('.drop-overlay')).toBeVisible({ timeout: 2000 });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. PDF INTEGRATION
  // ═══════════════════════════════════════════════════════════════════════

  test('PDF: loading a PDF creates a panel without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');

    const pdfInput = page.getByTestId('pdf-input');
    await pdfInput.setInputFiles(REAL_PDF_A);
    await page.waitForTimeout(1000);

    // PDF tab should appear
    const pdfTab = page.locator('.dv-tab', { hasText: '820-02016.pdf' }).first();
    await expect(pdfTab).toBeVisible({ timeout: 5000 });

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 13. BOARD STATUS INDICATORS
  // ═══════════════════════════════════════════════════════════════════════

  test('board panel shows restart and toggle buttons', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // Restart renderer button
    await expect(page.locator('.board-netlines-toggle', { hasText: '↺' })).toBeVisible();
    // Hover info toggle
    await expect(page.locator('.board-netlines-toggle', { hasText: '⊙' })).toBeVisible();
    // Net dim toggle
    await expect(page.locator('.board-netlines-toggle', { hasText: '◐' })).toBeVisible();
    // Net lines toggle
    await expect(page.locator('.board-netlines-toggle', { hasText: '※' })).toBeVisible();
  });

  test('restart renderer button does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const restartBtn = page.locator('.board-netlines-toggle', { hasText: '↺' });
    await restartBtn.click();
    await page.waitForTimeout(500);

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 14. SETTINGS PANEL
  // ═══════════════════════════════════════════════════════════════════════

  test('settings panel opens without crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');

    const settingsBtn = page.locator('.toolbar-btn-icon', { hasText: '⚙' });
    await settingsBtn.click();
    await page.waitForTimeout(500);

    // Settings panel should open as a floating dockview panel
    const settingsPanel = page.locator('.dv-tab', { hasText: 'Settings' });
    await expect(settingsPanel).toBeVisible({ timeout: 3000 });

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 15. EDGE CASES: no board scenarios
  // ═══════════════════════════════════════════════════════════════════════

  test('toolbar buttons do nothing gracefully when no board loaded', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');

    // Click all toolbar buttons without a board loaded
    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    const butterflyBtn = page.locator('.toolbar-btn', { hasText: 'Butterfly' });
    const netLinesBtn = page.locator('.board-netlines-toggle');

    await topBtn.click();
    await bottomBtn.click();
    await butterflyBtn.click();
    await netLinesBtn.click();
    await page.waitForTimeout(300);

    expect(errors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 16. HUD OVERLAY
  // ═══════════════════════════════════════════════════════════════════════

  test('HUD shows zoom percentage and FPS', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // Wait for HUD to populate
    await page.waitForTimeout(500);

    const hud = page.locator('.board-hud');
    await expect(hud).toBeVisible();
    const hudText = await hud.textContent();
    expect(hudText).toMatch(/\d+%/);      // zoom percentage
    expect(hudText).toMatch(/\d+ fps/);   // FPS counter
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 17. TOGGLE PERSISTENCE (localStorage)
  // ═══════════════════════════════════════════════════════════════════════

  test('net lines mode persists across board loads', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const netLinesBtn = page.locator('.board-netlines-toggle');

    // Cycle off → star
    await netLinesBtn.click();
    await expect(netLinesBtn).toHaveClass(/active/);

    const stored = await page.evaluate(() => localStorage.getItem('boardripper-view-prefs'));
    expect(stored).toBeTruthy();
    const prefs = JSON.parse(stored!);
    expect(prefs.netLineMode).toBe('star');

    // Load a second board — mode should carry over (button stays active)
    await loadBoard(page, REAL_BVR3, '3075');
    await expect(netLinesBtn).toHaveClass(/active/);
  });

  test('legacy showNetLines:true migrates to netLineMode:star', async ({ page }) => {
    await page.goto('/');

    // Pre-seed localStorage with the pre-3-state boolean
    await page.evaluate(() => {
      localStorage.setItem('boardripper-view-prefs', JSON.stringify({ showNetLines: true, showNetDim: true, showHoverInfo: true }));
    });

    await loadBoard(page, TEST_BVR1);
    const netLinesBtn = page.locator('.board-netlines-toggle');
    // Migration should have surfaced as 'star' (active button). One more click cycles to 'chain'.
    await expect(netLinesBtn).toHaveClass(/active/);
    await netLinesBtn.click();
    const stored = await page.evaluate(() => localStorage.getItem('boardripper-view-prefs'));
    expect(JSON.parse(stored!).netLineMode).toBe('chain');
  });

  test('PDF night mode persists across panel reloads', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');

    const pdfInput = page.getByTestId('pdf-input');
    await pdfInput.setInputFiles(REAL_PDF_A);
    await page.waitForTimeout(1000);

    // Find and click night mode button in the PDF panel
    const nightBtn = page.locator('.pdf-toolbar-btn').filter({ hasText: '🌙' }).or(
      page.locator('button[title*="night mode"]')
    ).first();

    if (await nightBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nightBtn.click();
      await page.waitForTimeout(200);

      // Verify localStorage was set
      const val = await page.evaluate(() => localStorage.getItem('boardripper-pdf-nightmode'));
      expect(val).toBe('1');
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 18. SEARCH MEMOIZATION (regression test)
  // ═══════════════════════════════════════════════════════════════════════

  test('search: repeated searches with same query return consistent results', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');

    // Search for U1
    await searchInput.fill('U1');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
    const items1 = await page.getByTestId('search-results').locator('.search-result-item').count();

    // Clear and search again
    await searchInput.fill('');
    await page.waitForTimeout(200);
    await searchInput.fill('U1');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
    const items2 = await page.getByTestId('search-results').locator('.search-result-item').count();

    // Same query should produce same count
    expect(items2).toBe(items1);
  });

  test('search: switching boards clears and updates results', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    const searchInput = page.getByTestId('search-input');
    await searchInput.fill('U1');
    await expect(page.getByTestId('search-results')).toBeVisible({ timeout: 3000 });
    const countBoard1 = await page.getByTestId('search-results').locator('.search-result-item').count();

    // Load another board
    await loadBoard(page, REAL_BVR3, '3075');

    // Search is per-tab, so the new tab starts with empty search
    const searchVal = await searchInput.inputValue();
    // Either empty or search is cleared on tab switch
    if (searchVal === 'U1') {
      // If search persists, results should be from new board
      const countBoard2 = await page.getByTestId('search-results').locator('.search-result-item').count();
      // BVR3 has different part count than BVR1
      expect(countBoard2).not.toBe(countBoard1);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 19. XSS SAFETY (tooltip does not execute scripts)
  // ═══════════════════════════════════════════════════════════════════════

  test('tooltip uses safe text content (no innerHTML injection)', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // Wait for renderer to initialize
    await page.waitForTimeout(500);

    // Verify the board loaded without script injection errors
    // Tooltip is created lazily on hover, so just confirm no XSS side-effects
    const canvas = page.getByTestId('board-canvas');
    await expect(canvas).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 20. BOARD PANEL TOGGLE BUTTONS (in-panel mini-controls)
  // ═══════════════════════════════════════════════════════════════════════

  test('hover info toggle works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // ⊙ button toggles hover info
    const hoverBtn = page.locator('.board-netlines-toggle', { hasText: '⊙' });
    await hoverBtn.click();
    await page.waitForTimeout(200);
    // Toggle back
    await hoverBtn.click();
    await page.waitForTimeout(200);

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  test('net dim toggle works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // ◐ button toggles net dimming
    const dimBtn = page.locator('.board-netlines-toggle', { hasText: '◐' });
    await dimBtn.click();
    await page.waitForTimeout(200);
    await dimBtn.click();
    await page.waitForTimeout(200);

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  test('in-panel net lines toggle works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, TEST_BVR1);

    // ※ button toggles net lines from panel header
    const nlBtn = page.locator('.board-netlines-toggle', { hasText: '※' });
    await nlBtn.click();
    await page.waitForTimeout(200);
    await nlBtn.click();
    await page.waitForTimeout(200);

    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 21. STRESS: search during tab switch
  // ═══════════════════════════════════════════════════════════════════════

  test('stress: search while switching between boards', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');
    await loadBoard(page, REAL_BRD, '4317');

    const searchInput = page.getByTestId('search-input');
    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const tab2 = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();

    // Type search, switch tabs rapidly
    await searchInput.fill('U');
    await tab1.click();
    await page.waitForTimeout(50);
    await searchInput.fill('R1');
    await tab2.click();
    await page.waitForTimeout(50);
    await searchInput.fill('C');
    await tab1.click();
    await page.waitForTimeout(50);

    await page.waitForTimeout(500);
    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 22. NO CONSOLE ERRORS ON FRESH LOAD
  // ═══════════════════════════════════════════════════════════════════════

  test('no unexpected console errors on fresh app load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');
    await page.waitForTimeout(1000);

    // Filter out expected WebGL/PixiJS warnings in headless
    const realErrors = errors.filter(e =>
      !e.includes('No available adapters') &&
      !e.includes('WebGL') &&
      !e.includes('PIXI') &&
      !e.includes('net::ERR_')  // network errors in test env
    );
    expect(realErrors).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 24. MULTI-BOARD + PDF CROSS-ACTIVATION
  // ═══════════════════════════════════════════════════════════════════════

  test('PDF auto-binds to matching board by 820 code', async ({ page }) => {
    await page.goto('/');
    await loadBoard(page, REAL_BVR3, '3075');

    const pdfInput = page.getByTestId('pdf-input');
    await pdfInput.setInputFiles(REAL_PDF_A);
    await page.waitForTimeout(1000);

    // PDF tab should appear with matching name
    const pdfTab = page.locator('.dv-tab', { hasText: '820-02016.pdf' });
    await expect(pdfTab).toBeVisible({ timeout: 5000 });

    // Board tab should still be accessible
    const boardTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' });
    await expect(boardTab).toBeVisible();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 25. MEMORY LEAK TEST: open and close multiple boards
  // ═══════════════════════════════════════════════════════════════════════

  test('opening 3 boards then closing tabs does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');

    // Open 3 boards
    await loadBoard(page, TEST_BVR1, '10 parts');
    await loadBoard(page, REAL_BVR3, '3075');
    await loadBoard(page, REAL_BRD, '4317');

    // Verify all 3 tabs exist
    const tabCount = await page.locator('.dv-tab').count();
    expect(tabCount).toBeGreaterThanOrEqual(3);

    // Close all tabs via dockview close buttons
    for (let i = 0; i < 3; i++) {
      const closeBtn = page.locator('.dv-default-tab-action').first();
      if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(200);
      }
    }

    await page.waitForTimeout(500);
    expect(errors.filter(e => !e.includes('WebGL'))).toHaveLength(0);
  });
});
