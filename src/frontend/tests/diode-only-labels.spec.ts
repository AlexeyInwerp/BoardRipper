import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Diode-only mode must leave a pin carrying nothing but its reading. Counting
// label records by kind rather than eyeballing the canvas, because the failure
// this guards is exactly the one a screenshot hides: a designator that lands ON
// a pin looks like a pin label but is emitted by the part-label site, so it
// survived the first implementation of the mode.
const F = path.resolve(
  __dirname,
  '../../../samples/XZZ PCB SAMPLES/iPhone16_16Plus/iPhone16_16Plus AP+BB Boardview.pcb',
);
const haveSample = fs.existsSync(F);

test.use({
  viewport: { width: 1400, height: 900 },
  launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

interface Probe {
  kinds: Record<string, number>;
  /** Designators drawn on a part that has exactly one pin — i.e. centred on
   *  the pin itself, in the spot the reading occupies. */
  singlePinLabels: number;
}

test('diode-only mode leaves only readings and body designators', async ({ page }) => {
  test.skip(!haveSample, 'samples/XZZ PCB SAMPLES/iPhone16_16Plus not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(F);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });

  const probe = async (patch: Record<string, unknown>): Promise<Probe> => {
    await page.evaluate((p) => {
      const rs = (window as unknown as { __renderSettings: { globalSnapshot(): object; applyGlobal(s: object): void } }).__renderSettings;
      rs.applyGlobal({ ...rs.globalSnapshot(), ...p });
    }, patch);
    await page.waitForTimeout(1800);
    return page.evaluate(() => {
      const w = window as unknown as {
        __boardRenderer?: { activeScene?: { labelModel?: { top: { kind: string; partIndex: number }[]; bottom: { kind: string; partIndex: number }[] } } };
        __boardStore?: { activeTab?: { board?: { parts: { pins: unknown[] }[] } } };
      };
      const m = w.__boardRenderer?.activeScene?.labelModel;
      const parts = w.__boardStore?.activeTab?.board?.parts ?? [];
      const kinds: Record<string, number> = {};
      let singlePinLabels = 0;
      for (const side of ['top', 'bottom'] as const) {
        for (const r of m?.[side] ?? []) {
          kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
          if (r.kind === 'part' && parts[r.partIndex]?.pins.length === 1) singlePinLabels++;
        }
      }
      return { kinds, singlePinLabels };
    });
  };

  const base = { showDiodeValues: true, showPinNumbers: true, showNetNames: true, diodeValuesOnly: false };
  const on = await probe(base);
  const only = await probe({ ...base, diodeValuesOnly: true });

  // Nothing else may share a pin with the reading.
  expect(only.kinds.pinNum ?? 0).toBe(0);
  expect(only.kinds.circleNum ?? 0).toBe(0);
  expect(only.kinds.circleNet ?? 0).toBe(0);
  expect(only.kinds.twoPinNet ?? 0).toBe(0);
  expect(only.singlePinLabels).toBe(0);

  // The readings themselves are untouched…
  expect(only.kinds.diode).toBe(on.kinds.diode);
  expect(only.kinds.diode).toBeGreaterThan(4000);
  // …and every designator that lives on a part BODY survives, so the board is
  // still navigable. On this board that is 2340 of 4686 parts.
  expect(only.kinds.part).toBe(on.kinds.part - on.singlePinLabels);
  expect(only.kinds.part).toBeGreaterThan(2000);

  // Sanity: the mode is actually doing something, and ON is the cluttered state.
  expect(on.singlePinLabels).toBeGreaterThan(2000);
  expect(on.kinds.circleNum ?? 0).toBeGreaterThan(5000);
});
