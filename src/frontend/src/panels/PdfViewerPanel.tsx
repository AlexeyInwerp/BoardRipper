import { useRef, useEffect, useCallback, useState } from 'react';
import { usePdfStore } from '../hooks/usePdfStore';
import { pdfStore } from '../store/pdf-store';
import { boardStore } from '../store/board-store';

const DRAG_THRESHOLD = 3;

export function PdfViewerPanel() {
  const { isLoaded, loading, fileName, pageCount, currentPage, searchQuery, matches, activeMatchIndex } = usePdfStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const scaleRef = useRef(1);
  const viewportHeightRef = useRef(0);
  const renderTierRef = useRef(1); // resolution multiplier for current render
  const [clickedText, setClickedText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pan/zoom state — refs are source of truth, state triggers re-render
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);

  // Reset pan/zoom when page changes
  useEffect(() => {
    zoomRef.current = 1;
    panRef.current = { x: 0, y: 0 };
    renderTierRef.current = 1;
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentPage]);

  /** Compute the resolution tier: steps up every 50% of zoom (1, 1.5, 2, 2.5, …) capped at 5 */
  const computeTier = useCallback((z: number) => {
    const tier = Math.ceil(z / 0.5) * 0.5;
    return Math.max(1, Math.min(tier, 5));
  }, []);

  const renderPage = useCallback(async (tier?: number) => {
    if (!isLoaded || !canvasRef.current || !highlightRef.current || !containerRef.current) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const resTier = tier ?? renderTierRef.current;
    renderTierRef.current = resTier;

    try {
      const page = await pdfStore.getPage(currentPage);
      const container = containerRef.current;
      const containerWidth = container.clientWidth;

      const unscaledViewport = page.getViewport({ scale: 1 });
      const baseScale = containerWidth / unscaledViewport.width;
      scaleRef.current = baseScale;
      viewportHeightRef.current = unscaledViewport.height;

      // Render at higher resolution for sharp zoom
      const hiresScale = baseScale * resTier;
      const viewport = page.getViewport({ scale: hiresScale });

      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d')!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // CSS size stays at base scale — the CSS zoom handles the rest
      const cssW = containerWidth;
      const cssH = unscaledViewport.height * baseScale;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;

      const highlight = highlightRef.current;
      highlight.width = viewport.width;
      highlight.height = viewport.height;
      highlight.style.width = `${cssW}px`;
      highlight.style.height = `${cssH}px`;

      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = { cancel: () => task.cancel() };
      await task.promise;

      drawHighlights();
    } catch (err) {
      // Cancelled render tasks throw — that's expected
      if (err instanceof Error && err.message?.includes('cancel')) return;
      console.error('[PdfViewerPanel] renderPage failed:', err);
      setError(String(err));
    }
  }, [isLoaded, currentPage]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isLoaded) return;
    const highlight = highlightRef.current;
    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getMatchesForPage(pageIndex);
    const scale = scaleRef.current * renderTierRef.current;
    const unscaledH = viewportHeightRef.current;

    for (let mi = 0; mi < pageMatches.length; mi++) {
      const match = pageMatches[mi];
      const t = match.item.transform;

      const x = t[4] * scale;
      const fontSize = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
      const y = (unscaledH - t[5]) * scale - fontSize * scale;
      const w = match.item.width * scale;
      const h = fontSize * scale * 1.2;

      const isActive = matches.indexOf(match) === activeMatchIndex;
      hCtx.fillStyle = isActive ? 'rgba(255, 170, 0, 0.4)' : 'rgba(255, 255, 68, 0.3)';
      hCtx.fillRect(x, y, w, h);
    }
  }, [isLoaded, currentPage, matches, activeMatchIndex]);

  // Keep a ref to renderPage so the wheel handler can trigger re-renders
  const renderPageRef = useRef(renderPage);
  renderPageRef.current = renderPage;

  useEffect(() => { renderPage(); }, [renderPage]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => renderPageRef.current());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Wheel zoom (anchored to cursor, proportional to deltaY — matches board view speed)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      // Proportional zoom matching pixi-viewport wheel({ smooth: 5 }) feel
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

      // Re-render at higher resolution when zoom tier changes
      const newTier = computeTier(newZoom);
      if (newTier !== renderTierRef.current) {
        renderPageRef.current(newTier);
      }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // Left-click drag to pan (with threshold to distinguish from click)
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    wasDragRef.current = false;
    dragStartRef.current = { x: e.clientX, y: e.clientY };
    lastMouseRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;

    const dx = e.clientX - lastMouseRef.current.x;
    const dy = e.clientY - lastMouseRef.current.y;
    lastMouseRef.current = { x: e.clientX, y: e.clientY };

    // Check if we've exceeded drag threshold
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

  // Text detection on click (not drag)
  // Uses refs for zoom/pan so it's never stale
  const handleTextClick = useCallback((e: React.MouseEvent) => {
    if (!isLoaded) return;

    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    // Convert screen coords to canvas pixel coords using known pan/zoom
    const containerRect = container.getBoundingClientRect();
    const screenX = e.clientX - containerRect.left;
    const screenY = e.clientY - containerRect.top;
    const clickX = (screenX - panRef.current.x) / zoomRef.current;
    const clickY = (screenY - panRef.current.y) / zoomRef.current;

    const scale = scaleRef.current;
    const unscaledH = viewportHeightRef.current;
    const pageIndex = currentPage - 1;
    const items = pdfStore.getTextItemsForPage(pageIndex);

    for (const item of items) {
      const t = item.transform;
      const fontSize = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
      const x = t[4] * scale;
      const y = (unscaledH - t[5]) * scale - fontSize * scale;
      const w = item.width * scale;
      const h = fontSize * scale * 1.2;

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
  }, [isLoaded, currentPage]);

  // Keep a ref to the latest handleTextClick so handleMouseUp never goes stale
  const handleTextClickRef = useRef(handleTextClick);
  handleTextClickRef.current = handleTextClick;

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDrag = wasDragRef.current;
    isDraggingRef.current = false;
    wasDragRef.current = false;

    // If it wasn't a drag, treat as a click for text detection
    if (!wasDrag && e.button === 0) {
      handleTextClickRef.current(e);
    }
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    pdfStore.searchText(searchInputRef.current?.value ?? '');
  };

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

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
        <span className="pdf-filename" title={fileName}>{fileName}</span>
        <div className="pdf-toolbar-separator" />

        <button
          className="pdf-toolbar-btn"
          onClick={() => pdfStore.goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
        >
          &lt;
        </button>
        <span className="pdf-page-info">{currentPage} / {pageCount}</span>
        <button
          className="pdf-toolbar-btn"
          onClick={() => pdfStore.goToPage(currentPage + 1)}
          disabled={currentPage >= pageCount}
        >
          &gt;
        </button>

        <div className="pdf-toolbar-separator" />

        <form className="pdf-search-form" onSubmit={handleSearch}>
          <input
            ref={searchInputRef}
            type="text"
            className="pdf-search-input"
            placeholder="Search in PDF..."
            defaultValue={searchQuery}
          />
        </form>
        {matches.length > 0 && (
          <>
            <span className="pdf-match-info">
              {activeMatchIndex + 1}/{matches.length}
            </span>
            <button className="pdf-toolbar-btn" onClick={() => pdfStore.prevMatch()}>&#9650;</button>
            <button className="pdf-toolbar-btn" onClick={() => pdfStore.nextMatch()}>&#9660;</button>
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

        <div className="pdf-toolbar-spacer" />
        <span className="pdf-zoom-info">{Math.round(zoom * 100)}%</span>
      </div>

      <div
        className="pdf-canvas-container"
        ref={containerRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => { isDraggingRef.current = false; wasDragRef.current = false; }}
        onContextMenu={handleContextMenu}
        style={{ cursor: isDraggingRef.current ? 'grabbing' : 'crosshair' }}
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
