import { useEffect, useRef, useState } from 'react';
import { fmtVersion } from '../store/update-store';
import { ReleaseNotes } from './ReleaseNotes';

/** The desktop app's version badge. Same look as the Docker build's
 *  UpdateBadge, but the state comes from the Electron main process
 *  (desktop/updater.js over window.electronAPI.updates): check a signed feed,
 *  download and verify this build's zip, swap it in when the app quits. */

function useDesktopUpdateState(): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    const api = window.electronAPI?.updates;
    if (!api) return;
    let live = true;
    void api.getState().then(s => { if (live) setState(s); });
    const off = api.onState(s => setState(s));
    return () => { live = false; off(); };
  }, []);
  return state;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

export function DesktopUpdateBadge() {
  const state = useDesktopUpdateState();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const api = window.electronAPI?.updates;
  if (!api || !state || !state.enabled) return null;

  const { phase, latest, progress } = state;
  const offered = phase === 'available' || phase === 'downloading' || phase === 'staging' || phase === 'ready' || phase === 'manual';
  const busy = phase === 'downloading' || phase === 'staging';
  // A skipped version stays in the dropdown but no longer draws attention.
  const highlight = offered && !(phase === 'available' && state.skipped === latest?.version);
  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : 0;
  const latestV = fmtVersion(latest?.version);

  const badgeText = busy
    ? (phase === 'staging' ? 'Preparing…' : `${pct}%`)
    : phase === 'ready' ? 'Restart' : null;

  const title = phase === 'ready'
    ? `${latestV} is ready — restart to install`
    : busy ? `Downloading ${latestV}`
    : highlight ? `Update available: ${latestV}`
    : `${fmtVersion(state.current)} — click to check`;

  return (
    <div className="update-badge-wrap" ref={ref}>
      <button
        data-testid="update-badge"
        data-update-phase={phase}
        className={`toolbar-btn toolbar-update-badge${highlight ? ' has-update' : ''}${busy ? ' is-updating' : ''}`}
        onClick={() => {
          if (!open && (phase === 'idle' || phase === 'error')) void api.check();
          setOpen(v => !v);
        }}
        title={title}
      >
        {badgeText !== null
          ? <span>{badgeText}</span>
          : highlight
            ? (
              <span className="update-badge-swap" aria-hidden="true">
                <span className="swap-version">{latestV}</span>
                <span className="swap-word">Update</span>
              </span>
            )
            : <span>{fmtVersion(state.current)}</span>}
      </button>

      {open && (
        <div className="update-dropdown" data-testid="update-dropdown">
          <div className="update-dropdown-header">
            <div className="update-dropdown-header-main">
              <span>{offered ? (phase === 'ready' ? 'Update ready' : 'Update available') : fmtVersion(state.current)}</span>
              {offered && <span className="update-dropdown-version-tag">{latestV}</span>}
            </div>
            <button className="update-dropdown-close" onClick={() => setOpen(false)}>x</button>
          </div>

          {offered && latest?.notes && (
            <details className="update-dropdown-notes" data-testid="update-whats-new">
              <summary>{`What's new in ${latestV}`}</summary>
              <div className="update-dropdown-body">
                <ReleaseNotes notes={latest.notes} />
              </div>
            </details>
          )}

          {phase === 'checking' && (
            <div className="update-dropdown-body"><p>Checking for updates…</p></div>
          )}
          {phase === 'idle' && (
            <div className="update-dropdown-body"><p>You are on the latest version.</p></div>
          )}
          {phase === 'error' && (
            <div className="update-dropdown-body" data-testid="update-error">
              <p>The last update attempt failed.</p>
              <p className="update-progress-error">{state.error}</p>
            </div>
          )}
          {busy && (
            <div className="update-dropdown-body" data-testid="update-progress">
              <p>{phase === 'staging' ? 'Verifying and unpacking…' : `Downloading ${latestV}…`}</p>
              <div className="update-dropdown-meter"><div style={{ width: `${phase === 'staging' ? 100 : pct}%` }} /></div>
              {progress && phase === 'downloading' && (
                <p className="update-dropdown-version">{`${fmtMB(progress.received)} of ${fmtMB(progress.total)}`}</p>
              )}
            </div>
          )}
          {phase === 'ready' && (
            <div className="update-dropdown-body">
              <p>Downloaded and verified. It installs when BoardRipper quits; restart now to use it.</p>
            </div>
          )}
          {phase === 'manual' && (
            <div className="update-dropdown-body" data-testid="update-manual">
              <p>{`Downloaded and verified, but it cannot be installed automatically because ${state.manualReason}.`}</p>
              <p>Replace the app with the one in the downloaded zip.</p>
            </div>
          )}

          <div className="update-dropdown-actions">
            {phase === 'available' && (
              <button className="update-dropdown-btn" data-testid="update-install" onClick={() => void api.install()}>
                Download &amp; Install
              </button>
            )}
            {phase === 'ready' && (
              <button className="update-dropdown-btn" data-testid="update-restart" onClick={() => void api.restart()}>
                Restart Now
              </button>
            )}
            {phase === 'manual' && (
              <button className="update-dropdown-btn" onClick={() => void api.reveal()}>
                Show Download
              </button>
            )}
            {phase === 'error' && (
              <button className="update-dropdown-btn" onClick={() => void api.check()}>
                Check Again
              </button>
            )}
            <div className="update-dropdown-actions-right">
              {offered && latest?.notes_url && (
                <a
                  className="update-dropdown-notes-link"
                  href={latest.notes_url}
                  onClick={(e) => { e.preventDefault(); void api.openNotes(); }}
                >
                  Release notes ↗
                </a>
              )}
              {phase === 'available' && state.skipped !== latest?.version && (
                <a
                  className="update-dropdown-notes-link"
                  href="#"
                  data-testid="update-skip"
                  onClick={(e) => { e.preventDefault(); void api.skip(); }}
                >
                  Skip this version
                </a>
              )}
              <span className="update-dropdown-version">
                {offered ? `${fmtVersion(state.current)} \u2192 ${latestV}` : fmtVersion(state.current)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
