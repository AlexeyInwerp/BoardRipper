import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// XZZ top-level 0x09 test points become one-pin parts TP<n> (issue #39,
// after Sean Johnson). iPadAir3 820-01531 YiDianTong stores all 538 of its
// test points this way; NET124 has one part pin (N103 AU21) and a test point
// 0.3" away, which used to be invisible. Proprietary sample: skips without it.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.resolve(HERE, '../../../samples/XZZ PCB SAMPLES/nas-issues/iPadAir3-10.5-4G-820-01531-920-06591 YiDianTong.pcb');

test.use({ launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

test('test points are parts on their net', async ({ page }) => {
  test.skip(!fs.existsSync(FILE), 'iPadAir3 820-01531 sample not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(FILE);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  const r = await page.evaluate(() => {
    const b = (window as unknown as { __boardStore: { activeTab: { board: {
      parts: { name: string; pins: { net: string }[] }[]; nails: unknown[];
    } } } }).__boardStore.activeTab.board;
    const tps = b.parts.filter(p => /^TP/.test(p.name) && p.pins.length === 1);
    return {
      tps: tps.length,
      nails: b.nails.length,
      withNet: tps.filter(p => p.pins[0].net && p.pins[0].net !== 'NC').length,
      net124: b.parts.filter(p => p.pins.some(q => q.net === 'NET124')).map(p => p.name),
    };
  });
  // 538 records; 42 sit inside a same-net part pin's pad (a copy of that pin,
  // e.g. on BGA ball N121.AH27) or have no net, and are not drawn twice.
  expect(r.tps).toBe(496);
  expect(r.nails).toBe(538);   // the status bar's count is kept
  expect(r.withNet).toBe(490);  // the other 6 are isolated NC pads (8 NC records in all)
  expect(r.net124.some(n => n.startsWith('TP'))).toBe(true);
  expect(r.net124.length).toBeGreaterThanOrEqual(2);
});
