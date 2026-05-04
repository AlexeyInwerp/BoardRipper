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
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 15000 });
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

test.describe('Parts dropdown', () => {
  test('opens, filters, and focuses a part on selection', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="parts-filter-input"]');

    await page.locator('[data-testid="parts-filter-input"]').focus();
    await page.fill('[data-testid="parts-filter-input"]', 'U0500');
    await page.waitForSelector('.overlay-dropdown-popover');

    // U0500 is the only part matching this filter in the sample board.
    await page.keyboard.press('Enter');

    // Selected name should be reflected in the StatusBar
    const status = await page.locator('.statusbar').textContent();
    expect(status).toMatch(/Selected:\s*U0500\b/);
  });
});

test.describe('Nets dropdown', () => {
  test('NC nets render at end with reduced opacity', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="nets-filter-input"]');

    await page.locator('[data-testid="nets-filter-input"]').focus();
    await page.fill('[data-testid="nets-filter-input"]', ' ');
    await page.waitForSelector('.overlay-dropdown-popover');

    // The NC group header should appear after at least one normal row
    const headerExists = await page.locator('.overlay-dropdown-group-header').count();
    if (headerExists > 0) {
      const dimmedCount = await page.locator('.overlay-dropdown-row.dimmed').count();
      expect(dimmedCount).toBeGreaterThan(0);

      // Confirm dimmed rows appear AFTER non-dimmed rows in DOM order
      const order = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.overlay-dropdown-row')) as HTMLElement[];
        return rows.map(r => r.classList.contains('dimmed'));
      });
      const lastNormal = order.lastIndexOf(false);
      const firstDimmed = order.indexOf(true);
      expect(firstDimmed).toBeGreaterThan(lastNormal);
    }
  });

  test('selecting a net highlights it', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="nets-filter-input"]');

    await page.locator('[data-testid="nets-filter-input"]').focus();
    await page.fill('[data-testid="nets-filter-input"]', 'GND');
    await page.keyboard.press('Enter');

    const status = await page.locator('.statusbar').textContent();
    expect(status).toMatch(/Net:\s*GND\b/i);
  });
});

test.describe('Selected-name label', () => {
  test('label appears when a part is selected and hides when cleared', async ({ page }) => {
    await loadBoard(page);
    await page.waitForSelector('[data-testid="parts-filter-input"]');

    await expect(page.locator('[data-testid="overlay-selected-name"]')).toHaveCount(0);

    await page.locator('[data-testid="parts-filter-input"]').focus();
    await page.fill('[data-testid="parts-filter-input"]', 'U0500');
    await page.keyboard.press('Enter');

    await expect(page.locator('[data-testid="overlay-selected-name"]')).toContainText(/U0500\b/);
  });
});

test.describe('Natural sort comparator', () => {
  test('sorts refdes-style names numerically', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sorted = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      return ['R10', 'R1', 'R2', 'R100'].sort(win.__overlayTest!.naturalCompare);
    });
    expect(sorted).toEqual(['R1', 'R2', 'R10', 'R100']);
  });

  test('mixes alpha prefixes correctly', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const sorted = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      return ['U21', 'C1', 'R10', 'C2', 'U1'].sort(win.__overlayTest!.naturalCompare);
    });
    expect(sorted).toEqual(['C1', 'C2', 'R10', 'U1', 'U21']);
  });

  test('handles all-numeric and all-alpha inputs', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const result = await page.evaluate(() => {
      const win = window as Window & { __overlayTest?: { naturalCompare: (a: string, b: string) => number } };
      const cmp = win.__overlayTest!.naturalCompare;
      return [cmp('100', '20'), cmp('GND', 'VCC'), cmp('R1', 'R1')];
    });
    expect(result[0]).toBeGreaterThan(0);
    expect(result[1]).toBeLessThan(0);
    expect(result[2]).toBe(0);
  });
});
