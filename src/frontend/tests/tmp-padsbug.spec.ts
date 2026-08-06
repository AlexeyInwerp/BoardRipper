import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
const __d = path.dirname(fileURLToPath(import.meta.url));
const S = path.resolve(__d, "../../../samples/XZZ PCB SAMPLES/A24xx/A2442_820-02098 MacBook Pro/Schematic and boardview/MacBook Pro M1 Pro 14' A2442 820-02098-A PCB layer.pcb");
test.use({ viewport: { width: 1280, height: 720 }, launchOptions: { args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] } });

async function probe(page: import('@playwright/test').Page, tag: string) {
  const r = await page.evaluate(() => {
    const w = window as unknown as { __boardRenderer?: any; __boardStore?: any };
    const R = w.__boardRenderer, S = R?.activeScene, vp = R?.viewport;
    const vis = (c: any) => c ? `${c.visible ? 'V' : '-'}${c.children?.length ?? 0}` : 'null';
    return {
      showPads: w.__boardStore?.showPads,
      zoom: vp ? +(vp.scale?.x ?? 0).toFixed(3) : null,
      vpPos: vp ? `${Math.round(vp.x)},${Math.round(vp.y)}` : null,
      worldVisible: vp?.visible,
      root: vis(S?.root),
      pinsTop: vis(S?.pinsTop), tracesTop: vis(S?.tracesTop),
      padsTop: vis(S?.padsTop), partsTop: vis(S?.partsTop),
      rootRenderable: S?.root?.renderable, rootAlpha: S?.root?.alpha,
      cullArea: vp?.hitArea ? `${Math.round(vp.hitArea.width)}x${Math.round(vp.hitArea.height)}` : null,
      // Where is the board relative to what the camera can see?
      view: vp ? `x[${Math.round(vp.left)}..${Math.round(vp.right)}] y[${Math.round(vp.top)}..${Math.round(vp.bottom)}]` : null,
      boardBounds: (() => { const b = w.__boardStore?.activeTab?.board?.bounds; return b ? `x[${Math.round(b.minX)}..${Math.round(b.maxX)}] y[${Math.round(b.minY)}..${Math.round(b.maxY)}]` : null; })(),
      kids: (S?.root?.children ?? []).map((c: any) => `${c.label ?? c.constructor?.name ?? '?'}:${c.visible ? 'V' : 'x'}${c.renderable === false ? 'R0' : ''}`).join(' '),
      worldKids: (vp?.children ?? []).map((c: any) => `${c.label ?? c.constructor?.name ?? '?'}:${c.visible ? 'V' : 'x'}`).join(' '),
      cullerOn: !!vp?.plugins?.get?.('cull'),
    };
  });
  console.log(`[${tag}] ${JSON.stringify(r)}`);
  return r;
}

test('pads toggle while zoomed', async ({ page }) => {
  test.skip(!fs.existsSync(S), 'no sample');
  test.setTimeout(180000);
  page.on('console', m => { const t = m.text(); if (/error|Error|cull|rebuild/.test(t)) console.log('  console:', t.slice(0, 160)); });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(S);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  await page.waitForTimeout(1500);
  await probe(page, 'loaded (fit zoom)');

  await page.evaluate(() => (window as any).__boardStore?.focusPart?.('N4355'));
  await page.waitForTimeout(1500);
  await probe(page, 'zoomed to N4355');
  await page.screenshot({ path: 'test-results/padsbug-1-zoomed.png' });

  await page.evaluate(() => (window as any).__boardStore?.togglePads?.());
  await page.waitForTimeout(1500);
  await probe(page, 'after togglePads');
  await page.screenshot({ path: 'test-results/padsbug-2-toggled.png' });
});
