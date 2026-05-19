/**
 * Database Contributions section — embedded into the Settings → Library tab.
 *
 * Surfaces the contribdb backend state and lets the user manually trigger
 * sync, copy their install token, and link/unlink a personal token issued by
 * ripperdoc.de. Polls /api/contribdb/status every 30s while mounted.
 */

import { useEffect, useState } from 'react';
import {
  contribdbStore,
  useContribDBStatus,
  useContribDBUserToken,
} from '../../store/contribdb-store';

// ---- Helpers (kept local — mirror LibrarySyncSection idioms) ---------------

function fmtRelative(iso?: string): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const now = Date.now();
  const diff = now - t;
  if (diff < 0) return new Date(t).toLocaleString();
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// ---- Public component ------------------------------------------------------

export function ContribDBSection() {
  const status = useContribDBStatus();
  const { linked, handle, installToken, syncing } = useContribDBUserToken();

  // Mount lifecycle: start refcounted polling + lazy-load user/install token
  // info on first render. Status is driven by the poll started here.
  useEffect(() => {
    contribdbStore.startPolling(30_000);
    void contribdbStore.refreshUserToken();
    return () => { contribdbStore.stopPolling(); };
  }, []);

  const [errorsOpen, setErrorsOpen] = useState(false);
  const [copyHint, setCopyHint] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const onCopyInstallToken = async () => {
    if (!installToken) return;
    try {
      await navigator.clipboard.writeText(installToken);
      setCopyHint('Copied');
    } catch {
      setCopyHint('Copy failed — select manually');
    }
    setTimeout(() => setCopyHint(null), 1500);
  };

  const onLink = async () => {
    if (!tokenInput.trim()) return;
    setTokenBusy(true);
    setTokenError(null);
    const r = await contribdbStore.setUserToken(tokenInput.trim());
    setTokenBusy(false);
    if (r.ok) setTokenInput('');
    else setTokenError(r.error ?? 'Failed to link token');
  };

  const onForget = async () => {
    setTokenBusy(true);
    setTokenError(null);
    const r = await contribdbStore.setUserToken('');
    setTokenBusy(false);
    if (!r.ok) setTokenError(r.error ?? 'Failed to remove token');
  };

  if (!status.enabled) {
    return (
      <div className="settings-section">
        <div className="settings-section-body">
          <h3 style={{ margin: '0 0 8px' }}>Database Contributions</h3>
          <div className="color-rule-hint">
            Contribution service is disabled or unavailable. Configure
            <code style={{ marginLeft: 4 }}>contribdb</code> on the backend to
            enable.
          </div>
        </div>
      </div>
    );
  }

  const recentErrors = status.recent_errors ?? [];
  const failedColor = status.outbox_failed > 0 ? '#c33' : '#888';

  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 4px' }}>Database Contributions</h3>
        <p style={{ fontSize: 12, color: '#888', lineHeight: 1.4, margin: '0 0 12px' }}>
          Help correct and grow the reference database. Edits you make in the
          Database Editor are queued locally, reviewed by a moderator, then
          merged into the shared snapshot. Anonymous by default — link a
          personal token below if you want attribution.
        </p>

        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          <div>
            <span style={{ color: '#888' }}>Connected to </span>
            <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{status.base_url || '—'}</code>
            <span style={{ color: '#888' }}> · Registered: </span>
            <span style={{ color: status.registered ? '#393' : '#c80' }}>
              {status.registered ? 'yes' : 'no'}
            </span>
            <span style={{ color: '#888' }}> · Snapshot counter: </span>
            <code style={{ fontFamily: 'var(--font-mono, monospace)' }}>{status.snapshot_counter}</code>
          </div>
          <div>
            <span style={{ color: '#888' }}>Last sync: </span>
            <span>{fmtRelative(status.last_sync_at)}</span>
            {status.last_sync_error && (
              <span style={{ marginLeft: 8, color: '#c33' }}>· {status.last_sync_error}</span>
            )}
          </div>
          <div>
            <span style={{ color: '#888' }}>Outbox: </span>
            <span>{status.outbox_pending} pending</span>
            <span style={{ color: '#888' }}> · </span>
            <span style={{ color: failedColor, fontWeight: status.outbox_failed > 0 ? 600 : 400 }}>
              {status.outbox_failed} failed
            </span>
          </div>
        </div>

        {/* Recent errors (collapsible) */}
        {recentErrors.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => setErrorsOpen(o => !o)}
              style={{
                background: 'none',
                border: 'none',
                color: '#c33',
                padding: 0,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              {errorsOpen ? '▾' : '▸'} {recentErrors.length} recent error{recentErrors.length === 1 ? '' : 's'}
            </button>
            {errorsOpen && (
              <ul style={{
                margin: '6px 0 0',
                padding: 0,
                listStyle: 'none',
                background: 'var(--bg-primary, #0a0a0a)',
                border: '1px solid var(--border-color, #333)',
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 11,
                maxHeight: 160,
                overflow: 'auto',
              }}>
                {recentErrors.map((e, i) => (
                  <li key={i} style={{
                    padding: '4px 8px',
                    color: '#c66',
                    borderBottom: i < recentErrors.length - 1 ? '1px solid var(--border-color, #222)' : 'none',
                  }}>
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Sync trigger */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
          <button
            onClick={() => { void contribdbStore.sync(); }}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
          {syncing && <span style={{ fontSize: 12, color: '#888' }}>● running…</span>}
        </div>

        {/* Install token */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color, #333)' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Install token
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="text"
              readOnly
              value={installToken ?? 'loading…'}
              className="settings-library-input"
              style={{ flex: 1, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}
              onClick={(e) => (e.target as HTMLInputElement).select()}
              spellCheck={false}
              autoComplete="off"
            />
            <button onClick={onCopyInstallToken} disabled={!installToken}>
              Copy
            </button>
            {copyHint && (
              <span style={{ fontSize: 11, color: copyHint === 'Copied' ? '#393' : '#c33' }}>
                {copyHint}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
            Identifies your install when contributing anonymously.
          </div>
        </div>

        {/* User token */}
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-color, #333)' }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-secondary)', marginBottom: 6 }}>
            User token (optional)
          </div>
          {linked ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13 }}>
                Linked as <strong>{handle ?? '(unknown)'}</strong>
              </span>
              <button onClick={onForget} disabled={tokenBusy}>
                {tokenBusy ? 'Working…' : 'Forget'}
              </button>
              {tokenError && (
                <span style={{ fontSize: 12, color: '#c33' }}>{tokenError}</span>
              )}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="password"
                  className="settings-library-input"
                  style={{ flex: 1 }}
                  placeholder="paste your token from ripperdoc.de/devicedb/register"
                  value={tokenInput}
                  onChange={e => { setTokenInput(e.target.value); setTokenError(null); }}
                  autoComplete="off"
                  spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter') void onLink(); }}
                />
                <button onClick={onLink} disabled={tokenBusy || !tokenInput.trim()}>
                  {tokenBusy ? 'Linking…' : 'Link'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>
                Don't have one yet?{' '}
                <a
                  href="https://ripperdoc.de/devicedb/register"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Register at ripperdoc.de/devicedb/register
                </a>
                .
              </div>
              {tokenError && (
                <div style={{ fontSize: 12, color: '#c33', marginTop: 4 }}>{tokenError}</div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
