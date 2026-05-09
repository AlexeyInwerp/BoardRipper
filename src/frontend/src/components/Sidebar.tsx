import { useState, useRef, useCallback, useEffect } from 'react';
import { IconLayoutSidebar, IconLayoutSidebarRight } from '@tabler/icons-react';
import { LibraryPanel } from '../panels/LibraryPanel';
import { SettingsPanel } from '../panels/SettingsPanel';
import { DebugPanel } from '../panels/DebugPanel';

const SIDEBAR_WIDTH_KEY = 'boardripper-sidebar-width';
const SIDEBAR_SIDE_KEY = 'boardripper-sidebar-side';
const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 200;

export type SidebarSide = 'left' | 'right';
export type SidebarTab = 'library' | 'settings' | 'debug';

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'debug', label: 'Debug' },
];

const MAX_WIDTH_RATIO = 0.5; // never wider than half the screen

function loadWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!v) return DEFAULT_WIDTH;
    const maxPx = Math.round(window.innerWidth * MAX_WIDTH_RATIO);
    return Math.min(maxPx, Math.max(MIN_WIDTH, parseInt(v, 10)));
  } catch { return DEFAULT_WIDTH; }
}

function saveWidth(px: number): void {
  try { localStorage.setItem(SIDEBAR_WIDTH_KEY, String(Math.round(px))); } catch { /* */ }
}

function loadSide(): SidebarSide {
  try {
    const v = localStorage.getItem(SIDEBAR_SIDE_KEY);
    return v === 'right' ? 'right' : 'left';
  } catch { return 'left'; }
}

function saveSide(side: SidebarSide): void {
  try { localStorage.setItem(SIDEBAR_SIDE_KEY, side); } catch { /* */ }
}

// --- Global sidebar state (for external access by Toolbar, keyboard shortcuts) ---
let _collapsed = false;
let _activeTab: SidebarTab = 'library';
let _side: SidebarSide = loadSide();
const _listeners = new Set<() => void>();

export function isSidebarCollapsed(): boolean { return _collapsed; }
export function getSidebarActiveTab(): SidebarTab { return _activeTab; }
export function getSidebarSide(): SidebarSide { return _side; }

export function toggleSidebar(): void {
  _collapsed = !_collapsed;
  _listeners.forEach(fn => fn());
}

export function showSidebarTab(tab: SidebarTab): void {
  _activeTab = tab;
  if (_collapsed) _collapsed = false;
  _listeners.forEach(fn => fn());
}

export function flipSidebarSide(): void {
  _side = _side === 'left' ? 'right' : 'left';
  saveSide(_side);
  _listeners.forEach(fn => fn());
}

export function toggleLibrarySidebar(): void {
  // Pure toggle:
  //   collapsed                          → open with library tab
  //   open on a non-library tab          → switch to library tab
  //   open on library tab                → collapse
  if (_collapsed || _activeTab !== 'library') {
    showSidebarTab('library');
  } else {
    toggleSidebar();
  }
}

export function onSidebarChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function getSidebarWidth(): number {
  return _collapsed ? 0 : loadWidth();
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as {
    __sidebar?: { isCollapsed: () => boolean; activeTab: () => SidebarTab; toggle: () => void };
  }).__sidebar = {
    isCollapsed: isSidebarCollapsed,
    activeTab: getSidebarActiveTab,
    toggle: toggleSidebar,
  };
}

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
    const delta = _side === 'left' ? rawDelta : -rawDelta;
    setWidth(clampWidth(startWidth.current + delta));
  }, [clampWidth]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const rawDelta = e.clientX - startX.current;
    const delta = _side === 'left' ? rawDelta : -rawDelta;
    const newWidth = clampWidth(startWidth.current + delta);
    setWidth(newWidth);
    saveWidth(newWidth);
    _listeners.forEach(fn => fn());
  }, [clampWidth]);

  const isLeft = _side === 'left';

  return (
    <div
      className={`sidebar sidebar-${_side}`}
      style={{
        width: _collapsed ? 0 : width,
        minWidth: _collapsed ? 0 : MIN_WIDTH,
        flexShrink: 0,
        order: isLeft ? 0 : 1,
        display: _collapsed ? 'none' : undefined,
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
            className={`sidebar-tab${_activeTab === tab.id ? ' active' : ''}`}
            onClick={() => { _activeTab = tab.id; _listeners.forEach(fn => fn()); }}
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
        <div style={{ display: _activeTab === 'library' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <LibraryPanel />
        </div>
        <div style={{ display: _activeTab === 'settings' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <SettingsPanel />
        </div>
        <div style={{ display: _activeTab === 'debug' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
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
