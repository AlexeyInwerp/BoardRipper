/**
 * Settings ▸ Theme ▸ "Sidebar navigation" — switches between the activity
 * rail (icon column) and the legacy text tab strip, and exposes the rail's
 * options (side, captions, auto-hide). The rail's right-click menu offers the
 * same options, but touch browsers never fire contextmenu, so this is the
 * tap-reachable home for them. Both read the same Sidebar.utils.ts state, so
 * flipping the layout loses nothing: the open tab, hidden/open state, side
 * and width all carry over.
 */
import { useSidebarState } from '../hooks/useSidebarState';
import { setSidebarRail, setSidebarCaptions, setSidebarAutoHide, flipSidebarSide } from './Sidebar.utils';

export function SidebarNavSwitch() {
  const { rail, captions, autoHide, side } = useSidebarState();
  return (
    <div data-testid="sidebar-nav-switch">
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <button
          type="button"
          className={`library-tab ${rail ? 'active' : ''}`}
          data-testid="sidebar-nav-rail"
          onClick={() => setSidebarRail(true)}
        >
          Icon rail
        </button>
        <button
          type="button"
          className={`library-tab ${!rail ? 'active' : ''}`}
          data-testid="sidebar-nav-strip"
          onClick={() => setSidebarRail(false)}
        >
          Text tabs
        </button>
      </div>

      <div className="settings-row settings-toggle-row" style={{ alignItems: 'center' }}>
        <span className="settings-label">Side</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className={`library-tab ${side === 'left' ? 'active' : ''}`}
            data-testid="sidebar-nav-side-left"
            onClick={() => { if (side !== 'left') flipSidebarSide(); }}>Left</button>
          <button type="button" className={`library-tab ${side === 'right' ? 'active' : ''}`}
            data-testid="sidebar-nav-side-right"
            onClick={() => { if (side !== 'right') flipSidebarSide(); }}>Right</button>
        </div>
      </div>

      {rail && (
        <>
          <label className="settings-row settings-toggle-row" style={{ cursor: 'pointer' }}>
            <span className="settings-label">Captions under icons</span>
            <input
              type="checkbox"
              checked={captions}
              onChange={(e) => setSidebarCaptions(e.target.checked)}
              data-testid="sidebar-nav-captions"
            />
          </label>
          <label className="settings-row settings-toggle-row" style={{ cursor: 'pointer' }}
            title="The panel opens over the board instead of pushing it, and hides again when you click into the board">
            <span className="settings-label">Auto-hide</span>
            <input
              type="checkbox"
              checked={autoHide}
              onChange={(e) => setSidebarAutoHide(e.target.checked)}
              data-testid="sidebar-nav-autohide"
            />
          </label>
        </>
      )}
      <p className="settings-hint" style={{ margin: '4px 0 0' }}>
        {rail
          ? 'Click a rail icon to open it; click the active one to hide the sidebar. The toolbar button cycles icons only → hidden → open. Right-click the rail for the same options.'
          : 'The original tab strip inside the sidebar, with the toolbar button and the edge arrow to show or hide it.'}
      </p>
    </div>
  );
}
