import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Regression guard for the 2026-07-12 memory-leak fix: closing a board tab
// must make its BoardRenderer + PixiJS Application collectable. Before the
// fix, viewport listeners ('moved'/'clicked') and the ResizeObserver callback
// pinned every closed renderer via the shared init() closure context, and
// lastRenderedSel.board retained the full parsed board (~15 MB per open).
// Canaries: WeakRef arrays __brRendererRefs (BoardRenderer constructor) and
// __brAppRefs (renderer-registry).

const BVR3_FILE = path.resolve(__dirname, '../../../samples/820-02016/820-02016.bvr');

test('closed board tabs release their renderer and board data', async ({ page }) => {
  test.skip(!fs.existsSync(BVR3_FILE), 'BVR fixture not present (proprietary)');
  test.setTimeout(120_000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const gc = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(300);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(300);
  };

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BVR3_FILE);
  await expect(page.getByTestId('statusbar')).toContainText('Components', { timeout: 60_000 });
  await page.waitForTimeout(1000);

  const tab = page.locator('.dv-tab', { hasText: '820-02016.bvr' }).first();
  await tab.click();
  await tab.hover();
  await tab.locator('.dv-default-tab-action').click({ force: true, timeout: 10_000 });
  await page.waitForTimeout(1500);

  // The dev-only window.__boardRenderer debug slot strongly pins the last
  // renderer — clear it so the canary measures real teardown, not the slot.
  await page.evaluate(() => {
    (window as unknown as { __boardRenderer?: unknown }).__boardRenderer = undefined;
  });
  await gc();

  const alive = await page.evaluate(() => {
    const w = window as unknown as {
      __brRendererRefs?: WeakRef<object>[];
      __brAppRefs?: WeakRef<object>[];
    };
    return {
      renderers: (w.__brRendererRefs ?? []).filter(r => r.deref() !== undefined).length,
      rendererTotal: (w.__brRendererRefs ?? []).length,
      apps: (w.__brAppRefs ?? []).filter(r => r.deref() !== undefined).length,
      appTotal: (w.__brAppRefs ?? []).length,
    };
  });

  expect(alive.rendererTotal).toBeGreaterThan(0); // canary wiring intact
  expect(alive.renderers, 'BoardRenderer instances still reachable after close+GC').toBe(0);
  expect(alive.apps, 'PixiJS Applications still reachable after close+GC').toBe(0);
});
