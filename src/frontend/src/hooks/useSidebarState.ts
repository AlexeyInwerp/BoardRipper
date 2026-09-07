import { createStoreHook } from './createStoreHook';
import {
  onSidebarChange,
  getCollapsed,
  getActiveTabRaw,
  getSideRaw,
  getSidebarRail,
  getSidebarCaptions,
  getStatusBarHidden,
  getSidebarAutoHide,
  getSidebarStage,
  type SidebarTab,
  type SidebarSide,
  type SidebarStage,
} from '../components/Sidebar.utils';

export interface SidebarSnapshot {
  collapsed: boolean;
  activeTab: SidebarTab;
  side: SidebarSide;
  rail: boolean;
  captions: boolean;
  /** Status bar hidden (rail layout only). */
  statusHidden: boolean;
  /** Panel overlays the board and hides on any click into it (rail layout only). */
  autoHide: boolean;
  /** open → icons → hidden, what the toolbar ≡ cycles through. */
  stage: SidebarStage;
}

/**
 * Reactive view of the sidebar's module state — the one subscription path for
 * every component that renders it (App, Sidebar, ActivityRail, the toolbar's
 * cycle button, the Settings switch, the rail badges).
 */
export const useSidebarState = createStoreHook<SidebarSnapshot>(
  { subscribe: onSidebarChange },
  () => ({
    collapsed: getCollapsed(),
    activeTab: getActiveTabRaw(),
    side: getSideRaw(),
    rail: getSidebarRail(),
    captions: getSidebarCaptions(),
    statusHidden: getStatusBarHidden(),
    autoHide: getSidebarAutoHide(),
    stage: getSidebarStage(),
  }),
);
