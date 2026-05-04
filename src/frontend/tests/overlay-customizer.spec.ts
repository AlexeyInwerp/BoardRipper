import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REAL_BVR3 = path.resolve(__dirname, '../../../samples/820-02016.bvr');

/** Load a sample board into the active panel and wait for the renderer to settle. */
async function loadBoard(page: Page, filePath: string = REAL_BVR3) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByTestId('file-input').setInputFiles(filePath);
  await expect(page.getByTestId('statusbar')).toContainText('parts', { timeout: 15000 });
}

test.describe('Overlay layout reconciliation', () => {
  test('returns full default layout when nothing is saved', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout(undefined);
    });

    expect(result.map(s => s.id)).toEqual([
      'pdfFollow', 'scrollMode', 'fitBoard', 'sep1',
      'hoverInfo', 'netDim', 'netLines', 'ghosts', 'sep2',
      'partsDropdown', 'netsDropdown',
    ]);
    expect(result.every(s => s.visible)).toBe(true);
  });

  test('drops unknown slot ids and preserves saved order', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout([
        { id: 'fitBoard', visible: false },
        { id: 'unknownLegacySlot', visible: true },
        { id: 'pdfFollow', visible: true },
      ]);
    });

    expect(result.find(s => s.id === 'unknownLegacySlot')).toBeUndefined();
    expect(result.slice(0, 2)).toEqual([
      { id: 'fitBoard', visible: false },
      { id: 'pdfFollow', visible: true },
    ]);
    expect(result.find(s => s.id === 'partsDropdown')?.visible).toBe(true);
  });

  test('appends new default slots that are missing from saved layout', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    const result = await page.evaluate(() => {
      const win = window as Window & {
        __overlayTest?: { reconcileOverlayLayout: (saved: unknown) => Array<{ id: string; visible: boolean }> };
      };
      return win.__overlayTest!.reconcileOverlayLayout([
        { id: 'pdfFollow', visible: true },
        { id: 'fitBoard', visible: true },
      ]);
    });

    const ids = result.map(s => s.id);
    expect(ids[0]).toBe('pdfFollow');
    expect(ids[1]).toBe('fitBoard');
    expect(ids).toContain('partsDropdown');
    expect(ids).toContain('netsDropdown');
    expect(ids).toContain('sep1');
  });
});
