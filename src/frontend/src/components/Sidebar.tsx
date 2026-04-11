import { useState, useRef, useCallback, useEffect } from 'react';
import { IconArrowsLeftRight } from '@tabler/icons-react';
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

function loadWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return v ? Math.max(MIN_WIDTH, parseInt(v, 10)) : DEFAULT_WIDTH;
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

export function onSidebarChange(fn: () => void): () => void {
  _listeners.add(fn);
  return () => { _listeners.delete(fn); };
}

export function getSidebarWidth(): number {
  return _collapsed ? 0 : loadWidth();
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

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const rawDelta = e.clientX - startX.current;
    const delta = _side === 'left' ? rawDelta : -rawDelta;
    const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta);
    setWidth(newWidth);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const rawDelta = e.clientX - startX.current;
    const delta = _side === 'left' ? rawDelta : -rawDelta;
    const newWidth = Math.max(MIN_WIDTH, startWidth.current + delta);
    setWidth(newWidth);
    saveWidth(newWidth);
    _listeners.forEach(fn => fn());
  }, []);

  if (_collapsed) return null;

  const isLeft = _side === 'left';

  return (
    <div
      className={`sidebar sidebar-${_side}`}
      style={{
        width,
        minWidth: MIN_WIDTH,
        flexShrink: 0,
        order: isLeft ? 0 : 1,
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
              <IconArrowsLeftRight size={14} />
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
              <IconArrowsLeftRight size={14} />
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
        {_activeTab === 'library' && <LibraryPanel />}
        {_activeTab === 'settings' && <SettingsPanel />}
        {_activeTab === 'debug' && <DebugPanel />}
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
