/**
 * Known CPU / GPU packages in the 3D view: a large ball field that matches a
 * record in store/cpu-packages.ts is drawn as that package (substrate, dies,
 * lid or stiffener ring) rather than a box the size of its pins. Needs the
 * proprietary Allegro sample (Dell XPS 15 9550: Skylake-H + GM107); skips
 * without it. BR_3D_SHOT=<dir> also writes screenshots for review.
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(HERE, '../../../samples/allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd');
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });
test.skip(!fs.existsSync(SAMPLE), 'proprietary sample not present');

type W = { __boardStore: { board: { parts: { name: string; pins: unknown[] }[] }; selectPart(i: number): void }; __board3d?: { renderer: { drawnParts: number; part(i: number): { est: { pkg?: string; L: number; W: number; family: string } } | undefined; focusPart(i: number): void; view(p: string, a?: boolean): void } } };

async function open3D(page: Page) {
  await page.goto('/'); await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', SAMPLE);
  await page.waitForFunction(() => (window as unknown as W).__boardStore?.board, null, { timeout: 120000 });
  await page.getByTestId('view3d-btn').click();
  await page.waitForFunction(() => ((window as unknown as W).__board3d?.renderer.drawnParts ?? 0) > 0, null, { timeout: 120000 });
}

test('Skylake-H and the GeForce are drawn as their packages', async ({ page }) => {
  test.setTimeout(300000);
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await open3D(page);
  const found = await page.evaluate(() => {
    const w = window as unknown as W; const out: Record<string, { pkg?: string; L: number; W: number; index: number }> = {};
    w.__boardStore.board.parts.forEach((p, i) => { if (['UH1', 'UV18', 'UH2'].includes(p.name)) { const e = w.__board3d!.renderer.part(i)?.est; if (e) out[p.name] = { pkg: e.pkg, L: e.L, W: e.W, index: i }; } });
    return out;
  });
  expect(found.UH1?.pkg).toBe('intel-bga1440');   // 42 × 28 from the record, not the 40.7 × 26.8 pin box
  expect(found.UH1?.L).toBe(42); expect(found.UH1?.W).toBe(28);
  expect(found.UV18?.pkg).toBe('nv-bga908');
  expect(found.UH2?.pkg).toBe('intel-pch-h-837');
  const dir = process.env.BR_3D_SHOT;
  if (dir) for (const [name, part] of Object.entries(found)) {
    await page.evaluate(i => { const w = window as unknown as W; w.__boardStore.selectPart(i); w.__board3d!.renderer.focusPart(i); }, part.index);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(dir, `app-${name}.png`) });
  }
  expect(errors).toEqual([]);
});
