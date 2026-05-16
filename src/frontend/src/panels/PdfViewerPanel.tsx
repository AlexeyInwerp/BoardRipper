import { useRef, useEffect, useCallback, useState, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { usePdfDoc } from '../hooks/usePdfStore';
import { pdfStore, pdfFontSize } from '../store/pdf-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from '../components/BindLink';
import { boardPanelId, activateLinkedPanel, isAutoSwitchLinked, setAutoSwitchLinked, onAutoSwitchChange } from '../store/dockview-api';
import { openBoardSearch } from './BoardViewerPanel';
import { fileInputRefs } from '../store/file-inputs';
import { contextMenuStore } from '../store/context-menu-store';
import { log } from '../store/log-store';
import type { GlyphDebugState, PageGlyphData } from '../pdf/glyph-types';
import { DEFAULT_GLYPH_DEBUG_STATE } from '../pdf/glyph-types';
import { extractPageGlyphs, clearFontCache } from '../pdf/glyph-extractor';
import { drawGlyphBoxes, drawGlyphOutlines, drawTextItems } from '../pdf/glyph-overlay';
import { drawSimplifiedGlyphs } from '../pdf/glyph-simplifier';
import type { SimplifyStats } from '../pdf/glyph-simplifier';
import { drawMonospaceReplacement } from '../pdf/glyph-replacer';
import { IconArrowAutofitWidth, IconBookmarkPlus, IconWand, IconHandMove, IconZoomIn } from '@tabler/icons-react';
import {
  TILE_SIZE, computeTileGrid, tileRenderRequest,
  getTileCached, putTileCached, invalidateTileCache,
  setTileCacheLimit,
} from '../pdf/tile-manager';
import type { TileGridInfo } from '../pdf/tile-manager';
import { renderSettingsStore, isPdfWatermarkText } from '../store/render-settings';
import { invertScrollBindings, useBareScrollAction } from '../store/scroll-mode';

const DRAG_THRESHOLD = 3;
const TOUCH_PINCH_FACTOR = 2;       // amplify touch-screen pinch (pointer events)
const TRACKPAD_PINCH_SPEED = 0.01;  // trackpad pinch sensitivity (10× faster than mouse wheel)
const MOUSE_WHEEL_SPEED = 0.001;    // mouse wheel zoom sensitivity
const LINE_HEIGHT_RATIO = 1.2;
const NIGHT_MODE_KEY = 'boardripper-pdf-nightmode';
const CLEAN_CONTRAST_KEY = 'boardripper-pdf-clean-contrast';
const DEFAULT_CLEAN_CONTRAST = 3;

/** The three scroll wheel actions */
export type ScrollAction = 'zoom' | 'pan' | 'switch';
export const SCROLL_ACTIONS: ScrollAction[] = ['zoom', 'pan', 'switch'];

/** Which action is assigned to each modifier (must be a permutation of all 3 actions) */
export interface ScrollBindings {
  bare: ScrollAction;   // no modifier
  shift: ScrollAction;  // shift + scroll
  meta: ScrollAction;   // cmd (mac) / ctrl (win) + scroll
}

export const PDF_INERTIA_KEY = 'boardripper-pdf-inertia';
export function loadPdfInertia(): boolean {
  try { return localStorage.getItem(PDF_INERTIA_KEY) !== 'false'; } catch { return true; }
}

export const SCROLL_BINDINGS_KEY = 'boardripper-pdf-scroll-bindings';
export const DEFAULT_SCROLL_BINDINGS: ScrollBindings = { bare: 'pan', shift: 'zoom', meta: 'switch' };

export function loadScrollBindings(): ScrollBindings {
  try {
    const raw = localStorage.getItem(SCROLL_BINDINGS_KEY);
    if (!raw) return DEFAULT_SCROLL_BINDINGS;
    const parsed = JSON.parse(raw) as ScrollBindings;
    // Validate: must be a valid permutation
    const vals = new Set([parsed.bare, parsed.shift, parsed.meta]);
    if (vals.size === 3 && SCROLL_ACTIONS.every(a => vals.has(a))) return parsed;
  } catch { /* ignore */ }
  return DEFAULT_SCROLL_BINDINGS;
}

// ---------------------------------------------------------------------------
// PDF Render Quality Settings
// ---------------------------------------------------------------------------
// These control how pdf.js renders pages at different zoom levels.
// The render pipeline works as follows:
//
//   1. User zooms to level Z (e.g. 5x)
//   2. mainTierFromZoom(Z) computes the render tier: min(Z, maxTier)
//   3. quantiseTier() snaps to discrete steps to maximize cache hits
//   4. hysteresisFilter() prevents tier thrashing at boundaries
//   5. pdf.js renders the page at baseScale * tier into an offscreen canvas
//   6. The canvas is displayed via CSS transform: scale(Z / tier) for any gap
//   7. Adjacent pages render after a settle delay at their own tier (adjTier)
//
// When "drawing optimization" (future work: tiled viewport rendering) is
// implemented, the tier system will be replaced by fixed-size tiles rendered
// only for the visible viewport region. The settings below will then control
// tile size, tile budget, and tile priority — but the user-facing labels
// (Quality / Performance / Battery) remain the same.
// ---------------------------------------------------------------------------

/**
 * Render quality presets. Each preset balances sharpness vs GPU/CPU cost.
 *
 * - **max**:   Tier tracks zoom 1:1 up to 16×. Pixel-perfect text at all zoom
 *              levels. High GPU memory and render time. Best for desktop with
 *              dedicated GPU.
 *
 * - **high**:  Tier tracks zoom up to 8×. Crisp text in most scenarios.
 *              Good balance for modern laptops. (Default)
 *
 * - **medium**: Tier capped at 4×. Text may soften above 400% zoom. Smooth
 *              on integrated GPUs and tablets.
 *
 * - **low**:   Tier capped at 2×. Noticeable softness above 200% zoom. Best
 *              for older machines or battery-sensitive contexts.
 *
 * When future optimizations land (OffscreenCanvas workers, tiled viewport
 * rendering, WebGL tile compositing), these presets will be updated to also
 * control tile budget and worker count, but the preset names stay stable.
 */
export type PdfRenderQuality = 'max' | 'high' | 'medium' | 'low';
export const PDF_RENDER_QUALITY_OPTIONS: PdfRenderQuality[] = ['max', 'high', 'medium', 'low'];

export interface PdfQualityConfig {
  /** Max render tier for the main (current) page */
  maxMainTier: number;
  /** Max render tier for adjacent (prev/next) pages */
  maxAdjTier: number;
  /** Delay (ms) before adjacent pages re-render after zoom settles */
  adjSettleMs: number;
  /** Max entries in the page render cache */
  cacheMaxEntries: number;
  /** Max total pixels across all cached page bitmaps */
  cacheMaxPixels: number;
  /** Max canvas dimension (px) — controls render resolution ceiling */
  maxCanvasDim: number;
}

// Higher tiers = crisper text. maxCanvasDim controls the resolution ceiling per preset.
const QUALITY_CONFIGS: Record<PdfRenderQuality, PdfQualityConfig> = {
  max:    { maxMainTier: 16, maxAdjTier: 6,  adjSettleMs: 100, cacheMaxEntries: 24, cacheMaxPixels: 200_000_000, maxCanvasDim: 16384 },
  high:   { maxMainTier: 10, maxAdjTier: 4,  adjSettleMs: 150, cacheMaxEntries: 16, cacheMaxPixels: 120_000_000, maxCanvasDim: 8192  },
  medium: { maxMainTier: 6,  maxAdjTier: 2,  adjSettleMs: 200, cacheMaxEntries: 10, cacheMaxPixels: 60_000_000,  maxCanvasDim: 4096  },
  low:    { maxMainTier: 4,  maxAdjTier: 1,  adjSettleMs: 300, cacheMaxEntries: 6,  cacheMaxPixels: 30_000_000,  maxCanvasDim: 2048  },
};

export const PDF_QUALITY_KEY = 'boardripper-pdf-render-quality';

export function loadPdfQuality(): PdfRenderQuality {
  try {
    const raw = localStorage.getItem(PDF_QUALITY_KEY) as PdfRenderQuality | null;
    if (raw && raw in QUALITY_CONFIGS) return raw;
  } catch { /* ignore */ }
  return 'high';
}

/** Scale cache limits by device memory (navigator.deviceMemory).
 *  Low-RAM devices (≤2GB) get halved pixel budgets to prevent OOM. */
function applyDeviceMemoryScaling(cfg: PdfQualityConfig): PdfQualityConfig {
  const mem = (navigator as { deviceMemory?: number }).deviceMemory;
  if (!mem || mem >= 4) return cfg; // 4GB+ or unknown — use full config
  const scale = mem <= 2 ? 0.5 : 0.75;
  return {
    ...cfg,
    cacheMaxEntries: Math.max(4, Math.round(cfg.cacheMaxEntries * scale)),
    cacheMaxPixels: Math.round(cfg.cacheMaxPixels * scale),
  };
}

/** Detect WebKit/Safari (including iOS Safari, iPad Safari, and macOS Safari).
 *  Used as a belt-and-suspenders cap in case the canvas-area probe doesn't
 *  catch every Safari silent-clamp variant. WebKit-only `GestureEvent` is
 *  the most reliable feature-detect — Chromium and Firefox don't ship it. */
function isWebKit(): boolean {
  if (typeof window === 'undefined') return false;
  return typeof (window as { GestureEvent?: unknown }).GestureEvent !== 'undefined';
}

/** Probe the browser's actual maximum canvas dimension. WebKit/Safari
 *  silently caps the backing store while still reporting the requested
 *  width/height — so width-readback alone doesn't catch the truth.
 *  We draw a sentinel pixel at the far corner and read it back; if the
 *  backing store was clamped, the pixel write/read fails or returns 0.
 *  In addition, WebKit gets a hard ceiling at 4096 because some macOS
 *  Safari builds report a successful draw at 8192² but produce blurry
 *  output downstream — likely an internal `createImageBitmap` cap. */
function probeMaxCanvasDim(): number {
  if (typeof document === 'undefined') return 4096; // SSR / test
  const ceiling = isWebKit() ? 4096 : 16384;
  const c = document.createElement('canvas');
  for (const dim of [16384, 8192, 4096, 2048]) {
    if (dim > ceiling) continue;
    try {
      c.width = dim;
      c.height = dim;
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      // Draw a sentinel at the bottom-right corner. Safari's silent clamp
      // means the corner pixel either won't be written (write succeeds
      // silently but no backing) or readback returns 0/throws.
      ctx.fillStyle = '#ff00ff';
      ctx.fillRect(dim - 2, dim - 2, 2, 2);
      const px = ctx.getImageData(dim - 1, dim - 1, 1, 1).data;
      if (px[0] === 0xff && px[2] === 0xff) return dim;
    } catch { /* taint / out-of-bounds / OOM — try next smaller */ }
  }
  return 2048;
}
const PROBED_MAX_CANVAS_DIM = probeMaxCanvasDim();
log.pdf.log(`probed canvas-dim = ${PROBED_MAX_CANVAS_DIM}px (WebKit:${isWebKit()}; full-page path only)`);

/** Clamp scale for the full-page render path (one giant canvas). Uses the
 *  smaller of the preset's nominal maxCanvasDim and the browser's actually-
 *  achievable canvas dim. Safari silently shrinks oversize canvases, so
 *  trusting the preset alone produces blurry output above the real limit. */
function clampFullPageScale(pageW: number, pageH: number, scale: number, presetMaxDim: number): number {
  return clampCanvasScale(pageW, pageH, scale, Math.min(presetMaxDim, PROBED_MAX_CANVAS_DIM));
}

export function getPdfQualityConfig(q: PdfRenderQuality): PdfQualityConfig {
  // No probe-clamp here. The preset's `maxCanvasDim` is used as a memory
  // budget for the tile path (where each tile renders into its own 1024px
  // canvas, well under any browser limit). The single full-page canvas
  // path applies the probe-clamp via `clampFullPageScale` at its call
  // sites so Safari's stricter limit doesn't shrink the tile-path budget.
  return applyDeviceMemoryScaling(QUALITY_CONFIGS[q]);
}

const TIER_DEBOUNCE_MS = 60; // trailing debounce — guarantees final crisp frame after zoom

/** Compute main-page render tier from zoom, capped by quality config. */
function mainTierFromZoom(zoom: number, maxTier: number): number {
  return Math.max(1, Math.min(zoom, maxTier));
}
/** Quantise tier to half-integer steps to reduce cache key thrashing. */
function quantiseTier(tier: number): number {
  return Math.round(tier * 2) / 2;
}

/**
 * Zoom hysteresis: prevent tier thrashing at quantisation boundaries.
 * Upgrade eagerly (users notice blur), downgrade lazily (over-res is invisible).
 * Returns the new tier, or the current tier if within the hysteresis band.
 */
const TIER_UP_THRESHOLD = 1.05;   // must exceed boundary by 5% to upgrade
const TIER_DOWN_THRESHOLD = 0.90; // must drop 10% below boundary to downgrade
let _lastCommittedTier = 1;
function hysteresisFilter(rawTier: number): number {
  if (rawTier > _lastCommittedTier * TIER_UP_THRESHOLD) {
    _lastCommittedTier = rawTier;
  } else if (rawTier < _lastCommittedTier * TIER_DOWN_THRESHOLD) {
    _lastCommittedTier = rawTier;
  }
  // else: stay at _lastCommittedTier (within hysteresis band)
  return _lastCommittedTier;
}

// --- Offscreen canvas pool (avoids GC churn during fast zoom/page navigation) ---
const CANVAS_POOL_CAP = 8;
const _canvasPool: HTMLCanvasElement[] = [];
function acquireCanvas(w: number, h: number): HTMLCanvasElement {
  const c = _canvasPool.pop() ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function releaseCanvas(c: HTMLCanvasElement): void {
  c.width = 1;
  c.height = 1;
  if (_canvasPool.length < CANVAS_POOL_CAP) _canvasPool.push(c);
}

/** Clamp a pdf.js render scale so the resulting canvas stays within GPU limits. */
/** Per-(pageW:pageH:maxDim) throttle so we log each distinct clamp once per
 *  session rather than on every tile/render. */
const _clampLogged = new Set<string>();

function clampCanvasScale(pageW: number, pageH: number, scale: number, maxDim: number): number {
  const maxArea = maxDim * maxDim;
  const requested = scale;
  let w = pageW * scale;
  let h = pageH * scale;
  if (w > maxDim || h > maxDim) {
    scale *= Math.min(maxDim / w, maxDim / h);
    w = pageW * scale;
    h = pageH * scale;
  }
  if (w * h > maxArea) {
    scale *= Math.sqrt(maxArea / (w * h));
  }
  if (scale < requested) {
    const key = `${Math.round(pageW)}:${Math.round(pageH)}:${maxDim}`;
    if (!_clampLogged.has(key)) {
      _clampLogged.add(key);
      log.perf.warn(
        `clampCanvasScale: ${Math.round(pageW)}×${Math.round(pageH)} pt @ requested=${requested.toFixed(2)} ` +
        `clamped=${scale.toFixed(2)} (${Math.round((scale / requested) * 100)}%, maxDim=${maxDim}). ` +
        `Page too large for target tier — visible result will be softer than quality preset implies.`
      );
    }
  }
  return scale;
}

// --- Page render cache (LRU, module-level shared across all PDF panels) ---
interface CachedRender {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  cssW: number;
  cssH: number;
  baseScale: number;
  hiresScale: number;
  vpHeight: number;
  vpTransform: number[];
}
// Cache limits are set dynamically from quality config via _pageCacheLimits
let _pageCacheMaxEntries = 10;
let _pageCacheMaxPixels = 80_000_000;
/** Update cache limits from quality config (called when quality changes) */
export function setPageCacheLimits(maxEntries: number, maxPixels: number): void {
  _pageCacheMaxEntries = maxEntries;
  _pageCacheMaxPixels = maxPixels;
}
const _pageCache = new Map<string, CachedRender>();
let _pageCacheTotalPixels = 0;

function pageCacheKey(file: string, page: number, tier: number, clean: boolean): string {
  return `${file}:${page}:${tier}:${clean ? 1 : 0}`;
}

function putPageCache(key: string, entry: CachedRender): void {
  const entryPixels = entry.width * entry.height;
  // LRU eviction: enforce both entry count and total pixel area
  while (
    _pageCache.size > 0 &&
    (_pageCache.size >= _pageCacheMaxEntries || _pageCacheTotalPixels + entryPixels > _pageCacheMaxPixels)
  ) {
    const oldest = _pageCache.keys().next().value!;
    const old = _pageCache.get(oldest)!;
    _pageCacheTotalPixels -= old.width * old.height;
    old.bitmap.close();
    _pageCache.delete(oldest);
  }
  _pageCacheTotalPixels += entryPixels;
  _pageCache.set(key, entry);
}

function getPageCache(key: string): CachedRender | undefined {
  const entry = _pageCache.get(key);
  if (entry) {
    // Move to end (most recently used)
    _pageCache.delete(key);
    _pageCache.set(key, entry);
  }
  return entry;
}

/** Find the best (highest-tier) cached render for a page, regardless of tier. */
function getBestPageCache(file: string, page: number, clean: boolean): CachedRender | undefined {
  let best: { key: string; entry: CachedRender; tier: number } | undefined;
  for (const [key, entry] of _pageCache) {
    if (key.startsWith(`${file}:${page}:`) && key.endsWith(`:${clean ? 1 : 0}`)) {
      const tier = parseFloat(key.split(':')[2]);
      if (!best || tier > best.tier) {
        best = { key, entry, tier };
      }
    }
  }
  if (best) {
    _pageCache.delete(best.key);
    _pageCache.set(best.key, best.entry);
  }
  return best?.entry;
}

// --- Preview cache: always-available tier-1 renders (never evicted by hi-res) ---
const PREVIEW_CACHE_MAX = 6;
const _previewCache = new Map<string, CachedRender>();
function previewCacheKey(file: string, page: number, clean: boolean): string {
  return `${file}:${page}:${clean ? 1 : 0}`;
}
function putPreviewCache(key: string, entry: CachedRender): void {
  if (_previewCache.size >= PREVIEW_CACHE_MAX && !_previewCache.has(key)) {
    const oldest = _previewCache.keys().next().value!;
    _previewCache.get(oldest)!.bitmap.close();
    _previewCache.delete(oldest);
  }
  const existing = _previewCache.get(key);
  if (existing) existing.bitmap.close();
  _previewCache.set(key, entry);
}
function getPreviewCache(key: string): CachedRender | undefined {
  const entry = _previewCache.get(key);
  if (entry) { _previewCache.delete(key); _previewCache.set(key, entry); }
  return entry;
}

/** Invalidate all cache entries for a given file (e.g. on clean mode toggle) */
export function invalidatePageCache(file?: string): void {
  if (!file) {
    for (const e of _pageCache.values()) e.bitmap.close();
    _pageCache.clear();
    _pageCacheTotalPixels = 0;
    for (const e of _previewCache.values()) e.bitmap.close();
    _previewCache.clear();
    return;
  }
  for (const [k, v] of _pageCache) {
    if (k.startsWith(file + ':')) {
      _pageCacheTotalPixels -= v.width * v.height;
      v.bitmap.close();
      _pageCache.delete(k);
    }
  }
  for (const [k, v] of _previewCache) {
    if (k.startsWith(file + ':')) { v.bitmap.close(); _previewCache.delete(k); }
  }
}

/** Transform a PDF-space point to canvas-pixel-space */
function toCanvas(px: number, py: number, vpT: number[], scale: number): [number, number] {
  return [
    (vpT[0] * px + vpT[2] * py + vpT[4]) * scale,
    (vpT[1] * px + vpT[3] * py + vpT[5]) * scale,
  ];
}

/** Compute a text item's axis-aligned bounding rect in canvas-space.
 *  Handles rotated/skewed text by projecting all 4 corners of the oriented
 *  text rectangle through the viewport transform and taking the AABB.
 *  Baseline at (e,f): ascent = 1.0×fontSize up, descent = 0.2×fontSize down. */
function textItemRect(
  transform: number[], width: number, vpT: number[], scale: number,
): { x: number; y: number; w: number; h: number } {
  const t = transform;
  const fsx = Math.sqrt(t[0] * t[0] + t[1] * t[1]);
  const fsy = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
  const fontSize = fsy;
  const ascent = fontSize;                                // 1.0× up from baseline
  const descent = (LINE_HEIGHT_RATIO - 1.0) * fontSize;  // 0.2× down from baseline

  const dx = fsx > 0 ? t[0] / fsx : 1;
  const dy = fsx > 0 ? t[1] / fsx : 0;
  const ux = fsy > 0 ? t[2] / fsy : 0;
  const uy = fsy > 0 ? t[3] / fsy : 1;

  const ex = t[4], ey = t[5];
  const c0 = toCanvas(ex - descent * ux,          ey - descent * uy,          vpT, scale);
  const c1 = toCanvas(ex + width * dx - descent * ux, ey + width * dy - descent * uy, vpT, scale);
  const c2 = toCanvas(ex + ascent * ux,            ey + ascent * uy,            vpT, scale);
  const c3 = toCanvas(ex + width * dx + ascent * ux, ey + width * dy + ascent * uy, vpT, scale);

  const minX = Math.min(c0[0], c1[0], c2[0], c3[0]);
  const minY = Math.min(c0[1], c1[1], c2[1], c3[1]);
  const maxX = Math.max(c0[0], c1[0], c2[0], c3[0]);
  const maxY = Math.max(c0[1], c1[1], c2[1], c3[1]);

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Watermark filtering happens at the pdf.js worker / parser level via a
 *  patch in `src/frontend/patches/pdfjs-dist+<version>.patch` (applied by
 *  `npm run postinstall`). The worker examines each `showText` op's
 *  reconstructed glyph string against the filter terms forwarded through
 *  the custom `watermarkFilter` render option and drops matching ops before
 *  they enter the operator list. No client-side filter callback is needed.
 *
 *  Returns the spreadable options blob (cast through `unknown` because the
 *  upstream pdf.js types don't declare our patched-in field). Pass `[]` /
 *  empty to disable on a given render. */
function wmFilterOptions(filter: readonly string[] | undefined): Record<string, readonly string[] | null> {
  return { watermarkFilter: (filter && filter.length > 0 ? filter : null) } as Record<string, readonly string[] | null>;
}

/** Compute zoom & pan to center a group of text items in the viewport */
function zoomToItemGroup(
  items: { transform: number[]; width: number }[],
  vpT: number[], baseScale: number,
  cw: number, ch: number,
  targetFraction: number,
  floorZoom: number = 0.5,
): { zoom: number; pan: { x: number; y: number } } {
  let gx1 = Infinity, gy1 = Infinity, gx2 = -Infinity, gy2 = -Infinity;
  for (const item of items) {
    const r = textItemRect(item.transform, item.width, vpT, baseScale);
    if (r.x < gx1) gx1 = r.x;
    if (r.y < gy1) gy1 = r.y;
    if (r.x + r.w > gx2) gx2 = r.x + r.w;
    if (r.y + r.h > gy2) gy2 = r.y + r.h;
  }
  const mcx = (gx1 + gx2) / 2;
  const mcy = (gy1 + gy2) / 2;
  const groupW = Math.max(gx2 - gx1, 1);
  const groupH = Math.max(gy2 - gy1, 1);
  const zoomByW = (cw * targetFraction) / groupW;
  const zoomByH = (ch * targetFraction) / groupH;
  const fit = Math.min(zoomByW, zoomByH);
  // Cap fit at 300% so we don't over-zoom tiny matches; then enforce a floor so
  // the caller can guarantee "at least floorZoom" (e.g. keep current zoom when
  // navigating matches).
  const zoom = Math.max(floorZoom, Math.min(fit, 3));
  return { zoom, pan: { x: cw / 2 - mcx * zoom, y: ch / 2 - mcy * zoom } };
}

/** Apply CSS transform directly to a DOM element — bypasses React for smooth 60fps pan/zoom.
 *
 *  Safari rasterizes a `transform: scale(z)` element to a Core Animation
 *  layer at the wrapper's *intrinsic* CSS size, then GPU-upscales the
 *  cached layer — at high zoom the user sees a blurry low-res copy on
 *  idle. The PDF panel works around this by sizing every wrapper child
 *  at *committed-zoom CSS pixels* (see committedZoomRef + the
 *  zCommit multipliers in renderTiledPage / blitToCanvas), then calling
 *  applyTransform with `s = currentZoom / committedZoom` — equal to 1 on
 *  idle. With s = 1 the wrapper has no scale, its intrinsic CSS size
 *  matches displayed size, and Safari rasterizes the GPU layer at full
 *  resolution. During gestures s briefly diverges; a 60ms-debounced
 *  render commits the new sizes and resets s to 1. */
function applyTransform(el: HTMLElement | null, x: number, y: number, s: number) {
  if (el) el.style.transform = `translate(${x}px,${y}px) scale(${s})`;
}

// --- Page Scrubber Rail ---
function PageScrubber({ currentPage, pageCount, onGoToPage, scrubberRef }: {
  currentPage: number;
  pageCount: number;
  onGoToPage: (page: number) => void;
  scrubberRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [hoverPage, setHoverPage] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const pageFromY = useCallback((clientY: number) => {
    const rail = railRef.current;
    if (!rail) return 1;
    const rect = rail.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.max(1, Math.min(pageCount, Math.round(ratio * (pageCount - 1) + 1)));
  }, [pageCount]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    const page = pageFromY(e.clientY);
    setHoverPage(page);
    onGoToPage(page);
  }, [pageFromY, onGoToPage]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const page = pageFromY(e.clientY);
    setHoverPage(page);
    if (isDragging) onGoToPage(page);
  }, [pageFromY, isDragging, onGoToPage]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    setIsDragging(false);
  }, []);

  // Thumb position as percentage
  const thumbPct = pageCount > 1 ? ((currentPage - 1) / (pageCount - 1)) * 100 : 0;

  return (
    <div
      className={`pdf-scrubber${isDragging ? ' dragging' : ''}`}
      ref={(el) => { (railRef as React.MutableRefObject<HTMLDivElement | null>).current = el; if (scrubberRef) scrubberRef.current = el; }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setIsDragging(false)}
      onPointerLeave={() => { if (!isDragging) setHoverPage(null); }}
      onPointerEnter={(e) => setHoverPage(pageFromY(e.clientY))}
    >
      <div className="pdf-scrubber-track">
        <div className="pdf-scrubber-thumb" style={{ top: `${thumbPct}%` }} />
      </div>
      {hoverPage !== null && (
        <div className="pdf-scrubber-tooltip" style={{ top: `${((hoverPage - 1) / Math.max(1, pageCount - 1)) * 100}%` }}>
          {hoverPage}
        </div>
      )}
    </div>
  );
}

export function PdfViewerPanel(props: IDockviewPanelProps<{ pdfFileName?: string }>) {
  const pdfFileName = props.params.pdfFileName ?? '';
  const { isLoaded, textExtracting, textExtractProgress, pageCount, currentPage, searchQuery, matches, activeMatchIndex, matchGroupCount, activeGroupIndex, isMultiTerm, isAtSyntax, multiTermYGap, multiTermXGap, bookmarks, cleanMode, lookupHint } = usePdfDoc(pdfFileName);
  const { tabs } = useBoardStore();
  const autoSwitchLinked = useSyncExternalStore(onAutoSwitchChange, isAutoSwitchLinked);

  // Switch pdfStore to this panel's document on activation (for mutations)
  useEffect(() => {
    if (!pdfFileName) return;
    // Also switch when this panel becomes active (focused)
    const disposable = props.api.onDidActiveChange((e) => {
      log.pdf.log(`onDidActiveChange pdf=${pdfFileName} isActive=${e.isActive} storeActive=${boardStore.activeTabId}`);
      if (e.isActive) {
        pdfStore.switchTo(pdfFileName);
        // Register this panel's search input for global Cmd+F routing
        fileInputRefs.pdfSearch = searchInputRef.current;
        // Activate linked board panel so it follows the PDF tab
        // Gated by auto-switch flag (toggled via BindLink dropdown header).
        const linkedTab = isAutoSwitchLinked()
          ? boardStore.tabs.find(t => t.pdfFileNames.includes(pdfFileName))
          : null;
        log.pdf.log(`linkedTab=${linkedTab?.id ?? 'none'} autoSwitch=${isAutoSwitchLinked()}`);
        if (linkedTab) {
          const ok = activateLinkedPanel(boardPanelId(linkedTab.id), () => boardStore.switchTab(linkedTab.id));
          log.pdf.log(`activateLinkedPanel board-${linkedTab.id} ok=${ok}`);
        }
      }
    });
    return () => {
      // Cleanup on unmount
      if (fileInputRefs.pdfSearch === searchInputRef.current) {
        fileInputRefs.pdfSearch = null;
      }
      disposable.dispose();
    };
  }, [pdfFileName, props.api]);

  // Board binding: which board tabs have this PDF linked
  const boundBoardTabs = tabs.filter(t => t.pdfFileNames.includes(pdfFileName));
  const boardTabNames = tabs.map(t => t.fileName);

  const handleBindBoard = (boardFileName: string | null) => {
    if (boardFileName === null) {
      for (const tab of boundBoardTabs) {
        boardStore.removePdfBinding(tab.id, pdfFileName);
      }
    } else {
      // Single-select: unbind from current, bind to selected
      for (const tab of boundBoardTabs) {
        boardStore.removePdfBinding(tab.id, pdfFileName);
      }
      const target = tabs.find(t => t.fileName === boardFileName);
      if (target) {
        boardStore.addPdfBinding(target.id, pdfFileName);
      }
    }
  };

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const scaleRef = useRef(1);
  /** Actual canvas render scale (after clamping) — used for highlight positioning */
  const hiresScaleRef = useRef(1);
  /** Forward-ref to scheduleTierRender — populated below after scheduleTierRender is created.
   *  Lets syncTransform (defined earlier) trigger a debounced tile re-render on pan
   *  without circular-dependency gymnastics in the useCallback chain. */
  const scheduleTierRenderRef = useRef<() => void>(() => {});

  /** Zoom level at which every in-DOM wrapper child's CSS dimensions are
   *  currently committed. See applyTransform docstring for rationale. */
  const committedZoomRef = useRef(1);

  /** Multiply every in-DOM wrapper child's CSS left/top/width/height by
   *  `ratio`. Called when committedZoom changes so old tiles outside the
   *  current viewport-cull range stay positioned correctly relative to
   *  the new committed coords (without this, old tiles end up at stale
   *  positions and appear in the wrong place — the "random tiles"
   *  regression). The same scalar `ratio` works for tiles at every
   *  rendered scale because each tile's CSS = (col × cssTileW) ×
   *  committedZoom: when committedZoom ratios up/down, every tile's
   *  CSS scales by the same factor.
   *
   *  Idempotent for elements that are then overwritten with explicit
   *  zCommit-scaled values later in the same render. */
  const rescaleWrapperChildren = useCallback((ratio: number) => {
    if (ratio === 1 || !Number.isFinite(ratio) || ratio <= 0) return;
    const apply = (s: CSSStyleDeclaration) => {
      const left = parseFloat(s.left);
      const top = parseFloat(s.top);
      const w = parseFloat(s.width);
      const h = parseFloat(s.height);
      if (Number.isFinite(left)) s.left = `${left * ratio}px`;
      if (Number.isFinite(top)) s.top = `${top * ratio}px`;
      if (Number.isFinite(w)) s.width = `${w * ratio}px`;
      if (Number.isFinite(h)) s.height = `${h * ratio}px`;
    };
    for (const tileCanvas of tileContainerRef.current.values()) apply(tileCanvas.style);
    for (const entry of adjCanvasMapRef.current.values()) apply(entry.canvas.style);
    if (canvasRef.current) apply(canvasRef.current.style);
    if (highlightRef.current) apply(highlightRef.current.style);
  }, []);
  const viewportHeightRef = useRef(0);
  const renderTierRef = useRef(1);
  const viewportTransformRef = useRef<number[]>([1, 0, 0, -1, 0, 0]);
  const [renderEpoch, setRenderEpoch] = useState(0); // bumped after each renderPage to sync overlays
  const [showNavHint, setShowNavHint] = useState(false);
  const navHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const navHintShownRef = useRef(false);
  // Click-to-lookup overlay state
  const [clickHighlight, setClickHighlight] = useState<{ word: string; rect: { x: number; y: number; w: number; h: number }; key: number; zoom: number } | null>(null);
  const clickHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickHighlightKeyRef = useRef(0);
  // Tile DOM management
  const tileGridRef = useRef<TileGridInfo | null>(null);
  const tileRenderIdRef = useRef(0);
  const tileContainerRef = useRef<Map<string, HTMLCanvasElement>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkPhaseRef = useRef(0);

  // Pan/zoom live in refs for 60fps DOM updates; React state only for toolbar display
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoomDisplay, setZoomDisplay] = useState(1);
  const [tiledMode, setTiledMode] = useState(false);
  const zoomDisplayRafRef = useRef(0);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastDragTimeRef = useRef(0);
  const inertiaRafRef = useRef(0);
  const pdfInertiaRef = useRef(loadPdfInertia());
  const tierDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last zoom level at which highlights were drawn — skip redraw on pan-only changes */
  const lastHighlightZoomRef = useRef('');
  /** Adaptive zoom: exponential moving average of pdf.js render time (ms) */
  const renderTimeEmaRef = useRef(0);
  /** Adaptive zoom: timestamp of last throttled render start */
  const lastThrottleRenderRef = useRef(0);
  /** Delayed full-quality render — fires 500ms after zoom settles */
  const crispTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When true, renderPage ignores quality cap and renders at full zoom tier */
  const forceFullTierRef = useRef(false);
  const CRISP_SETTLE_MS = 500;

  const [nightMode, setNightMode] = useState(() => {
    try { return localStorage.getItem(NIGHT_MODE_KEY) === '1'; } catch { return false; }
  });
  const [cleanContrast] = useState(() => {
    try { const v = localStorage.getItem(CLEAN_CONTRAST_KEY); return v ? Number(v) : DEFAULT_CLEAN_CONTRAST; } catch { return DEFAULT_CLEAN_CONTRAST; }
  });
  const cleanContrastRef = useRef(cleanContrast);
  cleanContrastRef.current = cleanContrast;
  const [scrollBindings, setScrollBindings] = useState<ScrollBindings>(loadScrollBindings);
  const scrollBindingsRef = useRef(scrollBindings);
  scrollBindingsRef.current = scrollBindings;
  const bareAction = useBareScrollAction();

  // Sync scroll bindings when changed from Settings panel
  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<ScrollBindings>).detail;
      setScrollBindings(next);
      scrollBindingsRef.current = next;
    };
    window.addEventListener('pdf-scroll-bindings-changed', handler);
    const inertiaHandler = () => { pdfInertiaRef.current = loadPdfInertia(); };
    window.addEventListener('pdf-inertia-changed', inertiaHandler);
    return () => {
      window.removeEventListener('pdf-scroll-bindings-changed', handler);
      window.removeEventListener('pdf-inertia-changed', inertiaHandler);
    };
  }, []);

  // PDF render quality — persisted, synced from Settings panel
  const [pdfQuality, setPdfQuality] = useState<PdfRenderQuality>(loadPdfQuality);
  const qcfg = getPdfQualityConfig(pdfQuality);
  const qcfgRef = useRef(qcfg);
  qcfgRef.current = qcfg;

  // Apply cache limits on mount and quality change
  useEffect(() => {
    setPageCacheLimits(qcfg.cacheMaxEntries, qcfg.cacheMaxPixels);
    setTileCacheLimit(qcfg.cacheMaxPixels);
  }, [qcfg.cacheMaxEntries, qcfg.cacheMaxPixels]);

  // Sync quality when changed from Settings panel
  useEffect(() => {
    const handler = (e: Event) => {
      const next = (e as CustomEvent<PdfRenderQuality>).detail;
      setPdfQuality(next);
      const cfg = getPdfQualityConfig(next);
      // Update ref immediately so renderPage uses the new config
      // (React state won't commit until next render cycle)
      qcfgRef.current = cfg;
      setPageCacheLimits(cfg.cacheMaxEntries, cfg.cacheMaxPixels);
      invalidatePageCache(pdfFileName);
      setTileCacheLimit(cfg.cacheMaxPixels);
      invalidateTileCache(pdfFileName);
      _lastCommittedTier = 1; // reset hysteresis
      renderPageRef.current();
    };
    window.addEventListener('pdf-quality-changed', handler);
    return () => window.removeEventListener('pdf-quality-changed', handler);
  }, [pdfFileName]);

  // Sync wand button + caches with the store's watermark filter. Runs on
  // every render-settings change, but the filter's own reference identity
  // is the fast guard — no stringify per notify.
  useEffect(() => {
    let prevFilter = renderSettingsStore.globalSettings.pdfWatermarkFilter;
    const unsub = renderSettingsStore.subscribe(() => {
      const curFilter = renderSettingsStore.globalSettings.pdfWatermarkFilter;
      if (curFilter === prevFilter) return;
      prevFilter = curFilter;
      setWmFilterActive((curFilter?.length ?? 0) > 0);
      // pdf.js keys intentStates only on rendering intent + annotation hash,
      // so a watermark-filter change alone doesn't invalidate the cached
      // operator list. Flush it explicitly so the worker re-parses with the
      // new filter. Then drop our bitmap caches and trigger a fresh render.
      pdfStore.flushOperatorListCache(pdfFileName);
      invalidatePageCache(pdfFileName);
      invalidateTileCache(pdfFileName);
      renderPageRef.current();
    });
    return unsub;
  }, [pdfFileName]);

  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [glyphDebug] = useState<GlyphDebugState>(DEFAULT_GLYPH_DEBUG_STATE);

  // Watermark filter toggle. `wmFilterActive` is driven from the store so
  // edits via SettingsPanel's editor keep the wand button in sync.
  const [wmFilterActive, setWmFilterActive] = useState(() =>
    (renderSettingsStore.globalSettings.pdfWatermarkFilter?.length ?? 0) > 0
  );
  const savedWmFilterRef = useRef<string[]>(
    renderSettingsStore.globalSettings.pdfWatermarkFilter?.length
      ? [...renderSettingsStore.globalSettings.pdfWatermarkFilter]
      : ['Vinafix', 'www.chinafix.com', 'www.xinxunwei.com', 'notebookschematics.com', 'notebook-schematics.com']
  );
  const toggleWatermarkFilter = useCallback(() => {
    const current = renderSettingsStore.globalSnapshot();
    const active = (current.pdfWatermarkFilter?.length ?? 0) > 0;
    if (active) {
      savedWmFilterRef.current = [...current.pdfWatermarkFilter];
      renderSettingsStore.applyGlobal({ ...current, pdfWatermarkFilter: [] });
    } else {
      renderSettingsStore.applyGlobal({ ...current, pdfWatermarkFilter: savedWmFilterRef.current });
    }
  }, []);
  // glyphMenuOpen/glyphMenuTimerRef removed — legacy glyph-debug menu was
  // rendered inside the now-commented cleaner popup.
  const [fontDataLoaded, setFontDataLoaded] = useState(false);
  const [glyphLoading, setGlyphLoading] = useState(false);
  const glyphCanvasRef = useRef<HTMLCanvasElement>(null);
  const pageGlyphDataRef = useRef<PageGlyphData | null>(null);
  const simplifyStatsRef = useRef<SimplifyStats | null>(null);

  const isTextItemsMode = glyphDebug.overlayMode === 'textItems';
  const isGlyphActive = (glyphDebug.overlayMode !== 'off' && !isTextItemsMode) || glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;
  const isOverlayActive = isGlyphActive || isTextItemsMode;
  const isGlyphComposite = glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;

  const bookmarkClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const skipResetRef = useRef(false);

  // Scrubber flash: DOM classList toggle to avoid re-rendering the whole panel
  const scrubberFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubberElRef = useRef<HTMLDivElement | null>(null);
  const flashScrubber = useCallback(() => {
    const el = scrubberElRef.current;
    if (!el) return;
    el.classList.add('flash');
    if (scrubberFlashTimerRef.current) clearTimeout(scrubberFlashTimerRef.current);
    scrubberFlashTimerRef.current = setTimeout(() => el.classList.remove('flash'), 800);
  }, []);

  // --- Multi-page rendering (adjacent pages visible when zoomed out / panning) ---
  /** CSS height of the current page at zoom=1 */
  const pageCssHRef = useRef(0);
  /** Imperatively managed canvases for adjacent pages, keyed by page number */
  const adjCanvasMapRef = useRef<Map<number, { canvas: HTMLCanvasElement; tier: number }>>(new Map());
  /** Bumped after zoom settles to trigger adjacent re-render (debounced, not per-render) */
  const [adjTrigger, setAdjTrigger] = useState(0);
  const adjDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Clamp pan so the page stays within view boundaries.
   *
   *  Single-page PDFs use *loose* clamps with a margin overshoot on both axes
   *  so the user can pull the page slightly off-screen to zoom-anchor near the
   *  edges. Multi-page first/last keep hard clamps because the page-flip
   *  threshold at `containerH/2` depends on them. */
  const clampPan = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    const zoom = zoomRef.current;
    const cssH = pageCssHRef.current;
    let { x, y } = panRef.current;

    const total = pdfStore.getDocPageCount(pdfFileName);
    const singlePage = total === 1;
    const SINGLE_PAGE_MARGIN = 80;

    // --- X axis ---
    const pageW = containerW * zoom;
    if (pageW <= containerW) {
      x = (containerW - pageW) / 2; // page fits — centered
    } else {
      const margin = singlePage ? SINGLE_PAGE_MARGIN : 0;
      x = Math.max(containerW - pageW - margin, Math.min(margin, x));
    }

    // --- Y axis ---
    if (cssH > 0) {
      const pageH = cssH * zoom;
      if (singlePage) {
        if (pageH > containerH) {
          y = Math.max(containerH - pageH - SINGLE_PAGE_MARGIN, Math.min(SINGLE_PAGE_MARGIN, y));
        } else {
          y = (containerH - pageH) / 2; // page fits vertically — centered
        }
      } else {
        const curPage = pdfStore.getDocCurrentPage(pdfFileName);
        if (curPage === 1) y = Math.min(y, 0);
        if (curPage === total) y = Math.max(y, containerH - pageH);
      }
    }

    panRef.current = { x, y };
  }, [pdfFileName]);

  /** Push zoom/pan refs to DOM + throttled React state for toolbar.
   *  Wrapper scale = `currentZoom / committedZoom`. On idle this is 1
   *  (transform: translate-only) — the wrapper layer is at its intrinsic
   *  CSS size which equals displayed size, so Safari rasterizes the GPU
   *  layer at full resolution = sharp. During gestures this briefly
   *  diverges; the next 60ms-debounced render commits the new zoom and
   *  resets it to 1. Also triggers tile re-render on pan in tiled mode. */
  const syncTransform = useCallback(() => {
    clampPan();
    const transientScale = zoomRef.current / committedZoomRef.current;
    applyTransform(wrapperRef.current, panRef.current.x, panRef.current.y, transientScale);
    if (!zoomDisplayRafRef.current) {
      zoomDisplayRafRef.current = requestAnimationFrame(() => {
        zoomDisplayRafRef.current = 0;
        setZoomDisplay(zoomRef.current);
      });
    }
    if (zoomRef.current > 1.05) scheduleTierRenderRef.current();
  }, [clampPan]);

  /** Schedule a re-render at exact zoom resolution.
   *  Adaptive throttle: renders at a rate the system can sustain (based on EMA of
   *  recent render times). Fast pages get near-instant crisp zoom; slow pages get
   *  CSS-only zoom with a trailing debounce for the final crisp frame.
   *
   *  Hysteresis invariant: `_lastCommittedTier` is module-global and held through
   *  intermediate renders so mid-zoom re-renders don't thrash tier boundaries.
   *  The trailing debounce below is the single place where we reset it — so the
   *  final settle render always commits to the exact requested tier, not a stale
   *  one. If the debounce is cleared and rescheduled before firing (new zoom
   *  event arrives) the reset is deferred, which is fine: the reset only matters
   *  for the final frame, and there's always a final frame. */
  const scheduleTierRender = useCallback(() => {
    if (tierDebounceRef.current) clearTimeout(tierDebounceRef.current);
    tierDebounceRef.current = setTimeout(() => {
      tierDebounceRef.current = null;
      _lastCommittedTier = 0;
      renderPageRef.current();
    }, TIER_DEBOUNCE_MS);

    // Adaptive throttle: re-render when zooming in (higher tier needed) or
    // when in tiled mode and zoom level changed (new tiles needed for viewport).
    const candidateTier = quantiseTier(mainTierFromZoom(zoomRef.current, qcfgRef.current.maxMainTier));
    if (candidateTier > renderTierRef.current) {
      const ema = renderTimeEmaRef.current;
      const throttleMs = ema > 0 ? Math.max(ema * 1.5, 16) : 0;
      const now = performance.now();
      if (now - lastThrottleRenderRef.current >= throttleMs) {
        lastThrottleRenderRef.current = now;
        renderPageRef.current();
      }
    }

    // Schedule full-quality crisp render after zoom fully settles (500ms).
    // Quality presets only cap the interactive tier; this ensures the final
    // frame is always rendered at full zoom resolution regardless of preset.
    if (crispTimerRef.current) clearTimeout(crispTimerRef.current);
    crispTimerRef.current = setTimeout(() => {
      crispTimerRef.current = null;
      // Only force full tier if zoom exceeds the preset cap — otherwise the
      // interactive render is already at full quality and this would be a no-op.
      const zoom = zoomRef.current;
      const presetMax = qcfgRef.current.maxMainTier;
      if (zoom > presetMax) {
        forceFullTierRef.current = true;
        log.perf.log(`crisp-render zoom=${zoom.toFixed(1)} preset-cap=${presetMax} → full tier`);
        renderPageRef.current();
      }
    }, CRISP_SETTLE_MS);
  }, []);
  // Forward-ref hookup: syncTransform calls scheduleTierRenderRef.current()
  // to trigger debounced re-renders on pan without depending on the
  // scheduleTierRender callback (which is defined after syncTransform).
  scheduleTierRenderRef.current = scheduleTierRender;

  // Reset scale refs when document is unloaded so framing re-runs on next load
  useEffect(() => {
    if (!isLoaded) { scaleRef.current = 0; viewportHeightRef.current = 0; }
  }, [isLoaded]);

  /** Remove all tile canvases from the DOM and clear the tile map */
  const clearTileDom = useCallback(() => {
    for (const canvas of tileContainerRef.current.values()) {
      canvas.remove();
    }
    tileContainerRef.current.clear();
  }, []);

  const prevPageRef = useRef(currentPage);
  useEffect(() => {
    const prevPage = prevPageRef.current;
    prevPageRef.current = currentPage;
    if (prevPage === currentPage) return; // no actual change (StrictMode re-run)
    if (skipResetRef.current) {
      // Page boundary crossing during pan/zoom — keep tiles, skip reset
      skipResetRef.current = false;
      return;
    }
    // Explicit page change (scrubber, nav) — full reset
    clearTileDom();
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    renderTierRef.current = 1;
    syncTransform();
  }, [currentPage, syncTransform, clearTileDom]);

  useEffect(() => {
    return () => {
      clearTileDom();
      invalidateTileCache(pdfFileName);
    };
  }, [pdfFileName, clearTileDom]);

  const renderIdRef = useRef(0);
  const prefetchIdRef = useRef(0);

  /** Render a single page to an ImageBitmap (shared by main render + prefetch) */
  const renderPageToBitmap = useCallback(async (
    pageNum: number, containerWidth: number, tier: number, clean: boolean,
    signal?: AbortSignal,
  ): Promise<CachedRender> => {
    const page = await pdfStore.getPageFor(pdfFileName, pageNum);
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const unscaledViewport = page.getViewport({ scale: 1 });
    const baseScale = containerWidth / unscaledViewport.width;

    const dpr = window.devicePixelRatio || 1;
    let hiresScale = baseScale * tier * dpr;
    hiresScale = clampFullPageScale(unscaledViewport.width, unscaledViewport.height, hiresScale, qcfgRef.current.maxCanvasDim);
    const viewport = page.getViewport({ scale: hiresScale });
    const cssW = containerWidth;
    const cssH = unscaledViewport.height * baseScale;

    const offscreen = acquireCanvas(viewport.width, viewport.height);
    const offCtx = offscreen.getContext('2d', { alpha: false });
    if (!offCtx) { releaseCanvas(offscreen); throw new Error(`Canvas too large: ${viewport.width}x${viewport.height}`); }

    // 'display' intent is significantly faster than 'print' for complex schematics
    const task = page.render({
      canvas: offscreen, canvasContext: offCtx, viewport, intent: 'display',
      ...wmFilterOptions(renderSettingsStore.globalSettings.pdfWatermarkFilter),
    });
    const onAbort = () => task.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } catch (err) {
      // On cancel/abort: DON'T return canvas to pool — pdf.js worker thread may
      // still queue draw operations that would corrupt a reused canvas. Abandon to GC.
      offscreen.width = 1; offscreen.height = 1; // release backing store
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    if (signal?.aborted) { offscreen.width = 1; offscreen.height = 1; throw new DOMException('Aborted', 'AbortError'); }

    // Apply contrast filter for clean mode before creating bitmap
    if (clean) {
      const tmpCanvas = acquireCanvas(offscreen.width, offscreen.height);
      const tmpCtx = tmpCanvas.getContext('2d', { alpha: false });
      if (!tmpCtx) { offscreen.width = 1; offscreen.height = 1; releaseCanvas(tmpCanvas); throw new Error('Canvas context failed for clean mode'); }
      tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
      tmpCtx.drawImage(offscreen, 0, 0);
      const bitmap = await createImageBitmap(tmpCanvas);
      // Abandon pdf.js-rendered canvas (worker may still reference it)
      offscreen.width = 1; offscreen.height = 1;
      releaseCanvas(tmpCanvas); // tmpCanvas is safe to pool (only used for contrast filter)
      return { bitmap, width: viewport.width, height: viewport.height, cssW, cssH, baseScale, hiresScale, vpHeight: unscaledViewport.height, vpTransform: unscaledViewport.transform };
    }

    const bitmap = await createImageBitmap(offscreen);
    // Abandon pdf.js-rendered canvas (worker may still reference it)
    offscreen.width = 1; offscreen.height = 1;
    return { bitmap, width: viewport.width, height: viewport.height, cssW, cssH, baseScale, hiresScale, vpHeight: unscaledViewport.height, vpTransform: unscaledViewport.transform };
  }, [pdfFileName]);

  /** Blit a cached or freshly rendered bitmap to the visible canvas.
   *  CSS sizes are scaled by current zoom so the wrapper layer rasterizes
   *  at displayed size on Safari. Old in-DOM elements are rescaled by the
   *  committed-zoom delta so they keep correct positions when zoom changes. */
  const blitToCanvas = useCallback((entry: CachedRender) => {
    const canvas = canvasRef.current;
    const highlight = highlightRef.current;
    if (!canvas || !highlight) return;

    const zCommit = zoomRef.current;
    const ratio = zCommit / committedZoomRef.current;
    rescaleWrapperChildren(ratio);
    committedZoomRef.current = zCommit;

    // Only resize if dimensions changed — avoids clearing existing content
    if (canvas.width !== entry.width || canvas.height !== entry.height) {
      canvas.width = entry.width;
      canvas.height = entry.height;
    }
    canvas.style.width = `${entry.cssW * zCommit}px`;
    canvas.style.height = `${entry.cssH * zCommit}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(entry.bitmap, 0, 0);

    if (highlight.width !== entry.width || highlight.height !== entry.height) {
      highlight.width = entry.width;
      highlight.height = entry.height;
    }
    highlight.style.width = `${entry.cssW * zCommit}px`;
    highlight.style.height = `${entry.cssH * zCommit}px`;

    if (wrapperRef.current) {
      // Reset wrapper transient scale so the layer rasterizes at full size.
      applyTransform(wrapperRef.current, panRef.current.x, panRef.current.y, zoomRef.current / zCommit);
    }

    scaleRef.current = entry.baseScale;
    hiresScaleRef.current = entry.hiresScale;
    viewportHeightRef.current = entry.vpHeight;
    viewportTransformRef.current = entry.vpTransform;
    pageCssHRef.current = entry.cssH;

    drawHighlightsRef.current();
    setRenderEpoch(e => e + 1);
  }, []);


  const renderPage = useCallback(async () => {
    if (!isLoaded) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const renderId = ++renderIdRef.current;
    const maxTier = qcfgRef.current.maxMainTier;
    const resTier = hysteresisFilter(quantiseTier(mainTierFromZoom(zoomRef.current, maxTier)));
    renderTierRef.current = resTier;
    const t0 = performance.now();

    try {
      const container = containerRef.current;
      if (!container) return;
      const containerWidth = container.clientWidth;
      if (containerWidth === 0) return;

      const cacheKey = pageCacheKey(pdfFileName, currentPage, resTier, cleanMode);

      // Fast path: cache hit — instant blit, no pdf.js render
      const cached = getPageCache(cacheKey);
      if (cached && cached.cssW === containerWidth) {
        blitToCanvas(cached);
        const tHit = performance.now() - t0;
        // Cache hits are near-instant — feed EMA so adaptive zoom stays aggressive
        const prev = renderTimeEmaRef.current;
        renderTimeEmaRef.current = prev > 0 ? prev * 0.7 + tHit * 0.3 : tHit;
        log.perf.log(`cache-hit ${cacheKey} ${Math.round(tHit)}ms`);
        return;
      }

      // Best-available fallback: show highest-tier cached version while rendering
      // (prevents blur flash when zooming out — sharp CSS downscale is better than tier-1 preview)
      const bestCached = getBestPageCache(pdfFileName, currentPage, cleanMode);
      if (bestCached && bestCached.cssW === containerWidth) {
        blitToCanvas(bestCached);
      }

      // Preview fallback: blit a tier-1 preview if available while hi-res renders
      if (resTier > 1) {
        const pvKey = previewCacheKey(pdfFileName, currentPage, cleanMode);
        const preview = getPreviewCache(pvKey);
        if (preview && preview.cssW === containerWidth) {
          blitToCanvas(preview);
          log.perf.log(`preview-fallback ${pvKey}`);
        }
      }

      const page = await pdfStore.getPageFor(pdfFileName, currentPage);
      if (renderIdRef.current !== renderId) return;
      const tPage = performance.now();

      const unscaledViewport = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledViewport.width;

      const dpr = window.devicePixelRatio || 1;
      let hiresScale = baseScale * resTier * dpr;
      hiresScale = clampFullPageScale(unscaledViewport.width, unscaledViewport.height, hiresScale, qcfgRef.current.maxCanvasDim);
      const viewport = page.getViewport({ scale: hiresScale });
      const cssW = containerWidth;
      const cssH = unscaledViewport.height * baseScale;

      // Render to pooled offscreen buffer
      const offscreen = acquireCanvas(viewport.width, viewport.height);
      const offCtx = offscreen.getContext('2d', { alpha: false });
      if (!offCtx) { releaseCanvas(offscreen); throw new Error(`Canvas too large: ${viewport.width}x${viewport.height}`); }

      // 'display' intent is significantly faster than 'print' for complex schematics
      const task = page.render({
        canvas: offscreen, canvasContext: offCtx, viewport, intent: 'display',
        ...wmFilterOptions(renderSettingsStore.globalSettings.pdfWatermarkFilter),
      });
      renderTaskRef.current = { cancel: () => task.cancel() };
      await task.promise;

      if (renderIdRef.current !== renderId) {
        // Stale render — abandon canvas (don't pool, pdf.js may still draw to it)
        offscreen.width = 1; offscreen.height = 1;
        return;
      }
      const tRender = performance.now();

      // Apply contrast to offscreen buffer before creating bitmap (avoids double-blit)
      let sourceCanvas = offscreen;
      if (cleanMode) {
        const tmpCanvas = acquireCanvas(offscreen.width, offscreen.height);
        const tmpCtx = tmpCanvas.getContext('2d', { alpha: false });
        if (tmpCtx) {
          tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
          tmpCtx.drawImage(offscreen, 0, 0);
          // Abandon offscreen to GC — pdf.js worker may still reference it
          offscreen.width = 1; offscreen.height = 1;
          sourceCanvas = tmpCanvas;
        }
      }

      if (renderIdRef.current !== renderId) { releaseCanvas(sourceCanvas); return; }

      // Blit to visible canvas SYNCHRONOUSLY from sourceCanvas — no async step
      // between render completion and visible blit. This prevents any race with
      // stale pdf.js worker operations or createImageBitmap orientation issues.
      const canvas = canvasRef.current;
      const highlight = highlightRef.current;
      if (!canvas || !highlight) { releaseCanvas(sourceCanvas); return; }

      // Capture committed zoom for this render. Same zCommit used for main
      // canvas, highlight canvas, and the wrapper transform reset below.
      const zCommitFP = zoomRef.current;
      const ratioFP = zCommitFP / committedZoomRef.current;
      rescaleWrapperChildren(ratioFP);
      committedZoomRef.current = zCommitFP;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${cssW * zCommitFP}px`;
      canvas.style.height = `${cssH * zCommitFP}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(sourceCanvas, 0, 0);

      // Create bitmap AFTER the visible blit for cache storage only.
      // sourceCanvas might get stale pdf.js draws during this await — that's
      // fine because the visible canvas already has the correct content.
      let bitmap: ImageBitmap | null = null;
      try { bitmap = await createImageBitmap(sourceCanvas); } catch { /* skip */ }
      // Don't pool sourceCanvas — abandon to GC (pdf.js worker may still reference it)
      sourceCanvas.width = 1; sourceCanvas.height = 1;
      if (renderIdRef.current !== renderId) { bitmap?.close(); return; }
      const tCopy = performance.now();

      scaleRef.current = baseScale;
      hiresScaleRef.current = hiresScale;
      viewportHeightRef.current = unscaledViewport.height;
      viewportTransformRef.current = unscaledViewport.transform;
      pageCssHRef.current = cssH;

      highlight.width = viewport.width;
      highlight.height = viewport.height;
      highlight.style.width = `${cssW * zCommitFP}px`;
      highlight.style.height = `${cssH * zCommitFP}px`;
      if (wrapperRef.current) {
        applyTransform(wrapperRef.current, panRef.current.x, panRef.current.y, zoomRef.current / zCommitFP);
      }

      drawHighlightsRef.current();
      setRenderEpoch(e => e + 1);

      // Cache the pre-created bitmap for instant reuse
      if (bitmap) {
        putPageCache(cacheKey, {
          bitmap, width: viewport.width, height: viewport.height,
          cssW, cssH, baseScale, hiresScale, vpHeight: unscaledViewport.height,
          vpTransform: unscaledViewport.transform,
        });
      }

      const totalMs = tCopy - t0;
      const metrics = {
        file: pdfFileName, page: currentPage, tier: resTier, clean: cleanMode,
        canvasW: viewport.width, canvasH: viewport.height,
        getPageMs: Math.round(tPage - t0),
        renderMs: Math.round(tRender - tPage),
        copyMs: Math.round(tCopy - tRender),
        totalMs: Math.round(totalMs),
      };
      log.perf.log(JSON.stringify(metrics));
      window.dispatchEvent(new CustomEvent('pdf-render-perf', { detail: metrics }));

      // Update adaptive zoom EMA (α=0.3 — responsive but not twitchy)
      const prev = renderTimeEmaRef.current;
      renderTimeEmaRef.current = prev > 0 ? prev * 0.7 + totalMs * 0.3 : totalMs;

      // Debounced adjacent page re-render — wait until zoom settles to avoid
      // re-rendering 4+ adjacent pages on every mid-zoom throttle render.
      if (adjDebounceRef.current) clearTimeout(adjDebounceRef.current);
      adjDebounceRef.current = setTimeout(() => {
        adjDebounceRef.current = null;
        setAdjTrigger(t => t + 1);
      }, qcfgRef.current.adjSettleMs);

      // Defer all prefetch work to idle time so the main render doesn't
      // compete with preview/adjacent renders for CPU/GPU. requestIdleCallback
      // fires when the browser is idle (after paint, before next frame deadline).
      const pfId = ++prefetchIdRef.current;
      const adjPfTier = quantiseTier(Math.min(resTier, qcfgRef.current.maxAdjTier));
      const idlePrefetch = () => {
        if (prefetchIdRef.current !== pfId) return; // stale

        // Preview for current page (only if rendered at hi-res)
        const pvKey = previewCacheKey(pdfFileName, currentPage, cleanMode);
        if (resTier > 1 && !getPreviewCache(pvKey)) {
          renderPageToBitmap(currentPage, containerWidth, 1, cleanMode)
            .then(result => { putPreviewCache(pvKey, result); })
            .catch(() => {});
        }

        // Adjacent pages: preview + hi-res
        const pagesToPrefetch = [currentPage + 1, currentPage - 1].filter(p => p >= 1 && p <= pageCount);
        for (const pNum of pagesToPrefetch) {
          if (prefetchIdRef.current !== pfId) return;
          const adjPvKey = previewCacheKey(pdfFileName, pNum, cleanMode);
          if (!getPreviewCache(adjPvKey)) {
            renderPageToBitmap(pNum, containerWidth, 1, cleanMode)
              .then(result => { putPreviewCache(adjPvKey, result); })
              .catch(() => {});
          }
          const pfKey = pageCacheKey(pdfFileName, pNum, adjPfTier, cleanMode);
          if (!getPageCache(pfKey)) {
            renderPageToBitmap(pNum, containerWidth, adjPfTier, cleanMode)
              .then(result => {
                if (prefetchIdRef.current !== pfId) { result.bitmap.close(); return; }
                putPageCache(pfKey, result);
                log.perf.log(`prefetched page ${pNum} tier=${adjPfTier}`);
              })
              .catch(() => {});
          }
        }
      };
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(idlePrefetch, { timeout: 2000 });
      } else {
        setTimeout(idlePrefetch, 200); // fallback for Safari
      }
    } catch (err) {
      if (err instanceof Error && err.message?.includes('cancel')) {
        return;
      }
      log.pdf.error('renderPage failed:', err);
      setError(String(err));
    }
  }, [pdfFileName, isLoaded, currentPage, cleanMode, pageCount, renderPageToBitmap, blitToCanvas]);

  // --- Tiled viewport rendering (zoom > 1) ---
  const renderTiledPage = useCallback(async () => {
    if (!isLoaded) return;
    renderTaskRef.current?.cancel();

    const tileRenderId = ++tileRenderIdRef.current;
    const zoom = zoomRef.current;
    const maxTier = qcfgRef.current.maxMainTier;
    const resTier = hysteresisFilter(quantiseTier(mainTierFromZoom(zoom, maxTier)));
    renderTierRef.current = resTier;

    const container = containerRef.current;
    const wrapper = wrapperRef.current;
    if (!container || !wrapper) return;
    const containerWidth = container.clientWidth;
    if (containerWidth === 0) return;

    try {
      // Guard: don't render if the store's current page doesn't match our closure.
      // This catches stale calls from scheduleTierRender firing before React commits.
      const storePage = pdfStore.getDocCurrentPage(pdfFileName);
      if (storePage !== currentPage) {
        log.pdf.log(`renderTiledPage: stale closure page=${currentPage}, store=${storePage} — skipping`);
        return;
      }

      const page = await pdfStore.getPageFor(pdfFileName, currentPage);
      if (tileRenderIdRef.current !== tileRenderId) return;

      const unscaledVp = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledVp.width;
      const dpr = window.devicePixelRatio || 1;
      // Tile path: each tile renders into its own TILE_SIZE canvas (1024px),
      // so the per-canvas browser dim cap doesn't apply. The previous clamp
      // by `maxCanvasDim` was a memory-budget proxy for the "render all
      // tiles" decision below; with viewport culling we render only ~9
      // visible tiles regardless of zoom, so memory is bounded by viewport
      // size, not by total page-pixel area. Keep renderScale at the
      // tier-requested value so Safari users get full Retina sharpness on
      // oversize schematic PDFs.
      const renderScale = baseScale * resTier * dpr;

      const cssW = containerWidth;
      const cssH = unscaledVp.height * baseScale;
      // Capture zoom for this render, rescale all old in-DOM children to
      // match (so tiles outside the viewport-cull range stay aligned), and
      // commit the new value before placing any new tiles.
      const zCommit = zoomRef.current;
      const ratio = zCommit / committedZoomRef.current;
      rescaleWrapperChildren(ratio);
      committedZoomRef.current = zCommit;
      scaleRef.current = baseScale;
      hiresScaleRef.current = renderScale;
      viewportHeightRef.current = unscaledVp.height;
      viewportTransformRef.current = unscaledVp.transform;
      pageCssHRef.current = cssH;

      const grid = computeTileGrid(unscaledVp.width, unscaledVp.height, renderScale);
      tileGridRef.current = grid;
      // Tile keys include renderScale — old/new tiles don't collide in the map.

      // Keep main canvas visible as blurry backdrop while tiles load on top
      // (tiles have z-index: 1, main canvas has no z-index — tiles cover it)

      // Size highlight canvas for tiled mode. Cap to the probed max canvas
      // dim so Safari can actually back the highlight overlay — at extreme
      // zoom on oversize pages the requested hlScale would otherwise blow
      // past Safari's silent canvas limit.
      const highlight = highlightRef.current;
      if (highlight) {
        const hlScale = clampFullPageScale(unscaledVp.width, unscaledVp.height, renderScale, qcfgRef.current.maxCanvasDim);
        highlight.width = Math.ceil(unscaledVp.width * hlScale);
        highlight.height = Math.ceil(unscaledVp.height * hlScale);
        highlight.style.width = `${cssW * zCommit}px`;
        highlight.style.height = `${cssH * zCommit}px`;
        highlight.style.display = '';
        // Tiles use renderScale for coords; highlight may be at lower
        // (clamped) scale on Safari. Store for drawHighlights to use.
        hiresScaleRef.current = hlScale;
      }

      const pxPerCss = renderScale / baseScale;
      const cssTileW = TILE_SIZE / pxPerCss;
      const cssTileH = TILE_SIZE / pxPerCss;

      // Tile selection strategy:
      //   - Small grids (≤ TILE_RENDER_ALL_THRESHOLD tiles): render the whole
      //     page eagerly. Behavior matches the previous "render all tiles"
      //     decision — fast-pan stays smooth because every tile is already
      //     in DOM. This covers typical 100-400% zoom on Letter-size PDFs.
      //   - Large grids (> threshold): viewport-cull with 2-tile padding.
      //     Avoids the 1.5GB blow-up on 1000% zoom of oversize schematics
      //     and lifts the previous tile-path scale clamp, so Safari users
      //     get full Retina sharpness on huge pages.
      const totalTiles = grid.cols * grid.rows;
      const TILE_RENDER_ALL_THRESHOLD = 30;
      const tiles: { col: number; row: number }[] = [];
      if (totalTiles <= TILE_RENDER_ALL_THRESHOLD) {
        for (let row = 0; row < grid.rows; row++) {
          for (let col = 0; col < grid.cols; col++) {
            tiles.push({ col, row });
          }
        }
      } else {
        const containerH = container.clientHeight;
        const zoomNow = zoomRef.current;
        const panNow = panRef.current;
        const visLeftCss = -panNow.x / zoomNow;
        const visTopCss = -panNow.y / zoomNow;
        const visRightCss = visLeftCss + containerWidth / zoomNow;
        const visBottomCss = visTopCss + containerH / zoomNow;
        // 2-tile padding (in each direction) gives breathing room for fast
        // pan bursts before the debounced re-render catches up.
        const PAD = 2;
        const colMin = Math.max(0, Math.floor(visLeftCss / cssTileW) - PAD);
        const colMax = Math.min(grid.cols - 1, Math.ceil(visRightCss / cssTileW) + PAD);
        const rowMin = Math.max(0, Math.floor(visTopCss / cssTileH) - PAD);
        const rowMax = Math.min(grid.rows - 1, Math.ceil(visBottomCss / cssTileH) + PAD);
        for (let row = rowMin; row <= rowMax; row++) {
          for (let col = colMin; col <= colMax; col++) {
            tiles.push({ col, row });
          }
        }
      }

      const visibleKeys = new Set<string>();
      const toRender: { col: number; row: number }[] = [];

      for (const t of tiles) {
        const key = `${currentPage}:${t.col}:${t.row}:${renderScale}`;
        visibleKeys.add(key);

        let tileCanvas = tileContainerRef.current.get(key);
        const cached = getTileCached(pdfFileName, currentPage, t.col, t.row, renderScale);

        // Per-tile CSS size — edge tiles may be smaller than TILE_SIZE
        const req = tileRenderRequest(t.col, t.row, grid);
        const tileCssW = req.pixelW / pxPerCss;
        const tileCssH = req.pixelH / pxPerCss;

        if (cached) {
          if (!tileCanvas) {
            tileCanvas = document.createElement('canvas');
            tileCanvas.className = 'pdf-tile';
            wrapper.appendChild(tileCanvas);
            tileContainerRef.current.set(key, tileCanvas);
          }
          tileCanvas.width = cached.bitmap.width;
          tileCanvas.height = cached.bitmap.height;
          tileCanvas.style.width = `${tileCssW * zCommit}px`;
          tileCanvas.style.height = `${tileCssH * zCommit}px`;
          tileCanvas.style.left = `${t.col * cssTileW * zCommit}px`;
          tileCanvas.style.top = `${t.row * cssTileH * zCommit}px`;
          const ctx = tileCanvas.getContext('2d');
          if (ctx) ctx.drawImage(cached.bitmap, 0, 0);
          tileCanvas.style.display = '';
        } else {
          if (tileCanvas) {
            tileCanvas.style.width = `${tileCssW * zCommit}px`;
            tileCanvas.style.height = `${tileCssH * zCommit}px`;
            tileCanvas.style.left = `${t.col * cssTileW * zCommit}px`;
            tileCanvas.style.top = `${t.row * cssTileH * zCommit}px`;
            tileCanvas.style.display = '';
          }
          toRender.push(t);
        }
      }

      // Now that all currently-cached tiles + highlight are at zCommit-scaled
      // CSS, reset the wrapper's transient scale so Safari rasterizes the
      // GPU layer at the (new larger) intrinsic CSS size = displayed size.
      if (wrapperRef.current) {
        applyTransform(wrapperRef.current, panRef.current.x, panRef.current.y, zoomRef.current / zCommit);
      }

      // Don't hide old tiles here — they stay visible as backdrop.
      // Out-of-viewport tiles are clipped by overflow:hidden on the container.
      // Cleanup happens in the batch display rAF after new tiles are shown.

      // Phase 2: render missing tiles sequentially (pdf.js can't handle concurrent
      // renders on the same page — parallel calls cause flipped/mirrored tiles).
      // Tiles are rendered to bitmaps first, then batch-displayed in one rAF.
      const t0 = performance.now();
      const rendered: { key: string; bitmap: ImageBitmap; col: number; row: number; pixelW: number; pixelH: number }[] = [];

      // Watermark filter forwarded through the patched `watermarkFilter`
      // render option — the worker drops matching showText ops at parse time.
      const wmOptions = wmFilterOptions(renderSettingsStore.globalSettings.pdfWatermarkFilter);

      for (const t of toRender) {
        if (tileRenderIdRef.current !== tileRenderId) return;

        const req = tileRenderRequest(t.col, t.row, grid);
        const offscreen = acquireCanvas(req.pixelW, req.pixelH);
        const offCtx = offscreen.getContext('2d', { alpha: false });
        if (!offCtx) { releaseCanvas(offscreen); continue; }

        const tileViewport = page.getViewport({
          scale: renderScale,
          offsetX: -req.srcX * renderScale,
          offsetY: -req.srcY * renderScale,
        });
        const task = page.render({
          canvas: offscreen, canvasContext: offCtx,
          viewport: tileViewport, intent: 'display',
          ...wmOptions,
        });
        renderTaskRef.current = { cancel: () => task.cancel() };

        try {
          await task.promise;
        } catch {
          offscreen.width = 1; offscreen.height = 1;
          continue;
        }

        if (tileRenderIdRef.current !== tileRenderId) {
          offscreen.width = 1; offscreen.height = 1;
          return;
        }

        let srcCanvas = offscreen;
        if (cleanMode) {
          const tmp = acquireCanvas(req.pixelW, req.pixelH);
          const tmpCtx = tmp.getContext('2d', { alpha: false });
          if (tmpCtx) {
            tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
            tmpCtx.drawImage(offscreen, 0, 0);
            offscreen.width = 1; offscreen.height = 1;
            srcCanvas = tmp;
          }
        }

        try {
          const bitmap = await createImageBitmap(srcCanvas);
          srcCanvas.width = 1; srcCanvas.height = 1;
          putTileCached(pdfFileName, currentPage, {
            bitmap, col: t.col, row: t.row, scale: renderScale,
          });
          rendered.push({ key: `${currentPage}:${t.col}:${t.row}:${renderScale}`, bitmap, col: t.col, row: t.row, pixelW: req.pixelW, pixelH: req.pixelH });
        } catch {
          srcCanvas.width = 1; srcCanvas.height = 1;
        }
      }

      // Batch display: blit all rendered tiles to DOM in one frame
      if (tileRenderIdRef.current === tileRenderId && rendered.length > 0) {
        const renderedForPage = currentPage; // capture which page these tiles are for
        requestAnimationFrame(() => {
          // Re-check render ID inside rAF — a newer render may have started
          if (tileRenderIdRef.current !== tileRenderId) return;
          // Check if page changed since we started rendering
          const nowPage = pdfStore.getDocCurrentPage(pdfFileName);
          if (nowPage !== renderedForPage) {
            log.pdf.log(`tile-rAF BLOCKED: rendered for page ${renderedForPage} but now on page ${nowPage}`);
            return; // don't display tiles for wrong page
          }
          for (const r of rendered) {
            let tileCanvas = tileContainerRef.current.get(r.key);
            if (!tileCanvas) {
              tileCanvas = document.createElement('canvas');
              tileCanvas.className = 'pdf-tile';
              wrapper.appendChild(tileCanvas);
              tileContainerRef.current.set(r.key, tileCanvas);
            }
            tileCanvas.width = r.pixelW;
            tileCanvas.height = r.pixelH;
            // Use zCommit captured at function entry — if zoom changed since,
            // syncTransform's transient scale handles the visual delta until
            // the next render commits with the newer zoom.
            tileCanvas.style.width = `${(r.pixelW / pxPerCss) * zCommit}px`;
            tileCanvas.style.height = `${(r.pixelH / pxPerCss) * zCommit}px`;
            tileCanvas.style.left = `${r.col * cssTileW * zCommit}px`;
            tileCanvas.style.top = `${r.row * cssTileH * zCommit}px`;
            const ctx = tileCanvas.getContext('2d');
            if (ctx) ctx.drawImage(r.bitmap, 0, 0);
            tileCanvas.style.display = '';
          }
          // Cap total tile DOM elements — only evict when excessive.
          // Don't eagerly remove old-scale tiles (they serve as backdrop during
          // zoom changes and page transitions, preventing blank flashes).
          const MAX_TILE_DOM = 80;
          if (tileContainerRef.current.size > MAX_TILE_DOM) {
            // Remove tiles not at current scale first (oldest insertion order)
            const currentScaleSuffix = `:${renderScale}`;
            for (const [key, canvas] of tileContainerRef.current) {
              if (tileContainerRef.current.size <= MAX_TILE_DOM / 2) break;
              if (!key.endsWith(currentScaleSuffix)) {
                canvas.remove();
                tileContainerRef.current.delete(key);
              }
            }
          }
          // Main canvas visibility is controlled by React via tiledMode state
          // Clean up transition backdrop canvases (adjacent canvases kept during page switch)
          wrapper.querySelectorAll('[data-transition-backdrop]').forEach(c => c.remove());
        });
      }

      drawHighlightsRef.current();
      setRenderEpoch(e => e + 1);

      const totalMs = performance.now() - t0;
      if (toRender.length > 0) {
        log.perf.log(`tiled-render page=${currentPage} tiles=${rendered.length}/${tiles.length} ${Math.round(totalMs)}ms scale=${renderScale.toFixed(1)}`);
        const prev = renderTimeEmaRef.current;
        renderTimeEmaRef.current = prev > 0 ? prev * 0.7 + totalMs * 0.3 : totalMs;
      }
    } catch (err) {
      if (err instanceof Error && err.message?.includes('cancel')) return;
      log.pdf.error('renderTiledPage failed:', err);
      setError(String(err));
    }
  }, [pdfFileName, isLoaded, currentPage, cleanMode, clearTileDom]);

  /** Route to tiled or full-page render based on zoom level.
   *  Never clear tiles during a page boundary crossing — tiles may temporarily
   *  show at the wrong zoom (effect chain fires renderActive with stale zoom).
   *  Tiles are only cleared when explicitly zooming out to ≤ 1. */
  const renderActive = useCallback(() => {
    const zoom = zoomRef.current;
    if (zoom > 1.05) {
      setTiledMode(true);
      renderTiledPage();
    } else {
      setTiledMode(false);
      renderPage();
      if (tileContainerRef.current.size > 0) {
        requestAnimationFrame(() => {
          if (zoomRef.current <= 1.05) clearTileDom();
        });
      }
    }
  }, [renderPage, renderTiledPage, clearTileDom]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isLoaded) return;
    const highlight = highlightRef.current;

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getDocMatchesForPage(pdfFileName, pageIndex);

    // Hide highlight canvas entirely when no matches — avoids compositing an empty layer
    if (pageMatches.length === 0 && matches.length === 0) {
      highlight.style.display = 'none';
      lastHighlightZoomRef.current = '';
      return;
    }
    if (highlight.style.display === 'none') highlight.style.display = '';

    const scale = hiresScaleRef.current;

    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);
    const vpT = viewportTransformRef.current;
    const blinkHide = blinkPhaseRef.current % 2 === 1;

    const activeIndices = pdfStore.getDocActiveMatchIndices(pdfFileName);
    const activeMatchSet = new Set<object>();
    for (const idx of activeIndices) {
      if (matches[idx]) activeMatchSet.add(matches[idx]);
    }

    if (isMultiTerm && activeMatchSet.size > 0) {
      const activeGroup = pdfStore.getDocMatchGroups(pdfFileName)[pdfStore.getDocActiveGroupIndex(pdfFileName)];
      if (activeGroup) {
        const anchorMatch = matches[activeGroup[0]];
        if (anchorMatch && anchorMatch.pageIndex === pageIndex) {
          const aRect = textItemRect(anchorMatch.item.transform, anchorMatch.item.width, vpT, scale);
          const aFontSize = pdfFontSize(anchorMatch.item.transform);

          const xTolPx = aFontSize * multiTermXGap * scale;
          const zoneX = aRect.x - xTolPx;
          const zoneW = xTolPx * 2 + aRect.w;

          const yGapPx = aFontSize * multiTermYGap * scale;
          const zoneY = aRect.y;
          const zoneH = yGapPx * (activeGroup.length);

          hCtx.strokeStyle = 'rgba(100, 200, 255, 0.4)';
          hCtx.lineWidth = 1;
          hCtx.setLineDash([4, 4]);
          hCtx.strokeRect(zoneX, zoneY, zoneW, zoneH);
          hCtx.fillStyle = 'rgba(100, 200, 255, 0.25)';
          hCtx.fillRect(zoneX, zoneY, zoneW, zoneH);
          hCtx.setLineDash([]);
        }
      }
    }

    for (let mi = 0; mi < pageMatches.length; mi++) {
      const match = pageMatches[mi];
      const { x, y, w, h } = textItemRect(match.item.transform, match.item.width, vpT, scale);

      const isActive = activeMatchSet.has(match);
      if (isActive) {
        hCtx.fillStyle = blinkHide ? 'rgba(220, 30, 30, 0.5)' : 'rgba(255, 170, 0, 0.4)';
      } else {
        hCtx.fillStyle = 'rgba(255, 255, 68, 0.3)';
      }
      hCtx.fillRect(x, y, w, h);
    }

  }, [pdfFileName, isLoaded, currentPage, matches, activeMatchIndex, activeGroupIndex, isMultiTerm, multiTermYGap, multiTermXGap]);

  const renderPageRef = useRef(renderActive);
  renderPageRef.current = renderActive;
  const drawHighlightsRef = useRef(drawHighlights);
  drawHighlightsRef.current = drawHighlights;

  useEffect(() => { renderActive(); }, [renderActive]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  // --- Adjacent page rendering (N pages visible when panning / zoomed out) ---
  useEffect(() => {
    if (!isLoaded || pageCount <= 1) return;
    const wrapper = wrapperRef.current;
    const container = containerRef.current;
    if (!wrapper || !container) return;

    const cssH = pageCssHRef.current;
    if (cssH === 0) return; // main page hasn't rendered yet

    const containerWidth = container.clientWidth;
    if (containerWidth === 0) return;

    // Adjacent pages render at main tier, capped by quality config.
    // The debounce (adjDebounceRef) prevents mid-zoom cascade.
    const tier = quantiseTier(Math.min(renderTierRef.current, qcfgRef.current.maxAdjTier));

    // How many pages fit in the viewport at current zoom? Render enough to cover.
    const zoom = zoomRef.current;
    const containerH = container.clientHeight;
    const pagesInView = Math.ceil(containerH / (cssH * zoom));
    const adjCount = Math.max(1, Math.ceil(pagesInView / 2) + 1);

    const ac = new AbortController();
    const adjMap = adjCanvasMapRef.current;

    // Determine which page numbers should have adjacent canvases
    const wantedPages = new Set<number>();
    for (let offset = -adjCount; offset <= adjCount; offset++) {
      if (offset === 0) continue; // current page rendered by main canvas
      const pageNum = currentPage + offset;
      if (pageNum >= 1 && pageNum <= pageCount) wantedPages.add(pageNum);
    }

    // Remove canvases for pages no longer in range.
    // Backdrop canvases (data-transition-backdrop) stay in DOM temporarily —
    // renderTiledPage's batch display rAF removes them after tiles cover them.
    for (const [pageNum, entry] of adjMap) {
      if (!wantedPages.has(pageNum)) {
        if (entry.canvas.dataset.transitionBackdrop) {
          adjMap.delete(pageNum); // detach from map, keep in DOM
        } else {
          entry.canvas.remove();
          adjMap.delete(pageNum);
        }
      }
    }

    const blitAdjacentPage = async (pageNum: number, canvas: HTMLCanvasElement, yOffset: number) => {
      const cacheKey = pageCacheKey(pdfFileName, pageNum, tier, cleanMode);
      let entry = getPageCache(cacheKey);

      if (!entry) {
        try {
          const result = await renderPageToBitmap(pageNum, containerWidth, tier, cleanMode, ac.signal);
          if (ac.signal.aborted) { result.bitmap.close(); return; }
          putPageCache(cacheKey, result);
          entry = result;
        } catch { return; }
      }
      if (ac.signal.aborted || !entry) return;

      // CSS sizes use committedZoom so adjacent pages stay in lockstep with
      // the main page's wrapper-children sizing — see applyTransform docstring.
      const zCommit = committedZoomRef.current;
      // Always reset canvas dimensions to clear stale content and ensure
      // getContext returns a fresh context with correct alpha setting.
      canvas.width = entry.width;
      canvas.height = entry.height;
      canvas.style.width = `${entry.cssW * zCommit}px`;
      canvas.style.height = `${entry.cssH * zCommit}px`;
      canvas.style.position = 'absolute';
      canvas.style.left = '0';
      canvas.style.top = `${yOffset * zCommit}px`;
      canvas.style.pointerEvents = 'none';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(entry.bitmap, 0, 0);

      if (!canvas.parentElement) {
        wrapper.insertBefore(canvas, wrapper.firstChild);
      }
    };

    // Sort wanted pages by distance from current page (center-out priority)
    const sortedPages = [...wantedPages].sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage));

    // Render each wanted adjacent page sequentially (center-out)
    (async () => {
      for (const pageNum of sortedPages) {
        if (ac.signal.aborted) break;
        const offset = pageNum - currentPage;
        const yOffset = offset * cssH;
        let existing = adjMap.get(pageNum);

        if (existing && existing.tier === tier) {
          // Already rendered at correct tier — just reposition (committed-zoom-scaled)
          existing.canvas.style.top = `${yOffset * committedZoomRef.current}px`;
          continue;
        }

        // Need to render (new page or tier changed)
        if (!existing) {
          const canvas = document.createElement('canvas');
          canvas.className = 'pdf-adjacent-page';
          existing = { canvas, tier: 0 };
          adjMap.set(pageNum, existing);
        }
        existing.tier = tier;
        await blitAdjacentPage(pageNum, existing.canvas, yOffset);
      }
    })();

    return () => { ac.abort(); };
  }, [isLoaded, currentPage, pageCount, pdfFileName, cleanMode, renderPageToBitmap, adjTrigger]);

  // Sync search input when searchQuery changes externally (e.g. pre-populated from library)
  useEffect(() => {
    if (searchInputRef.current && searchQuery !== searchInputRef.current.value) {
      searchInputRef.current.value = searchQuery;
    }
  }, [searchQuery]);

  // Auto-clear lookup hint after 4 seconds
  useEffect(() => {
    if (!lookupHint) return;
    const timer = setTimeout(() => pdfStore.clearLookupHint(pdfFileName), 4000);
    return () => clearTimeout(timer);
  }, [lookupHint, pdfFileName]);

  const pendingMatchRef = useRef<{ index: number; id: number }>({ index: -1, id: 0 });

  const prevMatchIndexRef = useRef(-1);
  const prevMatchesRef = useRef<typeof matches | null>(null);
  useEffect(() => {
    if (!isLoaded || activeMatchIndex < 0 || !matches[activeMatchIndex]) return;
    // Only snap-to-match on explicit navigation (activeMatchIndex OR matches
    // array changed — a new search produces a fresh matches reference even if
    // activeMatchIndex happens to land on the same number).
    const isNewSearch = prevMatchesRef.current !== matches;
    if (!isNewSearch && activeMatchIndex === prevMatchIndexRef.current) return;
    prevMatchIndexRef.current = activeMatchIndex;
    prevMatchesRef.current = matches;

    const match = matches[activeMatchIndex];
    const matchPage = match.pageIndex + 1;
    if (matchPage !== currentPage) {
      skipResetRef.current = true;
    }

    const matchId = ++pendingMatchRef.current.id;
    pendingMatchRef.current.index = activeMatchIndex;

    let scaleRetries = 0;
    const applyZoomAndBlink = () => {
      if (pendingMatchRef.current.id !== matchId) return;
      if (!containerRef.current) return;

      const baseScale = scaleRef.current;
      const unscaledH = viewportHeightRef.current;
      if (baseScale === 0 || unscaledH === 0) {
        if (scaleRetries++ < 5) {
          // renderPage() hasn't completed yet — retry once it does
          setTimeout(() => {
            if (pendingMatchRef.current.id === matchId) applyZoomAndBlink();
          }, 100);
        }
        return;
      }

      // For multi-term / @ groups, zoom to fit all group members; otherwise zoom to single match
      const activeGroup = (isMultiTerm || isAtSyntax) ? pdfStore.getDocMatchGroups(pdfFileName)[pdfStore.getDocActiveGroupIndex(pdfFileName)] : null;
      const groupMatches = activeGroup
        ? activeGroup.map(i => matches[i]).filter(Boolean)
        : [match];

      const container = containerRef.current;
      const items = groupMatches.map(m => m.item);

      // If the active match is already visible in the current viewport AND we're
      // already on its page, don't snap — the user already sees it (e.g. Cmd+F
      // on a selected component that's under the cursor). Just blink it.
      const matchPageNow = match.pageIndex + 1;
      const vpT = viewportTransformRef.current;
      const z = zoomRef.current;
      const px = panRef.current.x;
      const py = panRef.current.y;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const isItemInView = (it: { transform: number[]; width: number }): boolean => {
        const r = textItemRect(it.transform, it.width, vpT, baseScale);
        const sx = r.x * z + px;
        const sy = r.y * z + py;
        const sw = r.w * z;
        const sh = r.h * z;
        return sx + sw > 0 && sy + sh > 0 && sx < cw && sy < ch;
      };
      // Skip the zoom only if we're ALREADY zoomed in enough AND the match is
      // visible. At low zooms the whole page is "in view" which would wrongly
      // leave the user at 100% — enforce the 300% floor instead.
      const alreadyInView = z >= 3.0 && matchPageNow === currentPage && items.some(isItemInView);

      // On a FRESH search only, try to relocate the active match to a
      // different visible match on the same page (handles "multiple U5
      // instances on the page, user is looking at one of them" when Cmd+F
      // runs a lookup from a selection). NOT on stepwise navigation — that
      // would bounce back and forth as the user presses Down.
      if (isNewSearch && !alreadyInView && matchPageNow === currentPage && !activeGroup) {
        for (let i = 0; i < matches.length; i++) {
          if (i === activeMatchIndex) continue;
          if (matches[i].pageIndex !== match.pageIndex) continue;
          if (isItemInView(matches[i].item)) {
            pdfStore.setActiveMatchIndex(i);
            return; // effect will re-run with the new index
          }
        }
      }

      if (!alreadyInView) {
        // Match navigation: enforce a floor of max(currentZoom, 3.0) so we never
        // zoom OUT when stepping between matches — stay at ≥300% or keep higher
        // zoom if the user was already zoomed in further.
        const floor = Math.max(zoomRef.current, 3.0);
        const { zoom: newZoom, pan: newPan } = zoomToItemGroup(
          items, viewportTransformRef.current, baseScale,
          container.clientWidth, container.clientHeight, 0.2,
          floor,
        );

        zoomRef.current = newZoom;
        panRef.current = newPan;
        syncTransform();
      }

      renderPageRef.current();

      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      blinkPhaseRef.current = 0;
      const totalBlinks = 6;
      const blinkInterval = 250;

      const doBlink = (phase: number) => {
        if (pendingMatchRef.current.id !== matchId) return;
        blinkPhaseRef.current = phase;
        drawHighlightsRef.current();
        if (phase < totalBlinks) {
          blinkTimerRef.current = setTimeout(() => doBlink(phase + 1), blinkInterval);
        } else {
          blinkPhaseRef.current = 0;
          drawHighlightsRef.current();
          blinkTimerRef.current = null;
        }
      };
      doBlink(1);
    };

    const raf = requestAnimationFrame(applyZoomAndBlink);

    return () => {
      cancelAnimationFrame(raf);
      if (blinkTimerRef.current) {
        clearTimeout(blinkTimerRef.current);
        blinkTimerRef.current = null;
      }
      blinkPhaseRef.current = 0;
    };
  }, [isLoaded, activeMatchIndex, matches, currentPage]);

  // Follow target: zoom + highlight location (triggered by board follow mode / click-to-lookup)
  useEffect(() => {
    const target = pdfStore.consumeFollowTarget();
    if (!target || !isLoaded) return;

    const targetPage = target.pageIndex + 1;
    if (targetPage !== currentPage) {
      skipResetRef.current = true;
    }

    let retries = 0;
    const applyFollowZoom = () => {
      const baseScale = scaleRef.current;
      if (baseScale === 0 || !containerRef.current) {
        if (retries++ < 5) setTimeout(applyFollowZoom, 100);
        return;
      }

      // Board→PDF lookup: match the match-nav behavior — floor zoom at 3.0
      // (or keep higher current zoom) and center on the target group.
      const floor = Math.max(zoomRef.current, 3.0);
      const { zoom, pan } = zoomToItemGroup(
        target.items, viewportTransformRef.current, baseScale,
        containerRef.current.clientWidth, containerRef.current.clientHeight, 0.25,
        floor,
      );
      zoomRef.current = zoom;
      panRef.current = pan;
      syncTransform();
      renderPageRef.current();

      // Show highlight on the first item for visual feedback
      if (target.items.length > 0) {
        const r = textItemRect(target.items[0].transform, target.items[0].width, viewportTransformRef.current, baseScale);
        setClickHighlight({ word: '', rect: { x: r.x, y: r.y, w: r.w, h: r.h }, key: ++clickHighlightKeyRef.current, zoom: zoomRef.current });
        if (clickHighlightTimerRef.current) clearTimeout(clickHighlightTimerRef.current);
        clickHighlightTimerRef.current = setTimeout(() => setClickHighlight(null), 3000);
      }
    };

    // Defer to ensure the page has rendered first
    const raf = requestAnimationFrame(applyFollowZoom);
    return () => cancelAnimationFrame(raf);
  }, [isLoaded, currentPage]);

  // Apply initial transform + re-sync after page change
  useEffect(() => { syncTransform(); }, [syncTransform, currentPage]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      // Container size changed → fit-to-width baseScale changes too, so tiles
      // cached at the old containerWidth would blit at the wrong size. Drop
      // them. Re-clamp pan/zoom against the new bounds so the page doesn't
      // sit off-screen until the next user input.
      invalidateTileCache(pdfFileName);
      renderPageRef.current();
      syncTransform();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [pdfFileName, syncTransform]);

  // Reload PDF with fontExtraProperties when glyph debug is first activated
  useEffect(() => {
    if (!isGlyphActive || fontDataLoaded || !isLoaded) return;
    let cancelled = false;
    (async () => {
      setGlyphLoading(true);
      try {
        await pdfStore.reloadWithFontData(pdfFileName);
        if (!cancelled) {
          setFontDataLoaded(true);
          await renderPageRef.current();
        }
      } catch (err) {
        log.pdf.error('reloadWithFontData failed:', err);
      } finally {
        if (!cancelled) setGlyphLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isGlyphActive, fontDataLoaded, isLoaded, pdfFileName]);

  // Extract glyphs and render debug/optimization overlay
  // Skip when nightMode is active — CSS invert filter would not apply to replacement text
  // cleanMode is fine: contrast is baked into canvas pixels at render time
  const isFiltered = nightMode;
  useEffect(() => {
    if (!isOverlayActive || !isLoaded || isFiltered) {
      const gc = glyphCanvasRef.current;
      if (gc) {
        const gCtx = gc.getContext('2d');
        if (gCtx) gCtx.clearRect(0, 0, gc.width, gc.height);
      }
      pageGlyphDataRef.current = null;
      return;
    }

    // textItems mode: draw raw pdf.js text items without glyph extraction
    if (isTextItemsMode) {
      const gc = glyphCanvasRef.current;
      const pdfCanvas = canvasRef.current;
      if (!gc || !pdfCanvas) return;
      gc.width = pdfCanvas.width;
      gc.height = pdfCanvas.height;
      gc.style.width = pdfCanvas.style.width;
      gc.style.height = pdfCanvas.style.height;

      const gCtx = gc.getContext('2d')!;
      gCtx.clearRect(0, 0, gc.width, gc.height);

      const vpT = viewportTransformRef.current;
      const renderScale = scaleRef.current * renderTierRef.current;
      const pageIndex = currentPage - 1;
      const rawItems = pdfStore.getDocTextItemsForPage(pdfFileName, pageIndex);
      drawTextItems(gCtx, rawItems, vpT, renderScale);

      // Log all text items to console for investigation
      log.pdf.log(`[textItems] Page ${currentPage}: ${rawItems.length} items extracted by pdf.js`);
      for (let i = 0; i < rawItems.length; i++) {
        const it = rawItems[i];
        log.pdf.log(`  #${i} "${it.str}" font=${it.fontName} fs=${pdfFontSize(it.transform).toFixed(1)} w=${it.width.toFixed(1)} tx=[${it.transform.map(v => v.toFixed(2)).join(',')}]`);
      }
      return;
    }

    // Glyph modes: need fontData loaded
    if (!isGlyphActive || !fontDataLoaded) {
      const gc = glyphCanvasRef.current;
      if (gc) {
        const gCtx = gc.getContext('2d');
        if (gCtx) gCtx.clearRect(0, 0, gc.width, gc.height);
      }
      pageGlyphDataRef.current = null;
      return;
    }

    let cancelled = false;
    (async () => {
      setGlyphLoading(true);
      try {
        const page = await pdfStore.getPageFor(pdfFileName, currentPage);
        const doc = pdfStore.getDocProxy(pdfFileName);
        if (!doc || cancelled) return;
        const pageIndex = currentPage - 1;
        const textItems = pdfStore.getDocTextItemsForPage(pdfFileName, pageIndex);
        const pageData = await extractPageGlyphs(page, doc, textItems, pageIndex);
        if (cancelled) return;
        pageGlyphDataRef.current = pageData;

        const gc = glyphCanvasRef.current;
        const pdfCanvas = canvasRef.current;
        if (!gc || !pdfCanvas) return;
        gc.width = pdfCanvas.width;
        gc.height = pdfCanvas.height;
        gc.style.width = pdfCanvas.style.width;
        gc.style.height = pdfCanvas.style.height;

        const gCtx = gc.getContext('2d')!;
        gCtx.clearRect(0, 0, gc.width, gc.height);

        // For simplify/replace: blit PDF canvas onto overlay, then modify in-place
        if (isGlyphComposite) {
          // Wait for PDF canvas to have content (renderPage may still be in flight)
          if (pdfCanvas.width === 0 || pdfCanvas.height === 0) {
            await new Promise<void>(resolve => {
              const check = () => {
                if (cancelled) { resolve(); return; }
                if (pdfCanvas.width > 0 && pdfCanvas.height > 0) { resolve(); return; }
                requestAnimationFrame(check);
              };
              requestAnimationFrame(check);
            });
            if (cancelled) return;
          }
          gCtx.drawImage(pdfCanvas, 0, 0);
        }

        const vpT = viewportTransformRef.current;
        const renderScale = scaleRef.current * renderTierRef.current;

        if (glyphDebug.overlayMode === 'boxes') {
          drawGlyphBoxes(gCtx, pageData, vpT, renderScale);
        } else if (glyphDebug.overlayMode === 'outlines') {
          drawGlyphOutlines(gCtx, pageData, vpT, renderScale);
        }

        if (glyphDebug.simplifyEnabled) {
          simplifyStatsRef.current = drawSimplifiedGlyphs(gCtx, pageData, vpT, renderScale, glyphDebug.simplifyTolerance);
        } else {
          simplifyStatsRef.current = null;
        }
        if (glyphDebug.replaceEnabled) {
          drawMonospaceReplacement(gCtx, pageData, vpT, renderScale, glyphDebug.replaceFont);
        }
      } catch (err) {
        log.pdf.error('glyph overlay failed:', err);
      } finally {
        if (!cancelled) setGlyphLoading(false);
      }
    })();

    return () => { cancelled = true; };

  }, [isOverlayActive, isTextItemsMode, isGlyphActive, isGlyphComposite, fontDataLoaded, isLoaded, isFiltered, pdfFileName, currentPage,
      glyphDebug.overlayMode, glyphDebug.simplifyEnabled, glyphDebug.simplifyTolerance,
      glyphDebug.replaceEnabled, glyphDebug.replaceFont, renderEpoch]);

  // Clean up font cache + adjacent canvases on unmount
  useEffect(() => {
    return () => {
      const doc = pdfStore.getDocProxy(pdfFileName);
      clearFontCache(doc?.fingerprints[0] ?? undefined);
      pageGlyphDataRef.current = null;
      for (const entry of adjCanvasMapRef.current.values()) entry.canvas.remove();
      adjCanvasMapRef.current.clear();
      if (adjDebounceRef.current) clearTimeout(adjDebounceRef.current);
      if (scrubberFlashTimerRef.current) clearTimeout(scrubberFlashTimerRef.current);
    };
  }, [pdfFileName]);

  // Accumulated scroll for page-switch mode — debounce discrete page flips
  const switchAccRef = useRef(0);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      pdfStore.switchTo(pdfFileName);

      // Trackpad pinch-to-zoom generates wheel events with ctrlKey=true.
      // Always treat those as zoom — pinch is a fundamental gesture that should
      // never be remapped by scroll binding settings.
      const isTrackpadPinch = e.ctrlKey && !e.metaKey && !e.shiftKey;
      if (isTrackpadPinch) log.ui.log('pdf wheel pinch (ctrlKey)', { deltaY: e.deltaY });

      // Resolve effective action: trackpad pinch → always zoom, otherwise use bindings.
      // No `wheelDetection` safety net here — on PDF, classic mouse-wheel scrolling
      // is the natural way to walk through pages, so pan stays as pan even if the
      // input looks wheel-shaped. (Safety net remains active on the board view,
      // where there's no "next page" affordance.)
      const bindings = scrollBindingsRef.current;
      const effectiveAction: ScrollAction = isTrackpadPinch
        ? 'zoom'
        : (e.metaKey || e.ctrlKey) ? bindings.meta
        : e.shiftKey ? bindings.shift
        : bindings.bare;

      if (effectiveAction === 'zoom') {
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Min zoom floor: 0.5 (50% of fit-to-width). The fit-to-width-only
        // lock from a876c74 made multi-page navigation feel "stuck" — at
        // zoom > 1 each page is taller than the viewport, and the flip
        // threshold takes many wheel events to reach. 50% restores the
        // zoom-out-to-see-adjacent-pages workflow without going so far out
        // that the boundary-bounce glitch the lock was masking re-surfaces.
        const cssH = pageCssHRef.current;
        const minZoom = 0.5;

        // Trackpad pinch has small deltaY values — use higher sensitivity
        const speed = isTrackpadPinch ? TRACKPAD_PINCH_SPEED : MOUSE_WHEEL_SPEED;
        const zoomFactor = Math.exp(-e.deltaY * speed);
        const oldZoom = zoomRef.current;
        const newZoom = Math.max(minZoom, Math.min(oldZoom * zoomFactor, 10));
        const ratio = newZoom / oldZoom;
        const oldPan = panRef.current;
        const newPanY = mouseY - ratio * (mouseY - oldPan.y);
        panRef.current = {
          x: mouseX - ratio * (mouseX - oldPan.x),
          y: newPanY,
        };
        zoomRef.current = newZoom;

        // Page boundary detection during zoom: when zoomed in and the viewport
        // center has moved over an adjacent page, switch to it so it renders crisp.
        if (cssH > 0) {
          const pageH = cssH * newZoom;
          const containerH = container.clientHeight;
          const curPage = pdfStore.getDocCurrentPage(pdfFileName);
          const total = pdfStore.getDocPageCount(pdfFileName);

          if (newPanY + pageH < containerH / 2 && curPage < total) {
            skipResetRef.current = true;
            ++tileRenderIdRef.current;
            // Cancel stale timers — they have closures over old currentPage
            if (tierDebounceRef.current) { clearTimeout(tierDebounceRef.current); tierDebounceRef.current = null; }
            if (crispTimerRef.current) { clearTimeout(crispTimerRef.current); crispTimerRef.current = null; }
            for (const c of tileContainerRef.current.values()) c.style.display = 'none';
            pdfStore.goToPage(curPage + 1);
            panRef.current = { x: panRef.current.x, y: newPanY + pageH };
            flashScrubber();
            syncTransform();
            return;
          } else if (newPanY > containerH / 2 && curPage > 1) {
            skipResetRef.current = true;
            ++tileRenderIdRef.current;
            if (tierDebounceRef.current) { clearTimeout(tierDebounceRef.current); tierDebounceRef.current = null; }
            if (crispTimerRef.current) { clearTimeout(crispTimerRef.current); crispTimerRef.current = null; }
            for (const c of tileContainerRef.current.values()) c.style.display = 'none';
            pdfStore.goToPage(curPage - 1);
            panRef.current = { x: panRef.current.x, y: newPanY - pageH };
            flashScrubber();
            syncTransform();
            return;
          }
        }

        syncTransform();
        scheduleTierRender();
        return;
      }

      if (effectiveAction === 'pan') {
        // Omnidirectional multi-page scrolling. Two-finger scroll moves freely
        // in X and Y. syncTransform → clampPan handles all boundary clamping.
        const cssH = pageCssHRef.current;
        if (cssH === 0) return;
        const zoom = zoomRef.current;
        const pageH = cssH * zoom;
        const containerH = container.clientHeight;

        const oldPan = panRef.current;
        const newX = oldPan.x - e.deltaX;
        let newY = oldPan.y - e.deltaY;

        const curPage = pdfStore.getDocCurrentPage(pdfFileName);
        const total = pdfStore.getDocPageCount(pdfFileName);

        if (newY + pageH < containerH / 2 && curPage < total) {
          skipResetRef.current = true;
          ++tileRenderIdRef.current;
          if (tierDebounceRef.current) { clearTimeout(tierDebounceRef.current); tierDebounceRef.current = null; }
          if (crispTimerRef.current) { clearTimeout(crispTimerRef.current); crispTimerRef.current = null; }
          for (const c of tileContainerRef.current.values()) c.style.display = 'none';
          // In tiled mode: reposition the adjacent canvas as backdrop until tiles render.
          // In full-page mode: renderPage blits from cache instantly, no backdrop needed.
          if (zoom > 1.05) {
            const adj = adjCanvasMapRef.current.get(curPage + 1);
            if (adj) {
              adj.canvas.style.top = '0px';
              adj.canvas.dataset.transitionBackdrop = '1';
              wrapperRef.current?.querySelectorAll('canvas[data-transition-backdrop]').forEach(c => { if (c !== adj.canvas) c.remove(); });
            }
          }
          pdfStore.goToPage(curPage + 1);
          newY += pageH;
          flashScrubber();
        } else if (newY > containerH / 2 && curPage > 1) {
          skipResetRef.current = true;
          ++tileRenderIdRef.current;
          if (tierDebounceRef.current) { clearTimeout(tierDebounceRef.current); tierDebounceRef.current = null; }
          if (crispTimerRef.current) { clearTimeout(crispTimerRef.current); crispTimerRef.current = null; }
          for (const c of tileContainerRef.current.values()) c.style.display = 'none';
          if (zoom > 1.05) {
            const adj = adjCanvasMapRef.current.get(curPage - 1);
            if (adj) {
              adj.canvas.style.top = '0px';
              adj.canvas.dataset.transitionBackdrop = '1';
              wrapperRef.current?.querySelectorAll('canvas[data-transition-backdrop]').forEach(c => { if (c !== adj.canvas) c.remove(); });
            }
          }
          pdfStore.goToPage(curPage - 1);
          newY -= pageH;
          flashScrubber();
        }

        panRef.current = { x: newX, y: newY };
        syncTransform();
        return;
      }

      // action === 'switch': discrete page change, page stays centered
      const delta = e.deltaY;
      switchAccRef.current += delta;
      if (switchTimerRef.current) clearTimeout(switchTimerRef.current);
      switchTimerRef.current = setTimeout(() => { switchAccRef.current = 0; }, 200);

      const threshold = 50; // pixels of scroll accumulation needed
      if (Math.abs(switchAccRef.current) >= threshold) {
        const dir = switchAccRef.current > 0 ? 1 : -1;
        switchAccRef.current = 0;
        const doc = pdfStore.getDocCurrentPage(pdfFileName);
        const total = pdfStore.getDocPageCount(pdfFileName);
        const target = doc + dir;
        if (target >= 1 && target <= total) {
          // Reset zoom/pan to center the new page (don't skip reset)
          zoomRef.current = 1;
          panRef.current = { x: 0, y: 0 };
          pdfStore.goToPage(target);
          syncTransform();
          flashScrubber();
        }
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);

  }, [pdfFileName, isLoaded, syncTransform, scheduleTierRender, flashScrubber]);

  // --- Safari trackpad pinch via gesture* events ---
  // Mac Safari emits gesture* events for trackpad pinch. The global handler in
  // browser-zoom-block.ts preventDefaults gesture events at window level to
  // block browser page-zoom; that means the PDF never receives a zoom signal
  // via the wheel+ctrlKey path either, since Safari's pinch path is gesture-only.
  // Bubble-phase panel handlers fire before the window block and consume the
  // event with stopPropagation, so the global net stays a fallback for
  // gestures outside the panel (toolbar, sidebar).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startZoom = 1;
    let mid = { x: 0, y: 0 };

    const onGestureStart = (e: GestureEvent) => {
      pdfStore.switchTo(pdfFileName);
      startZoom = zoomRef.current;
      const rect = container.getBoundingClientRect();
      mid = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      log.ui.log('pdf gesturestart (Safari pinch)', { scale: e.scale });
      e.preventDefault();
      e.stopPropagation();
    };

    const onGestureChange = (e: GestureEvent) => {
      const minZoom = 0.5;
      const newZoom = Math.max(minZoom, Math.min(startZoom * e.scale, 10));
      const ratio = newZoom / zoomRef.current;
      panRef.current = {
        x: mid.x - ratio * (mid.x - panRef.current.x),
        y: mid.y - ratio * (mid.y - panRef.current.y),
      };
      zoomRef.current = newZoom;
      syncTransform();
      e.preventDefault();
      e.stopPropagation();
    };

    const onGestureEnd = (e: GestureEvent) => {
      scheduleTierRender();
      e.preventDefault();
      e.stopPropagation();
    };

    container.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    container.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    container.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });
    return () => {
      container.removeEventListener('gesturestart', onGestureStart as EventListener);
      container.removeEventListener('gesturechange', onGestureChange as EventListener);
      container.removeEventListener('gestureend', onGestureEnd as EventListener);
    };
  }, [pdfFileName, syncTransform, scheduleTierRender]);

  // --- Touch pinch-to-zoom state ---
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStartDistRef = useRef(0);
  const pinchStartZoomRef = useRef(1);
  const pinchMidRef = useRef({ x: 0, y: 0 });

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    container.setPointerCapture(e.pointerId);
    activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pdfStore.switchTo(pdfFileName);

    if (activeTouchesRef.current.size === 1 && (e.pointerType === 'mouse' ? e.button === 0 : true)) {
      cancelAnimationFrame(inertiaRafRef.current);
      velocityRef.current = { x: 0, y: 0 };
      lastDragTimeRef.current = performance.now();
      isDraggingRef.current = true;
      wasDragRef.current = false;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
      lastMouseRef.current = { x: e.clientX, y: e.clientY };
    }

    if (activeTouchesRef.current.size === 2) {
      // Start pinch — cancel any single-finger drag
      isDraggingRef.current = false;
      wasDragRef.current = false;
      const pts = [...activeTouchesRef.current.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      pinchStartDistRef.current = Math.sqrt(dx * dx + dy * dy);
      pinchStartZoomRef.current = zoomRef.current;
      const rect = container.getBoundingClientRect();
      pinchMidRef.current = {
        x: (pts[0].x + pts[1].x) / 2 - rect.left,
        y: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
    }
  }, [pdfFileName]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const prev = activeTouchesRef.current.get(e.pointerId);
    if (!prev) return;
    activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger pinch zoom
    if (activeTouchesRef.current.size === 2) {
      const pts = [...activeTouchesRef.current.values()];
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (pinchStartDistRef.current > 0) {
        const rawScale = dist / pinchStartDistRef.current;
        const scale = 1 + (rawScale - 1) * TOUCH_PINCH_FACTOR;
        const oldZoom = zoomRef.current;
        const minZoom = 0.5;
        const newZoom = Math.max(minZoom, Math.min(pinchStartZoomRef.current * scale, 10));
        const ratio = newZoom / oldZoom;
        const mid = pinchMidRef.current;
        panRef.current = {
          x: mid.x - ratio * (mid.x - panRef.current.x),
          y: mid.y - ratio * (mid.y - panRef.current.y),
        };
        zoomRef.current = newZoom;
        syncTransform();
        // Skip expensive PDF re-render during active pinch — CSS transform is enough.
        // The crisp render fires on pinch end (handlePointerUp).
      }
      return;
    }

    // Single-finger drag
    if (!isDraggingRef.current) return;
    const dxm = e.clientX - lastMouseRef.current.x;
    const dym = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    if (!wasDragRef.current) {
      const totalDx = e.clientX - dragStartRef.current.x;
      const totalDy = e.clientY - dragStartRef.current.y;
      if (Math.abs(totalDx) < DRAG_THRESHOLD && Math.abs(totalDy) < DRAG_THRESHOLD) return;
      wasDragRef.current = true;
    }

    // Track velocity for inertia
    const now = performance.now();
    const dt = now - lastDragTimeRef.current;
    if (dt > 0) {
      const decay = 0.6; // blend with previous velocity for smoothing
      velocityRef.current = {
        x: decay * velocityRef.current.x + (1 - decay) * (dxm / dt * 16),
        y: decay * velocityRef.current.y + (1 - decay) * (dym / dt * 16),
      };
    }
    lastDragTimeRef.current = now;

    panRef.current = { x: panRef.current.x + dxm, y: panRef.current.y + dym };
    syncTransform();
  }, [syncTransform]);

  /** Find the word + its page-space rect under a click. Shared by single & double click. */
  const hitTestWord = useCallback((e: React.MouseEvent): { word: string; rect: { x: number; y: number; w: number; h: number }; pageIndex: number; itemIndex: number } | null => {
    if (!isLoaded) return null;
    const container = containerRef.current;
    if (!container) return null;

    const containerRect = container.getBoundingClientRect();
    const clickX = (e.clientX - containerRect.left - panRef.current.x) / zoomRef.current;
    const clickY = (e.clientY - containerRect.top - panRef.current.y) / zoomRef.current;

    const scale = scaleRef.current;
    const vpT = viewportTransformRef.current;
    const pageIndex = currentPage - 1;
    const items = pdfStore.getDocTextItemsForPage(pdfFileName, pageIndex);

    // Collect all matching items at the click point, pick the smallest font.
    // Watermark filter: skip text items matching any configured watermark term.
    const wmFilter = renderSettingsStore.globalSettings.pdfWatermarkFilter;
    let bestHit: { word: string; rect: { x: number; y: number; w: number; h: number }; fontSize: number; itemIndex: number } | null = null;

    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];
      if (isPdfWatermarkText(item.str, wmFilter)) continue;
      const r = textItemRect(item.transform, item.width, vpT, scale);
      if (clickX >= r.x && clickX <= r.x + r.w && clickY >= r.y && clickY <= r.y + r.h) {
        const charWidth = r.w / item.str.length;
        const charIndex = Math.floor((clickX - r.x) / charWidth);
        const word = extractWord(item.str, charIndex);
        if (word) {
          const fontSize = Math.sqrt(item.transform[2] ** 2 + item.transform[3] ** 2);
          if (!bestHit || fontSize < bestHit.fontSize) {
            const wordStart = item.str.toUpperCase().indexOf(word.toUpperCase(), Math.max(0, charIndex - word.length));
            const wx = r.x + (wordStart >= 0 ? wordStart * charWidth : 0);
            const ww = word.length * charWidth;
            const fontH = fontSize * LINE_HEIGHT_RATIO * scale;
            const h = Math.min(r.h, fontH);
            const y = r.y + (r.h - h) / 2;
            bestHit = { word, rect: { x: wx, y, w: ww, h }, fontSize, itemIndex: ii };
          }
        }
      }
    }
    return bestHit ? { word: bestHit.word, rect: bestHit.rect, pageIndex, itemIndex: bestHit.itemIndex } : null;
  }, [pdfFileName, isLoaded, currentPage]);

  const handleTextClick = useCallback((e: React.MouseEvent) => {
    const hit = hitTestWord(e);
    if (!hit) { setClickHighlight(null); return; }

    // Remember last clicked word + location for Cmd+F prefill / exact-match pick
    pdfStore.setLastClickedWord(hit.word);
    pdfStore.setLastClickedLocation({ fileName: pdfFileName, pageIndex: hit.pageIndex, itemIndex: hit.itemIndex });

    // Show highlight + tooltip overlay on any text
    setClickHighlight({ ...hit, key: ++clickHighlightKeyRef.current, zoom: zoomRef.current });
    if (clickHighlightTimerRef.current) clearTimeout(clickHighlightTimerRef.current);
    clickHighlightTimerRef.current = setTimeout(() => setClickHighlight(null), 4000);

    // Focus part/net on board AND mirror the term into the board search panel
    // (board → PDF lookup is symmetric; this closes the reverse direction).
    const board = boardStore.board;
    if (board) {
      const upper = hit.word.toUpperCase();
      const isPart = board.parts.some(p => p.name.toUpperCase() === upper);
      const isNet = !isPart && [...board.nets.keys()].some(n => n.toUpperCase() === upper);
      if (isPart) boardStore.focusPart(hit.word);
      else if (isNet) boardStore.focusNet(hit.word);
      if (isPart || isNet) openBoardSearch(hit.word);
    }
  }, [hitTestWord, pdfFileName]);

  const handleTextDblClick = useCallback((e: React.MouseEvent) => {
    const hit = hitTestWord(e);
    if (!hit) return;

    // Double-click always overrides search
    if (searchInputRef.current) {
      searchInputRef.current.value = hit.word;
      pdfStore.switchTo(pdfFileName);
      // Set location so searchText picks the exact clicked occurrence
      pdfStore.setLastClickedLocation({ fileName: pdfFileName, pageIndex: hit.pageIndex, itemIndex: hit.itemIndex });
      pdfStore.searchText(hit.word);
      navHintShownRef.current = false;
    }
    setClickHighlight(null);

    const board = boardStore.board;
    if (board) {
      const upper = hit.word.toUpperCase();
      if (board.parts.some(p => p.name.toUpperCase() === upper)) {
        boardStore.focusPart(hit.word);
      } else {
        boardStore.focusNet(hit.word);
      }
      openBoardSearch(hit.word);
    }
  }, [hitTestWord, pdfFileName]);

  const handleTextClickRef = useRef(handleTextClick);
  handleTextClickRef.current = handleTextClick;

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasPinching = activeTouchesRef.current.size >= 2;
    activeTouchesRef.current.delete(e.pointerId);
    if (activeTouchesRef.current.size < 2) {
      pinchStartDistRef.current = 0;
    }

    // Pinch ended — schedule crisp re-render at final zoom level
    if (wasPinching && activeTouchesRef.current.size < 2) {
      scheduleTierRender();
    }

    const wasDrag = wasDragRef.current;
    isDraggingRef.current = false;
    wasDragRef.current = false;

    // Inertia: continue panning with decaying velocity
    if (wasDrag && pdfInertiaRef.current) {
      const v = velocityRef.current;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y);
      if (speed > 0.5) {
        cancelAnimationFrame(inertiaRafRef.current);
        const friction = 0.93;
        const animate = () => {
          velocityRef.current.x *= friction;
          velocityRef.current.y *= friction;
          if (Math.abs(velocityRef.current.x) < 0.2 && Math.abs(velocityRef.current.y) < 0.2) return;
          panRef.current = {
            x: panRef.current.x + velocityRef.current.x,
            y: panRef.current.y + velocityRef.current.y,
          };
          syncTransform();
          inertiaRafRef.current = requestAnimationFrame(animate);
        };
        inertiaRafRef.current = requestAnimationFrame(animate);
      }
    }
    velocityRef.current = { x: 0, y: 0 };

    if (!wasDrag && e.button === 0 && e.pointerType !== 'touch') {
      handleTextClickRef.current(e);
    }
  }, [scheduleTierRender]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    // No-op: Enter is handled by the input's onKeyDown so we can read
    // shiftKey to decide between next/prev and a fresh search.
  };

  // Show ↑↓ navigation hint once when matches first appear
  if (matches.length > 0 && !navHintShownRef.current) {
    navHintShownRef.current = true;
    if (!showNavHint) setShowNavHint(true);
    if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
    navHintTimerRef.current = setTimeout(() => setShowNavHint(false), 5000);
  }

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const zoom = zoomRef.current;
    const pan = panRef.current;
    // Screen → CSS-space on the wrapper (page is sized cssW × cssH in CSS units)
    const cssX = (e.clientX - rect.left - pan.x) / zoom;
    const cssY = (e.clientY - rect.top - pan.y) / zoom;

    const baseScale = scaleRef.current;
    const vpT = viewportTransformRef.current;
    if (baseScale <= 0 || !vpT) {
      contextMenuStore.showPdf(e.clientX, e.clientY, '', pdfFileName);
      return;
    }

    const curPage = pdfStore.getDocCurrentPage(pdfFileName);
    const pageIdx = curPage - 1;
    const items = pdfStore.getDocTextItemsForPage(pdfFileName, pageIdx);

    // Walk items, pick the smallest bbox containing (cssX, cssY)
    let bestStr = '';
    let bestArea = Infinity;
    for (const item of items) {
      const r = textItemRect(item.transform, item.width, vpT, baseScale);
      if (cssX >= r.x && cssX <= r.x + r.w && cssY >= r.y && cssY <= r.y + r.h) {
        const area = r.w * r.h;
        if (area < bestArea) {
          bestArea = area;
          bestStr = item.str.trim();
        }
      }
    }

    contextMenuStore.showPdf(e.clientX, e.clientY, bestStr, pdfFileName);
  }, [pdfFileName]);

  // DEV-only test hook: expose helpers so Playwright can exercise the
  // hit-test without reconstructing the transform math.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = window as unknown as {
      __pdfPanelTestHooks?: Record<string, unknown>;
    };
    target.__pdfPanelTestHooks = {
      ...(target.__pdfPanelTestHooks || {}),
      [pdfFileName]: {
        // Direct ref access — used by keyboard-shortcuts-game.spec.ts to read
        // pan/zoom state after dispatching pdf-pan / pdf-zoom events.
        getPan: () => ({ ...panRef.current }),
        getZoom: () => zoomRef.current,
        firstItemScreenCenter: () => {
          const container = containerRef.current;
          if (!container) return null;
          const rect = container.getBoundingClientRect();
          const zoom = zoomRef.current;
          const pan = panRef.current;
          const baseScale = scaleRef.current;
          const vpT = viewportTransformRef.current;
          if (baseScale <= 0 || !vpT) return null;
          const curPage = pdfStore.getDocCurrentPage(pdfFileName);
          const items = pdfStore.getDocTextItemsForPage(pdfFileName, curPage - 1);
          for (const item of items) {
            if (!item.str.trim()) continue;
            const r = textItemRect(item.transform, item.width, vpT, baseScale);
            const cx = rect.left + pan.x + (r.x + r.w / 2) * zoom;
            const cy = rect.top + pan.y + (r.y + r.h / 2) * zoom;
            return { clientX: cx, clientY: cy, str: item.str };
          }
          return null;
        },
      },
    };
    return () => {
      const hooks = target.__pdfPanelTestHooks as Record<string, unknown> | undefined;
      if (hooks) delete hooks[pdfFileName];
    };
  }, [pdfFileName]);

  /** Reset zoom to 1 and pan to origin — page fits container width exactly */
  const handleFitWidth = useCallback(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    syncTransform();
    scheduleTierRender();
  }, [syncTransform, scheduleTierRender]);

  // Listen for global Space key → fit-to-width dispatch, and keyboard pan/zoom events
  useEffect(() => {
    const handler = () => handleFitWidth();
    // pdf-fit-width intentionally omits the props.api.isActive gate: the
    // shortcut dispatch site already restricts firing to the PDF panel under
    // the cursor, so gating here would double-filter and miss legitimate cases.
    window.addEventListener('pdf-fit-width', handler);

    const panHandler = (ev: Event) => {
      // Active-panel gate: only the dockview-active PDF panel acts.
      if (!props.api.isActive) return;

      const detail = (ev as CustomEvent<{ direction: 'left' | 'right' | 'up' | 'down' }>).detail;
      const containerEl = containerRef.current;
      if (!containerEl || !wrapperRef.current) return;
      const cw = containerEl.clientWidth;
      const ch = containerEl.clientHeight;
      const { keyboardPanFraction } = renderSettingsStore.settings;
      const stepX = cw * keyboardPanFraction;
      const stepY = ch * keyboardPanFraction;
      let dx = 0, dy = 0;
      if (detail.direction === 'left')  dx = +stepX;
      if (detail.direction === 'right') dx = -stepX;
      if (detail.direction === 'up')    dy = +stepY;
      if (detail.direction === 'down')  dy = -stepY;
      panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
      syncTransform();
    };
    window.addEventListener('pdf-pan', panHandler as EventListener);

    const zoomHandler = (ev: Event) => {
      // Active-panel gate: only the dockview-active PDF panel acts.
      if (!props.api.isActive) return;

      const detail = (ev as CustomEvent<{ direction: 'in' | 'out' }>).detail;
      const containerEl = containerRef.current;
      if (!containerEl || !wrapperRef.current) return;
      const rawDelta = renderSettingsStore.settings.keyboardZoomDelta;
      const factor = Math.pow(2, 1.3 * (rawDelta / 500));
      const effFactor = detail.direction === 'in' ? factor : 1 / factor;
      const mid = { x: containerEl.clientWidth / 2, y: containerEl.clientHeight / 2 };
      const minZoom = 0.5;
      const oldZ = zoomRef.current;
      const newZ = Math.max(minZoom, Math.min(oldZ * effFactor, 10));
      const ratio = newZ / oldZ;
      // Pan correction: anchor the zoom on the container centre so the visible
      // mid-point stays put when the scale changes. Same formula as wheel-zoom.
      panRef.current = {
        x: mid.x - ratio * (mid.x - panRef.current.x),
        y: mid.y - ratio * (mid.y - panRef.current.y),
      };
      zoomRef.current = newZ;
      syncTransform();
      scheduleTierRender();
    };
    window.addEventListener('pdf-zoom', zoomHandler as EventListener);

    return () => {
      window.removeEventListener('pdf-fit-width', handler);
      window.removeEventListener('pdf-pan', panHandler as EventListener);
      window.removeEventListener('pdf-zoom', zoomHandler as EventListener);
    };
  }, [handleFitWidth, props.api, syncTransform, scheduleTierRender]);

  const handleAddBookmark = useCallback(() => {
    pdfStore.switchTo(pdfFileName);
    pdfStore.addBookmark(currentPage, zoomRef.current, panRef.current.x, panRef.current.y);
  }, [pdfFileName, currentPage]);

  const handleBookmarkClick = useCallback((id: string) => {
    if (bookmarkClickTimerRef.current) {
      clearTimeout(bookmarkClickTimerRef.current);
      bookmarkClickTimerRef.current = null;
    }
    bookmarkClickTimerRef.current = setTimeout(() => {
      bookmarkClickTimerRef.current = null;
      pdfStore.switchTo(pdfFileName);
      const bm = pdfStore.getDocBookmarks(pdfFileName).find(b => b.id === id);
      if (!bm) return;
      zoomRef.current = bm.zoom;
      panRef.current = { x: bm.panX, y: bm.panY };
      const samePage = bm.page === pdfStore.getDocCurrentPage(pdfFileName);
      if (!samePage) {
        // Defer zoom/pan restore — goToPage triggers re-render + renderPage via useEffect.
        // skipResetRef prevents the page-change effect from resetting zoom/pan to defaults.
        skipResetRef.current = true;
        pdfStore.goToPage(bm.page);
      }
      syncTransform();
      // Only render immediately when staying on the same page. When changing pages,
      // the useEffect([renderPage]) fires after re-render with the correct currentPage.
      if (samePage) renderPageRef.current();
    }, 250);
  }, [pdfFileName]);

  const handleBookmarkDblClick = useCallback((id: string) => {
    if (bookmarkClickTimerRef.current) {
      clearTimeout(bookmarkClickTimerRef.current);
      bookmarkClickTimerRef.current = null;
    }
    pdfStore.switchTo(pdfFileName);
    pdfStore.updateBookmark(id, currentPage, zoomRef.current, panRef.current.x, panRef.current.y);
  }, [pdfFileName, currentPage]);

  const handleBookmarkRightClick = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    pdfStore.switchTo(pdfFileName);
    pdfStore.removeBookmark(id);
  }, [pdfFileName]);

  const handleBookmarkMiddleClick = useCallback((e: React.MouseEvent, id: string) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      pdfStore.switchTo(pdfFileName);
      const bm = pdfStore.bookmarks.find(b => b.id === id);
      if (bm) {
        setEditingBookmarkId(id);
        setEditingLabel(bm.label);
      }
    }
  }, [pdfFileName]);

  const handleLabelEditSubmit = useCallback((id: string) => {
    pdfStore.switchTo(pdfFileName);
    pdfStore.renameBookmark(id, editingLabel.trim());
    setEditingBookmarkId(null);
    setEditingLabel('');
  }, [pdfFileName, editingLabel]);

  const handleLabelEditKeyDown = useCallback((e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      handleLabelEditSubmit(id);
    } else if (e.key === 'Escape') {
      setEditingBookmarkId(null);
      setEditingLabel('');
    }
  }, [handleLabelEditSubmit]);

  if (!isLoaded) {
    return (
      <div className="pdf-viewer pdf-empty">
        <span>{pdfFileName ? `Loading ${pdfFileName}...` : 'No PDF loaded.'}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pdf-viewer pdf-empty">
        <span style={{ color: '#ff6666' }}>PDF error: {error}</span>
      </div>
    );
  }

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        {boardTabNames.length > 0 && (
          <BindLink
            boundNames={boundBoardTabs.map(t => t.fileName)}
            options={boardTabNames}
            onToggle={handleBindBoard}
            title={boundBoardTabs.length > 0 ? `Board: ${boundBoardTabs.map(t => t.fileName).join(', ')}` : 'No board linked'}
            headerItem={{
              label: 'auto-open boardview',
              checked: autoSwitchLinked,
              onChange: setAutoSwitchLinked,
            }}
          />
        )}
        <span className="pdf-filename" title={boundBoardTabs.length > 0 ? boundBoardTabs.map(t => t.fileName).join(', ') : 'No board linked'}>
          {boundBoardTabs.length > 0 ? boundBoardTabs.map(t => t.fileName).join(', ') : 'no link'}
        </span>
        <div className="pdf-toolbar-separator" />

        <div className="pdf-toolbar-group">
          <button
            className="pdf-toolbar-btn"
            onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(currentPage - 1); }}
            disabled={currentPage <= 1}
          >
            ◀
          </button>
          <input
            className="pdf-page-input"
            type="text"
            value={currentPage}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              if (!isNaN(n)) { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(n); }
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onFocus={e => e.target.select()}
          />
          <span className="pdf-page-info">/ {pageCount}</span>
          <button
            className="pdf-toolbar-btn"
            onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(currentPage + 1); }}
            disabled={currentPage >= pageCount}
          >
            ▶
          </button>
        </div>

        <div className="pdf-toolbar-separator" />
        <div className="pdf-search-wrapper">
          <div className="pdf-search-bar">
            <form className="pdf-search-form" onSubmit={handleSearch}>
              <input
                ref={searchInputRef}
                type="text"
                className="pdf-search-input"
                placeholder="Search (multi-term: 10UF 25V)"
                title="Enter / ↓ / Cmd+F — next match. Shift+Enter / ↑ / Shift+Cmd+F — previous match."
                defaultValue={searchQuery}
                onChange={(e) => {
                  if (!e.target.value.trim()) {
                    pdfStore.switchTo(pdfFileName);
                    pdfStore.searchText('');
                  }
                }}
                onKeyDown={(e) => {
                  if (matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                    e.preventDefault();
                    pdfStore.switchTo(pdfFileName);
                    if (e.key === 'ArrowDown') pdfStore.nextMatch();
                    else pdfStore.prevMatch();
                    return;
                  }
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const value = (e.target as HTMLInputElement).value;
                    pdfStore.switchTo(pdfFileName);
                    // Query unchanged + have matches → step next/prev (Shift = prev).
                    if (value && value === searchQuery && matches.length > 0) {
                      if (e.shiftKey) pdfStore.prevMatch();
                      else pdfStore.nextMatch();
                      return;
                    }
                    pdfStore.searchText(value);
                    navHintShownRef.current = false;
                  }
                }}
              />
            </form>
            {matches.length > 0 && (
              <>
                <button className="pdf-search-nav-btn" onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.prevMatch(); }} title="Previous match">&#9650;</button>
                <span className="pdf-search-counter">
                  {matchGroupCount > 0
                    ? `${activeGroupIndex + 1}/${matchGroupCount}`
                    : `${activeMatchIndex + 1}/${matches.length}`}
                </span>
                <button className="pdf-search-nav-btn" onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.nextMatch(); }} title="Next match">&#9660;</button>
              </>
            )}
          </div>
          {lookupHint && (
            <div className="pdf-lookup-hint">
              Double-click <b>{lookupHint}</b> to search
            </div>
          )}
          {showNavHint && (
            <div className="pdf-nav-hint">Enter / ↑↓ to navigate results</div>
          )}
          {isMultiTerm && (
            <div className="pdf-multiterm-dropdown">
              <div className="pdf-gap-row">
                <label>V</label>
                <input
                  type="range" min={0.5} max={20} step={0.5}
                  defaultValue={multiTermYGap}
                  onPointerUp={e => { pdfStore.switchTo(pdfFileName); pdfStore.setMultiTermYGap(Number((e.target as HTMLInputElement).value)); }}
                />
                <span>{multiTermYGap}x</span>
              </div>
              <div className="pdf-gap-row">
                <label>H</label>
                <input
                  type="range" min={0.5} max={20} step={0.5}
                  defaultValue={multiTermXGap}
                  onPointerUp={e => { pdfStore.switchTo(pdfFileName); pdfStore.setMultiTermXGap(Number((e.target as HTMLInputElement).value)); }}
                />
                <span>{multiTermXGap}x</span>
              </div>
              <span className="pdf-multiterm-hint">
                {matchGroupCount > 0 ? `${matchGroupCount} groups` : 'no matches'}
              </span>
            </div>
          )}
        </div>

        <div className="pdf-toolbar-group">
          <button
            className="pdf-toolbar-btn pdf-bookmark-add"
            onClick={handleAddBookmark}
            title="Bookmark current view"
          >
            <IconBookmarkPlus size={14} />
          </button>
          {bookmarks.map(bm => (
            editingBookmarkId === bm.id ? (
              <input
                key={bm.id}
                className="pdf-bookmark-edit"
                value={editingLabel}
                onChange={e => setEditingLabel(e.target.value)}
                onKeyDown={e => handleLabelEditKeyDown(e, bm.id)}
                onBlur={() => handleLabelEditSubmit(bm.id)}
                autoFocus
              />
            ) : (
              <button
                key={bm.id}
                className={`pdf-toolbar-btn pdf-bookmark-pill${bm.page === currentPage ? ' active' : ''}`}
                onClick={e => { if (!e.altKey) handleBookmarkClick(bm.id); }}
                onDoubleClick={() => handleBookmarkDblClick(bm.id)}
                onContextMenu={e => handleBookmarkRightClick(e, bm.id)}
                onMouseDown={e => handleBookmarkMiddleClick(e, bm.id)}
                title={`Page ${bm.page} @ ${Math.round(bm.zoom * 100)}%\nClick: go | Dbl-click: update | Right-click: delete | Opt/Middle-click: rename`}
              >
                {bm.label}
              </button>
            )
          ))}
        </div>

        <div className="pdf-toolbar-spacer" />

        <div className="pdf-toolbar-group">
          <div className="pdf-corrector-wrapper">
            <button
              className={`pdf-toolbar-btn pdf-corrector-btn${wmFilterActive ? ' has-active' : ''}`}
              onClick={toggleWatermarkFilter}
              title={wmFilterActive ? 'Watermark filter ON — click to disable' : 'Watermark filter OFF — click to enable'}
            >
              <IconWand size={14} />
            </button>
          </div>
          <button
            className={`pdf-toolbar-btn pdf-night-btn${nightMode ? ' active' : ''}`}
            onClick={() => setNightMode(v => {
              const next = !v;
              try { localStorage.setItem(NIGHT_MODE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
              return next;
            })}
            title="Toggle night mode (invert colors)"
          >
            &#x25D0;
          </button>
        </div>
        <div className="pdf-viewport-group">
          <button
            className="pdf-toolbar-btn"
            onClick={invertScrollBindings}
            title={bareAction === 'pan'
              ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
              : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
          >
            {bareAction === 'pan' ? <IconHandMove size={14} /> : <IconZoomIn size={14} />}
          </button>
          <button
            className="pdf-toolbar-btn pdf-zoom-group"
            onClick={handleFitWidth}
            title="Fit to page width (Space)"
          >
            <IconArrowAutofitWidth size={14} />
            <span className="pdf-zoom-info">{Math.round(zoomDisplay * 100)}%</span>
          </button>
        </div>
      </div>

      {textExtracting && (
        <div className="pdf-text-extract-bar" title={`Indexing text: ${Math.round(textExtractProgress * 100)}%`}>
          <div className="pdf-text-extract-fill" style={{ width: `${textExtractProgress * 100}%` }} />
        </div>
      )}

      <div
        className="pdf-canvas-container"
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(e) => { activeTouchesRef.current.delete(e.pointerId); isDraggingRef.current = false; wasDragRef.current = false; }}
        onPointerLeave={(e) => { activeTouchesRef.current.delete(e.pointerId); isDraggingRef.current = false; wasDragRef.current = false; }}
        onDoubleClick={handleTextDblClick}
        onContextMenu={handleContextMenu}
        style={{ cursor: isDraggingRef.current ? 'grabbing' : 'crosshair', filter: nightMode ? 'invert(1)' : undefined }}
      >
        {glyphLoading && <div className="pdf-glyph-loading">Parsing fonts...</div>}
        <div
          ref={wrapperRef}
          className="pdf-page-wrapper"
          style={{ transformOrigin: '0 0', willChange: 'transform' }}
        >
          <canvas ref={canvasRef} style={(tiledMode || (isGlyphComposite && !glyphLoading && !isFiltered)) ? { visibility: 'hidden' } : undefined} />
          <canvas ref={highlightRef} className="pdf-highlight-canvas" />
          <canvas ref={glyphCanvasRef} className="pdf-glyph-overlay-canvas" />
          {clickHighlight && (() => {
            // Wrapper children are sized at committed-zoom CSS pixels; use
            // clickHighlight.zoom (captured at click time, matches committedZoom
            // at that moment) as the multiplier. Auto-dismisses in 4s, so any
            // staleness from later zoom changes is bounded.
            const z = clickHighlight.zoom || 1;
            const pad = 2 / z;
            return (
              <div
                key={clickHighlight.key}
                className="pdf-click-highlight"
                style={{
                  left: (clickHighlight.rect.x - pad) * z,
                  top: (clickHighlight.rect.y - pad) * z,
                  width: (clickHighlight.rect.w + pad * 2) * z,
                  height: (clickHighlight.rect.h + pad * 2) * z,
                  borderWidth: 1.5,
                }}
              >
                <span className="pdf-click-tooltip" style={{ transform: 'translateX(-50%)' }}>
                  {clickHighlight.word || 'Double-click to search'}
                </span>
              </div>
            );
          })()}
        </div>
        {pageCount > 1 && (
          <PageScrubber
            currentPage={currentPage}
            pageCount={pageCount}
            onGoToPage={(n) => { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(n); }}
            scrubberRef={scrubberElRef}
          />
        )}
      </div>
    </div>
  );
}

/** Extract a word from a string at the given character index */
function extractWord(str: string, charIndex: number): string | null {
  const idx = Math.max(0, Math.min(charIndex, str.length - 1));
  const wordChars = /[A-Za-z0-9_]/;
  if (!wordChars.test(str[idx])) return null;

  let start = idx;
  let end = idx;
  while (start > 0 && wordChars.test(str[start - 1])) start--;
  while (end < str.length - 1 && wordChars.test(str[end + 1])) end++;

  const word = str.slice(start, end + 1);
  return word.length > 0 ? word : null;
}
