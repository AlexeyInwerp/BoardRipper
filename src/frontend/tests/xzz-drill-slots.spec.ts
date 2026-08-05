import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// XZZ through-hole drills + oblong-pad capsules, rendered. The parser side is
// covered by tests/xzz-parser.spec.ts and src/parsers/xzz-oblong.test.ts; this
// spec exists because the geometry only reaches the user through the scene,
// and the failure mode is silent (a slot drawn as a centred circle still
// "works"). See docs/formats/XZZ_FORMAT.md and issue #32.
//
// A2442-820-02098-A is one of the ten files whose exporter populates the
// drill field: 81 drilled pins across 34 connector/mounting parts, including
// 42×15 pads with a 12.5-mil drill — an oblong through-hole, i.e. a slot.
const SAMPLE = path.resolve(
  __dirname,
  "../../../samples/XZZ PCB SAMPLES/A24xx/A2442_820-02098 MacBook Pro/Schematic and boardview/MacBook Pro M1 Pro 14' A2442 820-02098-A PCB layer.pcb",
);
const haveSample = fs.existsSync(SAMPLE);

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

test('A2442-A: drilled pads carry slots, capsules keep the pen on either axis', async ({ page }) => {
  test.skip(!haveSample, 'samples/XZZ PCB SAMPLES A2442-820-02098-A not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(SAMPLE);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });

  const geom = await page.evaluate(() => {
    const store = (window as unknown as {
      __boardStore?: {
        activeTab?: {
          board?: {
            parts: { name: string; type: string; pins: { drill?: number; padWidth?: number; padHeight?: number }[] }[];
            pads: { drill?: number; shape?: string; width?: number; height?: number }[];
          };
        };
      };
    }).__boardStore;
    const board = store?.activeTab?.board;
    const parts = board?.parts ?? [];
    const pads = board?.pads ?? [];
    const pins = parts.flatMap(p => p.pins);
    return {
      throughHoleParts: parts.filter(p => p.type === 'throughhole').length,
      smdParts: parts.filter(p => p.type === 'smd').length,
      drilledPins: pins.filter(p => p.drill != null).length,
      // Ring violations: a drill at least as wide as its own copper.
      ringViolations: pins.filter(p =>
        p.drill != null && p.drill >= Math.min(p.padWidth ?? Infinity, p.padHeight ?? Infinity)).length,
      slots: pads.filter(p => p.drill && p.shape === 'round' && p.width !== p.height).length,
      // Capsules with the pen on the W axis — the ones the old guard flattened.
      wAxisCapsules: pins.filter(p =>
        (p.padWidth ?? 0) > (p.padHeight ?? 0) && (p.padHeight ?? 0) > 0).length,
    };
  });

  expect(geom.drilledPins).toBeGreaterThan(0);
  expect(geom.throughHoleParts).toBeGreaterThan(0);
  expect(geom.smdParts).toBeGreaterThan(geom.throughHoleParts); // sanity: most parts are SMD
  expect(geom.ringViolations).toBe(0);
  expect(geom.slots).toBeGreaterThan(0);
  expect(geom.wAxisCapsules).toBeGreaterThan(0);

  // Pads on, so the drill layer (and therefore the slot path) is drawn, then
  // focus a through-hole connector so the shapes are big enough to see.
  await page.evaluate(() => {
    const w = window as unknown as {
      __boardStore?: { showPads: boolean; togglePads?: () => void; focusPart?: (n: string) => void };
    };
    if (w.__boardStore && !w.__boardStore.showPads) w.__boardStore.togglePads?.();
    w.__boardStore?.focusPart?.('N4355');
  });
  await page.waitForTimeout(1200);

  // Two canvases live in the panel now (the WebGL board + the Canvas2D label
  // overlay) — the board is the first.
  const canvas = page.getByTestId('board-canvas').locator('canvas').first();
  await expect(canvas).toBeVisible();
  await page.screenshot({ path: 'test-results/xzz-drill-slots-pads-on.png' });

  // …and with pads OFF, which is what §2b is about: the base pin sprite must
  // draw the capsule itself, and the selection halo must trace that capsule
  // rather than stamping a circle in its waist.
  //
  // Pads are toggled at fit zoom and the part re-focused afterwards, NOT the
  // other way round: toggling "Show pads" while zoomed in blanks the canvas
  // permanently on this board. That reproduces identically on main (a scene
  // rebuild while zoomed, same family as the post-rebuild cull noted in
  // CLAUDE.md) and is not caused by anything here.
  await page.evaluate(() => {
    const w = window as unknown as {
      __boardStore?: { showPads: boolean; togglePads?: () => void; selectPart?: (i: number | null) => void };
      __boardRenderer?: { fitToScreen?: () => void };
    };
    w.__boardStore?.selectPart?.(null);
    w.__boardRenderer?.fitToScreen?.();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const w = window as unknown as { __boardStore?: { showPads: boolean; togglePads?: () => void } };
    if (w.__boardStore?.showPads) w.__boardStore.togglePads?.();
  });
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const w = window as unknown as { __boardStore?: { focusPart?: (n: string) => void } };
    w.__boardStore?.focusPart?.('N4355');
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/xzz-drill-slots-pads-off.png' });
});
