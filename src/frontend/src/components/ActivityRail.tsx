/**
 * Activity rail — the 46px icon column that replaces the sidebar's text tab
 * strip. A second VIEW over the module state in Sidebar.utils.ts; it owns no
 * state of its own beyond the transient context menu.
 *
 * Gesture: click a destination to show it; click the active one to hide the
 * sidebar. The rail itself never hides, so the destinations are always legible.
 * Spec: docs/specs/2026-09-02-activity-rail-design.md.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconBooks, IconCalculator, IconBug, IconSettings } from '@tabler/icons-react';
import type { Icon } from '@tabler/icons-react';
import {
  SIDEBAR_GROUPS,
  TABS,
  showSidebarTab,
  toggleSidebar,
  flipSidebarSide,
  setSidebarCaptions,
  type SidebarTab,
} from './Sidebar.utils';
import { useSidebarState } from '../hooks/useSidebarState';
import { useRailBadges, type RailBadge } from '../hooks/useRailBadges';

const ICONS: Record<SidebarTab, Icon> = {
  library: IconBooks,
  tools: IconCalculator,
  debug: IconBug,
  settings: IconSettings,
};

const LABELS: Record<SidebarTab, string> = Object.fromEntries(
  TABS.map(t => [t.id, t.label]),
) as Record<SidebarTab, string>;

interface MenuPos { x: number; y: number }

export function ActivityRail() {
  const { collapsed, activeTab, side, captions } = useSidebarState();
  const badges = useRailBadges();
  const [menu, setMenu] = useState<MenuPos | null>(null);
  const railRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // Menu dismissal: outside pointerdown, Escape, viewport resize.
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu, closeMenu]);

  // Keep the menu inside the viewport once it has a size.
  useEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current;
    const r = el.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - r.width - 4);
    const y = Math.min(menu.y, window.innerHeight - r.height - 4);
    el.style.left = `${Math.max(4, x)}px`;
    el.style.top = `${Math.max(4, y)}px`;
  }, [menu]);

  const renderItem = (id: SidebarTab) => {
    const Ico = ICONS[id];
    const label = LABELS[id];
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
      </nav>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="activity-rail-menu"
          role="menu"
          aria-label="Sidebar options"
          data-testid="activity-rail-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <button type="button" role="menuitem" onClick={() => { flipSidebarSide(); closeMenu(); }}>
            <span className="activity-rail-menu-tick" />
            {side === 'left' ? 'Move sidebar to right' : 'Move sidebar to left'}
          </button>
          <button type="button" role="menuitemcheckbox" aria-checked={captions}
            onClick={() => { setSidebarCaptions(!captions); closeMenu(); }}>
            <span className="activity-rail-menu-tick">{captions ? '✓' : ''}</span>
            Show captions
          </button>
          <button type="button" role="menuitem" onClick={() => { toggleSidebar(); closeMenu(); }}>
            <span className="activity-rail-menu-tick" />
            {collapsed ? `Show ${LABELS[activeTab]}` : 'Hide sidebar'}
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
