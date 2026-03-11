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
  const [clickedText, setClickedText] = useState<string | null>(null);

  // Pan/zoom state (CSS transform on wrapper)
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);

  // Reset pan/zoom when page changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [currentPage]);

  const renderPage = useCallback(async () => {
    if (!isLoaded || !canvasRef.current || !highlightRef.current || !containerRef.current) return;

    renderTaskRef.current?.cancel();

    const page = await pdfStore.getPage(currentPage);
    const container = containerRef.current;
    const containerWidth = container.clientWidth;

    const unscaledViewport = page.getViewport({ scale: 1 });
    const scale = containerWidth / unscaledViewport.width;
    scaleRef.current = scale;
    viewportHeightRef.current = unscaledViewport.height;
    const viewport = page.getViewport({ scale });

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d')!;
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;

    const highlight = highlightRef.current;
    highlight.width = viewport.width;
    highlight.height = viewport.height;
    highlight.style.width = `${viewport.width}px`;
    highlight.style.height = `${viewport.height}px`;

    const task = page.render({ canvasContext: ctx, viewport });
    renderTaskRef.current = { cancel: () => task.cancel() };
    try {
      await task.promise;
    } catch {
      return;
    }

    drawHighlights();
  }, [isLoaded, currentPage]);

  const drawHighlights = useCallback(() => {
    if (!highlightRef.current || !isLoaded) return;
    const highlight = highlightRef.current;
    const hCtx = highlight.getContext('2d')!;
    hCtx.clearRect(0, 0, highlight.width, highlight.height);

    const pageIndex = currentPage - 1;
    const pageMatches = pdfStore.getMatchesForPage(pageIndex);
    const scale = scaleRef.current;
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

  useEffect(() => { renderPage(); }, [renderPage]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => renderPage());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [renderPage]);

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

      setZoom(prev => {
        const newZoom = Math.max(0.1, Math.min(prev * zoomFactor, 20));
        const ratio = newZoom / prev;
        setPan(p => ({
          x: mouseX - ratio * (mouseX - p.x),
          y: mouseY - ratio * (mouseY - p.y),
        }));
        return newZoom;
      });
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

    setPan(p => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    const wasDrag = wasDragRef.current;
    isDraggingRef.current = false;
    wasDragRef.current = false;

    // If it wasn't a drag, treat as a click for text detection
    if (!wasDrag && e.button === 0) {
      handleTextClick(e);
    }
  }, []);

  // Text detection on click (not drag)
  const handleTextClick = useCallback((e: React.MouseEvent) => {
    if (!isLoaded) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (canvas.width / rect.width);
    const clickY = (e.clientY - rect.top) * (canvas.height / rect.height);

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
