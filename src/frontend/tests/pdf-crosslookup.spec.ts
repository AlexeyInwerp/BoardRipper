import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Each test loads two PDFs from scratch (page.goto + setInputFiles + text extraction).
// Allow 60 s per test so slow CI machines have room to breathe.
test.setTimeout(60000);

// Build a tiny text (vector) PDF. Each inner array is one page's tokens, each
// drawn on its own line so pdf.js getTextContent extracts them as words.
async function makePdf(pages: string[][]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const tokens of pages) {
    const p = pdf.addPage([300, 400]);
    tokens.forEach((t, i) => p.drawText(t, { x: 40, y: 360 - i * 30, size: 18, font }));
  }
  return Buffer.from(await pdf.save());
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function loadTwoPdfs(page: any) {
  // A: U5300 on page 1.  B: U5300 on pages 2 AND 3 (for cycling), C100 on page 1.
  const a = await makePdf([['U5300'], ['Z1'], ['Z2']]);
  const b = await makePdf([['C100'], ['U5300'], ['U5300']]);
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.getByTestId('file-input').setInputFiles([
    { name: 'linkA.pdf', mimeType: 'application/pdf', buffer: a },
    { name: 'linkB.pdf', mimeType: 'application/pdf', buffer: b },
  ]);
  // Phase 1 — wait until both docs are loaded AND background text extraction
  // has populated textPages (read-only check; mutations run in page.evaluate
  // below to avoid triggering React's synchronous flush inside waitForFunction,
  // which causes RAF-based polling to stall indefinitely in headless Chromium).
  await page.waitForFunction(() => {
    const s = (window as any).__pdfStore;
    if (!s || !s.isDocLoaded('linkA.pdf') || !s.isDocLoaded('linkB.pdf')) return false;
    return s.getDocTextExtractProgress('linkB.pdf') >= 1 &&
           s.getDocTextExtractProgress('linkA.pdf') >= 1;
  }, { timeout: 40000 });
  // Phase 2 — link + probe (may call notify() safely from page.evaluate context).
  await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    s.linkDocs('linkA.pdf', 'linkB.pdf');
    s.crossProbe('linkA.pdf', 'U5300');
  });
  // Phase 3 — confirm the probe found ≥ 2 matches (assertion, not a timeout workaround).
  const matchCount = await page.evaluate(() =>
    (window as any).__pdfStore.getDocMatches('linkB.pdf').length
  );
  expect(matchCount, 'U5300 should appear on both pages of linkB.pdf').toBeGreaterThanOrEqual(2);
}

test('cross-probe navigates the linked doc and cycles matches', async ({ page }) => {
  await loadTwoPdfs(page);

  const afterFirst = await page.evaluate(() => (window as any).__pdfStore.getDocCurrentPage('linkB.pdf'));
  expect(afterFirst).toBe(2);

  const afterCycle = await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    s.crossProbe('linkA.pdf', 'U5300'); // same word → next occurrence
    return s.getDocCurrentPage('linkB.pdf');
  });
  expect(afterCycle).toBe(3);

  const afterWrap = await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    s.crossProbe('linkA.pdf', 'U5300'); // wraps back to first
    return s.getDocCurrentPage('linkB.pdf');
  });
  expect(afterWrap).toBe(2);
});

test('cross-probe is bidirectional and does not change the active doc', async ({ page }) => {
  await loadTwoPdfs(page);
  const result = await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    const activeBefore = s.fileName;
    s.crossProbe('linkB.pdf', 'Z2'); // B→A: Z2 lives on A page 3
    return { aPage: s.getDocCurrentPage('linkA.pdf'), activeBefore, activeAfter: s.fileName };
  });
  expect(result.aPage).toBe(3);
  expect(result.activeAfter).toBe(result.activeBefore); // crossProbe never calls switchTo
});

test('no-match probe sets a hint on the source and leaves target untouched', async ({ page }) => {
  await loadTwoPdfs(page);
  await page.locator('.dv-tab', { hasText: 'linkA.pdf' }).click(); // make A's panel visible
  const r = await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    const beforePage = s.getDocCurrentPage('linkB.pdf');
    s.crossProbe('linkA.pdf', 'NOSUCHTOKEN');
    return { hint: s.getDocCrossProbeHint('linkA.pdf'), beforePage, afterPage: s.getDocCurrentPage('linkB.pdf') };
  });
  expect(r.hint).toContain('NOSUCHTOKEN');
  expect(r.afterPage).toBe(r.beforePage);
  // Feedback surfaces as a toast (inline rendering broke the toolbar layout).
  await expect(
    page.locator('.toast').filter({ hasText: 'No match for NOSUCHTOKEN in linkB.pdf' }),
  ).toBeVisible();
});

test('unlink stops cross-probe', async ({ page }) => {
  await loadTwoPdfs(page);
  const stillLinked = await page.evaluate(() => {
    const s = (window as any).__pdfStore;
    s.unlinkDoc('linkA.pdf');
    return { a: s.getLinkedDoc('linkA.pdf'), b: s.getLinkedDoc('linkB.pdf') };
  });
  expect(stillLinked.a).toBeNull();
  expect(stillLinked.b).toBeNull();
});

test('bind menu Cross-link PDF section links and unlinks PDFs', async ({ page }) => {
  await loadTwoPdfs(page);
  // loadTwoPdfs already linked the docs programmatically; start clean.
  await page.evaluate(() => (window as any).__pdfStore.unlinkDoc('linkA.pdf'));

  // Select linkA.pdf's panel.
  await page.locator('.dv-tab', { hasText: 'linkA.pdf' }).click();

  // Open the main bind (∞/○○) menu and pick linkB.pdf from the "Cross-link PDF" section.
  await page.locator('.bind-link-btn').first().click();
  await page.getByTestId('bind-link-pdf-option').filter({ hasText: 'linkB.pdf' }).click();
  await expect.poll(() =>
    page.evaluate(() => (window as any).__pdfStore.getLinkedDoc('linkA.pdf')),
  ).toBe('linkB.pdf');

  // The dropdown stays open after selecting — unlink via the section's "(none)".
  await page.getByTestId('bind-link-pdf-clear').first().click();
  await expect.poll(() =>
    page.evaluate(() => (window as any).__pdfStore.getLinkedDoc('linkA.pdf')),
  ).toBeNull();
});
