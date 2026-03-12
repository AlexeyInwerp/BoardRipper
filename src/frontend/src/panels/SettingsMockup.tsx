/**
 * Settings preview mockup.
 * Uses the SAME PixiJS rendering pipeline (buildBoardScene) as the main board view —
 * visual changes in BoardRenderer automatically reflect here.
 */
import { useRef, useEffect, useState, useCallback } from 'react';
import { Application, Graphics } from 'pixi.js';
import type { Container } from 'pixi.js';
import { Viewport } from 'pixi-viewport';
import type { RenderSettings } from '../store/render-settings';
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

// ── Internal state held in a ref (avoids re-renders on every event) ──────────

interface PixiState {
  app:            Application;
  viewport:       Viewport;
  selectionGfx:   Graphics;
  sceneRoot:      Container | null;
  resizeObserver: ResizeObserver;
}

function fitMockup(viewport: Viewport) {
  const b   = MOCK_BOARD.bounds;
  const pad = 20;
  viewport.fit(true, b.maxX - b.minX + pad * 2, b.maxY - b.minY + pad * 2);
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
  settingsRef.current = settings;
  const onClickRef   = useRef(onElementClick);
  onClickRef.current = onElementClick;

  const [zoomPct, setZoomPct] = useState(100);

  // Rebuild PixiJS scene from settings (no viewport reset — preserves user zoom/pan)
  const rebuildScene = useCallback((state: PixiState, s: RenderSettings) => {
    if (state.sceneRoot) {
      state.viewport.removeChild(state.sceneRoot);
      state.sceneRoot.destroy({ children: true });
      (state as { sceneRoot: Container | null }).sceneRoot = null;
    }
    const graph = buildBoardScene(MOCK_BOARD, s);
    state.viewport.addChild(graph.root);
    (state as { sceneRoot: Container | null }).sceneRoot = graph.root;
    // Keep selection overlay on top
    state.viewport.addChild(state.selectionGfx);
    buildSelectionOverlay(state.selectionGfx, s);
  }, []);

  // ── Mount / unmount ─────────────────────────────────────────────────────────
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;

    let destroyed = false;
    const app = new Application();

    app.init({
      background:   BOARD_COLORS.background,
      width:        el.clientWidth  || 400,
      height:       el.clientHeight || 260,
      antialias:    true,
      resolution:   window.devicePixelRatio || 1,
      autoDensity:  true,
    }).then(() => {
      if (destroyed) { app.destroy(); return; }

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
      const state: PixiState = {
        app, viewport, selectionGfx,
        sceneRoot: null,
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
      canvas.addEventListener('pointermove', (ev: PointerEvent) => {
        const rect  = canvas.getBoundingClientRect();
        const world = viewport.toWorld(ev.clientX - rect.left, ev.clientY - rect.top);
        const hit   = hitTestSection(world, settingsRef.current);
        canvas.style.cursor = hit ? 'pointer' : 'default';
      });

      // Double-click resets zoom/pan to fit
      canvas.addEventListener('dblclick', () => {
        fitMockup(viewport);
      });

      // Resize observer
      const ro = new ResizeObserver(() => {
        viewport.resize(el.clientWidth, el.clientHeight);
        app.renderer.resize(el.clientWidth, el.clientHeight);
      });
      ro.observe(el);
      state.resizeObserver = ro;

      // Initial scene + fit
      rebuildScene(state, settingsRef.current);
      fitMockup(viewport);
    });

    return () => {
      destroyed = true;
      const state = pixiRef.current;
      if (state) {
        state.resizeObserver?.disconnect();
        state.selectionGfx.destroy();
        if (state.sceneRoot) {
          state.viewport.removeChild(state.sceneRoot);
          state.sceneRoot.destroy({ children: true });
        }
        const canvas = state.app.canvas as HTMLCanvasElement;
        if (el.contains(canvas)) el.removeChild(canvas);
        state.app.destroy();
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
