/**
 * Colour-scheme review harness (docs/specs/2026-10-11-colour-schemes-review.md).
 * Opens each local sample board in every built-in scheme and saves: fit view,
 * a zoom onto the densest IC, the same with it selected, and the overview and
 * zoom again with the dim off. Not an assertion suite — screenshots for review,
 * written to test-results/theme-review/. Skips boards that are not on disk.
 *
 * Opt-in (four minutes of screenshots has no place in the normal run):
 *   THEME_REVIEW=1 npx playwright test tests/theme-review-shots.spec.ts --workers=2
 */
import { test, type Page, type Browser } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../test-results/theme-review') + '/';
const S = (p: string) => path.resolve(__dirname, '../../../samples', p);
const BOARDS: [string, string][] = [
  ['k50', S('XZZ PCB SAMPLES/Old model/820-2347 K50/820-2347 K50.pcb')],
  ['iphone16', S('XZZ PCB SAMPLES/iPhone16_16Plus/iPhone16_16Plus AP+BB Boardview.pcb')],
  ['tomu', S('kicad/tomu-fpga.kicad_pcb')],
  ['lap', S('LA-P161PR1B.brd')],
];
const THEMES = ['default', 'landrex', 'drafting-paper', 'daylight', 'blueprint-light'];
test.setTimeout(600_000);

async function open(browser: Browser, theme: string, file: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 }, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    localStorage.setItem('boardripper-theme', JSON.stringify({ activeId: t }));
    localStorage.setItem('boardripper-sidebar-collapsed', 'true');
  }, theme);
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.getByTestId('file-input').setInputFiles(file);
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  return page;
}

for (const [bname, file] of BOARDS) {
  test(bname, async ({ browser }) => {
    test.skip(!process.env.THEME_REVIEW, 'set THEME_REVIEW=1 to take the review screenshots');
    test.skip(!fs.existsSync(file), `${file} not present (local sample)`);
    fs.mkdirSync(OUT, { recursive: true });
    for (const theme of THEMES) {
      const page = await open(browser, theme, file);
      const shot = (n: string) => page.screenshot({ path: `${OUT}${bname}-${theme}-${n}.png` });
      await shot('1fit');
      // densest top-side IC: most pins per area, at least 12 pins
      const a = await page.evaluate(() => {
        const b = (window as any).__boardStore.activeTab.board;
        let best = -1, bi = 0;
        b.parts.forEach((p: any, i: number) => {
          if (p.side === 'bottom' || p.pins.length < 12) return;
          const area = Math.max(1, (p.bounds.maxX - p.bounds.minX) * (p.bounds.maxY - p.bounds.minY));
          const score = p.pins.length * p.pins.length / area;   // favour many pins, small area
          if (score > best) { best = score; bi = i; }
        });
        return { name: b.parts[bi].name };
      });
      const zoomTo = (frac: number) => page.evaluate(({ name, frac }) => {
        const st = (window as any).__boardStore; const r = (window as any).__boardRenderer; const v = r.viewport;
        const b = st.activeTab.board; const p = b.parts.find((q: any) => q.name === name);
        const root = r.activeScene.root;
        const g0 = root.toGlobal({ x: p.bounds.minX, y: p.bounds.minY }), g1 = root.toGlobal({ x: p.bounds.maxX, y: p.bounds.maxY });
        const w0 = v.toWorld(g0.x, g0.y), w1 = v.toWorld(g1.x, g1.y);
        const cx = (w0.x + w1.x) / 2, cy = (w0.y + w1.y) / 2;
        const ext = Math.max(Math.abs(w1.x - w0.x), Math.abs(w1.y - w0.y));
        v.setZoom((v.screenHeight * frac) / ext, true); v.moveCenter(cx, cy);
      }, { name: a.name, frac });
      await zoomTo(0.7); await page.waitForTimeout(1800); await shot('2zoom');
      await page.evaluate((n) => (window as any).__boardStore.focusPart(n), a.name);
      await page.waitForTimeout(400); await zoomTo(0.7); await page.waitForTimeout(1800); await shot('3sel');
      await page.evaluate(() => (window as any).__boardStore.selectPart(null));
      await zoomTo(0.12); await page.waitForTimeout(1800); await shot('4mid');
      // the same views with the dim off: the theme as designed
      await page.evaluate(() => { const st = (window as any).__boardStore; st.updateActiveTab({ dimMode: 'off' }); st.notify(); });
      await page.waitForTimeout(1200); await shot('5mid-nodim');
      await zoomTo(0.7); await page.waitForTimeout(1800); await shot('6zoom-nodim');
      await page.context().close();
    }
  });
}
