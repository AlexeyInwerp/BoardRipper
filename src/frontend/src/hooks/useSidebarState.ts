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
  type SidebarTab,
  type SidebarSide,
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
  }),
);
