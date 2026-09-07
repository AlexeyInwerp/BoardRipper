/**
 * Sidebar state, persistence, and external API.
 *
 * This file is the non-component sibling of `Sidebar.tsx`. The Sidebar
 * component and the ActivityRail both read/mutate the module-level state
 * declared here; Toolbar, keyboard shortcuts, ContextMenu, etc. consume the
 * named function exports.
 *
 * The activity rail is deliberately a second VIEW over this state, not a
 * second store: `activeTab` / `collapsed` / `side` / `width` are the whole
 * truth, and every caller that existed before the rail (`showSidebarTab`,
 * `toggleSidebar`, `toggleLibrarySidebar`, `flipSidebarSide`) keeps its
 * signature and semantics. See docs/plans/2026-09-07-activity-rail.md.
 *
 * Split out to satisfy `react-refresh/only-export-components` — Vite Fast
 * Refresh can only HMR a file whose only exports are React components.
 */

import { isLiteBuild } from '../store/build-mode';

const SIDEBAR_WIDTH_KEY = 'boardripper-sidebar-width';
const SIDEBAR_SIDE_KEY = 'boardripper-sidebar-side';
const SIDEBAR_COLLAPSED_KEY = 'boardripper-sidebar-collapsed';
const SIDEBAR_TAB_KEY = 'boardripper-sidebar-tab';
const SIDEBAR_RAIL_KEY = 'boardripper-sidebar-rail';
const SIDEBAR_RAIL_HIDDEN_KEY = 'boardripper-sidebar-rail-hidden';
const SIDEBAR_CAPTIONS_KEY = 'boardripper-sidebar-captions';
const STATUSBAR_HIDDEN_KEY = 'boardripper-statusbar-hidden';
const SIDEBAR_AUTOHIDE_KEY = 'boardripper-sidebar-autohide';
const DEFAULT_WIDTH = 320;
export const MIN_WIDTH = 200;
export const MAX_WIDTH_RATIO = 0.5; // never wider than half the screen

export type SidebarSide = 'left' | 'right';
export type SidebarTab = 'library' | 'tools' | 'settings' | 'debug';

const ALL_TABS: SidebarTab[] = ['library', 'tools', 'settings', 'debug'];

export const TABS: { id: SidebarTab; label: string }[] = ([
  { id: 'library', label: 'Library' },
  { id: 'tools', label: 'Tools' },
  { id: 'settings', label: 'Settings' },
  { id: 'debug', label: 'Debug' },
] as { id: SidebarTab; label: string }[]).filter(t => !(isLiteBuild() && t.id === 'library'));

/** Rail grouping: top = where you work, bottom = where you check and configure.
 *  Derived from TABS so the lite build (no Library) needs no special case. */
export const SIDEBAR_GROUPS: { top: SidebarTab[]; bottom: SidebarTab[] } = {
  top: (['library', 'tools'] as SidebarTab[]).filter(id => TABS.some(t => t.id === id)),
  bottom: (['debug', 'settings'] as SidebarTab[]).filter(id => TABS.some(t => t.id === id)),
};

// ---- storage helpers ---------------------------------------------------------

function readKey(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeKey(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}
function readBool(key: string, fallback: boolean): boolean {
  const v = readKey(key);
  return v === null ? fallback : v === 'true';
}

export function loadWidth(): number {
  const v = readKey(SIDEBAR_WIDTH_KEY);
  if (!v) return DEFAULT_WIDTH;
  const maxPx = Math.round(window.innerWidth * MAX_WIDTH_RATIO);
  const parsed = parseInt(v, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WIDTH;
  return Math.min(maxPx, Math.max(MIN_WIDTH, parsed));
}

export function saveWidth(px: number): void {
  writeKey(SIDEBAR_WIDTH_KEY, String(Math.round(px)));
}

function loadSide(): SidebarSide {
  return readKey(SIDEBAR_SIDE_KEY) === 'right' ? 'right' : 'left';
}

/** Lite build has no Library tab — anything pointing at it lands on Settings. */
function coerceTab(tab: SidebarTab): SidebarTab {
  return (isLiteBuild() && tab === 'library') ? 'settings' : tab;
}

function loadTab(): SidebarTab {
  const v = readKey(SIDEBAR_TAB_KEY);
  const tab = (ALL_TABS as string[]).includes(v ?? '') ? (v as SidebarTab) : 'library';
  return coerceTab(tab);
}

// --- Global sidebar state (for external access by Toolbar, keyboard shortcuts) ---
const autoHideAtBoot = readBool(SIDEBAR_AUTOHIDE_KEY, false);
const state = {
  // Auto-hide always boots hidden: an overlay that pops open on reload,
  // covering the board until the first click, is exactly what it exists to avoid.
  collapsed: autoHideAtBoot ? true : readBool(SIDEBAR_COLLAPSED_KEY, false),
  activeTab: loadTab(),
  side: loadSide(),
  /** Activity rail (icon column) instead of the text tab strip. */
  rail: readBool(SIDEBAR_RAIL_KEY, true),
  /** "Nothing but the board": the rail itself is hidden too. Only meaningful
   *  while `rail` is on; implies the panel is hidden as well. */
  railHidden: readBool(SIDEBAR_RAIL_HIDDEN_KEY, false),
  /** 8px captions under the rail icons. */
  captions: readBool(SIDEBAR_CAPTIONS_KEY, true),
  /** Status bar hidden. Only honoured in the rail layout, which is the only
   *  place with a control to bring it back; the legacy strip always shows it. */
  statusHidden: readBool(STATUSBAR_HIDDEN_KEY, false),
  /** Auto-hide: the panel overlays the board instead of pushing it, and any
   *  click into the board area hides it. Rail layout only. */
  autoHide: autoHideAtBoot,
};
const listeners = new Set<() => void>();

export function getCollapsed(): boolean { return state.collapsed; }
export function getActiveTabRaw(): SidebarTab { return state.activeTab; }
export function getSideRaw(): SidebarSide { return state.side; }
export function setActiveTabRaw(tab: SidebarTab): void {
  state.activeTab = coerceTab(tab);
  writeKey(SIDEBAR_TAB_KEY, state.activeTab);
}
export function emitSidebarChange(): void { listeners.forEach(fn => fn()); }

export function isSidebarCollapsed(): boolean { return state.collapsed; }
export function getSidebarActiveTab(): SidebarTab { return state.activeTab; }
export function getSidebarSide(): SidebarSide { return state.side; }
export function getSidebarRail(): boolean { return state.rail; }
export function getSidebarRailHidden(): boolean { return state.rail && state.railHidden; }
export function getSidebarCaptions(): boolean { return state.captions; }
/** Hidden by its own toggle, OR because the whole sidebar area is hidden
 *  ("nothing but the board") — the latter without touching the preference,
 *  so bringing the rail back restores whatever the foot toggle had chosen. */
export function getStatusBarHidden(): boolean { return state.rail && (state.statusHidden || state.railHidden); }
export function getSidebarAutoHide(): boolean { return state.rail && state.autoHide; }

function setCollapsed(v: boolean): void {
  state.collapsed = v;
  writeKey(SIDEBAR_COLLAPSED_KEY, String(v));
}

function setRailHidden(v: boolean): void {
  state.railHidden = v;
  writeKey(SIDEBAR_RAIL_HIDDEN_KEY, String(v));
}

function setStatusHidden(v: boolean): void {
  state.statusHidden = v;
  writeKey(STATUSBAR_HIDDEN_KEY, String(v));
}

/** Panel-level toggle: open ↔ hidden. The rail (when on) stays. Used by the
 *  keyboard shortcut and clicking the active rail icon — status bar untouched. */
export function toggleSidebar(): void {
  if (state.collapsed && state.railHidden) setRailHidden(false); // showing the panel needs the rail back
  setCollapsed(!state.collapsed);
  emitSidebarChange();
}

export function hideSidebar(): void {
  if (state.collapsed) return;
  setCollapsed(true);
  emitSidebarChange();
}

/** Status bar on its own — the small control at the foot of the rail. */
export function toggleStatusBar(): void {
  setStatusHidden(!state.statusHidden);
  emitSidebarChange();
}

export function setSidebarAutoHide(v: boolean): void {
  if (state.autoHide === v) return;
  state.autoHide = v;
  writeKey(SIDEBAR_AUTOHIDE_KEY, String(v));
  if (v && !state.collapsed) setCollapsed(true); // switch on → start from hidden, like boot
  emitSidebarChange();
}

/**
 * Area-level toggle — the edge arrow. Between "nothing but the board" (panel,
 * rail and status bar all gone) and fully back. In the legacy strip layout
 * there is no rail, so it is plain toggleSidebar and the status bar is never
 * touched. The status bar follows railHidden via getStatusBarHidden(); the
 * foot toggle's own preference is left alone.
 */
export function toggleSidebarArea(): void {
  if (!state.rail) { toggleSidebar(); return; }
  if (state.railHidden) {
    setRailHidden(false);
    setCollapsed(false);
  } else {
    setRailHidden(true);
    setCollapsed(true);
  }
  emitSidebarChange();
}

export type SidebarStage = 'open' | 'icons' | 'hidden';

export function getSidebarStage(): SidebarStage {
  if (!state.rail) return state.collapsed ? 'hidden' : 'open';
  if (state.railHidden) return 'hidden';
  return state.collapsed ? 'icons' : 'open';
}

/**
 * The toolbar ≡: cycles open → icons only → completely hidden → open.
 * Progressive: each click takes a bit more away, and the third brings it all
 * back on the tab you had. Legacy strip layout has no icons stage.
 */
export function cycleSidebar(): void {
  if (!state.rail) { toggleSidebar(); return; }
  switch (getSidebarStage()) {
    case 'open':
      setCollapsed(true);
      break;
    case 'icons':
      setRailHidden(true);
      setCollapsed(true);
      break;
    case 'hidden':
      setRailHidden(false);
      setCollapsed(false);
      break;
  }
  emitSidebarChange();
}

export function showSidebarTab(tab: SidebarTab): void {
  setActiveTabRaw(tab);
  if (state.railHidden) setRailHidden(false);
  if (state.collapsed) setCollapsed(false);
  emitSidebarChange();
}

export function flipSidebarSide(): void {
  state.side = state.side === 'left' ? 'right' : 'left';
  writeKey(SIDEBAR_SIDE_KEY, state.side);
  emitSidebarChange();
}

export function setSidebarRail(v: boolean): void {
  if (state.rail === v) return;
  state.rail = v;
  writeKey(SIDEBAR_RAIL_KEY, String(v));
  emitSidebarChange();
}

export function setSidebarCaptions(v: boolean): void {
  if (state.captions === v) return;
  state.captions = v;
  writeKey(SIDEBAR_CAPTIONS_KEY, String(v));
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
    __sidebar?: {
      isCollapsed: () => boolean;
      activeTab: () => SidebarTab;
      toggle: () => void;
      show: (tab: SidebarTab) => void;
      hide: () => void;
      rail: () => boolean;
      setRail: (v: boolean) => void;
      railHidden: () => boolean;
      toggleArea: () => void;
      statusHidden: () => boolean;
      toggleStatus: () => void;
      stage: () => SidebarStage;
      cycle: () => void;
      autoHide: () => boolean;
      setAutoHide: (v: boolean) => void;
    };
  }).__sidebar = {
    isCollapsed: isSidebarCollapsed,
    activeTab: getSidebarActiveTab,
    toggle: toggleSidebar,
    show: showSidebarTab,
    hide: hideSidebar,
    rail: getSidebarRail,
    setRail: setSidebarRail,
    railHidden: getSidebarRailHidden,
    toggleArea: toggleSidebarArea,
    statusHidden: getStatusBarHidden,
    toggleStatus: toggleStatusBar,
    stage: getSidebarStage,
    cycle: cycleSidebar,
    autoHide: getSidebarAutoHide,
    setAutoHide: setSidebarAutoHide,
  };
}
