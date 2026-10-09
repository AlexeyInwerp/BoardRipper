/**
 * Opening a PDF says so from the start (PDF performance review 2026-10-03,
 * section 4). Before, nothing on screen changed between the file pick and the
 * first painted page: the panel was created only after the load, and the one
 * loading flag had no reader. Now the panel exists from the pick and shows
 * the file and its phase; a small overlay stays until the first page is
 * drawn; a file that cannot be opened says so instead of "Loading…" for ever.
 *
 * Timing is read with a MutationObserver installed before the pick, so a
 * state that lasts one frame is still seen.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PDF = path.resolve(HERE, 'fixtures/many-page-text.pdf');

async function watch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __events: { t: number; what: string }[] };
    w.__events = [];
    const seen = new Set<string>();
    const note = (what: string) => { if (!seen.has(what)) { seen.add(what); w.__events.push({ t: performance.now(), what }); } };
    const check = () => {
      if (document.querySelector('[data-testid="pdf-load-state"]')) note('load-state');
      if (document.querySelector('[data-testid="pdf-load-overlay"]')) note('overlay');
      if (document.querySelector('[data-testid="background-load-banner"]')) note('banner');
      const c = document.querySelector('.pdf-page-wrapper canvas:has(+ .pdf-highlight-canvas)') as HTMLCanvasElement | null;
      if (c && c.width > 1) note('painted');
      if (seen.has('painted') && !document.querySelector('[data-testid="pdf-load-overlay"]')) note('overlay-gone');
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true });
    const tick = () => { check(); if (!seen.has('overlay-gone')) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

test('a PDF open shows its state before the first page, and clears it after', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await watch(page);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.getByTestId('file-input').setInputFiles(PDF);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as { __events: { what: string }[] }).__events.some(e => e.what === 'overlay-gone')),
    { timeout: 30000 }).toBe(true);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const ev = await page.evaluate(() => (window as unknown as { __events: { t: number; what: string }[] }).__events);
  const at = (w: string) => ev.find(e => e.what === w)?.t ?? Infinity;
  // Some indicator is up before the page is painted…
  expect(Math.min(at('load-state'), at('overlay'), at('banner'))).toBeLessThan(at('painted'));
  // …and the panel's own placeholder is what shows while the file is parsed.
  expect(at('load-state')).toBeLessThan(at('painted'));
  // Nothing is left behind once the page is there.
  await expect(page.getByTestId('pdf-load-overlay')).toHaveCount(0);
  await expect(page.getByTestId('pdf-load-state')).toHaveCount(0);
  await expect(page.getByTestId('background-load-banner')).toHaveCount(0);
});

test('a file that is not a PDF says it could not be opened', async ({ page }) => {
  const bad = path.join(os.tmpdir(), `br-not-a-pdf-${process.pid}.pdf`);
  fs.writeFileSync(bad, 'this is not a PDF at all');
  await page.goto('/');
  await expect(page.getByTestId('toolbar')).toBeVisible({ timeout: 20000 });
  await page.getByTestId('file-input').setInputFiles(bad);
  const state = page.getByTestId('pdf-load-state');
  await expect(state).toHaveAttribute('data-phase', 'failed', { timeout: 15000 });
  await expect(state).toContainText('Could not open');
  await expect(page.getByTestId('background-load-banner')).toHaveCount(0);
  fs.unlinkSync(bad);
});
