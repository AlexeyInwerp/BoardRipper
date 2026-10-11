/**
 * PDF night mode (issue #41): one ◐ button, three styles in its hold / right-click menu.
 *  - Invert colours: `invert(1)` — red turns cyan.
 *  - Dark paper, keep colours: paper black, red/blue stay red/blue, lighter.
 *  - Custom colours: paper becomes exactly the chosen background, black ink
 *    exactly the chosen text colour.
 * The button toggles the chosen style; holding it or a right-click opens the
 * menu. Choices persist and apply to every PDF.
 *
 * Public fixture, so it always runs.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/two-page-text.pdf');

async function openFixture(page: Page) {
  await page.goto('/');
  await page.waitForTimeout(800);
  await page.getByTestId('file-input').setInputFiles(FIXTURE);
  await page.waitForTimeout(500);
  const tab = page.locator('.dv-tab', { hasText: /\.pdf$/i }).first();
  if (await tab.count()) await tab.click();
  await expect(page.locator('.pdf-canvas-container')).toBeVisible({ timeout: 15000 });
}

const filterOf = (page: Page) =>
  page.locator('.pdf-canvas-container').evaluate(el => (el as HTMLElement).style.filter);

/** Colour of three swatches (white paper, red line, black ink) seen through the
 *  container's own filter, read back from a real screenshot. */
async function swatches(page: Page): Promise<{ paper: number[]; red: number[]; ink: number[] }> {
  await page.locator('.pdf-canvas-container').evaluate(el => {
    const d = document.createElement('div');
    d.id = 'night-swatch';
    d.style.cssText = 'position:absolute;left:0;top:0;z-index:99;display:flex';
    for (const c of ['#ffffff', '#cc0000', '#000000']) {
      const s = document.createElement('div');
      s.style.cssText = `width:20px;height:20px;background:${c}`;
      d.appendChild(s);
    }
    el.appendChild(d);
  });
  const png = await page.locator('#night-swatch').screenshot();
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const y = Math.floor(img.height / 2), w = img.width / 3;
    return [0, 1, 2].map(i => Array.from(ctx.getImageData(Math.floor(w * i + w / 2), y, 1, 1).data.slice(0, 3)));
  }, png.toString('base64'));
  await page.locator('#night-swatch').evaluate(el => el.remove());
  return { paper: px[0], red: px[1], ink: px[2] };
}

const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

test('night mode: toggle, pick a style, style persists', async ({ page }) => {
  await openFixture(page);
  expect(await filterOf(page)).toBe('');

  await page.getByTestId('pdf-night-btn').click();
  expect(await filterOf(page)).toBe('invert(1)');

  await page.getByTestId('pdf-night-btn').click({ button: 'right' });
  await page.getByTestId('pdf-night-dark').click();
  await expect(page.getByTestId('pdf-night-menu')).toHaveCount(0);
  expect(await filterOf(page)).toBe('invert(1) hue-rotate(180deg)');

  // The button now toggles the dark style off and back on.
  await page.getByTestId('pdf-night-btn').click();
  expect(await filterOf(page)).toBe('');
  await page.getByTestId('pdf-night-btn').click();
  expect(await filterOf(page)).toBe('invert(1) hue-rotate(180deg)');

  // A hold opens the menu without toggling; Off turns it off.
  await page.getByTestId('pdf-night-btn').click({ delay: 650 });
  await expect(page.getByTestId('pdf-night-menu')).toBeVisible();
  expect(await filterOf(page)).toBe('invert(1) hue-rotate(180deg)');
  await page.getByTestId('pdf-night-off').click();
  expect(await filterOf(page)).toBe('');

  const stored = await page.evaluate(() => ({
    on: localStorage.getItem('boardripper-pdf-nightmode'),
    style: localStorage.getItem('boardripper-pdf-nightstyle'),
  }));
  expect(stored).toEqual({ on: '0', style: 'dark' });
});

test('each style puts the right colours on screen', async ({ page }) => {
  await openFixture(page);

  await page.getByTestId('pdf-night-btn').click({ button: 'right' });
  await page.getByTestId('pdf-night-invert').click();
  let s = await swatches(page);
  expect(near(s.paper, [0, 0, 0])).toBe(true);
  expect(s.red[1]).toBeGreaterThan(s.red[0] + 60);                 // red → cyan

  await page.getByTestId('pdf-night-btn').click({ button: 'right' });
  await page.getByTestId('pdf-night-dark').click();
  s = await swatches(page);
  expect(near(s.paper, [0, 0, 0])).toBe(true);
  expect(near(s.ink, [255, 255, 255])).toBe(true);
  expect(s.red[0]).toBeGreaterThan(s.red[1] + 60);                 // still red…
  expect(s.red[0] + s.red[1] + s.red[2]).toBeGreaterThan(0xcc);    // …and lighter

  // Custom: exact colours, both on a dark and on a light paper.
  await page.getByTestId('pdf-night-btn').click({ button: 'right' });
  await page.getByTestId('pdf-night-custom').click();
  await expect(page.getByTestId('pdf-night-menu')).toBeVisible();   // stays open for the wells
  await page.getByTestId('pdf-night-bg').fill('#203040');
  await page.getByTestId('pdf-night-fg').fill('#e0d0c0');
  await page.keyboard.press('Escape');
  expect(await filterOf(page)).toMatch(/^hue-rotate\(180deg\) url\("?#pdf-night-/);
  s = await swatches(page);
  expect(near(s.paper, [0x20, 0x30, 0x40])).toBe(true);
  expect(near(s.ink, [0xe0, 0xd0, 0xc0])).toBe(true);
  expect(s.red[0]).toBeGreaterThan(s.red[2] + 30);                 // red stays reddish

  await page.getByTestId('pdf-night-btn').click({ button: 'right' });
  await page.getByTestId('pdf-night-bg').fill('#f4ecd8');           // sepia paper
  await page.getByTestId('pdf-night-fg').fill('#3a2e20');
  await page.keyboard.press('Escape');
  expect(await filterOf(page)).toMatch(/^url\("?#pdf-night-/);
  s = await swatches(page);
  expect(near(s.paper, [0xf4, 0xec, 0xd8])).toBe(true);
  expect(near(s.ink, [0x3a, 0x2e, 0x20])).toBe(true);
});
