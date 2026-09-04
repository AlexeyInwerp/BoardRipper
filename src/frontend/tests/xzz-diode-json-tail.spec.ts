import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// XZZ JSON annotation tail — the second encoding of the post-`v6v6555v6v6`
// section (see `parseXzzTailAnnotations`). Verified against the two deliveries
// of one board, because the pair is the whole point: they are the same PCB,
// both carry a tail, and only one of them has diode data. A parser that
// reports "no readings" for both (what shipped before) and one that reports
// them for both are equally wrong.
const DIR = path.resolve(__dirname, '../../../samples/XZZ PCB SAMPLES/iPhone16_16Plus');
const WITH_DIODES = path.join(DIR, 'iPhone16_16Plus AP+BB Boardview.pcb');
const NO_DIODES   = path.join(DIR, 'iPhone16_16Plus AP+BB YiDianTong.pcb');
const haveSamples = fs.existsSync(WITH_DIODES) && fs.existsSync(NO_DIODES);

test.use({
  viewport: { width: 1280, height: 720 },
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

interface Probe {
  diodeReference: { matched: number; unmatched: number; counts: { value: number; open: number } } | undefined;
  pinsWithDiode: number;
  sample: string | null;
}

async function openAndProbe(page: import('@playwright/test').Page, file: string): Promise<Probe> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(file);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  return page.evaluate(() => {
    const store = (window as unknown as {
      __boardStore?: { activeTab?: { board?: {
        diodeReference?: Probe['diodeReference'];
        parts: { name: string; pins: { number: string; diode?: { raw: string } }[] }[];
      } } };
    }).__boardStore;
    const board = store?.activeTab?.board;
    let pinsWithDiode = 0;
    let sample: string | null = null;
    for (const p of board?.parts ?? []) {
      for (const pin of p.pins) {
        if (!pin.diode) continue;
        pinsWithDiode++;
        sample ??= `${p.name}(${pin.number})=${pin.diode.raw}`;
      }
    }
    return { diodeReference: board?.diodeReference, pinsWithDiode, sample };
  }) as Promise<Probe>;
}

test('Boardview delivery: JSON tail readings reach the pins', async ({ page }) => {
  test.skip(!haveSamples, 'samples/XZZ PCB SAMPLES/iPhone16_16Plus not present');
  const r = await openAndProbe(page, WITH_DIODES);
  expect(r.diodeReference?.matched).toBeGreaterThan(4000);
  expect(r.diodeReference?.counts.value).toBeGreaterThan(3000);
  expect(r.diodeReference?.counts.open).toBeGreaterThan(1000);   // OL is a reading, not a gap
  expect(r.pinsWithDiode).toBeGreaterThan(4000);
  expect(r.sample).toBeTruthy();
});

test('YiDianTong delivery: a rename-only JSON tail yields no readings', async ({ page }) => {
  test.skip(!haveSamples, 'samples/XZZ PCB SAMPLES/iPhone16_16Plus not present');
  const r = await openAndProbe(page, NO_DIODES);
  expect(r.diodeReference).toBeUndefined();
  expect(r.pinsWithDiode).toBe(0);
});

test('YiDianTong delivery: parts are renamed to their designators', async ({ page }) => {
  test.skip(!haveSamples, 'samples/XZZ PCB SAMPLES/iPhone16_16Plus not present');
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(NO_DIODES);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
  const names = await page.evaluate(() => {
    const store = (window as unknown as {
      __boardStore?: { activeTab?: { board?: { parts: { name: string }[] } } };
    }).__boardStore;
    return (store?.activeTab?.board?.parts ?? []).map(p => p.name);
  });
  // The binary names these by internal id; the tail's alias table is what
  // XZZ's own viewer displays. Both designators come from the shipped file.
  expect(names).toContain('C11814');
  expect(names).toContain('R11818');
  // …and the internal ids they replaced are gone.
  expect(names).not.toContain('C356_1');
  expect(names).not.toContain('R102_1');
});
