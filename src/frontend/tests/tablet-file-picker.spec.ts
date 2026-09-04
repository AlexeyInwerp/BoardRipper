import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The file picker is the ONLY way into the app on a tablet — there is no
// drag-and-drop on iPadOS or Android. It broke on iPad in a way that is
// invisible on desktop: Safari resolves every `accept` extension token to a
// UTI, `.pdf` maps to com.adobe.pdf, and every board extension we support is
// unregistered on iOS and resolves to a dynamic UTI matching nothing. The
// Files picker greyed out every board file and offered PDFs only. These guard
// the fix and the surrounding open path.
const BOARD = path.resolve(__dirname, '../../../samples/kicad/tomu-fpga.kicad_pcb');
const haveBoard = fs.existsSync(BOARD);

/** A real one-page PDF, built here so the test needs no binary fixture. */
async function makePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 200]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('SCHEMATIC PAGE', { x: 20, y: 100, size: 14, font });
  return Buffer.from(await doc.save());
}

test.describe('tablet file picker', () => {
  test('browser build sends no accept filter to the picker', async ({ page }) => {
    await page.goto('/');
    const input = page.getByTestId('file-input');
    await input.waitFor({ state: 'attached' });   // it is display:none by design

    // The regression, stated exactly: an `accept` naming .pdf and a pile of
    // extensions iOS cannot resolve is what left the picker PDF-only. No
    // accept at all means the Files app offers everything, and `detectFormat`
    // sniffs header bytes anyway.
    const accept = await input.getAttribute('accept');
    expect(accept, `accept must be absent in browser builds; got ${accept}`).toBeNull();

    // Multi-select must survive — a tablet user picking a board and its
    // schematic in one trip through the picker depends on it.
    await expect(input).toHaveAttribute('multiple', '');
  });

  test('iPad viewport: the Upload control is visible and hit-testable', async ({ browser }) => {
    // iPad Pro 11" portrait, WITH touch + coarse pointer — a viewport size
    // alone leaves `(pointer: coarse)` unmatched, so the touch-target rules
    // would not apply and the test would measure the desktop layout.
    const ctx = await browser.newContext({
      viewport: { width: 834, height: 1194 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await ctx.newPage();
    await page.goto('/');
    const openBtn = page.getByTestId('open-btn');
    await expect(openBtn).toBeVisible();

    const box = await openBtn.boundingBox();
    expect(box).not.toBeNull();
    // Inside the viewport, not clipped off the right edge by toolbar overflow.
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(834);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    // Apple's own minimum comfortable touch target is 44pt; the button sits in
    // a dense toolbar, so hold it to a laxer 24px and just refuse a hairline.
    // Apple's HIG minimum comfortable target is 44pt. Desktop metrics give
    // 22px here, so this both enforces the guideline and proves the
    // coarse-pointer rules actually matched.
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // And the element at that point is the button itself — nothing overlays it.
    const onTop = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return !!el?.closest('[data-testid="open-btn"]');
    }, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 });
    expect(onTop).toBe(true);
    await ctx.close();
  });

  test('one selection carrying a board and a PDF opens both', async ({ page }) => {
    test.skip(!haveBoard, 'samples/kicad not present');
    await page.setViewportSize({ width: 834, height: 1194 });
    await page.goto('/');
    // setInputFiles refuses to mix paths with buffers, so read the board too.
    await page.getByTestId('file-input').setInputFiles([
      { name: path.basename(BOARD), mimeType: 'application/octet-stream', buffer: fs.readFileSync(BOARD) },
      { name: 'schematic.pdf', mimeType: 'application/pdf', buffer: await makePdf() },
    ]);
    // Board loaded…
    await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 120000 });
    // …and the PDF landed too, rather than the mixed selection dropping one.
    await expect(page.locator('text=schematic.pdf').first()).toBeVisible({ timeout: 30000 });
  });
});
