/**
 * Sidebar state, persistence, and external API.
 *
 * This file is the non-component sibling of `Sidebar.tsx`. The Sidebar
 * component reads/mutates the module-level state declared here; Toolbar,
 * keyboard shortcuts, ContextMenu, etc. consume the named function exports.
 *
 * Split out to satisfy `react-refresh/only-export-components` — Vite Fast
 * Refresh can only HMR a file whose only exports are React components.
 */

import { isLiteBuild } from '../store/build-mode';

const SIDEBAR_WIDTH_KEY = 'boardripper-sidebar-width';
const SIDEBAR_SIDE_KEY = 'boardripper-sidebar-side';
const DEFAULT_WIDTH = 320;
export const MIN_WIDTH = 200;
export const MAX_WIDTH_RATIO = 0.5; // never wider than half the screen

export type SidebarSide = 'left' | 'right';
export type SidebarTab = 'library' | 'settings' | 'debug';

export const TABS: { id: SidebarTab; label: string }[] = ([
  { id: 'library', label: 'Library' },
  { id: 'settings', label: 'Settings' },
  { id: 'debug', label: 'Debug' },
] as { id: SidebarTab; label: string }[]).filter(t => !(isLiteBuild() && t.id === 'library'));

export function loadWidth(): number {
  try {
    const v = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!v) return DEFAULT_WIDTH;
    const maxPx = Math.round(window.innerWidth * MAX_WIDTH_RATIO);
    return Math.min(maxPx, Math.max(MIN_WIDTH, parseInt(v, 10)));
  } catch { return DEFAULT_WIDTH; }
}

export function saveWidth(px: number): void {
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
const state = {
  collapsed: false,
  activeTab: (isLiteBuild() ? 'settings' : 'library') as SidebarTab,
  side: loadSide(),
};
const listeners = new Set<() => void>();

export function getCollapsed(): boolean { return state.collapsed; }
export function getActiveTabRaw(): SidebarTab { return state.activeTab; }
export function getSideRaw(): SidebarSide { return state.side; }
export function setActiveTabRaw(tab: SidebarTab): void { state.activeTab = tab; }
export function emitSidebarChange(): void { listeners.forEach(fn => fn()); }

export function isSidebarCollapsed(): boolean { return state.collapsed; }
export function getSidebarActiveTab(): SidebarTab { return state.activeTab; }
export function getSidebarSide(): SidebarSide { return state.side; }

export function toggleSidebar(): void {
  state.collapsed = !state.collapsed;
  emitSidebarChange();
}

export function showSidebarTab(tab: SidebarTab): void {
  state.activeTab = (isLiteBuild() && tab === 'library') ? 'settings' : tab;
  if (state.collapsed) state.collapsed = false;
  emitSidebarChange();
}

export function flipSidebarSide(): void {
  state.side = state.side === 'left' ? 'right' : 'left';
  saveSide(state.side);
  emitSidebarChange();
}

export function toggleLibrarySidebar(): void {
  // Pure toggle:
  //   collapsed                          → open with library tab
  //   open on a non-library tab          → switch to library tab
  //   open on library tab                → collapse
  // Lite build has no library tab — degrade to a plain sidebar toggle.
  if (isLiteBuild()) { toggleSidebar(); return; }
  if (state.collapsed || state.activeTab !== 'library') {
    showSidebarTab('library');
  } else {
    toggleSidebar();
  }
}

export function onSidebarChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getSidebarWidth(): number {
  return state.collapsed ? 0 : loadWidth();
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
