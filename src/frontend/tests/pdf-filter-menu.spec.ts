/**
 * PDF filter menu — the toolbar's single filtering control.
 *
 *  1. Live settings (watermark text, terms) never ask for a reload.
 *  2. A parse-time setting (Skip invisible content) marks the open PDF stale:
 *     the reload row lights up and the button carries a dot.
 *  3. Reload & re-parse reopens the PDF, clears both, and the page draws again.
 *  4. Settings are global and persisted with the render settings.
 *
 * Public fixture (tests/fixtures/two-page-text.pdf), so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/two-page-text.pdf');

async function openFixture(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(800);   // app wiring settles before the input is live
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await page.waitForTimeout(500);
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible({ timeout: 15000 });
}

/** Dark pixels on the main page canvas — the page actually drew. */
async function inkOnPage(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('.pdf-page-wrapper canvas') as HTMLCanvasElement | null;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !c.width) return 0;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 128 && d[i + 3] > 0) n++;
    return n;
  });
}

function storedSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('boardripper-render-settings') ?? '{}'));
}

test('filter menu: live terms, parse-time options and reload', async ({ page }) => {
  test.setTimeout(60000);
  await openFixture(page);
  await expect.poll(() => inkOnPage(page), { timeout: 15000 }).toBeGreaterThan(0);

  const btn = page.getByTestId('pdf-filter-btn');
  await btn.click();
  const menu = page.getByTestId('pdf-filter-menu');
  await expect(menu).toBeVisible();

  const reload = page.getByTestId('pdf-filter-reload');
  await expect(reload).toBeDisabled();
  await expect(page.getByTestId('pdf-filter-dot')).toHaveCount(0);

  // Live: add and remove a term, toggle the text filter — no reload needed.
  const input = page.getByTestId('pdf-filter-term-input');
  await input.fill('ZZ-test-mark');
  await input.press('Enter');
  await expect(page.getByTestId('pdf-filter-term').filter({ hasText: 'ZZ-test-mark' })).toHaveCount(1);
  expect((await storedSettings(page)).pdfWatermarkFilter).toContain('ZZ-test-mark');
  await page.getByRole('button', { name: 'Remove ZZ-test-mark' }).click();
  await expect(page.getByTestId('pdf-filter-term').filter({ hasText: 'ZZ-test-mark' })).toHaveCount(0);

  const wmText = page.getByTestId('pdf-filter-wm-text');
  const wasOn = await wmText.getAttribute('aria-checked');
  await wmText.click();
  await expect(wmText).not.toHaveAttribute('aria-checked', wasOn!);
  await wmText.click();
  await expect(reload).toBeDisabled();

  // Parse-time: the open PDF is now stale.
  const prune = page.getByTestId('pdf-filter-prune');
  await expect(prune).toHaveAttribute('aria-checked', 'true');
  await prune.click();
  await expect(prune).toHaveAttribute('aria-checked', 'false');
  expect((await storedSettings(page)).pdfPruneInvisible).toBe(false);
  await expect(reload).toBeEnabled();
  await expect(page.getByTestId('pdf-filter-dot')).toHaveCount(1);

  // Turning it back clears the stale state without a reload.
  await prune.click();
  await expect(reload).toBeDisabled();
  await prune.click();
  await expect(reload).toBeEnabled();

  await reload.click();
  await expect(reload).toBeDisabled({ timeout: 15000 });
  await expect(page.getByTestId('pdf-filter-dot')).toHaveCount(0);
  await expect.poll(() => inkOnPage(page), { timeout: 15000 }).toBeGreaterThan(0);

  // Escape closes; the setting survives a reload of the app.
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.reload();
  expect((await storedSettings(page)).pdfPruneInvisible).toBe(false);
});

test('a typed term survives closing the menu by clicking away; a duplicate says so', async ({ page }) => {
  await openFixture(page);
  await page.getByTestId('pdf-filter-btn').click();
  const input = page.getByTestId('pdf-filter-term-input');
  await input.fill('ZZ-typed-away');
  // Click the page, not the menu: the menu unmounts with the input in it.
  const box = (await page.locator('.pdf-canvas-container').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId('pdf-filter-menu')).toHaveCount(0);
  expect((await storedSettings(page)).pdfWatermarkFilter).toContain('ZZ-typed-away');

  await page.getByTestId('pdf-filter-btn').click();
  await input.fill('ZZ-typed-away');
  await input.press('Enter');
  await expect(page.getByTestId('pdf-filter-dupe')).toContainText('already listed');
  await expect(page.getByTestId('pdf-filter-term').filter({ hasText: 'ZZ-typed-away' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Remove ZZ-typed-away' }).click();
});

test('strip images on open: no reload offered while the strip runs, and the page redraws from the stripped document', async ({ page }) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    try {
      const raw = localStorage.getItem('boardripper-render-settings');
      localStorage.setItem('boardripper-render-settings', JSON.stringify({ ...(raw ? JSON.parse(raw) : {}), pdfStripWatermarkImages: true }));
    } catch { /* ignore */ }
  });
  await openFixture(page);
  const S = () => page.evaluate(() => {
    const s = (window as unknown as { __pdfStore: { staleDocuments(): string[]; getDocParseGen(n: string): number; isDocClean(n: string): boolean; _documents: Map<string, { strippedDoc: unknown }> } }).__pdfStore;
    const name = [...s._documents.keys()][0];
    return { stale: s.staleDocuments(), gen: s.getDocParseGen(name), clean: s.isDocClean(name), stripped: !!s._documents.get(name)?.strippedDoc };
  });
  // The strip is part of the open: never "reload needed" meanwhile.
  await expect.poll(async () => (await S()).stripped, { timeout: 20000 }).toBe(true);
  const after = await S();
  expect(after.stale).toEqual([]);
  expect(after.clean).toBe(true);
  // … and the panel was told to redraw once the stripped document was in.
  expect(after.gen).toBeGreaterThan(0);
  await expect.poll(() => inkOnPage(page), { timeout: 15000 }).toBeGreaterThan(0);
  await page.getByTestId('pdf-filter-btn').click();
  await expect(page.getByTestId('pdf-filter-reload')).toBeDisabled();
});

test('two reloads of one document run once each, in turn', async ({ page }) => {
  test.setTimeout(60000);
  await openFixture(page);
  await page.getByTestId('pdf-filter-btn').click();
  await page.getByTestId('pdf-filter-prune').click();
  const result = await page.evaluate(async () => {
    const s = (window as unknown as { __pdfStore: { reparse(n: string): Promise<void>; getDocParseGen(n: string): number; _documents: Map<string, unknown> } }).__pdfStore;
    const name = [...s._documents.keys()][0];
    const before = s.getDocParseGen(name);
    await Promise.all([s.reparse(name), s.reparse(name)]);
    return s.getDocParseGen(name) - before;
  });
  // The second call finds nothing stale and does not reopen the document again.
  expect(result).toBe(1);
});
