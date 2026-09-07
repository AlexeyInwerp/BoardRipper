/**
 * Settings ▸ Theme ▸ "Sidebar navigation" — switches between the activity
 * rail (icon column) and the legacy text tab strip. Both read the same
 * Sidebar.utils.ts state, so flipping this loses nothing: the open tab,
 * hidden/open state, side and width all carry over.
 */
import { useSidebarState } from '../hooks/useSidebarState';
import { setSidebarRail, setSidebarCaptions } from './Sidebar.utils';

export function SidebarNavSwitch() {
  const { rail, captions } = useSidebarState();
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
      {rail && (
        <label className="settings-row settings-toggle-row" style={{ cursor: 'pointer' }}>
          <span className="settings-label">Captions under icons</span>
          <input
            type="checkbox"
            checked={captions}
            onChange={(e) => setSidebarCaptions(e.target.checked)}
            data-testid="sidebar-nav-captions"
          />
        </label>
      )}
      <p className="settings-hint" style={{ margin: '4px 0 0' }}>
        {rail
          ? 'Click a rail icon to open it; click the active one to hide the sidebar. Right-click the rail for more.'
          : 'The original tab strip inside the sidebar, with the ≡ toolbar button and the edge arrow to show or hide it.'}
      </p>
    </div>
  );
}
