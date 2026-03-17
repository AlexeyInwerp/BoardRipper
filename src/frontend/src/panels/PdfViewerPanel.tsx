import { useRef, useEffect, useCallback, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { usePdfStore } from '../hooks/usePdfStore';
import { pdfStore, pdfFontSize } from '../store/pdf-store';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from '../components/BindLink';
import { boardPanelId, activateLinkedPanel } from '../store/dockview-api';
import { logStore } from '../store/log-store';

const DRAG_THRESHOLD = 3;
const LINE_HEIGHT_RATIO = 1.2;
const NIGHT_MODE_KEY = 'boardviewer-pdf-nightmode';

/** Compute a text item's bounding rect in canvas-space given the viewport transform and scale */
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

export function PdfViewerPanel(props: IDockviewPanelProps<{ pdfFileName?: string }>) {
  const pdfFileName = props.params.pdfFileName ?? '';
  const { isLoaded, loading, textExtracting, textExtractProgress, fileName, pageCount, currentPage, searchQuery, matches, activeMatchIndex, matchGroupCount, activeGroupIndex, isMultiTerm, isAtSyntax, multiTermYGap, multiTermXGap, bookmarks } = usePdfStore();
  const { tabs } = useBoardStore();

  // Switch pdfStore to this panel's document on activation
  useEffect(() => {
    if (!pdfFileName) return;
    // Switch immediately on mount
    pdfStore.switchTo(pdfFileName);
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

  // Only render when this panel's document is the active one
  const isMyDoc = fileName === pdfFileName;

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

  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);

  const [nightMode, setNightMode] = useState(() => {
    try { return localStorage.getItem(NIGHT_MODE_KEY) === '1'; } catch { return false; }
  });
  const [debugTextBoxes, setDebugTextBoxes] = useState(false);

  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const bookmarkClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const skipResetRef = useRef(false);

  // When this panel is not the active document (another PDF is active), clear the
  // cached render scale so the framing logic retries after renderPage() completes
  // with fresh dimensions when this panel becomes active again.
  useEffect(() => {
    if (!isMyDoc) {
      scaleRef.current = 0;
      viewportHeightRef.current = 0;
    }
  }, [isMyDoc]);

  useEffect(() => {
    if (skipResetRef.current) {
      skipResetRef.current = false;
      return;
    }
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    renderTierRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentPage]);

  const computeTier = (z: number) => {
    const tier = Math.ceil(z / 0.5) * 0.5;
    return Math.max(1, Math.min(tier, 5));
  };

  const renderIdRef = useRef(0);

  const renderPage = useCallback(async () => {
    if (!isMyDoc || !isLoaded) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const renderId = ++renderIdRef.current;
    const resTier = computeTier(zoomRef.current);
    renderTierRef.current = resTier;

    try {
      const page = await pdfStore.getPage(currentPage);
      if (renderIdRef.current !== renderId) return; // superseded

      // Re-check refs after async — component may have unmounted or switched
      const container = containerRef.current;
      const canvas = canvasRef.current;
      const highlight = highlightRef.current;
      if (!container || !canvas || !highlight) return;
      const containerWidth = container.clientWidth;

      // Container not laid out yet — skip, ResizeObserver will re-trigger
      if (containerWidth === 0) return;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledViewport.width;
      scaleRef.current = baseScale;
      viewportHeightRef.current = unscaledViewport.height;
      viewportTransformRef.current = unscaledViewport.transform;

      const hiresScale = baseScale * resTier;
      const viewport = page.getViewport({ scale: hiresScale });

      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const cssW = containerWidth;
      const cssH = unscaledViewport.height * baseScale;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      highlight.width = viewport.width;
      highlight.height = viewport.height;
      highlight.style.width = `${cssW}px`;
      highlight.style.height = `${cssH}px`;

      const task = page.render({ canvas: canvas, canvasContext: ctx, viewport });
      renderTaskRef.current = { cancel: () => task.cancel() };
      await task.promise;

      if (renderIdRef.current !== renderId) return; // superseded during render
      drawHighlightsRef.current();
    } catch (err) {
      if (err instanceof Error && err.message?.includes('cancel')) {
        // Cancelled by a newer renderPage call — the newer call handles it
        return;
      }
      console.error('[PdfViewerPanel] renderPage failed:', err);
      setError(String(err));
    }
  }, [isMyDoc, isLoaded, currentPage]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isMyDoc || !isLoaded) return;
    const highlight = highlightRef.current;
    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getMatchesForPage(pageIndex);
    const scale = scaleRef.current * renderTierRef.current;
    const vpT = viewportTransformRef.current;
    const blinkHide = blinkPhaseRef.current % 2 === 1;

    const activeIndices = pdfStore.activeMatchIndices;
    const activeMatchSet = new Set<object>();
    for (const idx of activeIndices) {
      if (matches[idx]) activeMatchSet.add(matches[idx]);
    }

    if (isMultiTerm && activeMatchSet.size > 0) {
      const activeGroup = pdfStore.matchGroups[pdfStore.activeGroupIndex];
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

    // --- DEBUG: draw bounding boxes on ALL text items ---
    if (debugTextBoxes) {
      const dbgUnscaledH = viewportHeightRef.current;
      const allItems = pdfStore.getTextItemsForPage(pageIndex);
      for (let i = 0; i < allItems.length; i++) {
        const item = allItems[i];
        const t = item.transform;
        const fontSize = pdfFontSize(t);

        // OLD method (red) — manual Y flip, breaks on rotated pages
        const oldX = t[4] * scale;
        const oldY = (dbgUnscaledH - t[5]) * scale - fontSize * scale;
        hCtx.strokeStyle = 'rgba(255, 50, 50, 0.5)';
        hCtx.lineWidth = 1;
        hCtx.strokeRect(oldX, oldY, item.width * scale, fontSize * scale * LINE_HEIGHT_RATIO);

        // NEW method (green) — viewport transform, handles any rotation
        const r = textItemRect(t, item.width, vpT, scale);
        hCtx.strokeStyle = 'rgba(50, 255, 50, 0.6)';
        hCtx.lineWidth = 1;
        hCtx.strokeRect(r.x, r.y, r.w, r.h);

        if (i < 40) {
          hCtx.font = `${10 * renderTierRef.current}px monospace`;
          hCtx.fillStyle = 'rgba(50, 255, 50, 0.9)';
          hCtx.fillText(`${i}:"${item.str.slice(0, 12)}"`, r.x, r.y - 2);
          hCtx.fillStyle = 'rgba(255, 50, 50, 0.7)';
          hCtx.fillText(`${i}`, oldX, oldY - 2);
        }
      }

      const lx = 10 * renderTierRef.current;
      const ly = 20 * renderTierRef.current;
      const lfs = 14 * renderTierRef.current;
      hCtx.font = `bold ${lfs}px monospace`;
      hCtx.fillStyle = 'rgba(255, 50, 50, 0.9)';
      hCtx.fillText('RED = old (manual Y-flip)', lx, ly);
      hCtx.fillStyle = 'rgba(50, 255, 50, 0.9)';
      hCtx.fillText('GREEN = new (viewport transform)', lx, ly + lfs + 4);
      hCtx.fillStyle = 'rgba(255, 255, 255, 0.7)';
      hCtx.fillText(`vpT=[${vpT.map(v => v.toFixed(1)).join(', ')}]  rot=${vpT[0] === 1 && vpT[3] === -1 ? 'NO' : 'YES'}`, lx, ly + (lfs + 4) * 2);
    }
  }, [isMyDoc, isLoaded, currentPage, matches, activeMatchIndex, activeGroupIndex, isMultiTerm, multiTermYGap, multiTermXGap, debugTextBoxes]);

  const renderPageRef = useRef(renderPage);
  renderPageRef.current = renderPage;
  const drawHighlightsRef = useRef(drawHighlights);
  drawHighlightsRef.current = drawHighlights;

  useEffect(() => { renderPage(); }, [renderPage]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  const pendingMatchRef = useRef<{ index: number; id: number }>({ index: -1, id: 0 });

  useEffect(() => {
    if (!isMyDoc || activeMatchIndex < 0 || !matches[activeMatchIndex]) return;

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
      const activeGroup = (isMultiTerm || isAtSyntax) ? pdfStore.matchGroups[pdfStore.activeGroupIndex] : null;
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
      setZoom(newZoom);
      setPan(newPan);

      if (computeTier(newZoom) !== renderTierRef.current) {
        renderPageRef.current();
      }

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
  }, [isMyDoc, activeMatchIndex, matches, currentPage]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => renderPageRef.current());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

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
      setZoom(newZoom);
      setPan(newPan);

      if (computeTier(newZoom) !== renderTierRef.current) {
        renderPageRef.current();
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  // isMyDoc: re-attach when this panel regains its document (container remounts)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfFileName, isMyDoc]);

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

    const newPan = { x: panRef.current.x + dx, y: panRef.current.y + dy };
    panRef.current = newPan;
    setPan(newPan);
  }, []);

  const handleTextClick = useCallback((e: React.MouseEvent) => {
    if (!isMyDoc || !isLoaded) return;

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
    const items = pdfStore.getTextItemsForPage(pageIndex);

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
  }, [isMyDoc, isLoaded, currentPage]);

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
      setZoom(bm.zoom);
      setPan({ x: bm.panX, y: bm.panY });
      if (computeTier(bm.zoom) !== renderTierRef.current) {
        renderPageRef.current();
      }
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

  if (!isMyDoc) {
    // Not the active pdfStore document — show placeholder
    return (
      <div className="pdf-viewer pdf-empty">
        <span>{pdfFileName || 'No PDF'}</span>
      </div>
    );
  }

  if (!isLoaded && !loading) {
    return (
      <div className="pdf-viewer pdf-empty">
        <span>No PDF loaded. Use &quot;Open PDF&quot; in the toolbar.</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="pdf-viewer pdf-empty">
        <span>Loading {fileName}...</span>
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
        <button
          className={`pdf-toolbar-btn${debugTextBoxes ? ' active' : ''}`}
          onClick={() => setDebugTextBoxes(v => !v)}
          title="Debug: show text bounding boxes (RED=old manual flip, GREEN=new viewport transform)"
          style={debugTextBoxes ? { color: '#0f0' } : undefined}
        >
          DbgTxt
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
        <span className="pdf-zoom-info">{Math.round(zoom * 100)}%</span>
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
        <div
          className="pdf-page-wrapper"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
          }}
        >
          <canvas ref={canvasRef} />
          <canvas ref={highlightRef} className="pdf-highlight-canvas" />
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
