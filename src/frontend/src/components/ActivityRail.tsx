/**
 * Activity rail — the 46px icon column that replaces the sidebar's text tab
 * strip. A second VIEW over the module state in Sidebar.utils.ts; it owns no
 * state of its own beyond the transient context menu.
 *
 * Gesture: click a destination to show it; click the active one to hide the
 * sidebar. The rail itself never hides, so the destinations are always legible.
 * Spec: docs/specs/2026-09-02-activity-rail-design.md.
 */
import { useCallback, useRef, useState } from 'react';
import { IconLayoutBottombar, IconPin, IconPinnedOff } from '@tabler/icons-react';
import {
  SIDEBAR_GROUPS,
  TAB_LABELS,
  showSidebarTab,
  toggleSidebar,
  toggleStatusBar,
  flipSidebarSide,
  setSidebarCaptions,
  setSidebarAutoHide,
  type SidebarTab,
  type SidebarTabDef,
} from './Sidebar.utils';
import { useSidebarState } from '../hooks/useSidebarState';
import { useRailBadges, type RailBadge } from '../hooks/useRailBadges';
import { QuickMenu } from './QuickMenu';

interface MenuPos { x: number; y: number }

export function ActivityRail() {
  const { collapsed, activeTab, side, captions, statusHidden, autoHide } = useSidebarState();
  const badges = useRailBadges();
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const railRef = useRef<HTMLElement>(null);

  const closeMenu = useCallback(() => setMenu(null), []);

  const onItemClick = useCallback((id: SidebarTab) => {
    if (id === activeTab && !collapsed) toggleSidebar();
    else showSidebarTab(id);
    closeMenu();
  }, [activeTab, collapsed, closeMenu]);

  // Roving tabindex along the rail.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    const rail = railRef.current;
    if (!rail) return;
    const buttons = Array.from(rail.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next: HTMLButtonElement | undefined;
    if (e.key === 'ArrowDown') next = buttons[(i + 1) % buttons.length];
    else if (e.key === 'ArrowUp') next = buttons[(i - 1 + buttons.length) % buttons.length];
    else if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    if (!next) return;
    e.preventDefault();
    next.focus();
  }, []);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const renderItem = ({ id, label, icon: Ico }: SidebarTabDef) => {
    const active = id === activeTab;
    const badge: RailBadge | undefined = badges[id];
    const title = active
      ? (collapsed ? `${label} · click to show` : `${label} · click to hide`)
      : label;
    return (
      <button
        key={id}
        type="button"
        role="tab"
        className={`activity-rail-item${active ? ' active' : ''}`}
        aria-selected={active}
        aria-label={label}
        data-sidebar-tab={id}
        data-title={title}
        tabIndex={active ? 0 : -1}
        onClick={() => onItemClick(id)}
      >
        <span className="activity-rail-ico">
          <Ico size={20} stroke={1.75} />
          {badge && (
            <span
              className={`activity-rail-badge ${badge.kind}${badge.count == null ? ' dot' : ''}`}
              title={badge.title}
              data-testid={`rail-badge-${id}`}
            >
              {badge.count != null ? (badge.count > 9 ? '9+' : badge.count) : null}
            </span>
          )}
        </span>
        {captions && <span className="activity-rail-cap">{label}</span>}
      </button>
    );
  };

  return (
    <>
      <nav
        ref={railRef}
        className={`activity-rail activity-rail-${side}${captions ? '' : ' activity-rail-nocap'}`}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Sidebar"
        data-testid="activity-rail"
        data-collapsed={collapsed ? 'true' : 'false'}
        style={{ order: side === 'left' ? -1 : 3 }}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
      >
        {SIDEBAR_GROUPS.top.map(renderItem)}
        <div className="activity-rail-spacer" />
        {SIDEBAR_GROUPS.bottom.map(renderItem)}
        {/* Auto-hide switch — a pin, because that is what the mode is about:
            pinned, the panel sits in the layout; unpinned, it floats over the
            board and leaves when you click into it. It was reachable only from
            the right-click menu, which is not where anyone finds a mode. Lit
            while auto-hide is on, like the status toggle below it. */}
        <button
          type="button"
          className={`activity-rail-item activity-rail-foot${autoHide ? ' on' : ''}`}
          aria-label={autoHide ? 'Keep the panel pinned open' : 'Auto-hide the panel'}
          aria-pressed={autoHide}
          data-title={autoHide ? 'Keep panel open' : 'Auto-hide panel'}
          data-testid="rail-autohide-toggle"
          onClick={() => { setSidebarAutoHide(!autoHide); closeMenu(); }}
        >
          {autoHide ? <IconPinnedOff size={15} stroke={1.75} /> : <IconPin size={15} stroke={1.75} />}
        </button>
        {/* Status bar toggle — small, at the very foot, lit while the bar is
            showing. The glyph is a window with a bottom bar: the thing it
            toggles. (Hiding the PANEL needs no button of its own: clicking the
            active destination does it. The toolbar ≡ clears everything.) */}
        <button
          type="button"
          className={`activity-rail-item activity-rail-status${statusHidden ? '' : ' on'}`}
          aria-label={statusHidden ? 'Show status bar' : 'Hide status bar'}
          aria-pressed={!statusHidden}
          data-title={statusHidden ? 'Show status bar' : 'Hide status bar'}
          data-testid="rail-status-toggle"
          onClick={() => { toggleStatusBar(); closeMenu(); }}
        >
          <IconLayoutBottombar size={15} stroke={1.75} />
        </button>
      </nav>
      {menu && (
        <QuickMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          ariaLabel="Sidebar options"
          testId="activity-rail-menu"
          items={[
            { label: side === 'left' ? 'Move sidebar to right' : 'Move sidebar to left', onSelect: flipSidebarSide },
            { kind: 'check', label: 'Show captions', checked: captions, onSelect: () => setSidebarCaptions(!captions) },
            { kind: 'check', label: 'Auto-hide sidebar', checked: autoHide, testId: 'rail-menu-autohide',
              hint: 'The panel opens over the board instead of pushing it, and hides again when you click into the board',
              onSelect: () => setSidebarAutoHide(!autoHide) },
            { label: collapsed ? `Show ${TAB_LABELS[activeTab]}` : 'Hide sidebar', onSelect: toggleSidebar },
          ]}
        />
      )}
    </>
  );
}
