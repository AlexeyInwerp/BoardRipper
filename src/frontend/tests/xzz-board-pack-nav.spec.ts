import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Navigation on an XZZ board pack.
//
// A pack opens in the file's own layout (foldMode 'all-sides'), so a part's
// drawn position is the derived view's, not the parser's. Every camera request
// — search box, part focus, net focus — must aim at the drawn position. v0.37.3
// aimed at the parser's: on this file Q4400 is at x≈3037 in the file and
// x≈5506 on screen, so "Q4400" in the search box flew to the seam between the
// halves and showed an empty canvas. Kept apart from xzz-board-pack.spec.ts
// because that file is Node-only and `launchOptions` must be top-level here.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XZZ = path.resolve(__dirname, '../../../samples/XZZ PCB SAMPLES');
const PACK16 = path.resolve(XZZ, 'iPhone16_16Plus/iPhone16_16Plus AP+BB Boardview.pcb');
const havePack = fs.existsSync(PACK16);

test.use({
  viewport: { width: 1400, height: 900 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

test('focusPart aims the camera at the part as drawn, not as parsed', async ({ page }) => {
  test.skip(!havePack, 'iPhone16_16Plus pack fixture not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(PACK16);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  await page.waitForTimeout(1500);

  const r = await page.evaluate(async () => {
    const bs = (window as any).__boardStore, rend = (window as any).__boardRenderer;
    const tab = bs.activeTab;
    const idx = tab.board.parts.findIndex((p: any) => p.name === 'Q4400');
    const raw = tab.board.parts[idx].bounds;
    const drawn = bs.board.parts[idx].bounds;              // derived view = what the renderer draws
    bs.focusPart('Q4400');
    // Wait for the fly-to to SETTLE rather than a fixed delay: under a loaded
    // machine (several specs, SwiftShader) 3.5 s was not always enough and
    // the part read 200+ px off-centre mid-flight.
    const settled = () => new Promise<void>((resolve) => {
      // "Settled" = the camera has left its starting pose and then held still
      // for six RENDERED frames. Counting frames, not wall-clock samples: the
      // fly-to advances per frame, and under a loaded machine (several specs,
      // SwiftShader) frames can be >600 ms apart, so a 200 ms sampler read
      // "still" mid-flight and the part measured 140 px off-centre.
      const start = { x: rend.viewport.center.x, y: rend.viewport.center.y, s: rend.viewport.scale.x };
      let last = start, still = 0, moved = false, frames = 0;
      const tick = () => {
        frames++;
        const c = rend.viewport.center, s = rend.viewport.scale.x;
        const cur = { x: c.x, y: c.y, s };
        if (!moved && (Math.abs(cur.x - start.x) > 1 || Math.abs(cur.s - start.s) > 1e-3)) moved = true;
        const stable = Math.abs(cur.x - last.x) < 0.5 && Math.abs(cur.y - last.y) < 0.5 && Math.abs(cur.s - last.s) < 1e-4;
        still = stable ? still + 1 : 0;
        last = cur;
        if ((moved && still >= 6) || frames > 600) { rend.app.ticker.remove(tick); resolve(); }
      };
      rend.app.ticker.add(tick);
    });
    await settled();
    const mid = (b: any) => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
    // Compare in SCREEN space: board space is Y-flipped inside the scene root
    // for XZZ, so a viewport-world centre is not directly comparable to a
    // board-space bound. Where does the drawn part land on the canvas?
    const g = rend.activeScene.root.toGlobal(mid(drawn));
    const rect = rend.containerEl.getBoundingClientRect();
    return { foldMode: tab.foldMode, raw: mid(raw), drawn: mid(drawn),
             partOnScreen: { x: g.x, y: g.y }, screen: { w: rect.width, h: rect.height }, zoom: rend.viewport.scale.x };
  });
  // The fixture really is laid out differently from the file (else this proves nothing)…
  expect(r.foldMode).toBe('all-sides');
  expect(Math.abs(r.drawn.x - r.raw.x)).toBeGreaterThan(500);
  // …and the drawn part sits at the centre of the canvas, well zoomed in.
  expect(Math.abs(r.partOnScreen.x - r.screen.w / 2)).toBeLessThan(r.screen.w * 0.1);
  expect(Math.abs(r.partOnScreen.y - r.screen.h / 2)).toBeLessThan(r.screen.h * 0.1);
  expect(r.zoom).toBeGreaterThan(1);
});
