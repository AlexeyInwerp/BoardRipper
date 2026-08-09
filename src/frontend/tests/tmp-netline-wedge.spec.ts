import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __d = path.dirname(fileURLToPath(import.meta.url));
const S = path.resolve(__d, '../../../samples/XZZ PCB SAMPLES/PL5TU1B/PL5TU1B_BRD_MB_VA1RTE.pcb');
test.use({ viewport: { width: 1100, height: 850 }, launchOptions: { args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] } });

test('PL5TU1B net line with oblong pins', async ({ page }) => {
  test.skip(!fs.existsSync(S), 'no sample');
  test.setTimeout(180000);
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(S);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  await page.waitForTimeout(1200);

  // Pick a net whose pins are oblong capsules and that spans a few parts.
  const netName = await page.evaluate(() => {
    const w = window as any;
    const board = w.__boardStore?.activeTab?.board;
    for (const [name, net] of board.nets) {
      if (net.pinIndices.length < 3 || net.pinIndices.length > 8) continue;
      const oblong = net.pinIndices.filter((r: any) => {
        const p = board.parts[r.partIndex]?.pins[r.pinIndex];
        return p?.padShape === 'round' && p.padWidth > 0 && p.padHeight > 0 && p.padWidth !== p.padHeight;
      }).length;
      if (oblong >= 3) return name;
    }
    return null;
  });
  console.log('net picked:', netName);
  expect(netName).toBeTruthy();

  // Highlight the net AND select one of its pins, then zoom to that area so
  // the connection lines are actually on screen.
  await page.evaluate((n) => {
    const w = window as any;
    const board = w.__boardStore.activeTab.board;
    const ref = board.nets.get(n).pinIndices[0];
    w.__boardStore.highlightNet(n);
    w.__boardStore.selectPin(ref.partIndex, ref.pinIndex);
  }, netName);
  await page.waitForTimeout(1200);
  // Zoom to the selected part so the connection lines are on screen at size.
  const partName = await page.evaluate((n) => {
    const w = window as any;
    const board = w.__boardStore.activeTab.board;
    const ref = board.nets.get(n).pinIndices[0];
    const name = board.parts[ref.partIndex].name;
    w.__boardStore.focusPart(name);
    return name;
  }, netName);
  console.log('focused part:', partName);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/netline-wedge.png' });
});
