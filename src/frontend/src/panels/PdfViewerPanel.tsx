import { useRef, useEffect, useCallback, useState } from 'react';
import { usePdfStore } from '../hooks/usePdfStore';
import { pdfStore } from '../store/pdf-store';
import { boardStore } from '../store/board-store';

const DRAG_THRESHOLD = 3;

export function PdfViewerPanel() {
  const { isLoaded, loading, fileName, pageCount, currentPage, searchQuery, matches, activeMatchIndex, bookmarks } = usePdfStore();
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
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blinkPhaseRef = useRef(0); // 0 = no blink, >0 = blink countdown

  // Pan/zoom state — refs are source of truth, state triggers re-render
  const zoomRef = useRef(1);
  const panRef = useRef({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const lastMouseRef = useRef({ x: 0, y: 0 });
  const wasDragRef = useRef(false);

  // Night mode (inverted colors)
  const [nightMode, setNightMode] = useState(false);

  // Bookmark editing state
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const bookmarkClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Skip pan/zoom reset when navigating to a match or bookmark restore
  const skipResetRef = useRef(false);

  // Reset pan/zoom when page changes (unless navigating to a match)
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

  /** Compute the resolution tier: steps up every 50% of zoom (1, 1.5, 2, 2.5, …) capped at 5 */
  const computeTier = (z: number) => {
    const tier = Math.ceil(z / 0.5) * 0.5;
    return Math.max(1, Math.min(tier, 5));
  };

  const renderPage = useCallback(async () => {
    if (!isLoaded || !canvasRef.current || !highlightRef.current || !containerRef.current) return;

    renderTaskRef.current?.cancel();
    setError(null);

    const resTier = computeTier(zoomRef.current);
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
    const blinkHide = blinkPhaseRef.current % 2 === 1; // odd phases = hidden

    for (let mi = 0; mi < pageMatches.length; mi++) {
      const match = pageMatches[mi];
      const t = match.item.transform;

      const x = t[4] * scale;
      const fontSize = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
      const y = (unscaledH - t[5]) * scale - fontSize * scale;
      const w = match.item.width * scale;
      const h = fontSize * scale * 1.2;

      const isActive = matches.indexOf(match) === activeMatchIndex;
      if (isActive) {
        // Blink: alternate between orange and red
        hCtx.fillStyle = blinkHide ? 'rgba(220, 30, 30, 0.5)' : 'rgba(255, 170, 0, 0.4)';
      } else {
        hCtx.fillStyle = 'rgba(255, 255, 68, 0.3)';
      }
      hCtx.fillRect(x, y, w, h);
    }
  }, [isLoaded, currentPage, matches, activeMatchIndex]);

  // Keep a ref to renderPage so the wheel handler can trigger re-renders
  const renderPageRef = useRef(renderPage);
  renderPageRef.current = renderPage;
  const drawHighlightsRef = useRef(drawHighlights);
  drawHighlightsRef.current = drawHighlights;

  useEffect(() => { renderPage(); }, [renderPage]);
  useEffect(() => { drawHighlights(); }, [drawHighlights]);

  // When active match changes: center & zoom to match (~10% of screen), then blink
  // Uses a ref-based approach to avoid blocking the render pipeline
  const pendingMatchRef = useRef<{ index: number; id: number }>({ index: -1, id: 0 });

  useEffect(() => {
    if (activeMatchIndex < 0 || !matches[activeMatchIndex]) return;

    // Signal to skip the page-reset effect (match navigation handles zoom/pan)
    const match = matches[activeMatchIndex];
    const matchPage = match.pageIndex + 1;
    if (matchPage !== currentPage) {
      skipResetRef.current = true;
    }

    // Bump the match ID so we can detect stale blinks
    const matchId = ++pendingMatchRef.current.id;
    pendingMatchRef.current.index = activeMatchIndex;

    // Defer zoom/pan until after page render is ready (scaleRef populated)
    const applyZoomAndBlink = () => {
      if (pendingMatchRef.current.id !== matchId) return; // stale
      if (!containerRef.current) return;

      const baseScale = scaleRef.current;
      const unscaledH = viewportHeightRef.current;
      if (baseScale === 0 || unscaledH === 0) return; // not rendered yet

      const t = match.item.transform;
      const fontSize = Math.sqrt(t[2] * t[2] + t[3] * t[3]);
      const mx = t[4] * baseScale;
      const my = (unscaledH - t[5]) * baseScale - fontSize * baseScale;
      const mw = match.item.width * baseScale;
      const mh = fontSize * baseScale * 1.2;
      const mcx = mx + mw / 2;
      const mcy = my + mh / 2;

      const container = containerRef.current;
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const targetFrac = 0.1;
      const zoomByW = (cw * targetFrac) / Math.max(mw, 1);
      const zoomByH = (ch * targetFrac) / Math.max(mh, 1);
      const newZoom = Math.max(0.5, Math.min(Math.min(zoomByW, zoomByH), 20));

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

      // Blink: 6 phases alternating orange/red over ~1.5s (only redraws highlight canvas)
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
      blinkPhaseRef.current = 0;
      const totalBlinks = 6;
      const blinkInterval = 250;

      const doBlink = (phase: number) => {
        if (pendingMatchRef.current.id !== matchId) return; // stale
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

    // Use requestAnimationFrame to let the page render first
    const raf = requestAnimationFrame(applyZoomAndBlink);

    return () => {
      cancelAnimationFrame(raf);
      if (blinkTimerRef.current) {
        clearTimeout(blinkTimerRef.current);
        blinkTimerRef.current = null;
      }
      blinkPhaseRef.current = 0;
    };
  }, [activeMatchIndex, matches, currentPage]);

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
      if (computeTier(newZoom) !== renderTierRef.current) {
        renderPageRef.current();
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

  const handleAddBookmark = useCallback(() => {
    pdfStore.addBookmark(currentPage, zoomRef.current, panRef.current.x, panRef.current.y);
  }, [currentPage]);

  const handleBookmarkClick = useCallback((id: string) => {
    // Single click: navigate to bookmark. Use a timer to distinguish from double-click.
    if (bookmarkClickTimerRef.current) {
      clearTimeout(bookmarkClickTimerRef.current);
      bookmarkClickTimerRef.current = null;
    }
    bookmarkClickTimerRef.current = setTimeout(() => {
      bookmarkClickTimerRef.current = null;
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
  }, []);

  const handleBookmarkDblClick = useCallback((id: string) => {
    // Double click: overwrite bookmark with current view
    if (bookmarkClickTimerRef.current) {
      clearTimeout(bookmarkClickTimerRef.current);
      bookmarkClickTimerRef.current = null;
    }
    pdfStore.updateBookmark(id, currentPage, zoomRef.current, panRef.current.x, panRef.current.y);
  }, [currentPage]);

  const handleBookmarkRightClick = useCallback((e: React.MouseEvent, id: string) => {
    e.preventDefault();
    pdfStore.removeBookmark(id);
  }, []);

  const handleBookmarkMiddleClick = useCallback((e: React.MouseEvent, id: string) => {
    // Middle-click or Option+click (Mac) to start editing label
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      e.stopPropagation();
      const bm = pdfStore.bookmarks.find(b => b.id === id);
      if (bm) {
        setEditingBookmarkId(id);
        setEditingLabel(bm.label);
      }
    }
  }, []);

  const handleLabelEditSubmit = useCallback((id: string) => {
    pdfStore.renameBookmark(id, editingLabel.trim());
    setEditingBookmarkId(null);
    setEditingLabel('');
  }, [editingLabel]);

  const handleLabelEditKeyDown = useCallback((e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter') {
      handleLabelEditSubmit(id);
    } else if (e.key === 'Escape') {
      setEditingBookmarkId(null);
      setEditingLabel('');
    }
  }, [handleLabelEditSubmit]);

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
        <input
          className="pdf-page-input"
          type="text"
          value={currentPage}
          onChange={e => {
            const n = parseInt(e.target.value, 10);
            if (!isNaN(n)) pdfStore.goToPage(n);
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onFocus={e => e.target.select()}
        />
        <span className="pdf-page-info">/ {pageCount}</span>
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
          className={`pdf-toolbar-btn${nightMode ? ' active' : ''}`}
          onClick={() => setNightMode(v => !v)}
          title="Toggle night mode (invert colors)"
        >
          Night
        </button>
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
