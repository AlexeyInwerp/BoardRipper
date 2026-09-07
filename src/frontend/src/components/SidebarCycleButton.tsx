/**
 * Toolbar sidebar button: cycles open → icons only → completely hidden
 * (nothing but the board, status bar included) → open again on the tab you
 * had. The glyph is the sidebar-collapse icon, flipped to "expand" when the
 * next click brings things back. In the legacy strip layout it toggles the
 * panel as it always did.
 *
 * Its own component so the 700-line Toolbar does not subscribe to sidebar
 * state for the sake of one button.
 */
import {
  IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand,
} from '@tabler/icons-react';
import { cycleSidebar, TAB_LABELS } from './Sidebar.utils';
import { useSidebarState } from '../hooks/useSidebarState';

export function SidebarCycleButton() {
  const { rail, side, stage, activeTab } = useSidebarState();
  const willExpand = stage === 'hidden';
  const Ico = side === 'left'
    ? (willExpand ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse)
    : (willExpand ? IconLayoutSidebarRightExpand : IconLayoutSidebarRightCollapse);
  const tip = !rail
    ? 'Toggle Library / Settings panel'
    : stage === 'open' ? 'Sidebar → icons only'
    : stage === 'icons' ? 'Sidebar → hide completely (nothing but the board)'
    : `Sidebar → show ${TAB_LABELS[activeTab]}`;
  return (
    <button
      onClick={cycleSidebar}
      className="toolbar-btn toolbar-btn-icon"
      data-testid="sidebar-area-toggle"
      data-sidebar-stage={stage}
      data-tooltip={tip}
      aria-label={tip}
    >
      <Ico size={17} stroke={1.75} />
    </button>
  );
}
