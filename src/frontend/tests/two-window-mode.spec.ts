import { test, expect, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';

// Cover spec sections A (state machine), B (lazy popout), D (lifecycle),
// H (persistence), I (mixed-group safety). Sections C, E, F, G are covered
// by manual smoke + the separate two-window-mode-electron.spec.ts.

test.setTimeout(45_000);

// ─── Helpers ───────────────────────────────────────────────────────────────

async function makePdf(name: string): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([300, 400]);
  p.drawText(name, { x: 40, y: 200, size: 18, font });
  return Buffer.from(await pdf.save());
}

async function openMainPage(page: Page) {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.waitForFunction(
    () => !!(window as unknown as { __dockviewApi?: unknown }).__dockviewApi,
    { timeout: 10_000 },
  );
}

async function uploadPdf(page: Page, name: string): Promise<void> {
  const buf = await makePdf(name);
  await page.getByTestId('file-input').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: buf,
  });
  await page.waitForFunction(
    (panelIdFragment) => {
      const api = (window as unknown as { __dockviewApi?: { panels: { id: string }[] } }).__dockviewApi;
      if (!api) return false;
      return api.panels.some(p => p.id.startsWith('pdf-') && p.id.includes(panelIdFragment));
    },
    name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 8),
    { timeout: 8_000 },
  );
}

interface MinPanel { id: string; api: { location: { type: string } } }
interface MinGroup { panels: MinPanel[]; api: { location: { type: string } } }
interface MinApi { panels: MinPanel[]; groups: MinGroup[] }

async function pdfPanelCount(page: Page, where: 'main' | 'popout'): Promise<number> {
  return await page.evaluate((w) => {
    const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
    if (!api) return 0;
    return api.panels.filter(p => {
      if (!p.id.startsWith('pdf-')) return false;
      const inPopout = p.api.location.type === 'popout';
      return w === 'popout' ? inPopout : !inPopout;
    }).length;
  }, where);
}

async function popoutGroupCount(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
    return api ? api.groups.filter(g => g.api.location.type === 'popout').length : 0;
  });
}

// ─── A. State machine ──────────────────────────────────────────────────────

test.describe('A. Toggle state machine', () => {
  test('A1: OFF→ON with no PDF flips flag and persists', async ({ page }) => {
    await openMainPage(page);
    await page.click('[data-testid="two-window-toggle"]');
    const stored = await page.evaluate(() => localStorage.getItem('boardripper-two-window-mode'));
    expect(stored).toBe('1');
    expect(await popoutGroupCount(page)).toBe(0);
    const active = await page.locator('[data-testid="two-window-toggle"]').evaluate(el => el.classList.contains('active'));
    expect(active).toBe(true);
  });

  test('A2: OFF→ON→OFF flips both ways, no popout', async ({ page }) => {
    await openMainPage(page);
    await page.click('[data-testid="two-window-toggle"]');
    await page.click('[data-testid="two-window-toggle"]');
    expect(await page.evaluate(() => localStorage.getItem('boardripper-two-window-mode'))).toBe('0');
    expect(await popoutGroupCount(page)).toBe(0);
  });

  test('A3: OFF→ON with 1 PDF docked moves it to a popout window', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'a3.pdf');
    expect(await pdfPanelCount(page, 'main')).toBe(1);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(await popoutGroupCount(page)).toBe(1);
    expect(await pdfPanelCount(page, 'main')).toBe(0);
    expect(await pdfPanelCount(page, 'popout')).toBe(1);
  });

  test('A5: ON→OFF re-docks popout PDF back to main window', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'a5.pdf');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');

    const closed = popup.waitForEvent('close');
    await page.click('[data-testid="two-window-toggle"]');
    await closed;
    // setTimeout(0) re-add fires after close — wait for it to settle.
    await page.waitForFunction(() => {
      const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
      if (!api) return false;
      return api.panels.some(p => p.id.startsWith('pdf-') && p.api.location.type !== 'popout');
    }, { timeout: 5_000 });

    expect(await popoutGroupCount(page)).toBe(0);
    expect(await pdfPanelCount(page, 'main')).toBe(1);
    expect(await pdfPanelCount(page, 'popout')).toBe(0);
  });

  test('A4: OFF→ON with 2 PDFs docked — both end up in popout as tabs', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'a4-first.pdf');
    await uploadPdf(page, 'a4-second.pdf');
    expect(await pdfPanelCount(page, 'main')).toBe(2);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    // Wait for the synchronous moveTo loop to settle the second panel.
    await page.waitForFunction(() => {
      const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
      if (!api) return false;
      return api.panels.filter(p => p.id.startsWith('pdf-') && p.api.location.type === 'popout').length === 2;
    }, { timeout: 5_000 });
    expect(await popoutGroupCount(page)).toBe(1);
    expect(await pdfPanelCount(page, 'main')).toBe(0);
    expect(await pdfPanelCount(page, 'popout')).toBe(2);
  });

  test('A6: 3 OFF↔ON round-trips leak no windows', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'a6.pdf');

    for (let i = 0; i < 3; i++) {
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        page.click('[data-testid="two-window-toggle"]'),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      const closed = popup.waitForEvent('close');
      await page.click('[data-testid="two-window-toggle"]');
      await closed;
      await page.waitForFunction(() => {
        const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
        return !!api && api.panels.some(p => p.id.startsWith('pdf-') && p.api.location.type !== 'popout');
      }, { timeout: 5_000 });
    }
    expect(context.pages().length).toBe(1);
    expect(await pdfPanelCount(page, 'main')).toBe(1);
    expect(await pdfPanelCount(page, 'popout')).toBe(0);
  });
});

// ─── B. Lazy popout creation ───────────────────────────────────────────────

test.describe('B. Lazy popout creation', () => {
  test('B8: open another PDF while popout exists — lands as active tab in popout', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'b8-first.pdf');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    // Sanity: popout has the first PDF.
    expect(await pdfPanelCount(page, 'popout')).toBe(1);

    // Open a SECOND PDF while in 2w mode (no popup event expected — uses the
    // existing popout group, no new window).
    await uploadPdf(page, 'b8-second.pdf');
    await page.waitForFunction(() => {
      const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
      if (!api) return false;
      return api.panels.filter(p => p.id.startsWith('pdf-') && p.api.location.type === 'popout').length === 2;
    }, { timeout: 5_000 });
    expect(await pdfPanelCount(page, 'main')).toBe(0);
    expect(await pdfPanelCount(page, 'popout')).toBe(2);

    // The new PDF must be the active tab in the popout (otherwise the user
    // opens a PDF and sees nothing — the bug that triggered this test).
    const active = await page.evaluate(() => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const api = (window as any).__dockviewApi;
      const group = api?.groups.find((g: any) => g.api.location.type === 'popout');
      const activePanel = group?.panels.find((p: any) => p.api.isActive);
      return activePanel?.id ?? null;
    });
    expect(active).toBe('pdf-b8-second_pdf');
  });

  test('B7: toggle ON then open PDF — PDF goes into a popout', async ({ page, context }) => {
    await openMainPage(page);
    await page.click('[data-testid="two-window-toggle"]');
    expect(await popoutGroupCount(page)).toBe(0);

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      uploadPdf(page, 'b7.pdf'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(await pdfPanelCount(page, 'popout')).toBe(1);
    expect(await pdfPanelCount(page, 'main')).toBe(0);
  });
});

// ─── D. Window-lifecycle edge cases ────────────────────────────────────────

test.describe('D. Window lifecycle', () => {
  test('D13: closing popout via OS button re-docks and disables mode', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'd13.pdf');
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');

    // Simulate "user closes the popup via OS X button" by calling window.close()
    // from inside the popup. This fires the popup's beforeunload event, which
    // is what Dockview's PopoutWindow listens for to invoke its onWillClose
    // callback → our handlePopoutWillClose() handler.
    // Note: Playwright's popup.close({runBeforeUnload:true}) does NOT reliably
    // fire beforeunload in headless Chromium for window.open()-created popups.
    await popup.evaluate(() => window.close());
    await page.waitForFunction(() => {
      const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
      return !!api && api.panels.some(p => p.id.startsWith('pdf-') && p.api.location.type !== 'popout');
    }, { timeout: 5_000 });

    expect(await pdfPanelCount(page, 'main')).toBe(1);
    expect(await pdfPanelCount(page, 'popout')).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('boardripper-two-window-mode'))).toBe('0');
  });

  test('D15: reload with mode ON keeps flag; next PDF opens in popout', async ({ page, context }) => {
    await openMainPage(page);
    await page.click('[data-testid="two-window-toggle"]');
    await page.reload();
    await page.waitForFunction(
      () => !!(window as unknown as { __dockviewApi?: unknown }).__dockviewApi,
      { timeout: 10_000 },
    );
    expect(await page.evaluate(() => localStorage.getItem('boardripper-two-window-mode'))).toBe('1');

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      uploadPdf(page, 'd15.pdf'),
    ]);
    await popup.waitForLoadState('domcontentloaded');
    expect(await pdfPanelCount(page, 'popout')).toBe(1);
  });
});

// ─── H. Persistence ─────────────────────────────────────────────────────────

test.describe('H. Persistence', () => {
  test('H22: toggle state persists across reload', async ({ page }) => {
    await openMainPage(page);
    await page.click('[data-testid="two-window-toggle"]');
    await page.reload();
    await page.waitForFunction(
      () => !!(window as unknown as { __dockviewApi?: unknown }).__dockviewApi,
      { timeout: 10_000 },
    );
    const active = await page.locator('[data-testid="two-window-toggle"]').evaluate(el => el.classList.contains('active'));
    expect(active).toBe(true);
  });

  test('H23: corrupt localStorage value defaults to OFF', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.setItem('boardripper-two-window-mode', 'garbage'));
    await page.reload();
    await page.waitForFunction(
      () => !!(window as unknown as { __dockviewApi?: unknown }).__dockviewApi,
      { timeout: 10_000 },
    );
    const active = await page.locator('[data-testid="two-window-toggle"]').evaluate(el => el.classList.contains('active'));
    expect(active).toBe(false);
  });
});

// ─── I. Mixed-group safety ─────────────────────────────────────────────────

test.describe('I. Mixed-group safety', () => {
  test('I24: non-PDF panel in a PDF group stays in main window on toggle ON', async ({ page, context }) => {
    await openMainPage(page);
    await uploadPdf(page, 'i24.pdf');

    // Add a non-PDF panel (worklist) into the same group as the PDF, then
    // toggle 2-window mode. Only the PDF should migrate; worklist stays put.
    await page.evaluate(() => {
      type AddOpts = { id: string; component: string; title: string; position?: { referencePanel: string } };
      const api = (window as unknown as { __dockviewApi?: {
        addPanel: (o: AddOpts) => unknown;
        panels: { id: string }[];
      } }).__dockviewApi;
      if (!api) return;
      const pdf = api.panels.find(p => p.id.startsWith('pdf-'));
      if (!pdf) throw new Error('no pdf panel');
      api.addPanel({
        id: 'mixed-test-panel',
        component: 'worklist',
        title: 'Mixed test',
        position: { referencePanel: pdf.id },
      });
    });

    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      page.click('[data-testid="two-window-toggle"]'),
    ]);
    await popup.waitForLoadState('domcontentloaded');

    const result = await page.evaluate(() => {
      const api = (window as unknown as { __dockviewApi?: MinApi }).__dockviewApi;
      if (!api) return null;
      const mixed = api.panels.find(p => p.id === 'mixed-test-panel');
      return mixed ? mixed.api.location.type : null;
    });
    expect(result).toBe('grid');
    expect(await pdfPanelCount(page, 'popout')).toBe(1);
    expect(await pdfPanelCount(page, 'main')).toBe(0);
  });
});

// ─── J. Regression — mode-OFF path unchanged ───────────────────────────────

test.describe('J. Regression', () => {
  test('J25: mode OFF — PDF stays docked, no popout opens', async ({ page }) => {
    await openMainPage(page);
    await uploadPdf(page, 'j25.pdf');
    expect(await pdfPanelCount(page, 'main')).toBe(1);
    expect(await pdfPanelCount(page, 'popout')).toBe(0);
    expect(await popoutGroupCount(page)).toBe(0);
  });
});
