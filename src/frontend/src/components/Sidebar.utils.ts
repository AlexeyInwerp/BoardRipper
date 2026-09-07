/**
 * Sidebar state, persistence, and external API.
 *
 * This file is the non-component sibling of `Sidebar.tsx`. The Sidebar
 * component, the ActivityRail, the toolbar's cycle button and App all read
 * this module state (through `useSidebarState`); Toolbar, keyboard shortcuts,
 * ContextMenu, etc. mutate it through the named function exports.
 *
 * Layout is a three-stage machine — open → icons → hidden — and every mutator
 * goes through `setStage`, which is the only place that writes the
 * `collapsed` / `railHidden` pair. That keeps the one invariant the UI cannot
 * render without (railHidden ⇒ collapsed) in a single function.
 * See docs/plans/2026-09-07-activity-rail.md ▸ Show / hide model.
 *
 * Split out to satisfy `react-refresh/only-export-components` — Vite Fast
 * Refresh can only HMR a file whose only exports are React components.
 */

import { IconBooks, IconCalculator, IconBug, IconSettings } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
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
export type SidebarStage = 'open' | 'icons' | 'hidden';

export interface SidebarTabDef {
  id: SidebarTab;
  label: string;
  icon: Icon;
  /** Rail grouping: top = where you work, bottom = where you check and configure. */
  group: 'top' | 'bottom';
}

/** The one registry of destinations. Label, icon and rail group live together
 *  so adding a tab is one entry; the lite build simply has no Library. */
export const TABS: readonly SidebarTabDef[] = ([
  { id: 'library',  label: 'Library',  icon: IconBooks,      group: 'top' },
  { id: 'tools',    label: 'Tools',    icon: IconCalculator, group: 'top' },
  { id: 'debug',    label: 'Debug',    icon: IconBug,        group: 'bottom' },
  { id: 'settings', label: 'Settings', icon: IconSettings,   group: 'bottom' },
] as SidebarTabDef[]).filter(t => !(isLiteBuild() && t.id === 'library'));

export const TAB_LABELS: Readonly<Record<SidebarTab, string>> = Object.fromEntries(
  TABS.map(t => [t.id, t.label]),
) as Record<SidebarTab, string>;

export const SIDEBAR_GROUPS: { top: readonly SidebarTabDef[]; bottom: readonly SidebarTabDef[] } = {
  top: TABS.filter(t => t.group === 'top'),
  bottom: TABS.filter(t => t.group === 'bottom'),
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
  return coerceTab(TABS.find(t => t.id === v)?.id ?? 'library');
}

// ---- boot defaults -----------------------------------------------------------

// On a tablet the lite build's 320px sidebar covered most of an 834px board
// while the board sidebar (Info / Layers) started collapsed (measured
// 2026-09-04). Start it closed on a touch device when nothing is persisted;
// the toolbar's sidebar button is one tap away.
const COARSE_POINTER = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

const railAtBoot = readBool(SIDEBAR_RAIL_KEY, true);
const autoHideAtBoot = readBool(SIDEBAR_AUTOHIDE_KEY, false);

function bootCollapsed(): boolean {
  // Auto-hide (rail layout only) always boots hidden: an overlay that pops
  // open on reload, covering the board until the first click, is exactly what
  // it exists to avoid.
  if (railAtBoot && autoHideAtBoot) return true;
  return readBool(SIDEBAR_COLLAPSED_KEY, isLiteBuild() && COARSE_POINTER);
}

// --- Global sidebar state (for external access by Toolbar, keyboard shortcuts) ---
const state = {
  collapsed: bootCollapsed(),
  activeTab: loadTab(),
  side: loadSide(),
  /** Activity rail (icon column) instead of the text tab strip. */
  rail: railAtBoot,
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

// ---- reads -------------------------------------------------------------------

export function getCollapsed(): boolean { return state.collapsed; }
export function getActiveTabRaw(): SidebarTab { return state.activeTab; }
export function getSideRaw(): SidebarSide { return state.side; }
export function isSidebarCollapsed(): boolean { return state.collapsed; }
export function getSidebarActiveTab(): SidebarTab { return state.activeTab; }
export function getSidebarSide(): SidebarSide { return state.side; }
export function getSidebarRail(): boolean { return state.rail; }
export function getSidebarCaptions(): boolean { return state.captions; }
export function getSidebarAutoHide(): boolean { return state.rail && state.autoHide; }

export function getSidebarStage(): SidebarStage {
  if (!state.rail) return state.collapsed ? 'hidden' : 'open';
  if (state.railHidden) return 'hidden';
  return state.collapsed ? 'icons' : 'open';
}

/** Hidden by its own toggle, OR because the whole sidebar area is hidden
 *  ("nothing but the board") — the latter without touching the preference,
 *  so bringing the rail back restores whatever the foot toggle had chosen. */
export function getStatusBarHidden(): boolean {
  return state.rail && (state.statusHidden || getSidebarStage() === 'hidden');
}

export function getSidebarWidth(): number {
  return state.collapsed ? 0 : loadWidth();
}

export function emitSidebarChange(): void { listeners.forEach(fn => fn()); }

export function onSidebarChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// ---- writes ------------------------------------------------------------------

export function setActiveTabRaw(tab: SidebarTab): void {
  state.activeTab = coerceTab(tab);
  writeKey(SIDEBAR_TAB_KEY, state.activeTab);
}

/** The single writer of the collapsed / railHidden pair. The legacy strip
 *  layout has no icons stage, so 'icons' means 'hidden' there. */
function setStage(stage: SidebarStage): void {
  if (!state.rail && stage === 'icons') stage = 'hidden';
  state.railHidden = stage === 'hidden';
  state.collapsed = stage !== 'open';
  writeKey(SIDEBAR_RAIL_HIDDEN_KEY, String(state.railHidden));
  writeKey(SIDEBAR_COLLAPSED_KEY, String(state.collapsed));
}

const NEXT_STAGE: Record<SidebarStage, SidebarStage> = { open: 'icons', icons: 'hidden', hidden: 'open' };

/** Panel-level toggle — clicking the active rail icon, the keyboard shortcut.
 *  open ↔ icons (rail stays); from fully hidden it goes straight to open. */
export function toggleSidebar(): void {
  setStage(getSidebarStage() === 'open' ? 'icons' : 'open');
  emitSidebarChange();
}

/** Hide the panel if it is open; never changes an already-hidden layout. */
export function hideSidebar(): void {
  if (getSidebarStage() !== 'open') return;
  setStage('icons');
  emitSidebarChange();
}

/** The toolbar sidebar button and the edge arrow: open → icons → hidden → open.
 *  Progressive — each click takes a bit more away, the third brings it all
 *  back on the tab you had. In the legacy layout it is open ↔ hidden. */
export function cycleSidebar(): void {
  setStage(NEXT_STAGE[getSidebarStage()]);
  emitSidebarChange();
}

export function showSidebarTab(tab: SidebarTab): void {
  setActiveTabRaw(tab);
  setStage('open');
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
  // A rail turned back on should not come back invisible because a stale
  // "nothing but the board" flag survived a spell in the legacy layout.
  if (v && state.railHidden) setStage('icons');
  emitSidebarChange();
}

export function setSidebarCaptions(v: boolean): void {
  if (state.captions === v) return;
  state.captions = v;
  writeKey(SIDEBAR_CAPTIONS_KEY, String(v));
  emitSidebarChange();
}

/** Status bar on its own — the small control at the foot of the rail. */
export function toggleStatusBar(): void {
  state.statusHidden = !state.statusHidden;
  writeKey(STATUSBAR_HIDDEN_KEY, String(state.statusHidden));
  emitSidebarChange();
}

export function setSidebarAutoHide(v: boolean): void {
  if (state.autoHide === v) return;
  state.autoHide = v;
  writeKey(SIDEBAR_AUTOHIDE_KEY, String(v));
  if (v && getSidebarStage() === 'open') setStage('icons'); // switch on → start from hidden, like boot
  emitSidebarChange();
}

export function toggleLibrarySidebar(): void {
  // Pure toggle:
  //   hidden (any stage)                 → open with library tab
  //   open on a non-library tab          → switch to library tab
  //   open on library tab                → hide the panel
  // Lite build has no library tab — degrade to a plain sidebar toggle.
  if (isLiteBuild()) { toggleSidebar(); return; }
  if (getSidebarStage() !== 'open' || state.activeTab !== 'library') {
    showSidebarTab('library');
  } else {
    toggleSidebar();
  }
}

if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as {
    __sidebar?: {
      isCollapsed: () => boolean;
      activeTab: () => SidebarTab;
      stage: () => SidebarStage;
      toggle: () => void;
      cycle: () => void;
      show: (tab: SidebarTab) => void;
      hide: () => void;
      rail: () => boolean;
      setRail: (v: boolean) => void;
      statusHidden: () => boolean;
      toggleStatus: () => void;
      autoHide: () => boolean;
      setAutoHide: (v: boolean) => void;
    };
  }).__sidebar = {
    isCollapsed: isSidebarCollapsed,
    activeTab: getSidebarActiveTab,
    stage: getSidebarStage,
    toggle: toggleSidebar,
    cycle: cycleSidebar,
    show: showSidebarTab,
    hide: hideSidebar,
    rail: getSidebarRail,
    setRail: setSidebarRail,
    statusHidden: getStatusBarHidden,
    toggleStatus: toggleStatusBar,
    autoHide: getSidebarAutoHide,
    setAutoHide: setSidebarAutoHide,
  };
}
