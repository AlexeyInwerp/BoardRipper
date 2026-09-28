/**
 * Butterfly on a layered board.
 *
 * Until 2026-09-27 the store refused `toggleButterfly` whenever the board had
 * `layerNames`, while the ribbon hid the button only for formats whose
 * descriptor set `hasLayers` (TVW alone) — so on KiCad, Allegro, Altium and
 * EAGLE boards the button was shown and did nothing. The reason for the gate
 * was real: traces, vias and pours live under `scene.root`, not in a side
 * layer, and mirroring the bottom half would leave the bottom copper under
 * the top half. Butterfly now works on every format and hides that copper
 * while it is on, says so once in a toast, and puts everything back when it
 * is turned off. The user's own traces toggle is not touched.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Public KiCad sample: 2 copper layers, traces and vias, so the gate has
// something to hide.
const FIXTURE = path.resolve(HERE, '../public/samples/tomu-fpga.kicad_pcb');
const SILK_FIXTURE = path.resolve(HERE, '../../../samples/eagle/10004_epic_cape.brd');

interface SceneVis {
  layerNames: number;
  traces: number;
  traceContainersVisible: boolean[];
  viaVisible: boolean | null;
  silkBottomParent: 'silk' | 'butterfly' | 'none' | 'other';
  butterfly: boolean;
  showTraces: boolean;
}

async function sceneVis(page: Page): Promise<SceneVis> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __boardRenderer?: { activeScene?: {
        traceLayerContainers: ({ visible: boolean } | null)[];
        viaLayer: { visible: boolean } | null;
        silkscreenBottom: { parent: unknown } | null;
        silkscreenLayer: unknown;
        butterflyRoot: unknown;
      } };
      __boardStore?: { butterfly: boolean; showTraces: boolean; activeTab: { board: { layerNames?: string[]; traces?: unknown[] } } | null };
    };
    const S = w.__boardRenderer?.activeScene;
    const st = w.__boardStore!;
    const board = st.activeTab?.board;
    const sb = S?.silkscreenBottom ?? null;
    const silkBottomParent = !sb ? 'none'
      : sb.parent === S?.silkscreenLayer ? 'silk'
      : sb.parent === S?.butterflyRoot ? 'butterfly' : 'other';
    return {
      layerNames: board?.layerNames?.length ?? 0,
      traces: board?.traces?.length ?? 0,
      traceContainersVisible: (S?.traceLayerContainers ?? []).filter(Boolean).map(c => c!.visible),
      viaVisible: S?.viaLayer ? S.viaLayer.visible : null,
      silkBottomParent,
      butterfly: st.butterfly,
      showTraces: st.showTraces,
    };
  });
}

async function openBoard(page: Page) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.setInputFiles('[data-testid="file-input"]', FIXTURE);
  await expect(page.getByTestId('butterfly-btn')).toBeVisible();
  await expect.poll(async () => (await sceneVis(page)).traceContainersVisible.length, { timeout: 15000 }).toBeGreaterThan(0);
}

test.describe('butterfly on a layered board', () => {
  test('the button works, hides the copper, says so, and restores it', async ({ page }) => {
    await openBoard(page);
    const before = await sceneVis(page);
    expect(before.layerNames).toBeGreaterThan(0);        // it IS a layered board
    expect(before.traces).toBeGreaterThan(0);
    expect(before.traceContainersVisible.every(v => v)).toBe(true);
    expect(before.showTraces).toBe(true);

    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    await expect(page.locator('.toast-info', { hasText: /copper layers are hidden/i })).toBeVisible();

    await expect.poll(async () => (await sceneVis(page)).traceContainersVisible.every(v => !v)).toBe(true);
    const on = await sceneVis(page);
    expect(on.butterfly).toBe(true);
    expect(on.viaVisible).toBe(false);
    // Bottom silk rides with the bottom half — when the format has any. Only
    // TVW emits silkscreen and there is no public TVW fixture, so on this
    // KiCad board the reparenting is asserted only if silk exists.
    if (before.silkBottomParent !== 'none') expect(on.silkBottomParent).toBe('butterfly');
    expect(on.showTraces).toBe(true);                    // the user's toggle is untouched
    // The traces button cannot claim traces are shown while they are not.
    const tracesBtn = page.getByTestId('traces-btn');
    if (await tracesBtn.count()) await expect(tracesBtn).toBeDisabled();

    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).not.toHaveClass(/active/);
    await expect.poll(async () => (await sceneVis(page)).traceContainersVisible.every(v => v)).toBe(true);
    const off = await sceneVis(page);
    expect(off.viaVisible).toBe(before.viaVisible);      // back to the user's own via toggle (off by default)
    if (before.silkBottomParent !== 'none') expect(off.silkBottomParent).toBe('silk');
    if (await tracesBtn.count()) await expect(tracesBtn).toBeEnabled();
  });

  test('the Silkscreen toggle still hides the bottom silk while Butterfly is on', async ({ page }) => {
    // Needs a board that carries silkscreen; the KiCad fixture has none.
    test.skip(!fs.existsSync(SILK_FIXTURE), 'EAGLE sample with silkscreen not present');
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.setInputFiles('[data-testid="file-input"]', SILK_FIXTURE);
    await expect(page.getByTestId('butterfly-btn')).toBeVisible();
    // Drawn = visible itself and through every ancestor (Pixi v8 has no
    // worldVisible). Both sides are shown in Butterfly, so the bottom silk is
    // the one to watch: it is the container that leaves silkscreenLayer.
    const silkDrawn = () => page.evaluate(() => {
      type C = { visible: boolean; parent: C | null };
      const S = (window as unknown as { __boardRenderer?: { activeScene?: { silkscreenBottom: C | null } } }).__boardRenderer?.activeScene;
      let c = S?.silkscreenBottom ?? null;
      if (!c) return null;
      for (; c; c = c.parent) if (!c.visible) return false;
      return true;
    });
    await expect.poll(silkDrawn, { timeout: 15000 }).not.toBeNull();

    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    await expect.poll(silkDrawn).toBe(true);
    const toggle = page.locator('.board-sidebar-toggle');
    if (!(await page.locator('[data-board-tab="layers"]').isVisible())) await toggle.click();
    await page.locator('[data-board-tab="layers"]').click();
    await page.getByTitle('Hide silkscreen').click();
    // Reparented into butterflyRoot, the bottom silk used to stay drawn here.
    await expect.poll(silkDrawn).toBe(false);
    await page.getByTitle('Show silkscreen').click();
    await expect.poll(silkDrawn).toBe(true);
  });

  test('the Layers tab says why its rows do nothing', async ({ page }) => {
    await openBoard(page);
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    const toggle = page.locator('.board-sidebar-toggle');
    if (!(await page.locator('[data-board-tab="layers"]').isVisible())) await toggle.click();
    await page.locator('[data-board-tab="layers"]').click();
    await expect(page.getByTestId('layers-butterfly-hint')).toBeVisible();
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('layers-butterfly-hint')).toHaveCount(0);
  });

  test('a lit net draws no trace highlight while Butterfly is on', async ({ page }) => {
    await openBoard(page);
    await page.getByTestId('butterfly-btn').click();
    await expect(page.getByTestId('butterfly-btn')).toHaveClass(/active/);
    // Light the biggest net and check that hovering a trace finds nothing.
    const hit = await page.evaluate(() => {
      const w = window as unknown as {
        __boardStore: { activeTab: { board: { traces: { start: { x: number; y: number }; end: { x: number; y: number }; net?: string }[] } }; highlightNet(n: string): void };
        __boardRenderer: unknown;
      };
      const t = w.__boardStore.activeTab.board.traces.find(t => t.net);
      if (!t) return 'no-trace';
      w.__boardStore.highlightNet(t.net!);
      // traceHitTest is private in TS but reachable at runtime; a hidden
      // trace must not be hit at its own midpoint.
      const R = w.__boardRenderer as unknown as { traceHitTest(p: { x: number; y: number }): unknown; sceneToWorld(p: { x: number; y: number }): { x: number; y: number } };
      const mid = { x: (t.start.x + t.end.x) / 2, y: (t.start.y + t.end.y) / 2 };
      return R.traceHitTest(R.sceneToWorld(mid)) === null ? 'miss' : 'hit';
    });
    expect(hit).toBe('miss');
  });
});
