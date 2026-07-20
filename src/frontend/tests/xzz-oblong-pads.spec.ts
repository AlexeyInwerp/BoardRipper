import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// XZZ oblong-pad guard (normalizeOblongPads) + capsule rendering, verified
// against the board that surfaced the bug: PL5TU1B (MECHREVO). CPU1's BGA
// perimeter rings carry bogus 15×300/350 oblong entries that used to render
// as Ø300+ circles ("huge pins"); EC1's LQFP-128 leads are real 15×60
// oblongs that used to render as Ø60 circles. See docs/formats/XZZ_FORMAT.md
// ("Oblong pads").
const SAMPLE = path.resolve(
  __dirname,
  '../../../samples/XZZ PCB SAMPLES/PL5TU1B/PL5TU1B_BRD_MB_VA1RTE.pcb',
);
const haveSample = fs.existsSync(SAMPLE);

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

interface PinGeom {
  number: string;
  padWidth?: number;
  padHeight?: number;
  padAngleDeg?: number;
  radius: number;
}

test('PL5TU1B: CPU1 perimeter stubs collapse to dots, EC1 QFP leads stay oblong', async ({ page }) => {
  test.skip(!haveSample, 'samples/XZZ PCB SAMPLES/PL5TU1B not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(SAMPLE);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });

  const geom = await page.evaluate(() => {
    const store = (window as unknown as {
      __boardStore?: {
        activeTab?: { board?: { parts: { name: string; pins: PinGeom[] }[] } };
      };
    }).__boardStore;
    const parts = store?.activeTab?.board?.parts ?? [];
    const grab = (name: string) =>
      parts.find(p => p.name === name)?.pins.map(p => ({
        number: p.number,
        padWidth: p.padWidth,
        padHeight: p.padHeight,
        padAngleDeg: p.padAngleDeg,
        radius: p.radius,
      })) ?? [];
    return { cpu: grab('CPU1'), ec: grab('EC1') };
  });

  // CPU1: every ball is a 15-mil round dot — no oblong survivors (the
  // vendor's own assembly drawing shows plain dots on the perimeter rings).
  expect(geom.cpu.length).toBe(1449);
  for (const p of geom.cpu) {
    expect(p.padWidth, `CPU1 pin ${p.number}`).toBe(15);
    expect(p.padHeight, `CPU1 pin ${p.number}`).toBe(15);
  }

  // EC1: all 128 leads keep their real 15×60 oblong geometry, oriented
  // per side (left/right rows at the declared 270°, top/bottom rescued 90°).
  expect(geom.ec.length).toBe(128);
  const angles = new Set<number>();
  for (const p of geom.ec) {
    expect(p.padWidth, `EC1 pin ${p.number}`).toBe(15);
    expect(p.padHeight, `EC1 pin ${p.number}`).toBe(60);
    angles.add(p.padAngleDeg ?? 0);
  }
  expect(angles).toEqual(new Set([0, 270]));

  // Visual: frame EC1 (capsule leads) then CPU1 (dot field) via the DEV
  // renderer hook and screenshot for eyeball regression.
  const frame = async (name: string, marginMils: number) => {
    await page.evaluate(([partName, margin]) => {
      const w = window as unknown as {
        __boardStore?: { activeTab?: { board?: { parts: { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number } }[] } } };
        __boardRenderer?: { viewport: { moveCenter(x: number, y: number): void; setZoom(s: number, c?: boolean): void; screenWidth: number; screenHeight: number } };
      };
      const part = w.__boardStore?.activeTab?.board?.parts.find(p => p.name === partName);
      const vp = w.__boardRenderer?.viewport;
      if (!part || !vp) throw new Error(`no part/viewport for ${partName}`);
      const b = part.bounds;
      const wMils = (b.maxX - b.minX) + (margin as number) * 2;
      const hMils = (b.maxY - b.minY) + (margin as number) * 2;
      const scale = Math.min(vp.screenWidth / wMils, vp.screenHeight / hMils);
      vp.setZoom(scale, true);
      vp.moveCenter((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
    }, [name, marginMils] as const);
    await page.waitForTimeout(1200);
  };

  await frame('EC1', 60);
  await page.screenshot({ path: 'test-results/xzz-oblong-ec1.png' });
  await frame('CPU1', 100);
  await page.screenshot({ path: 'test-results/xzz-oblong-cpu1.png' });
});
