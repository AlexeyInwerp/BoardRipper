import { useState, useRef, useCallback, useEffect } from 'react';
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react';
import { LibraryPanel } from '../panels/LibraryPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { ToolsPanel } from '../panels/ToolsPanel';
import { PanelErrorBoundary } from './PanelErrorBoundary';
import { DebugPanel } from '../panels/DebugPanel';
import { isLiteBuild } from '../store/build-mode';
import {
  MIN_WIDTH,
  MAX_WIDTH_RATIO,
  TABS,
  loadWidth,
  saveWidth,
  getSideRaw,
  setActiveTabRaw,
  emitSidebarChange,
  toggleSidebar,
  flipSidebarSide,
  hideSidebar,
} from './Sidebar.utils';
import { useSidebarState } from '../hooks/useSidebarState';

export function Sidebar() {
  const { side, collapsed, activeTab, rail, autoHide } = useSidebarState();
  const [width, setWidth] = useState(loadWidth);
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [width]);

  const clampWidth = useCallback((raw: number) => {
    const maxPx = Math.round(window.innerWidth * MAX_WIDTH_RATIO);
    return Math.min(maxPx, Math.max(MIN_WIDTH, raw));
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rawDelta = e.clientX - startX.current;
    const delta = getSideRaw() === 'left' ? rawDelta : -rawDelta;
    setWidth(clampWidth(startWidth.current + delta));
  }, [clampWidth]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const rawDelta = e.clientX - startX.current;
    const delta = getSideRaw() === 'left' ? rawDelta : -rawDelta;
    const newWidth = clampWidth(startWidth.current + delta);
    setWidth(newWidth);
    saveWidth(newWidth);
    emitSidebarChange();
  }, [clampWidth]);

  const isLeft = side === 'left';
  // `rail`: navigation lives in the ActivityRail (App.tsx mounts it beside
  // this component) and the text strip below is not rendered.
  // `autoHide`: the panel is taken out of flow and laid over the board area
  // (.sidebar-overlay in index.css; the wrapper is position:relative and the
  // rail sits outside it), so opening and hiding never resize the WebGL
  // canvas. Any pointerdown that lands in the dockview area hides it; the
  // toolbar, dialogs, toasts and the rail's own menu do not — capture phase,
  // no preventDefault, so the click still reaches the board.
  useEffect(() => {
    if (!autoHide || collapsed) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest('.dockview-container')) hideSidebar();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [autoHide, collapsed]);

  // Auto-hide overlay must never cover a tab strip: tabs are navigation, and
  // a panel you cannot switch boards past is worse than a panel that resizes
  // the board. The docking area has no single "content top" — every dockview
  // group has its own strip — so measure: the overlay starts below the
  // top-most strip that shares its column, and stops above the next strip
  // below it (a vertical split) if there is one. Re-measured on resize and
  // whenever dockview adds, removes or re-arranges groups.
  const rootRef = useRef<HTMLDivElement>(null);
  const [overlayInset, setOverlayInset] = useState({ top: 0, bottom: 0 });
  useEffect(() => {
    if (!autoHide || collapsed) return;
    const host = rootRef.current?.parentElement;                   // .dockview-wrapper
    const dock = host?.querySelector<HTMLElement>('.dockview-container');
    if (!host || !dock) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const h = host.getBoundingClientRect();
      const w = rootRef.current?.offsetWidth ?? width;
      const x0 = isLeft ? h.left : h.right - w;
      const x1 = isLeft ? h.left + w : h.right;
      const strips = Array.from(dock.querySelectorAll<HTMLElement>('.dv-tabs-and-actions-container'))
        .map(el => el.getBoundingClientRect())
        .filter(r => r.height > 0 && r.right > x0 + 1 && r.left < x1 - 1)   // in the overlay's column
        .sort((a, b) => a.top - b.top);
      if (strips.length === 0) { setOverlayInset(v => (v.top === 0 && v.bottom === 0 ? v : { top: 0, bottom: 0 })); return; }
      const top = Math.max(0, Math.round(strips[0].bottom - h.top));
      const below = strips.find(r => r.top > strips[0].bottom + 1);
      const bottom = below ? Math.max(0, Math.round(h.bottom - below.top)) : 0;
      setOverlayInset(v => (v.top === top && v.bottom === bottom ? v : { top, bottom }));
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const ro = new ResizeObserver(schedule);
    ro.observe(dock);
    const mo = new MutationObserver(schedule);
    mo.observe(dock, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect(); mo.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [autoHide, collapsed, isLeft, width]);

  return (
    <div
      ref={rootRef}
      className={`sidebar sidebar-${side}${autoHide ? ' sidebar-overlay' : ''}`}
      data-testid="sidebar"
      data-overlay-top={autoHide ? overlayInset.top : undefined}
      style={{
        width: collapsed ? 0 : width,
        minWidth: collapsed ? 0 : MIN_WIDTH,
        flexShrink: 0,
        order: isLeft ? 0 : 1,
        display: collapsed ? 'none' : undefined,
        borderRight: isLeft ? '1px solid var(--border)' : 'none',
        borderLeft: isLeft ? 'none' : '1px solid var(--border)',
        ...(autoHide ? { top: overlayInset.top, bottom: overlayInset.bottom } : null),
      }}
    >
      {!rail && <div className="sidebar-tabs">
        {!isLeft && (
          <div style={{ display: 'flex', alignItems: 'center', marginRight: 'auto' }}>
            <button
              className="sidebar-tab sidebar-action-btn"
              onClick={toggleSidebar}
              title="Hide sidebar"
            >▶</button>
            <button
              className="sidebar-tab sidebar-action-btn"
              onClick={flipSidebarSide}
              title="Move sidebar to left"
            >
              <IconLayoutSidebar size={14} />
            </button>
          </div>
        )}
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`sidebar-tab${activeTab === tab.id ? ' active' : ''}`}
            data-sidebar-tab={tab.id}
            onClick={() => { setActiveTabRaw(tab.id); emitSidebarChange(); }}
          >
            {tab.label}
          </button>
        ))}
        {isLeft && (
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
            <button
              className="sidebar-tab sidebar-action-btn"
              onClick={flipSidebarSide}
              title="Move sidebar to right"
            >
              <IconLayoutSidebarRight size={14} />
            </button>
            <button
              className="sidebar-tab sidebar-action-btn"
              onClick={toggleSidebar}
              title="Hide sidebar"
            >◀</button>
          </div>
        )}
      </div>}
      <div className="sidebar-content">
        {/* All three panels stay mounted at all times — display toggling
            preserves React state (scroll, expanded folders, search query)
            across tab switches. The panel that's not active just renders
            with display:none and contributes no layout. */}
        {!isLiteBuild() && (
          <div style={{ display: activeTab === 'library' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <LibraryPanel />
          </div>
        )}
        <div style={{ display: activeTab === 'tools' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <PanelErrorBoundary label="Tools">
            <ToolsPanel />
          </PanelErrorBoundary>
        </div>
        <div style={{ display: activeTab === 'settings' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <SettingsPanel />
        </div>
        <div style={{ display: activeTab === 'debug' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <DebugPanel />
        </div>
      </div>
      <div
        className="sidebar-resize-handle"
        style={isLeft ? { right: -3 } : { left: -3 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
