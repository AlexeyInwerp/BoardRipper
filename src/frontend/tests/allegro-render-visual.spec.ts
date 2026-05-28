import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/allegroBRD');

// Skip (not fail) when the gitignored samples/ tree is absent — same idiom as
// ci-smoke.spec.ts / tvw-parser.spec.ts.
const Y0D = path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd');
const Z8IA = path.resolve(SAMPLES_DIR, 'Acer_TravelMate_TMP214_41_Quanta_Z8IA_DAZ8IAMBAC0_Rev_C_BoardView.brd');
const Z8I = path.resolve(SAMPLES_DIR, 'Quanta Z8I DA0Z8IMBAC0 Rev C (BDV) (.BRD).brd');
const haveY0D = fs.existsSync(Y0D);
const haveZ8IA = fs.existsSync(Z8IA);
const haveZ8I = fs.existsSync(Z8I);

test.describe('Allegro BRD Visual Rendering', () => {
  test('Y0D (v16.5): renders with components and canvas', async ({ page }) => {
    test.skip(!haveY0D, 'samples/allegroBRD Quanta Y0D not present');
    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(path.resolve(SAMPLES_DIR, 'Quanta Y0D DA0Y0DMBAF0 boardview .brd'));

    await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
    const statusText = await page.getByTestId('statusbar').textContent();
    const compMatch = statusText!.match(/Components:\s*(\d+)/);
    expect(compMatch).toBeTruthy();
    const compCount = parseInt(compMatch![1]);
    expect(compCount).toBeGreaterThan(1000);
    console.log(`Y0D: ${compCount} components`);

    // Canvas should exist and have dimensions
    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);

    // Take screenshot for visual inspection
    await page.screenshot({ path: 'test-results/allegro-y0d-render.png' });
  });

  test('Z8IA (v17.2): renders with components and canvas', async ({ page }) => {
    test.skip(!haveZ8IA, 'samples/allegroBRD Acer Z8IA not present');
    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(path.resolve(SAMPLES_DIR, 'Acer_TravelMate_TMP214_41_Quanta_Z8IA_DAZ8IAMBAC0_Rev_C_BoardView.brd'));

    await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
    const statusText = await page.getByTestId('statusbar').textContent();
    const compMatch = statusText!.match(/Components:\s*(\d+)/);
    expect(compMatch).toBeTruthy();
    const compCount = parseInt(compMatch![1]);
    expect(compCount).toBeGreaterThan(1000);
    console.log(`Z8IA: ${compCount} components`);

    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    await page.screenshot({ path: 'test-results/allegro-z8ia-render.png' });
  });

  test('Z8I (v17.2 large): renders with components and canvas', async ({ page }) => {
    test.skip(!haveZ8I, 'samples/allegroBRD Quanta Z8I not present');
    await page.goto('/');
    const fileInput = page.getByTestId('file-input');
    await fileInput.setInputFiles(path.resolve(SAMPLES_DIR, 'Quanta Z8I DA0Z8IMBAC0 Rev C (BDV) (.BRD).brd'));

    await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
    const statusText = await page.getByTestId('statusbar').textContent();
    const compMatch = statusText!.match(/Components:\s*(\d+)/);
    expect(compMatch).toBeTruthy();
    const compCount = parseInt(compMatch![1]);
    expect(compCount).toBeGreaterThan(1000);
    console.log(`Z8I: ${compCount} components`);

    const canvas = page.getByTestId('board-canvas').locator('canvas');
    await expect(canvas).toBeVisible();
    await page.screenshot({ path: 'test-results/allegro-z8i-render.png' });
  });
});
