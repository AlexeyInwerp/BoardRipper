import { createStoreHook } from './createStoreHook';
import {
  onSidebarChange,
  getCollapsed,
  getActiveTabRaw,
  getSideRaw,
  getSidebarRail,
  getSidebarRailHidden,
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
  /** Rail layout with the rail itself hidden ("nothing but the board"). */
  railHidden: boolean;
  captions: boolean;
  /** Status bar hidden (rail layout only). */
  statusHidden: boolean;
  /** Panel overlays the board and hides on any click into it (rail layout only). */
  autoHide: boolean;
  /** open → icons → hidden, what the toolbar ≡ cycles through. */
  stage: SidebarStage;
}

/**
 * Reactive view of the sidebar's module state for components that need to
 * re-render when it changes (ActivityRail, Toolbar, App). Sidebar.tsx still
 * uses its original forceUpdate subscription; both read the same source.
 */
export const useSidebarState = createStoreHook<SidebarSnapshot>(
  { subscribe: onSidebarChange },
  () => ({
    collapsed: getCollapsed(),
    activeTab: getActiveTabRaw(),
    side: getSideRaw(),
    rail: getSidebarRail(),
    railHidden: getSidebarRailHidden(),
    captions: getSidebarCaptions(),
    statusHidden: getStatusBarHidden(),
    autoHide: getSidebarAutoHide(),
    stage: getSidebarStage(),
  }),
);
