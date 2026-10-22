/**
 * Popups placed from pointer or anchor coordinates sit where they should at
 * every interface scale (2026-10-22).
 *
 * `body { zoom: var(--ui-scale) }` multiplies a fixed element's `left`/`top`
 * by the scale while `clientX` and `getBoundingClientRect()` stay unzoomed —
 * at 125 % the ribbon's suggestion list opened a quarter of the screen to the
 * right of its field, at 80 % to the left and above it. Every such popup now
 * divides by the body zoom (`store/ui-zoom.ts`).
 *
 * Also covers the PDF context menu's magnifier chip, "Find … in this PDF",
 * on the header line next to copy and web search.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = path.resolve(here, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const PDF = path.resolve(here, 'fixtures/two-page-text.pdf');

const rect = (page: Page, sel: string) => page.evaluate(s => {
  const b = document.querySelector(s)?.getBoundingClientRect();
  return b ? { x: b.x, y: b.y, w: b.width, h: b.height, bottom: b.bottom } : null;
}, sel);

for (const scale of ['1.25', '0.8']) {
  test(`ribbon suggestion list hangs under its field at ${scale}×`, async ({ page }) => {
    test.skip(!fs.existsSync(BOARD), 'needs samples/kicad/tomu-fpga.kicad_pcb');
    await page.addInitScript(s => localStorage.setItem('boardripper-ui-scale', s), scale);
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('file-input').setInputFiles(BOARD);
    await expect(page.locator('.dv-tab', { hasText: 'tomu-fpga' })).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(800);
    const input = page.getByTestId('parts-filter-input');
    await input.click();
    await input.type('U');
    const pop = page.locator('.overlay-dropdown-popover');
    await expect(pop).toBeVisible();
    const i = (await rect(page, '[data-testid="parts-filter-input"]'))!;
    const p = (await rect(page, '.overlay-dropdown-popover'))!;
    // Left-aligned with the field unless the viewport's right edge clamps it
    // (the list is at least 200 px wide); in either case it overlaps the
    // field horizontally and sits just under it.
    const vw = await page.evaluate(() => window.innerWidth);
    expect(p.x).toBeLessThanOrEqual(i.x + 1);
    expect(p.x + p.w).toBeGreaterThanOrEqual(i.x + i.w - 1);
    expect(p.x + p.w).toBeLessThanOrEqual(vw);
    expect(p.y - i.bottom).toBeGreaterThan(0);
    expect(p.y - i.bottom).toBeLessThan(12);
  });

  test(`PDF context menu opens at the pointer at ${scale}× and finds the text in this PDF`, async ({ page }) => {
    await page.addInitScript(s => localStorage.setItem('boardripper-ui-scale', s), scale);
    await page.goto('/');
    await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('file-input').setInputFiles(PDF);
    await expect(page.locator('.pdf-canvas-container')).toBeVisible({ timeout: 20000 });
    await page.waitForTimeout(2000);
    // Sweep the top of the page for a point that has text under it.
    const b = (await page.locator('.pdf-canvas-container').boundingBox())!;
    let hit: { x: number; y: number } | null = null;
    outer: for (let fy = 0.03; fy < 0.5; fy += 0.012) {
      for (let fx = 0.08; fx < 0.8; fx += 0.03) {
        const x = b.x + b.width * fx, y = b.y + b.height * fy;
        await page.mouse.click(x, y, { button: 'right' });
        const item = page.getByTestId('qa-find-pdf');
        if (await item.count()) { hit = { x, y }; break outer; }
        await page.keyboard.press('Escape');
      }
    }
    expect(hit).not.toBeNull();
    const m = (await rect(page, '.context-menu'))!;
    expect(Math.abs(m.x - hit!.x)).toBeLessThan(12);
    expect(Math.abs(m.y - hit!.y)).toBeLessThan(12);
    const item = page.getByTestId('qa-find-pdf');
    const word = (await page.getByTestId('qa-copy-text').textContent())?.trim();
    expect(word).toBeTruthy();
    await item.click();
    const field = page.locator('.pdf-search-input');
    await expect(field).toHaveValue(word!);
    await expect(field).toBeFocused();
  });
}
