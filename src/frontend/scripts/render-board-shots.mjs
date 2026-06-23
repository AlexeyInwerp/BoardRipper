#!/usr/bin/env node
/**
 * Headless board-render harness — catches *visual* parser/renderer regressions
 * that data-only assertions miss (e.g. oversized aggregate "components" that
 * render as giant boxes; coordinate-scale bugs that shrink pins sub-pixel).
 *
 * Unlike capture-screenshots.mjs (headed, for README art) this runs headless
 * with SwiftShader so PixiJS WebGL actually rasterises in CI / over SSH.
 *
 * Usage (Vite dev server must be running — `npm run dev`):
 *   node scripts/render-board-shots.mjs <file.cad> [<file2> ...]
 *   BOARDRIPPER_URL=http://localhost:8082 node scripts/render-board-shots.mjs ~/Downloads/*.cad
 *
 * Output: PNG per board + a board-shots-report.json with per-board stats
 * (component count, mechanical-flagged count, largest part bbox as % of board,
 * console errors). The size stats are the machine-checkable signal — a single
 * part exceeding ~20% of the board area is the fingerprint of an aggregate /
 * coordinate bug. See tests/cad-component-size-invariant.spec.ts for the gate.
 */
import { chromium } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../../test-results/board-shots');
const URL = process.env.BOARDRIPPER_URL || 'http://localhost:8082/';
const VIEWPORT = { width: 1600, height: 1000 };

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/render-board-shots.mjs <board-file> [...]');
  process.exit(2);
}

async function reachable(url) {
  try { const r = await fetch(url); return r.ok; } catch { return false; }
}

if (!(await reachable(URL))) {
  console.error(`Dev server not reachable at ${URL}. Run \`npm run dev\` first (or set BOARDRIPPER_URL).`);
  process.exit(2);
}

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
  ],
});

const report = [];
for (const file of files) {
  const name = path.basename(file).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
  const entry = { file: path.basename(file), name };
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('file-input').setInputFiles(path.resolve(file));
    await page.waitForFunction(() => {
      const t = document.querySelector('[data-testid=statusbar]')?.textContent || '';
      return /Components:\s*\d+/.test(t);
    }, { timeout: 90000 });
    await page.waitForTimeout(2500); // let fit + first frames settle

    // Pull board stats straight from the live store (exposed for tooling).
    const stats = await page.evaluate(() => {
      const b = window.__boardStore?.board;
      if (!b) return null;
      const bb = b.bounds, A = (bb.maxX - bb.minX) * (bb.maxY - bb.minY) || 1;
      let maxPct = 0, maxName = '', maxUnflaggedPct = 0, maxUnflaggedName = '', mech = 0;
      for (const p of b.parts) {
        const pct = ((p.bounds.maxX - p.bounds.minX) * (p.bounds.maxY - p.bounds.minY)) / A * 100;
        if (p.mechanical) mech++;
        if (pct > maxPct) { maxPct = pct; maxName = p.name; }
        if (!p.mechanical && pct > maxUnflaggedPct) { maxUnflaggedPct = pct; maxUnflaggedName = p.name; }
      }
      return { parts: b.parts.length, mech, maxName, maxPct, maxUnflaggedName, maxUnflaggedPct };
    });
    Object.assign(entry, stats || {}, { errors: errs.length });
    await page.getByTestId('board-canvas').screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
  } catch (e) {
    entry.error = String(e.message || e).slice(0, 160);
  }
  report.push(entry);
  console.log(JSON.stringify(entry));
  await page.close();
}

await fs.writeFile(path.join(OUT_DIR, 'board-shots-report.json'), JSON.stringify(report, null, 2));
console.log(`\nPNGs + report → ${OUT_DIR}`);
await browser.close();
