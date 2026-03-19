import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Watermarked PDFs (laptop-schematics.com tiled images)
const WATERMARKED_PDF = path.resolve(__dirname, '../../../samples/820-01055/Power Sequence Timing Diagram_LO.pdf');
const WATERMARKED_PDF_B = path.resolve(__dirname, '../../../samples/820-01055/MLB# 820-01055 Component Placement diagram_LO.pdf');
const WATERMARKED_PDF_C = path.resolve(__dirname, '../../../samples/820-01055/Taurus power sequence(before press power button) and architecture diagram_LO.pdf');
// Clean PDF (no watermark)
const CLEAN_PDF = path.resolve(__dirname, '../../../samples/820-02016.pdf');

interface RenderPerf {
  file: string; page: number; tier: number; clean: boolean;
  canvasW: number; canvasH: number;
  getPageMs: number; renderMs: number; copyMs: number; totalMs: number;
}

interface StripPerf {
  file: string; stripMs: number; reloadMs: number; totalMs: number;
  origSize: number; strippedSize: number;
}

/** Load a PDF and wait for its panel to appear */
async function loadPdf(page: import('@playwright/test').Page, filePath: string) {
  const pdfInput = page.getByTestId('pdf-input');
  await pdfInput.setInputFiles(filePath);
  await page.waitForTimeout(1500);
}

/** Collect render perf events from console */
function collectRenderPerf(page: import('@playwright/test').Page): RenderPerf[] {
  const events: RenderPerf[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[pdf-perf]')) {
      try { events.push(JSON.parse(text.slice(11))); } catch { /* ignore */ }
    }
  });
  return events;
}

/** Collect strip perf events */
function collectStripPerf(page: import('@playwright/test').Page): StripPerf[] {
  const events: StripPerf[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.startsWith('[pdf-strip-perf]')) {
      try { events.push(JSON.parse(text.slice(17))); } catch { /* ignore */ }
    }
  });
  return events;
}

/** Trigger zoom via wheel events on the pdf canvas container, then wait for re-render */
async function zoomTo(page: import('@playwright/test').Page, targetZoomPercent: number) {
  // Use evaluate to directly set zoom and trigger re-render — more reliable than mouse wheel in headless
  await page.evaluate((zoom) => {
    const container = document.querySelector('.pdf-canvas-container');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    // Simulate wheel events to reach target zoom
    const delta = zoom > 100 ? -500 : 500;
    const steps = Math.abs(Math.log(zoom / 100) / 0.5);
    for (let i = 0; i < Math.ceil(steps); i++) {
      container.dispatchEvent(new WheelEvent('wheel', {
        deltaY: delta, clientX: cx, clientY: cy, bubbles: true,
      }));
    }
  }, targetZoomPercent);
  // Wait for tier re-render to complete
  await page.waitForTimeout(3000);
}

function printTable(label: string, perfs: RenderPerf[]) {
  console.log(`\n${label}`);
  console.log('  tier | render ms | copy ms | total ms | canvas size');
  console.log('  -----|-----------|---------|----------|------------');
  for (const p of perfs) {
    console.log(`  ${String(p.tier).padStart(4)} | ${String(p.renderMs).padStart(9)} | ${String(p.copyMs).padStart(7)} | ${String(p.totalMs).padStart(8)} | ${p.canvasW}×${p.canvasH.toFixed(0)}`);
  }
}

test.describe('PDF Rendering Performance', () => {

  test('watermarked PDF: baseline vs clean at multiple zoom tiers', async ({ page }) => {
    const perfs = collectRenderPerf(page);
    const strips = collectStripPerf(page);
    await page.goto('/');
    await loadPdf(page, WATERMARKED_PDF);
    await page.waitForTimeout(2000);

    // ── Baseline tier 1 ──
    const baselineT1 = perfs.filter(p => !p.clean && p.tier === 1);
    printTable('BASELINE TIER 1', baselineT1);

    // ── Baseline zoom to ~200% (tier 2) ──
    perfs.length = 0;
    await zoomTo(page, 200);
    const baselineZoom = [...perfs];
    printTable('BASELINE ZOOMED', baselineZoom);

    // Reset zoom for clean mode test
    await zoomTo(page, 100);
    await page.waitForTimeout(1000);

    // ── Enable clean mode ──
    perfs.length = 0;
    const cleanBtn = page.locator('.pdf-toolbar-btn', { hasText: 'Clean' });
    await cleanBtn.click();
    await page.waitForTimeout(5000);

    // Strip metrics
    if (strips.length > 0) {
      const s = strips[0];
      console.log(`\nSTRIP: ${s.stripMs}ms strip + ${s.reloadMs}ms reload = ${s.totalMs}ms total`);
    }

    const cleanT1 = perfs.filter(p => p.clean && p.tier === 1);
    printTable('CLEAN TIER 1', cleanT1);

    // ── Clean zoom to ~200% ──
    perfs.length = 0;
    await zoomTo(page, 200);
    const cleanZoom = [...perfs];
    printTable('CLEAN ZOOMED', cleanZoom);

    // ── Clean zoom to ~400% ──
    perfs.length = 0;
    await zoomTo(page, 400);
    const cleanZoom4 = [...perfs];
    printTable('CLEAN 400%', cleanZoom4);

    // ── Summary ──
    const b1 = baselineT1[0];
    const c1 = cleanT1[0];
    if (b1 && c1) {
      console.log(`\nSUMMARY: Tier 1 render ${b1.renderMs}ms → ${c1.renderMs}ms (${(b1.renderMs / Math.max(1, c1.renderMs)).toFixed(1)}x speedup)`);
    }

    // Assert clean mode is significantly faster
    if (b1 && c1) {
      expect(c1.renderMs).toBeLessThan(b1.renderMs);
    }
  });

  test('clean PDF (no watermark) at multiple zoom tiers', async ({ page }) => {
    const perfs = collectRenderPerf(page);
    await page.goto('/');
    await loadPdf(page, CLEAN_PDF);
    await page.waitForTimeout(2000);

    const t1 = [...perfs];
    printTable('CLEAN PDF TIER 1', t1);

    perfs.length = 0;
    await zoomTo(page, 200);
    printTable('CLEAN PDF 200%', [...perfs]);

    perfs.length = 0;
    await zoomTo(page, 400);
    printTable('CLEAN PDF 400%', [...perfs]);
  });

  test('all 3 watermarked PDFs: strip + render benchmark', async ({ page }) => {
    const perfs = collectRenderPerf(page);
    const strips = collectStripPerf(page);
    await page.goto('/');

    const results: { name: string; baselineMs: number; cleanMs: number; stripMs: number }[] = [];

    for (const pdf of [WATERMARKED_PDF, WATERMARKED_PDF_B, WATERMARKED_PDF_C]) {
      const name = path.basename(pdf).slice(0, 40);
      perfs.length = 0;
      strips.length = 0;

      await loadPdf(page, pdf);
      await page.waitForTimeout(2000);
      const baseline = perfs.find(p => p.tier === 1);

      // Enable clean
      const cleanBtn = page.locator('.pdf-toolbar-btn', { hasText: 'Clean' });
      await cleanBtn.click();
      await page.waitForTimeout(5000);

      const cleanRender = perfs.find(p => p.clean && p.tier === 1);

      results.push({
        name,
        baselineMs: baseline?.renderMs ?? -1,
        cleanMs: cleanRender?.renderMs ?? -1,
        stripMs: strips[0]?.stripMs ?? -1,
      });
    }

    console.log('\n=== ALL WATERMARKED PDFs ===');
    console.log('  file                                     | baseline | clean | strip | speedup');
    console.log('  -----------------------------------------|----------|-------|-------|--------');
    for (const r of results) {
      const speedup = r.baselineMs > 0 && r.cleanMs > 0
        ? (r.baselineMs / r.cleanMs).toFixed(1) + 'x'
        : 'n/a';
      console.log(`  ${r.name.padEnd(40)} | ${String(r.baselineMs).padStart(6)}ms | ${String(r.cleanMs).padStart(3)}ms | ${String(r.stripMs).padStart(3)}ms | ${speedup}`);
    }
  });
});
