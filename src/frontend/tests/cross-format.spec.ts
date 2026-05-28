import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Sample files — different formats. All live under the gitignored, proprietary
// top-level samples/ tree, so every test here skips (not fails) when its fixture
// is absent — same idiom as ci-smoke.spec.ts. The skip lives in the shared
// loadBoard/loadPdf helpers, keyed on the file each test actually requests, so
// a test only skips when one of its own fixtures is missing.
const BVR3_FILE = path.resolve(__dirname, '../../../samples/820-02016.bvr');
const BRD_FILE = path.resolve(__dirname, '../../../samples/820-02935-05.brd');
const FZ_FILE = path.resolve(__dirname, '../../../samples/Asus G532LWS 60NR02T0-MB7010 r1.3.fz');
const CAD_FILE = path.resolve(__dirname, '../../../samples/Quanta NJM - DANJMMB1AA0_revA_Asus TUF Gaming FA507RM.cad');
const PDF_FILE = path.resolve(__dirname, '../../../samples/820-02016.pdf');
const PDF_935 = path.resolve(__dirname, '../../../samples/820-02935 051-08286 Rev 5.0.3.pdf');

/** Helper: load a board file and wait for the status bar to show part count */
async function loadBoard(page: import('@playwright/test').Page, filePath: string, expectedText?: string) {
  test.skip(!fs.existsSync(filePath), `${path.basename(filePath)} not present (proprietary fixture)`);
  const fileInput = page.getByTestId('file-input');
  await fileInput.setInputFiles(filePath);
  if (expectedText) {
    await expect(page.getByTestId('statusbar')).toContainText(expectedText, { timeout: 15000 });
  } else {
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 15000 });
  }
}

/** Helper: load a PDF file */
async function loadPdf(page: import('@playwright/test').Page, filePath: string) {
  test.skip(!fs.existsSync(filePath), `${path.basename(filePath)} not present (proprietary fixture)`);
  const pdfInput = page.getByTestId('pdf-input');
  await pdfInput.setInputFiles(filePath);
  await page.waitForTimeout(1000);
}

/** Filter out expected WebGL/PixiJS errors in headless Chromium */
function filterErrors(errors: string[]): string[] {
  return errors.filter(e =>
    !e.includes('No available adapters') &&
    !e.includes('WebGL') &&
    !e.includes('PIXI') &&
    !e.includes('net::ERR_') &&
    // Downstream of the "No available adapters" failure: PixiJS fails to
    // initialize its renderer, leaving app.renderer null. Later teardown
    // paths that reach .canvas on the null renderer throw this. Real
    // browsers have WebGL, so this only surfaces in the test environment.
    !e.includes("reading 'canvas'")
  );
}

test.describe('Cross-Format Renderer Stability', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // 1. BVR + BRD simultaneously
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: both load without errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Both tabs should exist
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await expect(bvrTab).toBeVisible();
    await expect(brdTab).toBeVisible();

    await page.waitForTimeout(500);
    expect(filterErrors(errors)).toHaveLength(0);
  });

  test('BVR3 + BRD: switching between tabs updates stats correctly', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    const stats1 = await page.getByTestId('statusbar').textContent();

    await loadBoard(page, BRD_FILE);
    const stats2 = await page.getByTestId('statusbar').textContent();
    expect(stats2).not.toBe(stats1);

    // Switch back to BVR tab
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(500);

    const statsAfterSwitch = await page.getByTestId('statusbar').textContent();
    expect(statsAfterSwitch).toBe(stats1);

    // Switch to BRD tab
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await brdTab.click();
    await page.waitForTimeout(500);

    const statsAfterSwitch2 = await page.getByTestId('statusbar').textContent();
    expect(statsAfterSwitch2).toBe(stats2);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  test('BVR3 + BRD: rapid tab switching does not crash', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();

    // Rapid switching between different format tabs
    for (let i = 0; i < 15; i++) {
      await bvrTab.click();
      await page.waitForTimeout(30);
      await brdTab.click();
      await page.waitForTimeout(30);
    }

    await page.waitForTimeout(1000);
    expect(filterErrors(errors)).toHaveLength(0);
  });

  test('BVR3 + BRD: HUD displays on both tabs after switching', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Check HUD on BRD tab (currently active)
    await page.waitForTimeout(500);
    let hud = page.locator('.board-hud');
    let hudText = await hud.first().textContent();
    expect(hudText).toMatch(/\d+%/); // zoom percentage

    // Switch to BVR tab
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(500);

    hud = page.locator('.board-hud');
    hudText = await hud.first().textContent();
    expect(hudText).toMatch(/\d+%/); // zoom percentage still shows

    expect(filterErrors(errors)).toHaveLength(0);
  });

  test('BVR3 + BRD: restart renderer on each tab works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Restart renderer on BRD tab
    let restartBtn = page.locator('.board-netlines-toggle', { hasText: '↺' }).first();
    await restartBtn.click();
    await page.waitForTimeout(500);

    // Switch to BVR tab and restart
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);
    restartBtn = page.locator('.board-netlines-toggle', { hasText: '↺' }).first();
    await restartBtn.click();
    await page.waitForTimeout(500);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 2. BVR + BRD + layer toggles
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: layer toggles work on both tabs', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    const butterflyBtn = page.locator('.toolbar-btn', { hasText: 'Butterfly' });

    // Toggle layers on BRD tab
    await bottomBtn.click();
    await page.waitForTimeout(200);
    await butterflyBtn.click();
    await page.waitForTimeout(200);
    await topBtn.click();
    await page.waitForTimeout(200);

    // Switch to BVR tab and toggle
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);

    await bottomBtn.click();
    await page.waitForTimeout(200);
    await butterflyBtn.click();
    await page.waitForTimeout(200);
    await topBtn.click();
    await page.waitForTimeout(200);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 3. BVR + BRD + PDF simultaneously
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD + PDF: all three panels coexist', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);
    await loadPdf(page, PDF_FILE);

    // All tabs should exist
    await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first()).toBeVisible();
    await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first()).toBeVisible();
    await expect(page.locator('.dv-tab', { hasText: '820-02016.pdf' }).first()).toBeVisible();

    // Switch between all of them
    await page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.dv-tab', { hasText: '820-02016.pdf' }).first().click();
    await page.waitForTimeout(300);

    // Go back to boards
    await page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first().click();
    await page.waitForTimeout(300);
    await page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first().click();
    await page.waitForTimeout(300);

    await page.waitForTimeout(500);
    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 4. Two BRD files (same format, different files)
  // ═══════════════════════════════════════════════════════════════════════

  test('BRD + FZ: switching between them works', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BRD_FILE);
    const stats1 = await page.getByTestId('statusbar').textContent();

    await loadBoard(page, FZ_FILE);
    const stats2 = await page.getByTestId('statusbar').textContent();
    expect(stats2).not.toBe(stats1);

    // Switch back
    const tab1 = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await tab1.click();
    await page.waitForTimeout(500);

    const statsAfter = await page.getByTestId('statusbar').textContent();
    expect(statsAfter).toBe(stats1);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 5. Three+ formats simultaneously
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD + FZ: three different formats coexist', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // FZ file may fail to parse (encryption/decompression issue with sample file).
    // Load it but tolerate "compressed data" errors — the test verifies that a
    // failed parse on one tab does not crash the other open renderers.
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(FZ_FILE);
    await page.waitForTimeout(2000);

    // BVR and BRD tabs should still exist and work
    await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first()).toBeVisible();
    await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first()).toBeVisible();

    // Switch between the surviving tabs
    for (let i = 0; i < 3; i++) {
      await page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first().click();
      await page.waitForTimeout(200);
      await page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first().click();
      await page.waitForTimeout(200);
    }

    await page.waitForTimeout(500);
    // Filter out known FZ decompression error
    const realErrors = filterErrors(errors).filter(e =>
      !e.includes('compressed data')
    );
    expect(realErrors).toHaveLength(0);
  });

  test('BVR3 + BRD + CAD: three different formats coexist', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);
    await loadBoard(page, CAD_FILE);

    // All tabs should exist
    await expect(page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first()).toBeVisible();
    await expect(page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first()).toBeVisible();
    await expect(page.locator('.dv-tab', { hasText: 'Quanta' }).first()).toBeVisible();

    // Switch between all three
    for (let i = 0; i < 3; i++) {
      await page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first().click();
      await page.waitForTimeout(200);
      await page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first().click();
      await page.waitForTimeout(200);
      await page.locator('.dv-tab', { hasText: 'Quanta' }).first().click();
      await page.waitForTimeout(200);
    }

    await page.waitForTimeout(500);
    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 6. Close one tab while other format is open
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: closing BRD tab leaves BVR working', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Close BRD tab
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    const closeBtn = brdTab.locator('.dv-default-tab-action');
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }

    // BVR tab should still work
    const statusbar = page.getByTestId('statusbar');
    await expect(statusbar).toContainText('3075', { timeout: 5000 });

    // Canvas should still exist
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();

    expect(filterErrors(errors)).toHaveLength(0);
  });

  test('BVR3 + BRD: closing BVR tab leaves BRD working', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Switch to BVR first, then close it
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);

    const closeBtn = bvrTab.locator('.dv-default-tab-action');
    if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }

    // BRD tab should still work
    const statusbar = page.getByTestId('statusbar');
    await expect(statusbar).toContainText('Components', { timeout: 5000 });

    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 7. Stress: rotation + mirror on cross-format tabs
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: rotation/mirror on each tab independently', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    const cwBtn = page.locator('.toolbar-btn-icon', { hasText: '↻' });
    const hBtn = page.locator('.toolbar-btn-icon', { hasText: '⇔' });
    const vBtn = page.locator('.toolbar-btn-icon', { hasText: '⇕' });

    // Rotate and mirror on BRD tab
    await cwBtn.click();
    await page.waitForTimeout(100);
    await hBtn.click();
    await page.waitForTimeout(100);

    // Switch to BVR tab
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);

    // Rotate and mirror differently on BVR tab
    await cwBtn.click();
    await cwBtn.click();
    await page.waitForTimeout(100);
    await vBtn.click();
    await page.waitForTimeout(100);

    // Switch back to BRD
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await brdTab.click();
    await page.waitForTimeout(300);

    // Do more rotation
    await cwBtn.click();
    await page.waitForTimeout(100);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 8. Stress: search on cross-format tabs
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: search on each tab independently', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    const searchInput = page.getByTestId('search-input');

    // Search on BRD tab
    await searchInput.fill('U1');
    await page.waitForTimeout(300);

    // Switch to BVR and search
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);
    await searchInput.fill('R1');
    await page.waitForTimeout(300);

    // Switch back to BRD
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await brdTab.click();
    await page.waitForTimeout(300);

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(300);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 9. BVR + BRD + two PDFs simultaneously
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD + two PDFs: full multi-panel test', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadPdf(page, PDF_FILE);
    await page.waitForTimeout(500);

    await loadBoard(page, BRD_FILE);
    await loadPdf(page, PDF_935);
    await page.waitForTimeout(500);

    // Switch between board tabs rapidly
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();

    for (let i = 0; i < 5; i++) {
      await bvrTab.click();
      await page.waitForTimeout(100);
      await brdTab.click();
      await page.waitForTimeout(100);
    }

    await page.waitForTimeout(500);
    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 10. Renderer recovery: restart both tabs after switching
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: restart renderer on both tabs recovers properly', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    // Switch to BVR, restart
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(300);
    await page.locator('.board-netlines-toggle', { hasText: '↺' }).first().click();
    await page.waitForTimeout(500);

    // Verify HUD still working
    let hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%');

    // Switch to BRD, restart
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await brdTab.click();
    await page.waitForTimeout(300);
    await page.locator('.board-netlines-toggle', { hasText: '↺' }).first().click();
    await page.waitForTimeout(500);

    // Verify HUD still working
    hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%');

    // Switch back to BVR to verify it's still alive
    await bvrTab.click();
    await page.waitForTimeout(500);
    hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%');

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 11. Flipy difference: BVR (no flipY) vs BRD (flipY=true)
  // ═══════════════════════════════════════════════════════════════════════

  test('BVR3 + BRD: flipY format difference does not corrupt other tab', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', err => errors.push(err.message));

    await page.goto('/');
    await loadBoard(page, BVR3_FILE, '3075');
    await loadBoard(page, BRD_FILE);

    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();

    // Toggle bottom view on BRD (flipY=true) — this exercises the flipY path
    const bottomBtn = page.locator('.toolbar-btn', { hasText: 'Bottom' });
    await bottomBtn.click();
    await page.waitForTimeout(300);

    // Switch to BVR (flipY=false) — check that flips are correct for this format
    await bvrTab.click();
    await page.waitForTimeout(300);
    await bottomBtn.click();
    await page.waitForTimeout(300);

    // Switch back to BRD — verify no corruption
    await brdTab.click();
    await page.waitForTimeout(300);

    // Re-enable top view
    const topBtn = page.locator('.toolbar-btn', { hasText: 'Top' });
    await topBtn.click();
    await page.waitForTimeout(300);

    expect(filterErrors(errors)).toHaveLength(0);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // 12. EXACT REPRO: BVR + PDF, then BRD + PDF, switch back to BVR
  //     Matches user's manual reproduction steps:
  //     1. Open 820-02016.bvr (with 820-02841.pdf)
  //     2. Open 820-02935-05.brd (with 820-02935 schematic PDF)
  //     3. Switch back to first board tab → should NOT be blank
  // ═══════════════════════════════════════════════════════════════════════

  test('REPRO: BVR+PDF then BRD+PDF, switch back — board must not be blank', async ({ page }) => {
    const errors: string[] = [];
    const consoleLogs: string[] = [];

    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[BoardRenderer]') || text.includes('[renderer]') || text.includes('[panel]')) {
        consoleLogs.push(`[${msg.type()}] ${text}`);
      }
    });

    await page.goto('/');

    // Step 1: Open BVR board + its PDF
    await loadBoard(page, BVR3_FILE);
    await loadPdf(page, PDF_FILE);
    await page.waitForTimeout(1000);

    // Verify first board is rendering (HUD shows zoom percentage)
    const hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%', { timeout: 5000 });

    // Step 2: Open BRD board + its PDF
    await loadBoard(page, BRD_FILE);
    await loadPdf(page, PDF_935);
    await page.waitForTimeout(1000);

    // Step 3: Switch back to BVR tab
    const bvrTab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    await bvrTab.click();
    await page.waitForTimeout(2000); // Extra time for reinitApp async

    // Verify: HUD must still show zoom (proves renderer is alive)
    await expect(hud).toContainText('%', { timeout: 5000 });

    // Verify: status bar shows the BVR board's stats (part count)
    await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 5000 });

    // Step 4: Switch to BRD and back again (second round)
    const brdTab = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    await brdTab.click();
    await page.waitForTimeout(2000);
    await bvrTab.click();
    await page.waitForTimeout(2000);

    await expect(hud).toContainText('%', { timeout: 5000 });

    // Dump all console logs for debugging
    console.log('=== BoardRenderer Console Logs ===');
    for (const log of consoleLogs) {
      console.log(log);
    }
    console.log('=== End Console Logs ===');
    console.log(`Total errors: ${errors.length}`);
    for (const err of errors) {
      console.log(`  ERROR: ${err}`);
    }

    // Allow WebGL-related errors (context loss is expected in some environments)
    // but not crashes that prevent rendering
    const fatalErrors = errors.filter(e =>
      !e.includes('No available adapters') &&
      !e.includes('WebGL') &&
      !e.includes('PIXI') &&
      !e.includes('net::ERR_') &&
      !e.includes('context lost') &&
      !e.includes('disconnected port') &&
      !e.includes("reading 'canvas'")
    );
    expect(fatalErrors).toHaveLength(0);
  });

  test('REPRO: three boards + PDFs, rapid switching — no permanent crash', async ({ page }) => {
    const errors: string[] = [];
    const consoleLogs: string[] = [];

    page.on('pageerror', err => errors.push(err.message));
    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[BoardRenderer]') || text.includes('[renderer]') || text.includes('[panel]')) {
        consoleLogs.push(`[${msg.type()}] ${text}`);
      }
    });

    await page.goto('/');

    // Open 3 boards with PDFs
    await loadBoard(page, BVR3_FILE, '3075');
    await loadPdf(page, PDF_FILE);
    await page.waitForTimeout(500);

    await loadBoard(page, BRD_FILE);
    await loadPdf(page, PDF_935);
    await page.waitForTimeout(500);

    await loadBoard(page, FZ_FILE);
    await page.waitForTimeout(500);

    // Rapid switching
    const tab1 = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
    const tab2 = page.locator('.dv-tab', { hasText: '820-02935-05.brd' }).first();
    const tab3 = page.locator('.dv-tab', { hasText: 'Asus G532LWS' }).first();

    for (let i = 0; i < 3; i++) {
      await tab1.click();
      await page.waitForTimeout(500);
      await tab2.click();
      await page.waitForTimeout(500);
      await tab3.click();
      await page.waitForTimeout(500);
    }

    // End on tab1 — verify it's alive
    await tab1.click();
    await page.waitForTimeout(2000);

    const hud = page.locator('.board-hud').first();
    await expect(hud).toContainText('%', { timeout: 5000 });

    // Dump console logs
    console.log('=== BoardRenderer Console Logs (3-board test) ===');
    for (const log of consoleLogs) {
      console.log(log);
    }
    console.log('=== End Console Logs ===');
    console.log(`Total errors: ${errors.length}`);
    for (const err of errors) {
      console.log(`  ERROR: ${err}`);
    }

    const fatalErrors = errors.filter(e =>
      !e.includes('No available adapters') &&
      !e.includes('WebGL') &&
      !e.includes('PIXI') &&
      !e.includes('net::ERR_') &&
      !e.includes('context lost') &&
      !e.includes('disconnected port') &&
      !e.includes("reading 'canvas'")
    );
    expect(fatalErrors).toHaveLength(0);
  });
});
