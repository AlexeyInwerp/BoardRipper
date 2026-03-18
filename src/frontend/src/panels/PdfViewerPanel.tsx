import { useRef, useEffect, useCallback, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { usePdfDoc } from '../hooks/usePdfStore';
import { pdfStore, pdfFontSize } from '../store/pdf-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from '../components/BindLink';
import { boardPanelId, activateLinkedPanel } from '../store/dockview-api';
import { logStore } from '../store/log-store';
import type { GlyphDebugState, PageGlyphData } from '../pdf/glyph-types';
import { DEFAULT_GLYPH_DEBUG_STATE } from '../pdf/glyph-types';
import { extractPageGlyphs, clearFontCache } from '../pdf/glyph-extractor';
import { drawGlyphBoxes, drawGlyphOutlines } from '../pdf/glyph-overlay';
import { drawSimplifiedGlyphs } from '../pdf/glyph-simplifier';
import { drawMonospaceReplacement } from '../pdf/glyph-replacer';

const DRAG_THRESHOLD = 3;
const LINE_HEIGHT_RATIO = 1.2;
const NIGHT_MODE_KEY = 'boardripper-pdf-nightmode';
const CLEAN_FILTER = 'contrast(3)';
const MAX_CANVAS_DIM = 8192;

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

/** Apply CSS transform directly to a DOM element — bypasses React for smooth 60fps pan/zoom */
function applyTransform(el: HTMLElement | null, x: number, y: number, s: number) {
  if (el) el.style.transform = `translate(${x}px,${y}px) scale(${s})`;
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
      logStore.log('log', `[pdf] onDidActiveChange pdf=${pdfFileName} isActive=${e.isActive} storeActive=${boardStore.activeTabId}`);
      if (e.isActive) {
        pdfStore.switchTo(pdfFileName);
        // Activate linked board panel so it follows the PDF tab
        const linkedTab = boardStore.tabs.find(t => t.pdfFileNames.includes(pdfFileName));
        logStore.log('log', `[pdf] linkedTab=${linkedTab?.id ?? 'none'} bindings=${JSON.stringify(boardStore.tabs.map(t => ({ id: t.id, pdfs: t.pdfFileNames })))}`);
        if (linkedTab) {
          const ok = activateLinkedPanel(boardPanelId(linkedTab.id), () => boardStore.switchTab(linkedTab.id));
          logStore.log('log', `[pdf] activateLinkedPanel board-${linkedTab.id} ok=${ok}`);
        }
      }
    });
    return () => disposable.dispose();
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

  const [nightMode, setNightMode] = useState(() => {
    try { return localStorage.getItem(NIGHT_MODE_KEY) === '1'; } catch { return false; }
  });

  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [glyphDebug, setGlyphDebug] = useState<GlyphDebugState>(DEFAULT_GLYPH_DEBUG_STATE);
  const [glyphMenuOpen, setGlyphMenuOpen] = useState(false);
  const [fontDataLoaded, setFontDataLoaded] = useState(false);
  const [glyphLoading, setGlyphLoading] = useState(false);
  const glyphCanvasRef = useRef<HTMLCanvasElement>(null);
  const pageGlyphDataRef = useRef<PageGlyphData | null>(null);
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

  /** Schedule a re-render at exact zoom resolution once zoom settles (debounced 150ms) */
  const scheduleTierRender = useCallback(() => {
    if (tierDebounceRef.current) clearTimeout(tierDebounceRef.current);
    tierDebounceRef.current = setTimeout(() => {
      tierDebounceRef.current = null;
      renderPageRef.current();
    }, 150);
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

  const renderPage = useCallback(async () => {
    if (!isLoaded) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const renderId = ++renderIdRef.current;
    // Render at exact zoom level for pixel-perfect text at any magnification
    const resTier = Math.max(1, zoomRef.current);
    renderTierRef.current = resTier;
    const t0 = performance.now();

    try {
      const page = await pdfStore.getPageFor(pdfFileName, currentPage);
      if (renderIdRef.current !== renderId) return; // superseded
      const tPage = performance.now();

      const container = containerRef.current;
      const canvas = canvasRef.current;
      const highlight = highlightRef.current;
      if (!container || !canvas || !highlight) return;
      const containerWidth = container.clientWidth;
      if (containerWidth === 0) return;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledViewport.width;
      scaleRef.current = baseScale;
      viewportHeightRef.current = unscaledViewport.height;
      viewportTransformRef.current = unscaledViewport.transform;

      // Render at exact zoom resolution, capped to GPU texture limits
      let hiresScale = baseScale * resTier;
      const rawW = unscaledViewport.width * hiresScale;
      const rawH = unscaledViewport.height * hiresScale;
      if (rawW > MAX_CANVAS_DIM || rawH > MAX_CANVAS_DIM) {
        hiresScale *= Math.min(MAX_CANVAS_DIM / rawW, MAX_CANVAS_DIM / rawH);
      }
      const viewport = page.getViewport({ scale: hiresScale });

      const cssW = containerWidth;
      const cssH = unscaledViewport.height * baseScale;

      // Render to offscreen buffer, then blit — prevents blink on resize
      const offscreen = document.createElement('canvas');
      offscreen.width = viewport.width;
      offscreen.height = viewport.height;
      const offCtx = offscreen.getContext('2d')!;

      const task = page.render({ canvas: offscreen, canvasContext: offCtx, viewport, intent: 'print' });
      renderTaskRef.current = { cancel: () => task.cancel() };
      await task.promise;

      if (renderIdRef.current !== renderId) return;
      const tRender = performance.now();

      // Blit to visible canvas
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      const ctx = canvas.getContext('2d')!;
      if (cleanMode) ctx.filter = CLEAN_FILTER;
      ctx.drawImage(offscreen, 0, 0);
      if (cleanMode) ctx.filter = 'none';
      const tCopy = performance.now();

      highlight.width = viewport.width;
      highlight.height = viewport.height;
      highlight.style.width = `${cssW}px`;
      highlight.style.height = `${cssH}px`;

      drawHighlightsRef.current();

      const metrics = {
        file: pdfFileName, page: currentPage, tier: resTier, clean: cleanMode,
        canvasW: viewport.width, canvasH: viewport.height,
        getPageMs: Math.round(tPage - t0),
        renderMs: Math.round(tRender - tPage),
        copyMs: Math.round(tCopy - tRender),
        totalMs: Math.round(tCopy - t0),
      };
      console.log(`[pdf-perf] ${JSON.stringify(metrics)}`);
      window.dispatchEvent(new CustomEvent('pdf-render-perf', { detail: metrics }));
    } catch (err) {
      if (err instanceof Error && err.message?.includes('cancel')) {
        // Cancelled by a newer renderPage call — the newer call handles it
        return;
      }
      console.error('[PdfViewerPanel] renderPage failed:', err);
      setError(String(err));
    }
  }, [pdfFileName, isLoaded, currentPage, cleanMode]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isLoaded) return;
    const highlight = highlightRef.current;
    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getDocMatchesForPage(pdfFileName, pageIndex);
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

      const vpT = viewportTransformRef.current;
      let gx1 = Infinity, gy1 = Infinity, gx2 = -Infinity, gy2 = -Infinity;
      for (const m of groupMatches) {
        const r = textItemRect(m.item.transform, m.item.width, vpT, baseScale);
        const mx0 = r.x;
        const my0 = r.y;
        const mx1 = r.x + r.w;
        const my1 = r.y + r.h;
        if (mx0 < gx1) gx1 = mx0;
        if (my0 < gy1) gy1 = my0;
        if (mx1 > gx2) gx2 = mx1;
        if (my1 > gy2) gy2 = my1;
      }
      const mcx = (gx1 + gx2) / 2;
      const mcy = (gy1 + gy2) / 2;
      const groupW = Math.max(gx2 - gx1, 1);
      const groupH = Math.max(gy2 - gy1, 1);

      const container = containerRef.current;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      // Match should occupy ~20% of viewport, capped at 3× zoom
      const targetFraction = 0.2;
      const zoomByW = (cw * targetFraction) / groupW;
      const zoomByH = (ch * targetFraction) / groupH;
      const newZoom = Math.max(0.5, Math.min(Math.min(zoomByW, zoomByH), 3));

      const newPan = {
        x: cw / 2 - mcx * newZoom,
        y: ch / 2 - mcy * newZoom,
      };

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
          renderPageRef.current();
        }
      } catch (err) {
        console.error('[PdfViewerPanel] reloadWithFontData failed:', err);
      } finally {
        if (!cancelled) setGlyphLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isGlyphActive, fontDataLoaded, isLoaded, pdfFileName]);

  // Extract glyphs and render debug/optimization overlay
  // Skip when cleanMode or nightMode is active — filters would not apply to replacement text
  const isFiltered = cleanMode || nightMode;
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

        // For simplify/replace: blit PDF canvas onto overlay first, then modify
        if (isGlyphComposite) {
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
          drawSimplifiedGlyphs(gCtx, pageData, vpT, renderScale, glyphDebug.simplifyTolerance);
        } else if (glyphDebug.replaceEnabled) {
          drawMonospaceReplacement(gCtx, pageData, vpT, renderScale, glyphDebug.replaceFont);
        }
      } catch (err) {
        console.error('[PdfViewerPanel] glyph overlay failed:', err);
      } finally {
        if (!cancelled) setGlyphLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [isGlyphActive, isGlyphComposite, fontDataLoaded, isLoaded, isFiltered, pdfFileName, currentPage, glyphDebug]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfFileName, isLoaded, syncTransform, scheduleTierRender]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    pdfStore.switchTo(pdfFileName);
    isDraggingRef.current = true;
    wasDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, [pdfFileName]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;

    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    if (!wasDragRef.current) {
      const totalDx = e.clientX - dragStartRef.current.x;
      const totalDy = e.clientY - dragStartRef.current.y;
      if (Math.abs(totalDx) < DRAG_THRESHOLD && Math.abs(totalDy) < DRAG_THRESHOLD) return;
      wasDragRef.current = true;
    }

    panRef.current = { x: panRef.current.x + dx, y: panRef.current.y + dy };
    syncTransform();
  }, [syncTransform]);

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
            }
          }
        }
        return;
      }
    }
  }, [pdfFileName, isLoaded, currentPage]);

  const handleTextClickRef = useRef(handleTextClick);
  handleTextClickRef.current = handleTextClick;

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDrag = wasDragRef.current;
    isDraggingRef.current = false;
    wasDragRef.current = false;

    if (!wasDrag && e.button === 0) {
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

        <div className="pdf-glyph-debug-wrapper">
          <button
            className={`pdf-glyph-debug-btn${isGlyphActive ? ' active' : ''}`}
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
            </div>
          )}
        </div>

        <div className="pdf-toolbar-spacer" />
        <button
          className={`pdf-toolbar-btn${cleanMode ? ' active' : ''}`}
          onClick={() => pdfStore.toggleClean(pdfFileName, !cleanMode)}
          title="Strip watermark images from PDF (removes tiled overlays)"
        >
          Clean
        </button>
        <button
          className={`pdf-toolbar-btn${nightMode ? ' active' : ''}`}
          onClick={() => setNightMode(v => {
            const next = !v;
            try { localStorage.setItem(NIGHT_MODE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
            return next;
          })}
          title="Toggle night mode (invert colors)"
        >
          Night
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
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { isDraggingRef.current = false; wasDragRef.current = false; }}
        onContextMenu={handleContextMenu}
        style={{ cursor: isDraggingRef.current ? 'grabbing' : 'crosshair', filter: nightMode ? 'invert(1)' : undefined }}
      >
        {glyphLoading && <div className="pdf-glyph-loading">Parsing fonts...</div>}
        <div
          ref={wrapperRef}
          className="pdf-page-wrapper"
          style={{ transformOrigin: '0 0', willChange: 'transform' }}
        >
          <canvas ref={canvasRef} style={isGlyphComposite && !glyphLoading ? { visibility: 'hidden' } : undefined} />
          <canvas ref={highlightRef} className="pdf-highlight-canvas" />
          <canvas ref={glyphCanvasRef} className="pdf-glyph-overlay-canvas" />
        </div>
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
