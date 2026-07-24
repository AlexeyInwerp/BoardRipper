import { test, expect } from '@playwright/test';
import fs from 'fs';

// Reproduces "any settings change crashes render": darklight (spotlight) dim
// mode + a selected part + a settings-change rebuild → the halo sprite is
// destroyed with the old scene, then updateHalo() dereferences its null texture.
const BOARD = '/Users/besitzer/Desktop/Boardviewer/samples/820-02016/820-02016.bvr';
const isNoise = (s: string) => /status of 500|Failed to load resource|ECONNREFUSED|\/api\//.test(s);

test('darklight + selection + settings change does not crash the halo', async ({ page }) => {
  test.skip(!fs.existsSync(BOARD), 'sample board not present');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !isNoise(m.text())) errors.push(`console.error: ${m.text()}`); });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  await page.waitForTimeout(1500);

  // Spotlight (darklight) mode + the LARGEST (definitely visible) part → the
  // halo sprite gets mounted into scene.root.
  await page.evaluate(() => {
    const bs = (window as any).__boardStore;
    bs.cycleDimMode();          // dim → darklight
    let best = 0, bestArea = -1;
    bs.board.parts.forEach((p: any, i: number) => {
      const b = p.bounds; if (!b) return;
      const a = (b.maxX - b.minX) * (b.maxY - b.minY);
      if (a > bestArea) { bestArea = a; best = i; }
    });
    bs.selectPart(best);
  });
  await page.waitForTimeout(500);

  // Any settings change rebuilds the scene → previously crashed in updateHalo.
  const changes: Array<[string, number]> = [
    ['partBorderWidth', 5], ['labelMinSize', 15], ['pinSizeScale', 2], ['partBorderWidth', 1],
  ];
  for (const [k, v] of changes) {
    await page.evaluate(([key, val]) => {
      const rs = (window as any).__renderSettings;
      rs.applyGlobal({ ...rs.globalSnapshot(), [key as string]: val as number });
    }, [k, v] as [string, number]);
    await page.waitForTimeout(500);   // let the debounced rebuild + renderSelection run
    console.log(`after ${k}=${v}: errors=${errors.length}`);
  }
  console.log('ERRORS:\n' + (errors.join('\n') || '(none)'));
  expect(errors, errors.join('\n')).toHaveLength(0);
});
