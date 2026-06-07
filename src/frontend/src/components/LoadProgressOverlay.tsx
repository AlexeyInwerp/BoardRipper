/**
 * Per-file board-load progress overlay.
 *
 * Lights up when loadProgressStore.start() is called (today: from
 * databankStore.fetchFileBuffer for library opens, or from boardStore.loadFile
 * for drag-drop). Stays open through each phase (Downloading → Cache lookup →
 * Reading file bytes → Parsing → Post-process → Writing cache → Building scene)
 * and dismisses ~1.5 s after the last phase completes so the user sees the
 * final per-phase totals before it goes away.
 *
 * Phase rows show:
 *   - name + free-text detail (e.g. "5.2 / 29.4 MB (18%)" during download)
 *   - status icon (running → spinner, done → ✓, error → ✕)
 *   - elapsed time for completed phases
 *
 * Log entries (loadProgressStore.pushLog) sit below the phase list and carry
 * arbitrary diagnostics: "Cache hit: …", "buildBoardScene: 642ms (…)", etc.
 *
 * Styling reuses .update-progress-* classes from index.css so we don't grow
 * the stylesheet for a single-shot overlay. The overlay is rendered alongside
 * <UpdateProgressOverlay /> in App.tsx; only one of them is ever visible at a
 * time because the update path force-reloads the page.
 */

import { useSyncExternalStore } from 'react';
import { loadProgressStore } from '../store/load-progress-store';
import type { LoadPhase } from '../store/load-progress-store';

function subscribe(cb: () => void): () => void {
  return loadProgressStore.subscribe(cb);
}

// React's useSyncExternalStore needs a stable snapshot — return the
// monotonic version counter so it sees a primitive change on every notify.
// The state itself is read separately via getState() below.
function getVersion(): number {
  return loadProgressStore.getVersion();
}

function fmtMs(ms: number | undefined): string {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function fmtBytes(b: number | null): string {
  if (b == null || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function phaseIcon(p: LoadPhase): string {
  if (p.status === 'done') return '✓';
  if (p.status === 'error') return '✕';
  return '…';
}

export function LoadProgressOverlay() {
  useSyncExternalStore(subscribe, getVersion);
  const state = loadProgressStore.getState();
  if (!state.visible || state.startedAt == null) return null;

  const total = (state.finishedAt ?? performance.now()) - state.startedAt;
  const failed = state.phases.some(p => p.status === 'error');

  // Non-blocking corner panel — earlier draft was a full-screen modal
  // (.update-progress-overlay = position:fixed inset:0 z-index 99999),
  // which left users stuck behind a black screen if the dismiss path
  // missed (tab-switch mid-load, finishIfMatching not matching, etc.).
  // Pin to bottom-right, no backdrop, pointer-events on the panel only.
  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    right: '1rem',
    bottom: '1rem',
    zIndex: 9000, // below toasts (10000) and update-progress (99999)
    pointerEvents: 'none', // canvas stays interactive behind us
    maxWidth: 'min(420px, calc(100vw - 2rem))',
  };
  const panelStyle: React.CSSProperties = {
    pointerEvents: 'auto', // X button works, rest of canvas stays free
    background: 'rgba(20, 20, 22, 0.92)',
    borderRadius: '8px',
    boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
    border: '1px solid rgba(255,255,255,0.1)',
    padding: '0.75rem 1rem',
    color: '#e0e0e0',
    fontSize: '12px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    position: 'relative',
  };
  const closeBtnStyle: React.CSSProperties = {
    position: 'absolute',
    top: '0.25rem',
    right: '0.5rem',
    background: 'transparent',
    border: 'none',
    color: '#999',
    cursor: 'pointer',
    fontSize: '16px',
    lineHeight: 1,
    padding: '4px 8px',
  };

  return (
    <div style={containerStyle} role="status" aria-live="polite" aria-labelledby="load-progress-title">
      <div style={panelStyle}>
        <button
          style={closeBtnStyle}
          onClick={() => loadProgressStore.dismiss()}
          title="Dismiss"
          aria-label="Dismiss load-progress overlay"
        >
          ✕
        </button>
        <h3 id="load-progress-title" style={{ margin: '0 1.5rem 0.25rem 0', fontSize: '13px' }}>
          {failed ? '✕ Load failed' : '⟳ Loading board'}
        </h3>
        <div style={{ color: '#bbb', marginBottom: '0.25rem', wordBreak: 'break-all' }}>
          <code style={{ fontSize: '11px' }}>{state.fileName ?? ''}</code>
          {state.fileSize != null && state.fileSize > 0 ? ` — ${fmtBytes(state.fileSize)}` : ''}
        </div>
        <div style={{ color: '#888', marginBottom: '0.5rem' }}>Elapsed: {fmtMs(total)}</div>

        <ol style={{ margin: 0, padding: '0 0 0 1rem', listStyle: 'none', maxHeight: '180px', overflowY: 'auto' }}>
          {state.phases.map((p, i) => (
            <li key={i} style={{
              padding: '2px 0',
              color: p.status === 'error' ? '#f88' : p.status === 'running' ? '#fc8' : '#7c7',
            }}>
              <span style={{ display: 'inline-block', width: '1.25rem' }}>{phaseIcon(p)}</span>
              <strong>{p.name}</strong>
              {p.detail ? ` — ${p.detail}` : ''}
              {p.status === 'done' && p.elapsedMs != null ? ` (${fmtMs(p.elapsedMs)})` : ''}
              {p.status === 'running' ? ` (${fmtMs(performance.now() - p.startedAt)})` : ''}
            </li>
          ))}
        </ol>

        {state.log.length > 0 && (
          <details style={{ marginTop: '0.5rem' }}>
            <summary style={{ cursor: 'pointer', color: '#888', fontSize: '11px' }}>
              Log ({state.log.length})
            </summary>
            <ol style={{ margin: '0.25rem 0 0', padding: '0 0 0 1rem', listStyle: 'none', maxHeight: '120px', overflowY: 'auto', color: '#999', fontSize: '11px' }}>
              {state.log.slice(-10).map((entry, i) => (
                <li key={i} style={{ padding: '1px 0' }}>
                  <span style={{ display: 'inline-block', width: '3rem', color: '#666' }}>{fmtMs(entry.tMs)}</span>
                  {entry.message}
                </li>
              ))}
            </ol>
          </details>
        )}
      </div>
    </div>
  );
}
