/**
 * PDF Page Transition — detects wrong-page flash during scroll.
 * Uses in-browser MutationObserver + canvas pixel sampling to catch
 * sub-frame flashes that screenshot-based approaches miss.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PDF_FILE = path.resolve(__dirname, '../../../samples/820-02016.pdf');
const OUT_DIR = path.resolve(__dirname, '../test-results/page-transition');

// Skip (not fail) when the gitignored, proprietary PDF fixture is absent —
// same idiom as ci-smoke.spec.ts.
const havePdf = fs.existsSync(PDF_FILE);

async function dispatchWheel(page: Page, x: number, y: number, deltaY: number, ctrlKey = false) {
  await page.evaluate(({ x, y, deltaY, ctrlKey }: { x: number; y: number; deltaY: number; ctrlKey: boolean }) => {
    const el = document.elementFromPoint(x, y);
    if (el) el.dispatchEvent(new WheelEvent('wheel', {
      clientX: x, clientY: y, deltaY, ctrlKey, bubbles: true, cancelable: true,
    }));
  }, { x, y, deltaY, ctrlKey });
}

test('detect wrong-page flash via in-browser pixel monitoring', async ({ page }) => {
  test.skip(!havePdf, 'samples/820-02016.pdf not present (proprietary fixture)');
  test.setTimeout(120000);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.png') || f.endsWith('.json')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  // Capture console messages
  const consoleLogs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[page-change]') || text.includes('tile-rAF') || text.includes('tiled-render') || text.includes('renderActive') || text.includes('[clearTileDom]')) {
      consoleLogs.push(`${Date.now()} ${text}`);
    }
  });

  await page.goto('/');
  await page.waitForTimeout(800);

  await page.getByTestId('pdf-input').setInputFiles(PDF_FILE);
  await page.locator('.dv-tab', { hasText: '820-02016.pdf' }).click();
  await page.waitForTimeout(2500);

  const container = page.locator('.pdf-canvas-container');
  await expect(container).toBeVisible();
  const box = await container.boundingBox();
  if (!box) throw new Error('No bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Zoom to ~200%
  for (let i = 0; i < 20; i++) {
    await dispatchWheel(page, cx, cy, -30, true);
    await page.waitForTimeout(20);
  }
  await page.waitForTimeout(2500);

  // Install in-browser monitors:
  // 1. Sample center pixels of the wrapper on every rAF
  // 2. Track page input value changes
  // 3. Watch for tile DOM mutations
  await page.evaluate(() => {
    type LogEntry = {
      frame: number;
      time: number;
      page: string;
      tileCount?: number;
      mainVisible?: boolean;
      tileSample?: string;
      mainSample?: string;
      event?: string;
    };
    const w = window as unknown as {
      __transitionLog: LogEntry[];
      __monitoring: boolean;
    };
    w.__transitionLog = [];
    w.__monitoring = true;

    const wrapper = document.querySelector('.pdf-page-wrapper');
    const pageInput = document.querySelector('.pdf-page-input') as HTMLInputElement;
    if (!wrapper || !pageInput) return;

    // Sample visible canvas content on every frame
    let frameId = 0;
    const sampleFrame = () => {
      if (!w.__monitoring) return;
      frameId++;

      const page = pageInput.value;
      const tiles = wrapper.querySelectorAll('.pdf-tile');
      const visibleTiles = Array.from(tiles).filter(
        (t) => {
          const c = t as HTMLCanvasElement;
          return c.style.display !== 'none' && c.width > 0;
        },
      );

      // Sample center pixel of first visible tile
      let pixelSample = '';
      if (visibleTiles.length > 0) {
        const canvas = visibleTiles[0] as HTMLCanvasElement;
        try {
          const ctx = canvas.getContext('2d');
          if (ctx && canvas.width > 10 && canvas.height > 10) {
            const px = ctx.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
            pixelSample = `${px[0]},${px[1]},${px[2]}`;
          }
        } catch { /* tainted canvas */ }
      }

      // Also sample main canvas
      let mainSample = '';
      const mainCanvas = wrapper.querySelector('canvas:not(.pdf-tile):not(.pdf-highlight-canvas):not(.pdf-glyph-overlay-canvas)') as HTMLCanvasElement;
      if (mainCanvas && mainCanvas.width > 10) {
        try {
          const ctx = mainCanvas.getContext('2d');
          if (ctx) {
            const px = ctx.getImageData(mainCanvas.width / 2, mainCanvas.height / 2, 1, 1).data;
            mainSample = `${px[0]},${px[1]},${px[2]}`;
          }
        } catch { /* tainted */ }
      }

      w.__transitionLog.push({
        frame: frameId,
        time: performance.now(),
        page,
        tileCount: visibleTiles.length,
        mainVisible: mainCanvas ? mainCanvas.style.visibility !== 'hidden' : false,
        tileSample: pixelSample,
        mainSample,
      });

      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);

    // Watch for tile DOM additions/removals
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          const added = Array.from(m.addedNodes).filter((n) => (n as Element).classList?.contains('pdf-tile')).length;
          const removed = Array.from(m.removedNodes).filter((n) => (n as Element).classList?.contains('pdf-tile')).length;
          if (added > 0 || removed > 0) {
            w.__transitionLog.push({
              frame: frameId,
              time: performance.now(),
              event: `tiles: +${added} -${removed}`,
              page: pageInput.value,
            });
          }
        }
      }
    });
    observer.observe(wrapper, { childList: true });
  });

  // Reference pixel sample from page 1
  const refSample = await page.evaluate(() => {
    const wrapper = document.querySelector('.pdf-page-wrapper');
    if (!wrapper) return '';
    const tiles = wrapper.querySelectorAll('.pdf-tile');
    for (const t of tiles) {
      const c = t as HTMLCanvasElement;
      if (c.style.display !== 'none' && c.width > 10) {
        try {
          const ctx = c.getContext('2d');
          if (ctx) {
            const px = ctx.getImageData(c.width / 2, c.height / 2, 1, 1).data;
            return `${px[0]},${px[1]},${px[2]}`;
          }
        } catch { /* ignore */ }
      }
    }
    return '';
  });
  console.log(`Page 1 reference pixel: ${refSample}`);

  // Scroll down slowly
  for (let step = 0; step < 200; step++) {
    await dispatchWheel(page, cx, cy, 60);
    await page.waitForTimeout(10); // minimal wait — let rAF fire
  }

  // Wait for rendering to settle
  await page.waitForTimeout(1000);

  // Stop monitoring and collect results
  type LogEntry = {
    frame: number;
    time: number;
    page?: string;
    tileCount?: number;
    mainVisible?: boolean;
    tileSample?: string;
    mainSample?: string;
    event?: string;
  };
  const log: LogEntry[] = await page.evaluate(() => {
    const w = window as unknown as {
      __monitoring: boolean;
      __transitionLog: unknown[];
    };
    w.__monitoring = false;
    return w.__transitionLog as LogEntry[];
  });

  // Save full log
  fs.writeFileSync(path.join(OUT_DIR, 'transition-log.json'), JSON.stringify(log, null, 2));
  console.log(`Collected ${log.length} log entries`);

  // Analyze: find page transitions
  let prevPage = '';
  const transitions: { from: string; to: string; frame: number; time: number }[] = [];
  for (const entry of log) {
    if (entry.page && entry.page !== prevPage) {
      if (prevPage) {
        transitions.push({ from: prevPage, to: entry.page, frame: entry.frame, time: entry.time });
      }
      prevPage = entry.page;
    }
  }

  console.log(`\nPage transitions detected: ${transitions.length}`);
  for (const t of transitions) {
    console.log(`  frame=${t.frame} ${t.from} → ${t.to}`);
  }

  // Look for "revert" pattern: page goes N→N+1→N→N+1 (flash of old page)
  const pageSequence = log.filter((e) => e.page).map((e) => e.page!);
  const uniqueTransitions: string[] = [];
  let lastPage = '';
  for (const p of pageSequence) {
    if (p !== lastPage) {
      uniqueTransitions.push(p);
      lastPage = p;
    }
  }
  console.log(`\nPage sequence: ${uniqueTransitions.join(' → ')}`);

  // Check for bounces (e.g., 1→2→1→2)
  for (let i = 2; i < uniqueTransitions.length; i++) {
    if (uniqueTransitions[i] === uniqueTransitions[i - 2] && uniqueTransitions[i] !== uniqueTransitions[i - 1]) {
      console.log(`🔴 PAGE BOUNCE detected: ${uniqueTransitions[i-2]} → ${uniqueTransitions[i-1]} → ${uniqueTransitions[i]}`);
    }
  }

  // Check for pixel reversion: post-transition frames that match pre-transition pixels
  if (refSample && transitions.length > 0) {
    const firstTransFrame = transitions[0].frame;
    const postTransEntries = log.filter((e) =>
      e.frame > firstTransFrame && e.frame < firstTransFrame + 30 && e.tileSample
    );
    console.log(`\nPost-transition pixel samples (${postTransEntries.length} frames):`);
    for (const e of postTransEntries) {
      const match = e.tileSample === refSample;
      console.log(`  frame=${e.frame} page=${e.page} tiles=${e.tileCount} pixel=${e.tileSample}${match ? ' ⚠️ MATCHES PAGE 1!' : ''}`);
    }
  }

  // Also take a screenshot at final state
  const finalShot = await container.screenshot();
  fs.writeFileSync(path.join(OUT_DIR, 'final-state.png'), finalShot);

  // Look for tile mutation events around transitions
  const tileEvents = log.filter((e) => e.event);
  console.log(`\nTile DOM events: ${tileEvents.length}`);
  for (const e of tileEvents.slice(0, 20)) {
    console.log(`  frame=${e.frame} page=${e.page} ${e.event}`);
  }

  console.log('\nConsole logs:');
  for (const l of consoleLogs) console.log(`  ${l}`);

  expect(transitions.length, 'Should have page transitions').toBeGreaterThan(0);
});
