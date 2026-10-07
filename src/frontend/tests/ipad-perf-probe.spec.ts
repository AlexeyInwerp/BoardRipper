/**
 * Measurement probe, not a regression test: what a frame costs on a dense
 * board when the main thread is slow — a stand-in for an A12Z-class iPad.
 *
 * Chromium with its real GPU (Metal through ANGLE, not SwiftShader, whose
 * software raster makes every pixel a CPU cost and measures the wrong thing),
 * an iPad-sized viewport at DPR 2, the touch profile forced on, and a CDP
 * CPU throttle. The board is panned and zoomed programmatically, one step per
 * animation frame, so the input path is not part of the measurement.
 *
 * Per frame it records the ticker's total, `app.render()` and the Canvas2D
 * label overlay, and reports medians plus the achieved frame rate, for each
 * named configuration in CONFIGS. Run:
 *
 *   PERF_PROBE=1 npx playwright test ipad-perf-probe --workers=1
 *
 * Needs the proprietary Allegro sample (3369 parts, 39k traces); skips
 * without it.
 */
import { test, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD = process.env.PERF_BOARD
  ? path.resolve(process.env.PERF_BOARD)
  : path.resolve(here, '../../../samples/LA-P161PR1B.brd');
const THROTTLE = Number(process.env.PERF_THROTTLE ?? 4);

test.use({
  viewport: { width: 1194, height: 834 },
  deviceScaleFactor: 2,
  launchOptions: { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] },
});

type Overrides = Record<string, unknown>;
const CONFIGS: Array<{ name: string; set: Overrides }> = JSON.parse(process.env.PERF_CONFIGS ?? 'null') ?? [
  { name: 'default', set: {} },
];

async function applySettings(page: Page, set: Overrides) {
  await page.evaluate((s) => {
    const rs = (window as any).__renderSettings;
    const snap = rs.globalSnapshot();
    const { __tab, ...rest } = s as { __tab?: Record<string, unknown> };
    if (__tab) (window as any).__boardStore.updateActiveTab(__tab);
    Object.assign(snap, rest);
    rs.applyGlobal(snap);
  }, set);
  await page.waitForTimeout(2500);
}

/** One phase: `frames` animation frames, each moving the view by `step`. */
async function phase(page: Page, kind: 'pan' | 'zoom' | 'idle', frames: number) {
  return page.evaluate(async ({ kind, frames }) => {
    const r = (window as any).__boardRenderer;
    const vp = r.viewport;
    const app = r.app;
    const tick: number[] = [], render: number[] = [], overlay: number[] = [], gaps: number[] = [];
    const origRender = app.render.bind(app);
    let renderMs = 0;
    app.render = (...a: unknown[]) => { const t = performance.now(); const out = origRender(...a); renderMs += performance.now() - t; return out; };
    const origSync = r.syncLabelOverlay.bind(r);
    let overlayMs = 0;
    r.syncLabelOverlay = (...a: unknown[]) => { const t = performance.now(); const out = origSync(...a); overlayMs += performance.now() - t; return out; };
    const origTick = r.onTick?.bind(r);
    let tickMs = 0;
    const tickWrap = (...a: unknown[]) => { const t = performance.now(); const out = origTick(...a); tickMs += performance.now() - t; return out; };
    // onTick is registered on the ticker as a bound fn; time the whole ticker
    // update instead, which includes every listener.
    const ticker = app.ticker;
    const origUpdate = ticker.update.bind(ticker);
    ticker.update = (now?: number) => { const t = performance.now(); origUpdate(now); tickMs += performance.now() - t; };
    void tickWrap;
    const gl = app.renderer.gl as WebGL2RenderingContext;
    let draws = 0, verts = 0, upload = 0;
    const de = gl.drawElements.bind(gl), da = gl.drawArrays.bind(gl), bsd = gl.bufferSubData.bind(gl), bd = gl.bufferData.bind(gl);
    (gl as any).drawElements = (m: number, c: number, t: number, o: number) => { draws++; verts += c; de(m, c, t, o); };
    (gl as any).drawArrays = (m: number, f: number, c: number) => { draws++; verts += c; da(m, f, c); };
    (gl as any).bufferSubData = (...a: any[]) => { upload += (a[2]?.byteLength ?? 0); return (bsd as any)(...a); };
    (gl as any).bufferData = (...a: any[]) => { upload += (a[1]?.byteLength ?? 0); return (bd as any)(...a); };
    const drawsA: number[] = [], vertsA: number[] = [], upA: number[] = [];
    let last = performance.now();
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    for (let i = 0; i < frames; i++) {
      renderMs = 0; overlayMs = 0; tickMs = 0; draws = 0; verts = 0; upload = 0;
      if (kind === 'pan') {
        vp.x += (i % 60 < 30 ? 9 : -9); vp.y += (i % 40 < 20 ? 4 : -4);
        vp.emit('moved', { viewport: vp, type: 'drag' });
      } else if (kind === 'zoom') {
        const f = i % 40 < 20 ? 1.03 : 1 / 1.03;
        const before = vp.toWorld(cx, cy);
        vp.scale.set(vp.scale.x * f, vp.scale.y * f);
        const after = vp.toWorld(cx, cy);
        vp.x += (after.x - before.x) * vp.scale.x; vp.y += (after.y - before.y) * vp.scale.y;
        vp.emit('moved', { viewport: vp, type: 'wheel' });
        vp.emit('zoomed', { viewport: vp, type: 'wheel' });
      }
      await new Promise(requestAnimationFrame);
      const now = performance.now();
      gaps.push(now - last); last = now;
      tick.push(tickMs); render.push(renderMs); overlay.push(overlayMs);
      if (draws) { drawsA.push(draws); vertsA.push(verts); upA.push(upload); }
    }
    (gl as any).drawElements = de; (gl as any).drawArrays = da; (gl as any).bufferSubData = bsd; (gl as any).bufferData = bd;
    app.render = origRender; r.syncLabelOverlay = origSync; ticker.update = origUpdate;
    const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length / 2)].toFixed(1); };
    const p90 = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return +s[Math.floor(s.length * 0.9)].toFixed(1); };
    return {
      fps: +(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1),
      draws: drawsA.length ? med(drawsA) : 0, kverts: vertsA.length ? Math.round(med(vertsA) / 1000) : 0, kbUp: upA.length ? Math.round(med(upA) / 1024) : 0,
      tick: med(tick), tick90: p90(tick), render: med(render), render90: p90(render), overlay: med(overlay), overlay90: p90(overlay),
    };
  }, { kind, frames });
}

test('iPad-class frame cost on a dense board', async ({ page }) => {
  test.skip(!process.env.PERF_PROBE, 'measurement probe — set PERF_PROBE=1');
  test.skip(!fs.existsSync(BOARD), 'proprietary sample not present');
  test.setTimeout(900_000);

  // Force the touch profile: an iPad answers `(pointer: coarse)`.
  await page.addInitScript(() => {
    const mm = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => q.includes('pointer: coarse')
      ? ({ matches: true, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false } as MediaQueryList)
      : mm(q);
  });
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(BOARD);
  await page.waitForFunction(() => !!(window as any).__boardRenderer?.board, null, { timeout: 180_000 });
  await page.waitForTimeout(4000);
  const gpu = await page.evaluate(() => {
    const gl = (window as any).__boardRenderer.app.renderer.gl as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown') + ' · ' + navigator.userAgent.slice(0, 60);
  });
  console.log(`GPU: ${gpu} · throttle ${THROTTLE}× · resolution ${await page.evaluate(() => (window as any).__boardRenderer.app.renderer.resolution)}`);

  if (process.env.PERF_DUMP) {
    await page.evaluate((k) => { const r = (window as any).__boardRenderer; r.fitToBoard?.(); r.viewport.setZoom(r.viewport.scale.x * k, true); }, Number(process.env.PERF_DUMP));
    await page.waitForTimeout(1500);
    const dump = await page.evaluate(() => {
      const r = (window as any).__boardRenderer;
      const out: Record<string, { n: number; idx: number; batched: number }> = {};
      const walk = (o: any, pathLabel: string, depth: number) => {
        const lbl = depth <= 7 ? `${pathLabel}/${o.label || o.constructor?.name}` : pathLabel;
        if (o.culled || o.visible === false) return;
        if (o.context?.instructions || o._context) {
          const ctx = o.context;
          let idx = 0;
          try { const gd = (r.app.renderer.graphicsContext as any).getGpuContext?.(ctx) ?? (r.app.renderer.graphicsContext as any).getContextRenderData?.(ctx);
            if (gd?.geometryData) idx = gd.geometryData.indices.length; else if (gd?.batches) idx = gd.batches.reduce((a: number, b: any) => a + (b.indexSize || 0), 0);
          } catch { /* */ }
          const e = (out[lbl] ??= { n: 0, idx: 0, batched: 0 });
          e.n++; e.idx += idx; if (ctx.batchMode === 'batch' || (ctx as any).isBatchable) e.batched++;
        }
        if (o.visible === false || o.culled) return;
        for (const c of o.children ?? []) walk(c, lbl, depth + 1);
      };
      walk(r.app.stage, '', 0);
      return out;
    });
    const census = await page.evaluate(() => {
      const r = (window as any).__boardRenderer;
      const c: Record<string, number> = { total: 0, visible: 0, culled: 0, cullable: 0, graphics: 0, batchableGfx: 0, batchableVerts: 0 };
      const walk = (o: any, vis: boolean) => {
        c.total++;
        const v = vis && o.visible !== false && !o.culled;
        if (v) c.visible++;
        if (o.culled) c.culled++;
        if (o.cullable) c.cullable++;
        if (o.context && v) {
          c.graphics++;
          const g = r.app.renderer.graphicsContext.updateGpuContext(o.context);
          if (g.isBatchable) { c.batchableGfx++; c.batchableVerts += g.geometryData?.vertices?.length ?? 0; }
        }
        for (const ch of o.children ?? []) walk(ch, v);
      };
      walk(r.app.stage, true);
      return c;
    });
    console.log('census', JSON.stringify(census));
    for (const [k, v] of Object.entries(dump).sort((a, b) => b[1].idx - a[1].idx).slice(0, 25)) console.log(`${String(v.idx).padStart(9)} idx  ${String(v.n).padStart(6)} gfx  ${k}`);
  }
  const isChromium = page.context().browser()?.browserType().name() === 'chromium';
  const cdp = isChromium ? await page.context().newCDPSession(page) : { send: async (..._a: unknown[]) => {} };
  const zoomTo = async (k: number) => page.evaluate((k) => {
    const r = (window as any).__boardRenderer;
    r.fitToBoard?.();
    const vp = r.viewport;
    vp.setZoom(vp.scale.x * k, true);
    vp.emit('moved', { viewport: vp, type: 'wheel' });
  }, k);

  const rows: string[] = [];
  for (const cfg of CONFIGS) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await applySettings(page, cfg.set);
    for (const [label, k] of [['fit', 1], ['4×', 4], ['16×', 16]] as const) {
      await zoomTo(k);
      await page.waitForTimeout(1500);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
      if (process.env.PERF_PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
      const pan = await phase(page, 'pan', 90);
      if (process.env.PERF_PROFILE) {
        const { profile } = await (cdp as any).send('Profiler.stop');
        const byId = new Map<number, any>(profile.nodes.map((n: any) => [n.id, n]));
        const self = new Map<string, number>();
        const dt = profile.timeDeltas as number[];
        profile.samples.forEach((id: number, i: number) => {
          const n = byId.get(id); const cf = n.callFrame;
          const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop()?.split('?')[0]}:${cf.lineNumber}`;
          self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
        });
        const top = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, 18);
        console.log(`profile ${label}:\n` + top.map(([k, v]) => `  ${v.toFixed(0).padStart(6)} ms  ${k}`).join('\n'));
      }
      if (cfg.set.showPerfOverlay) console.log('overlay:', (await page.locator('.board-perf-overlay').first().textContent())?.replace(/\n/g, ' ⏎ '));
      const zoom = await phase(page, 'zoom', 80);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      await zoomTo(k);
      await page.waitForTimeout(800);
      rows.push(`${cfg.name.padEnd(22)} ${label.padEnd(4)} pan ${pan.fps}fps tick ${pan.tick}/${pan.tick90} render ${pan.render}/${pan.render90} ovl ${pan.overlay}/${pan.overlay90} dc ${pan.draws} kv ${pan.kverts} up ${pan.kbUp}KB` +
        ` | zoom ${zoom.fps}fps tick ${zoom.tick}/${zoom.tick90} render ${zoom.render}/${zoom.render90} ovl ${zoom.overlay}/${zoom.overlay90}`);
      console.log(rows[rows.length - 1]);
    }
  }
  console.log('\n' + rows.join('\n'));
});
