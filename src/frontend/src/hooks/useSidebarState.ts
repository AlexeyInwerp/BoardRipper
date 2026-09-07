import { createStoreHook } from './createStoreHook';
import {
  onSidebarChange,
  getCollapsed,
  getActiveTabRaw,
  getSideRaw,
  getSidebarRail,
  getSidebarCaptions,
  type SidebarTab,
  type SidebarSide,
} from '../components/Sidebar.utils';

export interface SidebarSnapshot {
  collapsed: boolean;
  activeTab: SidebarTab;
  side: SidebarSide;
  rail: boolean;
  captions: boolean;
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
    captions: getSidebarCaptions(),
  }),
);
