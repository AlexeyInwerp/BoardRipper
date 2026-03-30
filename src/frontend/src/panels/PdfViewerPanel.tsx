import { useRef, useEffect, useCallback, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { usePdfDoc } from '../hooks/usePdfStore';
import { pdfStore, pdfFontSize } from '../store/pdf-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from '../components/BindLink';
import { boardPanelId, activateLinkedPanel } from '../store/dockview-api';
import { fileInputRefs } from '../store/file-inputs';
import { log } from '../store/log-store';
import type { GlyphDebugState, PageGlyphData } from '../pdf/glyph-types';
import { DEFAULT_GLYPH_DEBUG_STATE } from '../pdf/glyph-types';
import { extractPageGlyphs, clearFontCache } from '../pdf/glyph-extractor';
import { drawGlyphBoxes, drawGlyphOutlines } from '../pdf/glyph-overlay';
import { drawSimplifiedGlyphs } from '../pdf/glyph-simplifier';
import type { SimplifyStats } from '../pdf/glyph-simplifier';
import { drawMonospaceReplacement } from '../pdf/glyph-replacer';

const DRAG_THRESHOLD = 3;
const LINE_HEIGHT_RATIO = 1.2;
const NIGHT_MODE_KEY = 'boardripper-pdf-nightmode';
const CLEAN_CONTRAST_KEY = 'boardripper-pdf-clean-contrast';
const DEFAULT_CLEAN_CONTRAST = 3;
const MAX_CANVAS_DIM = 4096;
const MAX_CANVAS_AREA = 4096 * 4096; // ~16M pixels — safe for mobile/tablet GPUs
const TIER_DEBOUNCE_MS = 60; // trailing debounce — guarantees final crisp frame after zoom

// --- Offscreen canvas pool (avoids GC churn during fast zoom/page navigation) ---
const _canvasPool: HTMLCanvasElement[] = [];
function acquireCanvas(w: number, h: number): HTMLCanvasElement {
  const c = _canvasPool.pop() ?? document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}
function releaseCanvas(c: HTMLCanvasElement): void {
  // Shrink canvas before pooling to release its backing store memory
  c.width = 1;
  c.height = 1;
  // Cap pool size to avoid hoarding memory
  if (_canvasPool.length < 4) _canvasPool.push(c);
}

/** Clamp a pdf.js render scale so the resulting canvas stays within GPU limits. */
function clampCanvasScale(pageW: number, pageH: number, scale: number): number {
  let w = pageW * scale;
  let h = pageH * scale;
  // Clamp individual dimensions
  if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
    scale *= Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h);
    w = pageW * scale;
    h = pageH * scale;
  }
  // Clamp total pixel area
  if (w * h > MAX_CANVAS_AREA) {
    scale *= Math.sqrt(MAX_CANVAS_AREA / (w * h));
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
  vpHeight: number;
  vpTransform: number[];
}
const PAGE_CACHE_MAX = 10;
const PAGE_CACHE_MAX_PIXELS = 80_000_000; // ~80M total pixels across all cached bitmaps
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
    (_pageCache.size >= PAGE_CACHE_MAX || _pageCacheTotalPixels + entryPixels > PAGE_CACHE_MAX_PIXELS)
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

/** Invalidate all cache entries for a given file (e.g. on clean mode toggle) */
export function invalidatePageCache(file?: string): void {
  if (!file) {
    for (const e of _pageCache.values()) e.bitmap.close();
    _pageCache.clear();
    _pageCacheTotalPixels = 0;
    return;
  }
  for (const [k, v] of _pageCache) {
    if (k.startsWith(file + ':')) {
      _pageCacheTotalPixels -= v.width * v.height;
      v.bitmap.close();
      _pageCache.delete(k);
    }
  }
}

/** Compute a text item's bounding rect in canvas-space */
function textItemRect(
  transform: number[], width: number, vpT: number[], scale: number,
): { x: number; y: number; w: number; h: number } {
  const fontSize = pdfFontSize(transform);
  const vx = vpT[0] * transform[4] + vpT[2] * transform[5] + vpT[4];
  const vy = vpT[1] * transform[4] + vpT[3] * transform[5] + vpT[5];
  return {
    x: vx * scale,
    y: vy * scale - fontSize * scale,
    w: width * scale,
    h: fontSize * scale * LINE_HEIGHT_RATIO,
  };
}

/** Compute zoom & pan to center a group of text items in the viewport */
function zoomToItemGroup(
  items: { transform: number[]; width: number }[],
  vpT: number[], baseScale: number,
  cw: number, ch: number,
  targetFraction: number,
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
  const zoom = Math.max(0.5, Math.min(Math.min(zoomByW, zoomByH), 3));
  return { zoom, pan: { x: cw / 2 - mcx * zoom, y: ch / 2 - mcy * zoom } };
}

/** Apply CSS transform directly to a DOM element — bypasses React for smooth 60fps pan/zoom */
function applyTransform(el: HTMLElement | null, x: number, y: number, s: number) {
  if (el) el.style.transform = `translate(${x}px,${y}px) scale(${s})`;
}

// --- Page Scrubber Rail ---
function PageScrubber({ currentPage, pageCount, onGoToPage }: {
  currentPage: number;
  pageCount: number;
  onGoToPage: (page: number) => void;
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
      ref={railRef}
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
  const { isLoaded, textExtracting, textExtractProgress, pageCount, currentPage, searchQuery, matches, activeMatchIndex, matchGroupCount, activeGroupIndex, isMultiTerm, isAtSyntax, multiTermYGap, multiTermXGap, bookmarks, cleanMode } = usePdfDoc(pdfFileName);
  const { tabs } = useBoardStore();

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
        const linkedTab = boardStore.tabs.find(t => t.pdfFileNames.includes(pdfFileName));
        log.pdf.log(`linkedTab=${linkedTab?.id ?? 'none'} bindings=${JSON.stringify(boardStore.tabs.map(t => ({ id: t.id, pdfs: t.pdfFileNames })))}`);
        if (linkedTab) {
          const ok = activateLinkedPanel(boardPanelId(linkedTab.id), () => boardStore.switchTab(linkedTab.id));
          log.pdf.log(`activateLinkedPanel board-${linkedTab.id} ok=${ok}`);
        }
      } else {
        // Clear PDF search ref when this panel deactivates (only if it's ours)
        if (fileInputRefs.pdfSearch === searchInputRef.current) {
          fileInputRefs.pdfSearch = null;
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
  const viewportHeightRef = useRef(0);
  const renderTierRef = useRef(1);
  const viewportTransformRef = useRef<number[]>([1, 0, 0, -1, 0, 0]);
  const [clickedText, setClickedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkPhaseRef = useRef(0);

  // Pan/zoom live in refs for 60fps DOM updates; React state only for toolbar display
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoomDisplay, setZoomDisplay] = useState(1);
  const zoomDisplayRafRef = useRef(0);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);
  const tierDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Last zoom level at which highlights were drawn — skip redraw on pan-only changes */
  const lastHighlightZoomRef = useRef(0);
  /** Adaptive zoom: exponential moving average of pdf.js render time (ms) */
  const renderTimeEmaRef = useRef(0);
  /** Adaptive zoom: timestamp of last throttled render start */
  const lastThrottleRenderRef = useRef(0);

  const [nightMode, setNightMode] = useState(() => {
    try { return localStorage.getItem(NIGHT_MODE_KEY) === '1'; } catch { return false; }
  });
  const [cleanContrast, setCleanContrast] = useState(() => {
    try { const v = localStorage.getItem(CLEAN_CONTRAST_KEY); return v ? Number(v) : DEFAULT_CLEAN_CONTRAST; } catch { return DEFAULT_CLEAN_CONTRAST; }
  });
  const cleanContrastRef = useRef(cleanContrast);
  cleanContrastRef.current = cleanContrast;

  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [glyphDebug, setGlyphDebug] = useState<GlyphDebugState>(DEFAULT_GLYPH_DEBUG_STATE);
  const [correctorOpen, setCorrectorOpen] = useState(false);
  const [glyphMenuOpen, setGlyphMenuOpen] = useState(false);
  const [fontDataLoaded, setFontDataLoaded] = useState(false);
  const [glyphLoading, setGlyphLoading] = useState(false);
  const glyphCanvasRef = useRef<HTMLCanvasElement>(null);
  const pageGlyphDataRef = useRef<PageGlyphData | null>(null);
  const simplifyStatsRef = useRef<SimplifyStats | null>(null);
  const glyphMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isGlyphActive = glyphDebug.overlayMode !== 'off' || glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;
  const isGlyphComposite = glyphDebug.simplifyEnabled || glyphDebug.replaceEnabled;

  const bookmarkClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const skipResetRef = useRef(false);

  /** Push zoom/pan refs to DOM + throttled React state for toolbar */
  const syncTransform = useCallback(() => {
    applyTransform(wrapperRef.current, panRef.current.x, panRef.current.y, zoomRef.current);
    if (!zoomDisplayRafRef.current) {
      zoomDisplayRafRef.current = requestAnimationFrame(() => {
        zoomDisplayRafRef.current = 0;
        setZoomDisplay(zoomRef.current);
      });
    }
  }, []);

  /** Schedule a re-render at exact zoom resolution.
   *  Adaptive throttle: renders at a rate the system can sustain (based on EMA of
   *  recent render times). Fast pages get near-instant crisp zoom; slow pages get
   *  CSS-only zoom with a trailing debounce for the final crisp frame. */
  const scheduleTierRender = useCallback(() => {
    // Trailing debounce: always fires after zoom settles — guarantees final crisp frame
    if (tierDebounceRef.current) clearTimeout(tierDebounceRef.current);
    tierDebounceRef.current = setTimeout(() => {
      tierDebounceRef.current = null;
      renderPageRef.current();
    }, TIER_DEBOUNCE_MS);

    // Adaptive throttle: if enough time has passed since the last render, fire now.
    // Throttle interval = max(EMA × 1.5, 16ms) — gives the GPU breathing room
    // while keeping up with fast pages. First render (EMA=0) always fires immediately.
    const ema = renderTimeEmaRef.current;
    const throttleMs = ema > 0 ? Math.max(ema * 1.5, 16) : 0;
    const now = performance.now();
    if (now - lastThrottleRenderRef.current >= throttleMs) {
      lastThrottleRenderRef.current = now;
      renderPageRef.current();
    }
  }, []);

  // Reset scale refs when document is unloaded so framing re-runs on next load
  useEffect(() => {
    if (!isLoaded) { scaleRef.current = 0; viewportHeightRef.current = 0; }
  }, [isLoaded]);

  useEffect(() => {
    if (skipResetRef.current) {
      skipResetRef.current = false;
      return;
    }
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    renderTierRef.current = 1;
    syncTransform();
  }, [currentPage, syncTransform]);

  const renderIdRef = useRef(0);
  const prefetchIdRef = useRef(0);

  /** Render a single page to an ImageBitmap (shared by main render + prefetch) */
  const renderPageToBitmap = useCallback(async (
    pageNum: number, containerWidth: number, tier: number, clean: boolean,
  ): Promise<{ bitmap: ImageBitmap; width: number; height: number; cssW: number; cssH: number; baseScale: number; vpHeight: number; vpTransform: number[] }> => {
    const page = await pdfStore.getPageFor(pdfFileName, pageNum);
    const unscaledViewport = page.getViewport({ scale: 1 });
    const baseScale = containerWidth / unscaledViewport.width;

    let hiresScale = baseScale * tier;
    // Clamp to safe canvas dimensions and total pixel area
    hiresScale = clampCanvasScale(unscaledViewport.width, unscaledViewport.height, hiresScale);
    const viewport = page.getViewport({ scale: hiresScale });
    const cssW = containerWidth;
    const cssH = unscaledViewport.height * baseScale;

    const offscreen = acquireCanvas(viewport.width, viewport.height);
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) { releaseCanvas(offscreen); throw new Error(`Canvas too large: ${viewport.width}x${viewport.height}`); }

    // 'display' intent is significantly faster than 'print' for complex schematics
    await page.render({ canvas: offscreen, canvasContext: offCtx, viewport, intent: 'display' }).promise;

    // Apply contrast filter for clean mode before creating bitmap
    if (clean) {
      const tmpCanvas = acquireCanvas(offscreen.width, offscreen.height);
      const tmpCtx = tmpCanvas.getContext('2d');
      if (!tmpCtx) { releaseCanvas(offscreen); releaseCanvas(tmpCanvas); throw new Error('Canvas context failed for clean mode'); }
      tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
      tmpCtx.drawImage(offscreen, 0, 0);
      const bitmap = await createImageBitmap(tmpCanvas);
      releaseCanvas(offscreen);
      releaseCanvas(tmpCanvas);
      return { bitmap, width: viewport.width, height: viewport.height, cssW, cssH, baseScale, vpHeight: unscaledViewport.height, vpTransform: unscaledViewport.transform };
    }

    const bitmap = await createImageBitmap(offscreen);
    releaseCanvas(offscreen);
    return { bitmap, width: viewport.width, height: viewport.height, cssW, cssH, baseScale, vpHeight: unscaledViewport.height, vpTransform: unscaledViewport.transform };
  }, [pdfFileName]);

  /** Blit a cached or freshly rendered bitmap to the visible canvas */
  const blitToCanvas = useCallback((entry: CachedRender) => {
    const canvas = canvasRef.current;
    const highlight = highlightRef.current;
    if (!canvas || !highlight) return;

    // Only resize if dimensions changed — avoids clearing existing content
    if (canvas.width !== entry.width || canvas.height !== entry.height) {
      canvas.width = entry.width;
      canvas.height = entry.height;
    }
    canvas.style.width = `${entry.cssW}px`;
    canvas.style.height = `${entry.cssH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(entry.bitmap, 0, 0);

    if (highlight.width !== entry.width || highlight.height !== entry.height) {
      highlight.width = entry.width;
      highlight.height = entry.height;
    }
    highlight.style.width = `${entry.cssW}px`;
    highlight.style.height = `${entry.cssH}px`;

    scaleRef.current = entry.baseScale;
    viewportHeightRef.current = entry.vpHeight;
    viewportTransformRef.current = entry.vpTransform;

    drawHighlightsRef.current();
  }, []);

  const renderPage = useCallback(async () => {
    if (!isLoaded) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const renderId = ++renderIdRef.current;
    const resTier = Math.max(1, zoomRef.current);
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

      // Don't blit a low-res preview — it downgrades the current canvas content and
      // causes a visible blur flash. The existing canvas (at whatever tier was last
      // rendered) stays visible via CSS transform until the new tier is ready.

      const page = await pdfStore.getPageFor(pdfFileName, currentPage);
      if (renderIdRef.current !== renderId) return;
      const tPage = performance.now();

      const unscaledViewport = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledViewport.width;

      let hiresScale = baseScale * resTier;
      hiresScale = clampCanvasScale(unscaledViewport.width, unscaledViewport.height, hiresScale);
      const viewport = page.getViewport({ scale: hiresScale });
      const cssW = containerWidth;
      const cssH = unscaledViewport.height * baseScale;

      // Render to pooled offscreen buffer
      const offscreen = acquireCanvas(viewport.width, viewport.height);
      const offCtx = offscreen.getContext('2d');
      if (!offCtx) { releaseCanvas(offscreen); throw new Error(`Canvas too large: ${viewport.width}x${viewport.height}`); }

      // 'display' intent is significantly faster than 'print' for complex schematics
      const task = page.render({ canvas: offscreen, canvasContext: offCtx, viewport, intent: 'display' });
      renderTaskRef.current = { cancel: () => task.cancel() };
      await task.promise;

      if (renderIdRef.current !== renderId) { releaseCanvas(offscreen); return; }
      const tRender = performance.now();

      // Apply contrast to offscreen buffer before creating bitmap (avoids double-blit)
      let sourceCanvas = offscreen;
      if (cleanMode) {
        const tmpCanvas = acquireCanvas(offscreen.width, offscreen.height);
        const tmpCtx = tmpCanvas.getContext('2d');
        if (tmpCtx) {
          tmpCtx.filter = `contrast(${cleanContrastRef.current})`;
          tmpCtx.drawImage(offscreen, 0, 0);
          releaseCanvas(offscreen);
          sourceCanvas = tmpCanvas;
        }
      }

      // Create bitmap from offscreen BEFORE touching the visible canvas —
      // this avoids the blank frame caused by canvas.width= clearing content.
      let bitmap: ImageBitmap | null = null;
      try { bitmap = await createImageBitmap(sourceCanvas); } catch { /* skip */ }
      if (renderIdRef.current !== renderId) { releaseCanvas(sourceCanvas); bitmap?.close(); return; }

      // Atomic blit: resize + draw in one go, minimising the cleared-canvas window
      const canvas = canvasRef.current;
      const highlight = highlightRef.current;
      if (!canvas || !highlight) { releaseCanvas(sourceCanvas); bitmap?.close(); return; }

      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.drawImage(sourceCanvas, 0, 0);
      releaseCanvas(sourceCanvas);
      const tCopy = performance.now();

      scaleRef.current = baseScale;
      viewportHeightRef.current = unscaledViewport.height;
      viewportTransformRef.current = unscaledViewport.transform;

      highlight.width = viewport.width;
      highlight.height = viewport.height;
      highlight.style.width = `${cssW}px`;
      highlight.style.height = `${cssH}px`;

      drawHighlightsRef.current();

      // Cache the pre-created bitmap for instant reuse
      if (bitmap) {
        putPageCache(cacheKey, {
          bitmap, width: viewport.width, height: viewport.height,
          cssW, cssH, baseScale, vpHeight: unscaledViewport.height,
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

      // Prefetch adjacent pages at base resolution (fire-and-forget)
      const pfId = ++prefetchIdRef.current;
      const pagesToPrefetch = [currentPage + 1, currentPage - 1].filter(p => p >= 1 && p <= pageCount);
      for (const pNum of pagesToPrefetch) {
        const pfKey = pageCacheKey(pdfFileName, pNum, 1, cleanMode);
        if (getPageCache(pfKey)) continue;
        renderPageToBitmap(pNum, containerWidth, 1, cleanMode)
          .then(result => {
            if (prefetchIdRef.current !== pfId) { result.bitmap.close(); return; }
            putPageCache(pfKey, result);
            log.perf.log(`prefetched page ${pNum}`);
          })
          .catch(() => {});
      }
    } catch (err) {
      if (err instanceof Error && err.message?.includes('cancel')) {
        return;
      }
      log.pdf.error('renderPage failed:', err);
      setError(String(err));
    }
  }, [pdfFileName, isLoaded, currentPage, cleanMode, pageCount, renderPageToBitmap, blitToCanvas]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isLoaded) return;
    const highlight = highlightRef.current;

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getDocMatchesForPage(pdfFileName, pageIndex);

    // Hide highlight canvas entirely when no matches — avoids compositing an empty layer
    if (pageMatches.length === 0 && matches.length === 0) {
      highlight.style.display = 'none';
      lastHighlightZoomRef.current = 0;
      return;
    }
    if (highlight.style.display === 'none') highlight.style.display = '';

    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);
    const scale = scaleRef.current * renderTierRef.current ;
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

  const renderPageRef = useRef(renderPage);
  renderPageRef.current = renderPage;
  const drawHighlightsRef = useRef(drawHighlights);
  drawHighlightsRef.current = drawHighlights;

  useEffect(() => { renderPage(); }, [renderPage]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  // Sync search input when searchQuery changes externally (e.g. pre-populated from library)
  useEffect(() => {
    if (searchInputRef.current && searchQuery !== searchInputRef.current.value) {
      searchInputRef.current.value = searchQuery;
    }
  }, [searchQuery]);

  const pendingMatchRef = useRef<{ index: number; id: number }>({ index: -1, id: 0 });

  useEffect(() => {
    if (!isLoaded || activeMatchIndex < 0 || !matches[activeMatchIndex]) return;

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
      const { zoom: newZoom, pan: newPan } = zoomToItemGroup(
        items, viewportTransformRef.current, baseScale,
        container.clientWidth, container.clientHeight, 0.2,
      );

      zoomRef.current = newZoom;
      panRef.current = newPan;
      syncTransform();

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

  // Follow target: zoom to a location without highlighting (triggered by board follow mode)
  useEffect(() => {
    const target = pdfStore.consumeFollowTarget();
    if (!target || !isLoaded) return;

    const targetPage = target.pageIndex + 1;
    if (targetPage !== currentPage) {
      skipResetRef.current = true;
    }

    const applyFollowZoom = () => {
      const baseScale = scaleRef.current;
      if (baseScale === 0 || !containerRef.current) return;

      const { zoom, pan } = zoomToItemGroup(
        target.items, viewportTransformRef.current, baseScale,
        containerRef.current.clientWidth, containerRef.current.clientHeight, 0.25,
      );
      zoomRef.current = zoom;
      panRef.current = pan;
      syncTransform();
      renderPageRef.current();
    };

    // Defer to ensure the page has rendered first
    const raf = requestAnimationFrame(applyFollowZoom);
    return () => cancelAnimationFrame(raf);
  }, [isLoaded, currentPage]);

  // Apply initial transform + re-sync after page change
  useEffect(() => { syncTransform(); }, [syncTransform, currentPage]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => renderPageRef.current());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

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
    if (!isGlyphActive || !fontDataLoaded || !isLoaded || isFiltered) {
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
   
  }, [isGlyphActive, isGlyphComposite, fontDataLoaded, isLoaded, isFiltered, pdfFileName, currentPage,
      glyphDebug.overlayMode, glyphDebug.simplifyEnabled, glyphDebug.simplifyTolerance,
      glyphDebug.replaceEnabled, glyphDebug.replaceFont]);

  // Clean up font cache on unmount
  useEffect(() => {
    return () => {
      const doc = pdfStore.getDocProxy(pdfFileName);
      clearFontCache(doc?.fingerprints[0] ?? undefined);
      pageGlyphDataRef.current = null;
    };
  }, [pdfFileName]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Ensure this panel's document is active before interacting
      pdfStore.switchTo(pdfFileName);

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const zoomFactor = Math.exp(-e.deltaY * 0.001);
      const oldZoom = zoomRef.current;
      const newZoom = Math.max(0.1, Math.min(oldZoom * zoomFactor, 20));
      const ratio = newZoom / oldZoom;
      const oldPan = panRef.current;
      const newPan = {
        x: mouseX - ratio * (mouseX - oldPan.x),
        y: mouseY - ratio * (mouseY - oldPan.y),
      };

      zoomRef.current = newZoom;
      panRef.current = newPan;
      syncTransform();
      scheduleTierRender();
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
   
  }, [pdfFileName, isLoaded, syncTransform, scheduleTierRender]);

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
        const scale = dist / pinchStartDistRef.current;
        const oldZoom = zoomRef.current;
        const newZoom = Math.max(0.1, Math.min(pinchStartZoomRef.current * scale, 20));
        const ratio = newZoom / oldZoom;
        const mid = pinchMidRef.current;
        panRef.current = {
          x: mid.x - ratio * (mid.x - panRef.current.x),
          y: mid.y - ratio * (mid.y - panRef.current.y),
        };
        zoomRef.current = newZoom;
        syncTransform();
        scheduleTierRender();
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

    panRef.current = { x: panRef.current.x + dxm, y: panRef.current.y + dym };
    syncTransform();
  }, [syncTransform, scheduleTierRender]);

  const handleTextClick = useCallback((e: React.MouseEvent) => {
    if (!isLoaded) return;

    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const containerRect = container.getBoundingClientRect();
    const screenX = e.clientX - containerRect.left;
    const screenY = e.clientY - containerRect.top;
    const clickX = (screenX - panRef.current.x) / zoomRef.current;
    const clickY = (screenY - panRef.current.y) / zoomRef.current;

    const scale = scaleRef.current;
    const vpT = viewportTransformRef.current;
    const pageIndex = currentPage - 1;
    const items = pdfStore.getDocTextItemsForPage(pdfFileName, pageIndex);

    for (const item of items) {
      const { x, y, w, h } = textItemRect(item.transform, item.width, vpT, scale);

      if (clickX >= x && clickX <= x + w && clickY >= y && clickY <= y + h) {
        const charWidth = w / item.str.length;
        const charIndex = Math.floor((clickX - x) / charWidth);
        const word = extractWord(item.str, charIndex);

        if (word) {
          setClickedText(word);

          const board = boardStore.board;
          if (board) {
            const upper = word.toUpperCase();
            if (board.parts.some(p => p.name.toUpperCase() === upper)) {
              boardStore.focusPart(word);
            } else {
              boardStore.focusNet(word);
            }
          }
        }
        return;
      }
    }
  }, [pdfFileName, isLoaded, currentPage]);

  const handleTextClickRef = useRef(handleTextClick);
  handleTextClickRef.current = handleTextClick;

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    activeTouchesRef.current.delete(e.pointerId);
    if (activeTouchesRef.current.size < 2) {
      pinchStartDistRef.current = 0;
    }

    const wasDrag = wasDragRef.current;
    isDraggingRef.current = false;
    wasDragRef.current = false;

    if (!wasDrag && e.button === 0 && e.pointerType !== 'touch') {
      handleTextClickRef.current(e);
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    pdfStore.switchTo(pdfFileName);
    pdfStore.searchText(searchInputRef.current?.value ?? '');
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

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
      const bm = pdfStore.bookmarks.find(b => b.id === id);
      if (!bm) return;
      skipResetRef.current = true;
      pdfStore.goToPage(bm.page);
      zoomRef.current = bm.zoom;
      panRef.current = { x: bm.panX, y: bm.panY };
      syncTransform();
      renderPageRef.current();
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
            singleSelect
          />
        )}
        <span className="pdf-filename" title={boundBoardTabs.length > 0 ? boundBoardTabs.map(t => t.fileName).join(', ') : 'No board linked'}>
          {boundBoardTabs.length > 0 ? boundBoardTabs.map(t => t.fileName).join(', ') : 'no link'}
        </span>
        <div className="pdf-toolbar-separator" />

        <button
          className="pdf-toolbar-btn"
          onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(currentPage - 1); }}
          disabled={currentPage <= 1}
        >
          &lt;
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
          &gt;
        </button>

        <div className="pdf-toolbar-separator" />

        <div className="pdf-search-wrapper">
          <form className="pdf-search-form" onSubmit={handleSearch}>
            <input
              ref={searchInputRef}
              type="text"
              className="pdf-search-input"
              placeholder="Search (multi-term: 10UF 25V 0603)"
              defaultValue={searchQuery}
              onKeyDown={(e) => {
                if (matches.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                  e.preventDefault();
                  pdfStore.switchTo(pdfFileName);
                  if (e.key === 'ArrowDown') pdfStore.nextMatch();
                  else pdfStore.prevMatch();
                }
              }}
            />
          </form>
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
        {matches.length > 0 && (
          <>
            <span className="pdf-match-info">
              {matchGroupCount > 0
                ? `${activeGroupIndex + 1}/${matchGroupCount}`
                : `${activeMatchIndex + 1}/${matches.length}`}
            </span>
            <button className="pdf-toolbar-btn" onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.prevMatch(); }}>&#9650;</button>
            <button className="pdf-toolbar-btn" onClick={() => { pdfStore.switchTo(pdfFileName); pdfStore.nextMatch(); }}>&#9660;</button>
          </>
        )}

        {clickedText && (
          <>
            <div className="pdf-toolbar-separator" />
            <span className="pdf-clicked-text" title="Clicked text">
              {clickedText}
            </span>
          </>
        )}

        <div className="pdf-toolbar-separator" />
        <button
          className="pdf-toolbar-btn pdf-bookmark-add"
          onClick={handleAddBookmark}
          title="Bookmark current view"
        >
          +
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
              className={`pdf-bookmark-pill${bm.page === currentPage ? ' active' : ''}`}
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

        <div className="pdf-toolbar-spacer" />

        <div className="pdf-corrector-wrapper">
          <button
            className={`pdf-toolbar-btn pdf-corrector-btn${correctorOpen ? ' active' : ''}${(cleanMode || isGlyphActive) ? ' has-active' : ''}`}
            onClick={() => setCorrectorOpen(v => !v)}
            title="PDF corrector tools"
          >
            &#x229E;
          </button>
          {correctorOpen && (
            <div className="pdf-corrector-strip">
              <button
                className={`pdf-toolbar-btn${cleanMode ? ' active' : ''}`}
                onClick={() => pdfStore.toggleClean(pdfFileName, !cleanMode)}
                title="Strip watermark images"
              >
                Clean
              </button>
              {cleanMode && (
                <input
                  className="pdf-clean-slider"
                  type="range"
                  min={1}
                  max={10}
                  step={0.1}
                  value={cleanContrast}
                  onChange={e => setCleanContrast(Number(e.target.value))}
                  onPointerUp={e => {
                    const v = Number((e.target as HTMLInputElement).value);
                    cleanContrastRef.current = v;
                    try { localStorage.setItem(CLEAN_CONTRAST_KEY, String(v)); } catch { /* ignore */ }
                    invalidatePageCache(pdfFileName);
                    renderPageRef.current();
                  }}
                  title={`Contrast: ${cleanContrast}`}
                />
              )}

              <div className="pdf-glyph-debug-wrapper">
                <button
                  className={`pdf-toolbar-btn${isGlyphActive ? ' active' : ''}`}
                  onClick={() => setGlyphMenuOpen(v => !v)}
                  title="Glyph debug & optimization"
                >
                  Glyphs
                </button>
                {glyphMenuOpen && (
                  <div
                    className="pdf-glyph-debug-menu"
                    onMouseEnter={() => { if (glyphMenuTimerRef.current) { clearTimeout(glyphMenuTimerRef.current); glyphMenuTimerRef.current = null; } }}
                    onMouseLeave={() => { glyphMenuTimerRef.current = setTimeout(() => setGlyphMenuOpen(false), 300); }}
                  >
                    {(['off', 'boxes', 'outlines'] as const).map(mode => (
                      <label key={mode}>
                        <input
                          type="radio"
                          name="glyphOverlay"
                          checked={glyphDebug.overlayMode === mode}
                          onChange={() => setGlyphDebug(s => ({ ...s, overlayMode: mode }))}
                        />
                        {mode === 'off' ? 'Off' : mode === 'boxes' ? 'Show Boxes' : 'Show Outlines'}
                      </label>
                    ))}
                    <hr />
                    <label>
                      <input
                        type="checkbox"
                        checked={glyphDebug.simplifyEnabled}
                        onChange={() => setGlyphDebug(s => ({
                          ...s,
                          simplifyEnabled: !s.simplifyEnabled,
                          replaceEnabled: !s.simplifyEnabled ? false : s.replaceEnabled,
                        }))}
                      />
                      Simplify Glyphs
                    </label>
                    {glyphDebug.simplifyEnabled && (
                      <div className="pdf-glyph-slider-row">
                        <span>Tol</span>
                        <input
                          type="range"
                          min={0.1}
                          max={5}
                          step={0.1}
                          value={glyphDebug.simplifyTolerance}
                          onChange={e => setGlyphDebug(s => ({ ...s, simplifyTolerance: Number(e.target.value) }))}
                        />
                        <span>{glyphDebug.simplifyTolerance.toFixed(1)}</span>
                      </div>
                    )}
                    <label>
                      <input
                        type="checkbox"
                        checked={glyphDebug.replaceEnabled}
                        onChange={() => setGlyphDebug(s => ({
                          ...s,
                          replaceEnabled: !s.replaceEnabled,
                          simplifyEnabled: !s.replaceEnabled ? false : s.simplifyEnabled,
                        }))}
                      />
                      Monospace Replace
                    </label>
                    {glyphDebug.replaceEnabled && (
                      <div className="pdf-glyph-slider-row">
                        <span>Font</span>
                        <select
                          value={glyphDebug.replaceFont}
                          onChange={e => setGlyphDebug(s => ({ ...s, replaceFont: e.target.value }))}
                        >
                          <option value="Courier New">Courier New</option>
                          <option value="Courier">Courier</option>
                          <option value="monospace">monospace</option>
                        </select>
                      </div>
                    )}
                    {(() => {
                      const pd = pageGlyphDataRef.current;
                      if (!pd || pd.items.length === 0) return null;
                      let totalGlyphs = 0, totalVerts = 0, type3Count = 0;
                      for (const item of pd.items) {
                        if (item.isType3) { type3Count++; continue; }
                        if (!item.glyphs) continue;
                        for (const g of item.glyphs) {
                          totalGlyphs++;
                          totalVerts += g.vertexCount;
                        }
                      }
                      const avgVerts = totalGlyphs > 0 ? (totalVerts / totalGlyphs).toFixed(1) : '0';
                      const ss = simplifyStatsRef.current;
                      const reduction = ss && ss.totalBefore > 0 ? Math.round((1 - ss.totalAfter / ss.totalBefore) * 100) : 0;
                      return (
                        <>
                          <hr />
                          <div className="pdf-glyph-summary">
                            <div>{pd.fontNames.length} font{pd.fontNames.length !== 1 ? 's' : ''} · {pd.items.length} items · {totalGlyphs} glyphs</div>
                            <div>avg {avgVerts} verts/glyph · {totalVerts} total</div>
                            {ss && <div>{ss.totalBefore} → {ss.totalAfter} verts ({reduction}% reduced)</div>}
                            {type3Count > 0 && <div>{type3Count} Type3 (skipped)</div>}
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              <button
                className="pdf-toolbar-btn"
                onClick={() => pdfStore.dumpTextToNewTab(pdfFileName)}
                title="Dump extracted text to new tab (debug)"
              >
                Dump Text
              </button>
            </div>
          )}
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
        <span className="pdf-zoom-info">{Math.round(zoomDisplay * 100)}%</span>
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
        onContextMenu={handleContextMenu}
        style={{ cursor: isDraggingRef.current ? 'grabbing' : 'crosshair', filter: nightMode ? 'invert(1)' : undefined }}
      >
        {glyphLoading && <div className="pdf-glyph-loading">Parsing fonts...</div>}
        <div
          ref={wrapperRef}
          className="pdf-page-wrapper"
          style={{ transformOrigin: '0 0', willChange: 'transform' }}
        >
          <canvas ref={canvasRef} style={isGlyphComposite && !glyphLoading && !isFiltered ? { visibility: 'hidden' } : undefined} />
          <canvas ref={highlightRef} className="pdf-highlight-canvas" />
          <canvas ref={glyphCanvasRef} className="pdf-glyph-overlay-canvas" />
        </div>
        {pageCount > 1 && (
          <PageScrubber
            currentPage={currentPage}
            pageCount={pageCount}
            onGoToPage={(n) => { pdfStore.switchTo(pdfFileName); pdfStore.goToPage(n); }}
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
