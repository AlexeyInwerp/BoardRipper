import { useState, useRef, useCallback, useEffect } from 'react';
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react';
import { LibraryPanel } from '../panels/LibraryPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';
import {
  MIN_WIDTH,
  MAX_WIDTH_RATIO,
  TABS,
  loadWidth,
  saveWidth,
  getCollapsed,
  getActiveTabRaw,
  getSideRaw,
  setActiveTabRaw,
  emitSidebarChange,
  toggleSidebar,
  flipSidebarSide,
  onSidebarChange,
} from './Sidebar.utils';

export function Sidebar() {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const unsub = onSidebarChange(() => forceUpdate(n => n + 1));
    return unsub;
  }, []);

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

  const side = getSideRaw();
  const collapsed = getCollapsed();
  const activeTab = getActiveTabRaw();
  const isLeft = side === 'left';

  return (
    <div
      className={`sidebar sidebar-${side}`}
      style={{
        width: collapsed ? 0 : width,
        minWidth: collapsed ? 0 : MIN_WIDTH,
        flexShrink: 0,
        order: isLeft ? 0 : 1,
        display: collapsed ? 'none' : undefined,
        borderRight: isLeft ? '1px solid var(--border)' : 'none',
        borderLeft: isLeft ? 'none' : '1px solid var(--border)',
      }}
    >
      <div className="sidebar-tabs">
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
      </div>
      <div className="sidebar-content">
        {/* All three panels stay mounted at all times — display toggling
            preserves React state (scroll, expanded folders, search query)
            across tab switches. The panel that's not active just renders
            with display:none and contributes no layout. */}
        <div style={{ display: activeTab === 'library' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <LibraryPanel />
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
