/**
 * Live PixiJS preview for the Settings panel.
 *
 * Uses the SAME rendering pipeline (buildBoardScene) as the main board view —
 * any visual change in board-scene.ts is automatically reflected here.
 *
 * Viewport layer order (bottom → top):
 *   sceneRoot  →  netLinesGfx  →  selectionGfx  →  labelsRoot
 * Labels are lifted out of the scene and placed above selectionGfx so that
 * label shadows visually overlay the net-highlight circles beneath them.
 *
 * Click-to-navigate: clicking a board element scrolls and highlights the
 * corresponding settings section in SettingsPanel (via onElementClick).
 * Hit testing uses computeEffectiveBounds() — the same helper used during rendering.
 *
 * Static mockup board: renderer/mockup-data.ts (U1 IC + R1 resistor + C1 capacitor).
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { Application, Graphics, Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { RenderSettings } from '../store/render-settings';
import { log } from '../store/log-store';
import { computePinRadius, computeEffectiveBounds } from '../store/render-settings';
import { buildBoardScene, BOARD_COLORS } from '../renderer/board-scene';
import { MOCK_BOARD } from '../renderer/mockup-data';

export type MockupSectionId = 'outline' | 'parts' | 'pins' | 'netColors' | 'selection';

// ── Hit-testing ───────────────────────────────────────────────────────────────
// Derives bounds from the same shared helpers used in rendering, so it stays
// in sync automatically when rendering logic changes.

function hitTestSection(world: { x: number; y: number }, s: RenderSettings): MockupSectionId | null {
  // 1. Net highlight circles (VCC3V3 on U1)
  const u1 = MOCK_BOARD.parts[0];
  for (const pin of u1.pins) {
    if (pin.net !== 'VCC3V3') continue;
    const r  = computePinRadius(s, pin.radius) + s.netHighlightGrow + 2;
    const dx = world.x - pin.position.x;
    const dy = world.y - pin.position.y;
    if (dx * dx + dy * dy <= r * r) return 'netColors';
  }

  // 2. Individual pins / pads
  for (const part of MOCK_BOARD.parts) {
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);
    if (part.pins.length === 2) {
      for (let i = 0; i < 2; i++) {
        const pin   = part.pins[i];
        const other = part.pins[1 - i];
        let rx: number, ry: number, rw: number, rh: number;
        if (eb.horiz) {
          const depth = Math.min(eb.ph, eb.pw * 0.4);
          const left  = pin.position.x < other.position.x;
          rx = left ? eb.px : eb.px + eb.pw - depth;
          ry = eb.py; rw = depth; rh = eb.ph;
        } else {
          const depth = Math.min(eb.pw, eb.ph * 0.4);
          const top   = pin.position.y < other.position.y;
          rx = eb.px; ry = top ? eb.py : eb.py + eb.ph - depth;
          rw = eb.pw; rh = depth;
        }
        if (world.x >= rx && world.x <= rx + rw && world.y >= ry && world.y <= ry + rh) return 'pins';
      }
    } else {
      for (const pin of part.pins) {
        const r  = computePinRadius(s, pin.radius);
        const dx = world.x - pin.position.x;
        const dy = world.y - pin.position.y;
        if (dx * dx + dy * dy <= r * r) return 'pins';
      }
    }
  }

  // 3. Selection border (strip around U1's selection rect)
  {
    const eb   = computeEffectiveBounds(u1.bounds, u1.pins, s);
    const sp   = s.selectionPadding;
    const sx   = eb.px - sp, sy = eb.py - sp;
    const sw   = eb.pw + sp * 2, sh = eb.ph + sp * 2;
    const edge = Math.max(6, s.selectionWidth + 4);
    if (
      world.x >= sx - edge && world.x <= sx + sw + edge &&
      world.y >= sy - edge && world.y <= sy + sh + edge &&
      (world.x < sx + edge || world.x > sx + sw - edge ||
       world.y < sy + edge || world.y > sy + sh - edge)
    ) return 'selection';
  }

  // 4. Part body rectangles
  for (const part of MOCK_BOARD.parts) {
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);
    if (
      world.x >= eb.px && world.x <= eb.px + eb.pw &&
      world.y >= eb.py && world.y <= eb.py + eb.ph
    ) return 'parts';
  }

  // 5. Board outline strips
  const { maxX: bw, maxY: bh } = MOCK_BOARD.bounds;
  const edge = 12;
  if (world.x < edge || world.x > bw - edge || world.y < edge || world.y > bh - edge) return 'outline';

  return null;
}

// ── Selection overlay (hardcoded: U1 selected + VCC3V3 highlighted) ──────────

function buildSelectionOverlay(gfx: Graphics, s: RenderSettings) {
  gfx.clear();

  // Net highlight for VCC3V3 pins on U1
  const u1      = MOCK_BOARD.parts[0];
  const vccPins = u1.pins.filter(p => p.net === 'VCC3V3');
  for (const pin of vccPins) {
    const r = computePinRadius(s, pin.radius) + s.netHighlightGrow;
    gfx.circle(pin.position.x, pin.position.y, r);
  }
  if (vccPins.length) gfx.fill({ color: BOARD_COLORS.netHighlight, alpha: s.netHighlightAlpha });

  // Selection rect around U1
  const eb = computeEffectiveBounds(u1.bounds, u1.pins, s);
  const sp = s.selectionPadding;
  gfx.rect(eb.px - sp, eb.py - sp, eb.pw + sp * 2, eb.ph + sp * 2);
  gfx.fill({ color: 0xffffff, alpha: s.selectionFillAlpha });
  gfx.stroke({ width: s.selectionWidth, color: BOARD_COLORS.partSelected, alpha: 0.9 });
}

// ── Net lines (VCC3V3 connections from U1 to R1 and C1) ──────────────────────

function buildNetLines(gfx: Graphics, s: RenderSettings) {
  gfx.clear();

  const u1 = MOCK_BOARD.parts[0]; // U1
  const u1eb = computeEffectiveBounds(u1.bounds, u1.pins, s);
  const u1cx = u1eb.px + u1eb.pw / 2;
  const u1cy = u1eb.py + u1eb.ph / 2;

  // VCC3V3 target parts: R1 pin 1, C1 pin 1
  const targets = [
    MOCK_BOARD.parts[1], // R1
    MOCK_BOARD.parts[2], // C1
  ];

  for (const part of targets) {
    const eb = computeEffectiveBounds(part.bounds, part.pins, s);
    const tcx = eb.px + eb.pw / 2;
    const tcy = eb.py + eb.ph / 2;

    if (s.netLineDashed) {
      // Simple dashed line
      const dx = tcx - u1cx, dy = tcy - u1cy;
      const len = Math.sqrt(dx * dx + dy * dy);
      const dashLen = s.netLineDashLength;
      const ux = dx / len, uy = dy / len;
      let pos = 0;
      let drawing = true;
      while (pos < len) {
        const segEnd = Math.min(pos + dashLen, len);
        if (drawing) {
          gfx.moveTo(u1cx + ux * pos, u1cy + uy * pos);
          gfx.lineTo(u1cx + ux * segEnd, u1cy + uy * segEnd);
        }
        pos = segEnd;
        drawing = !drawing;
      }
      gfx.stroke({ width: s.netLineWidth, color: s.netLineColor, alpha: s.netLineAlpha });
    } else {
      gfx.moveTo(u1cx, u1cy);
      gfx.lineTo(tcx, tcy);
      gfx.stroke({ width: s.netLineWidth, color: s.netLineColor, alpha: s.netLineAlpha });
    }
  }
}

// ── Internal state held in a ref (avoids re-renders on every event) ──────────

interface PixiState {
  app:            Application;
  viewport:       Viewport;
  selectionGfx:   Graphics;
  netLinesGfx:    Graphics;
  sceneRoot:      Container | null;
  labelsRoot:     Container | null;
  resizeObserver: ResizeObserver;
}

function fitMockup(viewport: Viewport) {
  const b = MOCK_BOARD.bounds;
  const bw = b.maxX - b.minX;
  const bh = b.maxY - b.minY;
  // Fit to content, then scale to 80%
  viewport.fit(true, bw, bh);
  viewport.scale.set(viewport.scale.x * 0.8, viewport.scale.y * 0.8);
  viewport.moveCenter((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2);
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SettingsMockup({
  settings,
  onElementClick,
}: {
  settings: RenderSettings;
  onElementClick?: (section: MockupSectionId) => void;
}) {
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const pixiRef      = useRef<PixiState | null>(null);
  const settingsRef  = useRef(settings);
  const onClickRef   = useRef(onElementClick);
  // Refs mirror the latest props so event handlers (pointermove/dblclick) and
  // the init effect read fresh values without re-binding listeners. Updating
  // refs inside an effect (not during render) keeps React 19's refs-rule happy.
  useEffect(() => {
    settingsRef.current = settings;
    onClickRef.current = onElementClick;
  });

  const [zoomPct, setZoomPct] = useState(100);

  // Rebuild PixiJS scene from settings (no viewport reset — preserves user zoom/pan)
  const rebuildScene = useCallback((state: PixiState, s: RenderSettings) => {
    const st = state as { sceneRoot: Container | null; labelsRoot: Container | null };
    if (st.sceneRoot) {
      state.viewport.removeChild(st.sceneRoot);
      st.sceneRoot.destroy({ children: true });
      st.sceneRoot = null;
    }
    if (st.labelsRoot) {
      state.viewport.removeChild(st.labelsRoot);
      st.labelsRoot.destroy({ children: true });
      st.labelsRoot = null;
    }
    let graph;
    try {
      graph = buildBoardScene(MOCK_BOARD, { ...s, showPadVertices: false });
    } catch (err) {
      log.render.error('buildBoardScene failed:', err);
      return;
    }
    // Lift labels out of the scene so they render above selection/highlight overlays
    const labelsRoot = new Container();
    for (const label of graph.labels) {
      const wx = label.x, wy = label.y;
      label.parent?.removeChild(label);
      label.x = wx; label.y = wy;
      labelsRoot.addChild(label);
    }
    state.viewport.addChild(graph.root);
    st.sceneRoot = graph.root;
    // Z-order: scene → net lines → selection highlights → labels (shadow covers highlights)
    state.viewport.addChild(state.netLinesGfx);
    buildNetLines(state.netLinesGfx, s);
    state.viewport.addChild(state.selectionGfx);
    buildSelectionOverlay(state.selectionGfx, s);
    state.viewport.addChild(labelsRoot);
    st.labelsRoot = labelsRoot;
  }, []);

  // ── Mount / unmount ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let destroyed = false;
    let onPointerMove: ((ev: PointerEvent) => void) | null = null;
    let onDblClick: (() => void) | null = null;
    const app = new Application();

    app.init({
      background:   BOARD_COLORS.background,
      width:        el.clientWidth  || 400,
      height:       el.clientHeight || 260,
      antialias:    true,
      resolution:   window.devicePixelRatio || 1,
      autoDensity:  true,
    }).then(() => {
      if (destroyed) { return; }

      el.appendChild(app.canvas as HTMLCanvasElement);

      const viewport = new Viewport({
        screenWidth:  el.clientWidth,
        screenHeight: el.clientHeight,
        events:       app.renderer.events,
      });

      // Same plugin setup as main board, but with slower wheel zoom (percent: 0.05)
      viewport
        .drag()
        .pinch()
        .wheel({ smooth: 5, percent: 0.05 })
        .decelerate({ friction: 0.95 })
        .clampZoom({ minScale: 0.001, maxScale: 100 });

      app.stage.addChild(viewport);

      const selectionGfx = new Graphics();
      const netLinesGfx = new Graphics();
      const state: PixiState = {
        app, viewport, selectionGfx, netLinesGfx,
        sceneRoot: null, labelsRoot: null,
        resizeObserver: null!,
      };
      pixiRef.current = state;

      // Zoom badge: poll on ticker (catches decelerate animation too)
      let lastZoom = -1;
      app.ticker.add(() => {
        const z = Math.round(viewport.scale.x * 100);
        if (z !== lastZoom) { lastZoom = z; setZoomPct(z); }
      });

      // Click to navigate settings
      viewport.on('clicked', (e: unknown) => {
        const world = (e as { world: { x: number; y: number } }).world;
        const section = hitTestSection(world, settingsRef.current);
        if (section) onClickRef.current?.(section);
      });

      // Cursor updates
      const canvas = app.canvas as HTMLCanvasElement;
      onPointerMove = (ev: PointerEvent) => {
        const rect  = canvas.getBoundingClientRect();
        const world = viewport.toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        const hit   = hitTestSection(world, settingsRef.current);
        canvas.style.cursor = hit ? 'pointer' : 'default';
      };
      canvas.addEventListener('pointermove', onPointerMove);

      // Double-click resets zoom/pan to fit
      onDblClick = () => {
        fitMockup(viewport);
      };
      canvas.addEventListener('dblclick', onDblClick);

      // Resize observer — also handles initial fit when container gets its real size
      let hasFitted = false;
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth, h = el.clientHeight;
        if (w === 0 || h === 0) return;
        viewport.resize(w, h);
        app.renderer.resize(w, h);
        if (!hasFitted) {
          hasFitted = true;
          fitMockup(viewport);
        }
      });
      ro.observe(el);
      state.resizeObserver = ro;

      // Initial scene + fit (fit may be deferred if container has no size yet)
      rebuildScene(state, settingsRef.current);
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        fitMockup(viewport);
        hasFitted = true;
      }
    });

    return () => {
      destroyed = true;
      const state = pixiRef.current;
      if (state) {
        state.resizeObserver?.disconnect();
        state.netLinesGfx.destroy();
        state.selectionGfx.destroy();
        if (state.labelsRoot) {
          state.viewport.removeChild(state.labelsRoot);
          state.labelsRoot.destroy({ children: true });
        }
        if (state.sceneRoot) {
          state.viewport.removeChild(state.sceneRoot);
          state.sceneRoot.destroy({ children: true });
        }
        const canvas = state.app.canvas as HTMLCanvasElement;
        if (onPointerMove) canvas.removeEventListener('pointermove', onPointerMove);
        if (onDblClick) canvas.removeEventListener('dblclick', onDblClick);
        if (el.contains(canvas)) el.removeChild(canvas);
        // Do NOT call app.destroy() — PixiJS v8 destroy() corrupts the global
        // batch pool, breaking all other Application instances. But DO release the
        // WebGL context explicitly (mirrors BoardRenderer.teardownForReinit) so the
        // browser reclaims the GPU slot immediately — otherwise each Settings
        // open/close orphans an un-lost context until the browser's ~16-context cap
        // force-loses the oldest. Then let GC reclaim the rest.
        try {
          const gl = (state.app.renderer as unknown as { gl?: WebGL2RenderingContext })?.gl;
          gl?.getExtension('WEBGL_lose_context')?.loseContext();
        } catch { /* renderer may already be gone */ }
        pixiRef.current = null;
      }
    };
  }, [rebuildScene]);

  // ── Settings changes → rebuild scene (debounced to avoid per-pixel slider rebuilds) ──
  useEffect(() => {
    const state = pixiRef.current;
    if (!state) return;
    const id = requestAnimationFrame(() => rebuildScene(state, settings));
    return () => cancelAnimationFrame(id);
  }, [settings, rebuildScene]);

  return (
    <div className="settings-mockup" ref={wrapperRef}>
      <div className={`mockup-zoom-badge${zoomPct !== 100 ? ' mockup-zoom-active' : ''}`}>
        {zoomPct}%
      </div>
      <div className="mockup-hint">
        scroll to zoom · drag to pan · dbl-click to fit
      </div>
    </div>
  );
}
