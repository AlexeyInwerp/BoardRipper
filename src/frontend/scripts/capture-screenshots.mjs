#!/usr/bin/env node
/**
 * Generate README screenshots for BoardRipper.
 *
 * Scenarios captured (all at 1600×1000):
 *   01-board-pdf-lookup.png   — BVR board + matching PDF schematic side by side
 *   02-format-support.png     — multiple tabs open showing different formats
 *   03-multi-layer.png        — Allegro BRD with layers visible
 *   04-stacked-boards.png     — BROKEN/V382_20.cad showing stacked-board support
 *
 * Usage (from repo root):  node src/frontend/scripts/capture-screenshots.mjs
 *
 * Requires the frontend's devDependencies to be installed (@playwright/test).
 * Vite dev server is started automatically on port 5174 and torn down on exit.
 * Chromium is launched headed (WebGL is needed for PixiJS rendering).
 */

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(__dirname, '..');
const ROOT = path.resolve(FRONTEND, '../..');
const SAMPLES = path.join(ROOT, 'samples');
const OUT_DIR = path.join(ROOT, 'docs/screenshots');
const VIEWPORT = { width: 1600, height: 1000 };
const DEV_URL = 'http://localhost:5174';

function log(msg) { console.log(`[capture] ${msg}`); }

async function waitForServer(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 200) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Dev server at ${url} did not respond within ${timeoutMs}ms`);
}

async function settle(page, ms = 2500) {
  await page.waitForTimeout(ms);
}

async function waitForTab(page, name, timeout = 30000) {
  await page.locator('.dv-tab', { hasText: name }).first().waitFor({ state: 'visible', timeout });
}

async function waitForBoardReady(page, minComponents = 1, timeout = 60000) {
  await page.getByTestId('statusbar').waitFor({ state: 'visible', timeout });
  await page.waitForFunction(
    (min) => {
      const sb = document.querySelector('[data-testid="statusbar"]');
      if (!sb) return false;
      const m = sb.textContent?.match(/Components:\s*(\d+)/);
      return !!m && parseInt(m[1], 10) >= min;
    },
    minComponents,
    { timeout }
  );
  await page.locator('[data-testid="board-canvas"] canvas').first().waitFor({ state: 'visible' });
}

async function captureBoardPdfLookup(page) {
  log('Scenario 1: Board + PDF cross-reference');
  await page.goto(DEV_URL + '/');
  await page.getByTestId('toolbar').waitFor({ state: 'visible' });
  await page.getByTestId('file-input').setInputFiles(path.join(SAMPLES, '820-02016.bvr'));
  await waitForTab(page, '820-02016.bvr');
  await waitForBoardReady(page, 1000);
  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, '820-02016.pdf'));
  await waitForTab(page, '820-02016.pdf');
  // Give PDF worker time to finish initial render
  await settle(page, 2500);
  // Navigate PDF past the index/cover page to a schematic page
  const pageInput = page.locator('.pdf-page-input').first();
  if (await pageInput.count() > 0) {
    await pageInput.fill('15');
    await pageInput.press('Enter');
    await settle(page, 2500);
  }
  await page.screenshot({ path: path.join(OUT_DIR, '01-board-pdf-lookup.png') });
  log('  → 01-board-pdf-lookup.png');
}

async function captureFormatSupport(page) {
  log('Scenario 2: Multi-format tab bar');
  await page.goto(DEV_URL + '/');
  await page.getByTestId('toolbar').waitFor({ state: 'visible' });
  const files = [
    '820-02016.bvr',
    '820-02935-05.brd',
    'Asus G532LWS 60NR02T0-MB7010 r1.3.fz',
    'HY56F_NMD821R10_View.tvw',
    '820-00165.pcb',
  ];
  for (const f of files) {
    log(`  loading ${f}`);
    await page.getByTestId('file-input').setInputFiles(path.join(SAMPLES, f));
    await waitForTab(page, f);
    await settle(page, 1200);
  }
  await settle(page, 2000);
  await page.screenshot({ path: path.join(OUT_DIR, '02-format-support.png') });
  log('  → 02-format-support.png');
}

async function captureMultiLayer(page) {
  log('Scenario 3: Multi-layer Allegro board');
  await page.goto(DEV_URL + '/');
  await page.getByTestId('toolbar').waitFor({ state: 'visible' });
  await page.getByTestId('file-input').setInputFiles(
    path.join(SAMPLES, 'allegroBRD/Quanta Y0D DA0Y0DMBAF0 boardview .brd')
  );
  await waitForTab(page, 'Quanta Y0D');
  await waitForBoardReady(page, 1000, 90000);
  await settle(page, 3000);
  await page.screenshot({ path: path.join(OUT_DIR, '03-multi-layer.png') });
  log('  → 03-multi-layer.png');
}

async function captureStackedBoards(page) {
  log('Scenario 4: Stacked boards (BROKEN/V382_20.cad)');
  await page.goto(DEV_URL + '/');
  await page.getByTestId('toolbar').waitFor({ state: 'visible' });
  await page.getByTestId('file-input').setInputFiles(path.join(SAMPLES, 'BROKEN/V382_20.cad'));
  await waitForTab(page, 'V382_20.cad');
  await waitForBoardReady(page, 1, 60000);
  await page.getByTestId('pdf-input').setInputFiles(path.join(SAMPLES, 'BROKEN/V382_20.pdf'));
  await waitForTab(page, 'V382_20.pdf');
  await settle(page, 3500);
  await page.screenshot({ path: path.join(OUT_DIR, '04-stacked-boards.png') });
  log('  → 04-stacked-boards.png');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  log('Starting vite dev server on port 5174…');
  const vite = spawn('npx', ['vite', '--port', '5174', '--strictPort'], {
    cwd: FRONTEND,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killVite = () => { try { vite.kill('SIGTERM'); } catch { /* ignore */ } };
  process.on('exit', killVite);
  process.on('SIGINT', () => { killVite(); process.exit(130); });

  try {
    await waitForServer(DEV_URL + '/');
    log('Dev server ready.');

    const browser = await chromium.launch({
      headless: false,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);

    try {
      await captureBoardPdfLookup(page);
      await captureFormatSupport(page);
      await captureMultiLayer(page);
      await captureStackedBoards(page);
    } finally {
      await browser.close();
    }

    log('All screenshots written to docs/screenshots/');
  } finally {
    killVite();
  }
}

main().catch(err => {
  console.error('[capture] FAILED:', err);
  process.exit(1);
});
