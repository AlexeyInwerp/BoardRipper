/**
 * PDF night mode (issue #41): one ◐ button, three styles in its click menu.
 *  - Invert colours: `invert(1)` — red turns cyan.
 *  - Dark paper, keep colours: paper black, red/blue stay red/blue, lighter.
 *  - Custom colours: paper becomes exactly the chosen background, black ink
 *    exactly the chosen text colour.
 * Below them, two controls for coloured lines in every style: Colour (0 % =
 * grey, i.e. a shade of the text colour) and Contrast with Auto, which pulls
 * pale lines toward the text colour until they read against the background.
 * The button opens the menu on click, like the wand. Choices persist and apply
 * to every PDF.
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
async function swatches(page: Page): Promise<{ paper: number[]; red: number[]; ink: number[]; pale: number[] }> {
  await page.locator('.pdf-canvas-container').evaluate(el => {
    const d = document.createElement('div');
    d.id = 'night-swatch';
    d.style.cssText = 'position:absolute;left:0;top:0;z-index:99;display:flex';
    for (const c of ['#ffffff', '#cc0000', '#000000', '#a8e0a8']) {
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
    const y = Math.floor(img.height / 2), w = img.width / 4;
    return [0, 1, 2, 3].map(i => Array.from(ctx.getImageData(Math.floor(w * i + w / 2), y, 1, 1).data.slice(0, 3)));
  }, png.toString('base64'));
  await page.locator('#night-swatch').evaluate(el => el.remove());
  return { paper: px[0], red: px[1], ink: px[2], pale: px[3] };
}

const near = (a: number[], b: number[], tol = 3) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

/** WCAG contrast of two sRGB 0…255 colours. */
function contrast(a: number[], b: number[]): number {
  const lum = (c: number[]) => {
    const l = c.map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const styleOf = (page: Page) => page.getByTestId('pdf-night-btn').getAttribute('data-night-style');

test('the button opens the menu on click; Off and the styles live in it; the choice persists', async ({ page }) => {
  await openFixture(page);
  expect(await filterOf(page)).toBe('');

  // A click opens the menu and changes nothing by itself (like the wand).
  await page.getByTestId('pdf-night-btn').click();
  await expect(page.getByTestId('pdf-night-menu')).toBeVisible();
  expect(await filterOf(page)).toBe('');

  await page.getByTestId('pdf-night-dark').click();
  await expect(page.getByTestId('pdf-night-menu')).toBeVisible();  // stays open for the sliders
  expect(await styleOf(page)).toBe('dark');
  expect(await filterOf(page)).not.toBe('');
  await expect(page.getByTestId('pdf-night-btn')).toHaveClass(/active/);

  // A second click on the button closes the menu.
  await page.getByTestId('pdf-night-btn').click();
  await expect(page.getByTestId('pdf-night-menu')).toHaveCount(0);

  // Off is in the menu and closes it.
  await page.getByTestId('pdf-night-btn').click();
  await page.getByTestId('pdf-night-off').click();
  await expect(page.getByTestId('pdf-night-menu')).toHaveCount(0);
  expect(await filterOf(page)).toBe('');
  await expect(page.getByTestId('pdf-night-btn')).not.toHaveClass(/active/);

  const stored = await page.evaluate(() => ({
    on: localStorage.getItem('boardripper-pdf-nightmode'),
    style: localStorage.getItem('boardripper-pdf-nightstyle'),
  }));
  expect(stored).toEqual({ on: '0', style: 'dark' });
});

const pick = async (page: Page, id: string) => {
  if (!(await page.getByTestId('pdf-night-menu').count())) await page.getByTestId('pdf-night-btn').click();
  await page.getByTestId(id).click();
};

test('each style puts the right colours on screen', async ({ page }) => {
  await openFixture(page);

  // Plain styles with the contrast curve off: the classic results, CSS only.
  await pick(page, 'pdf-night-contrast-auto');   // Auto off …
  await page.getByTestId('pdf-night-contrast').fill('0');   // … and no curve
  await pick(page, 'pdf-night-invert');
  expect(await filterOf(page)).toBe('invert(1)');
  let s = await swatches(page);
  expect(near(s.paper, [0, 0, 0])).toBe(true);
  expect(s.red[1]).toBeGreaterThan(s.red[0] + 60);                 // red → cyan

  await pick(page, 'pdf-night-dark');
  expect(await filterOf(page)).toBe('hue-rotate(180deg) invert(1)');
  s = await swatches(page);
  expect(near(s.paper, [0, 0, 0])).toBe(true);
  expect(near(s.ink, [255, 255, 255])).toBe(true);
  expect(s.red[0]).toBeGreaterThan(s.red[1] + 60);                 // still red…
  expect(s.red[0] + s.red[1] + s.red[2]).toBeGreaterThan(0xcc);    // …and lighter

  // Custom: exact colours, both on a dark and on a light paper.
  await pick(page, 'pdf-night-custom');
  await page.getByTestId('pdf-night-bg').fill('#203040');
  await page.getByTestId('pdf-night-fg').fill('#e0d0c0');
  expect(await filterOf(page)).toMatch(/^hue-rotate\(180deg\) url\("?#pdf-night-/);
  s = await swatches(page);
  expect(near(s.paper, [0x20, 0x30, 0x40])).toBe(true);
  expect(near(s.ink, [0xe0, 0xd0, 0xc0])).toBe(true);
  expect(s.red[0]).toBeGreaterThan(s.red[2] + 30);                 // red stays reddish
  const paleBefore = contrast(s.pale, s.paper);

  // Auto contrast: the pale green line now reads against the paper; paper and
  // ink stay exactly where they were.
  await pick(page, 'pdf-night-contrast-auto');
  s = await swatches(page);
  expect(near(s.paper, [0x20, 0x30, 0x40])).toBe(true);
  expect(near(s.ink, [0xe0, 0xd0, 0xc0])).toBe(true);
  expect(contrast(s.pale, s.paper)).toBeGreaterThan(paleBefore + 1);
  expect(contrast(s.pale, s.paper)).toBeGreaterThan(3);              // WCAG large-text level; it was 1.7
  expect(s.red[0]).toBeGreaterThan(s.red[2] + 20);                 // and red is still red

  // Colour 0: coloured lines become a shade of the text colour.
  await page.getByTestId('pdf-night-colour').fill('0');
  s = await swatches(page);
  const fg = [0xe0, 0xd0, 0xc0], bg = [0x20, 0x30, 0x40];
  const t = (s.red[0] - bg[0]) / (fg[0] - bg[0]);
  expect(near(s.red, bg.map((b, i) => b + (fg[i] - b) * t), 6)).toBe(true);
  await page.getByTestId('pdf-night-colour').fill('100');

  await page.getByTestId('pdf-night-bg').fill('#f4ecd8');           // sepia paper
  await page.getByTestId('pdf-night-fg').fill('#3a2e20');
  expect(await filterOf(page)).toMatch(/^url\("?#pdf-night-/);
  s = await swatches(page);
  expect(near(s.paper, [0xf4, 0xec, 0xd8])).toBe(true);
  expect(near(s.ink, [0x3a, 0x2e, 0x20])).toBe(true);

  // Reset restores the defaults, Auto included.
  await page.getByTestId('pdf-night-reset').click();
  await expect(page.getByTestId('pdf-night-contrast-auto')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('pdf-night-colour')).toHaveValue('100');
});
