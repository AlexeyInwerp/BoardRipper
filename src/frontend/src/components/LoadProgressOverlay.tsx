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

  return (
    <div className="update-progress-overlay" role="dialog" aria-modal="false" aria-labelledby="load-progress-title">
      <div className="update-progress-modal">
        <div className="update-progress-spinner" aria-hidden="true" />
        <h2 id="load-progress-title">{failed ? 'Load failed' : 'Loading board'}</h2>
        <p>
          <code>{state.fileName ?? ''}</code>
          {state.fileSize != null && state.fileSize > 0 ? ` — ${fmtBytes(state.fileSize)}` : ''}
        </p>
        <p className="update-progress-note">
          <span className="update-progress-elapsed">Elapsed: {fmtMs(total)}</span>
        </p>

        <div className="update-progress-modal-log-wrap">
          <div className="update-progress-modal-log-label">Phases ({state.phases.length})</div>
          <ol className="update-progress-modal-log">
            {state.phases.map((p, i) => (
              <li key={i} className={`update-progress-line update-progress-${p.status === 'running' ? 'running' : p.status === 'error' ? 'error' : 'success'}`}>
                <span className="update-progress-modal-log-time">{phaseIcon(p)}</span>
                <span className="update-progress-modal-log-msg">
                  <strong>{p.name}</strong>
                  {p.detail ? ` — ${p.detail}` : ''}
                  {p.status === 'done' && p.elapsedMs != null ? ` (${fmtMs(p.elapsedMs)})` : ''}
                  {p.status === 'running' ? ` (${fmtMs(performance.now() - p.startedAt)})` : ''}
                </span>
              </li>
            ))}
          </ol>
        </div>

        {state.log.length > 0 && (
          <div className="update-progress-modal-log-wrap">
            <div className="update-progress-modal-log-label">Log ({state.log.length})</div>
            <ol className="update-progress-modal-log">
              {state.log.slice(-10).map((entry, i) => (
                <li key={i} className="update-progress-line">
                  <span className="update-progress-modal-log-time">{fmtMs(entry.tMs)}</span>
                  <span className="update-progress-modal-log-msg">{entry.message}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {failed && (
          <button
            className="visibility-toggle"
            onClick={() => loadProgressStore.dismiss()}
            style={{ marginTop: '0.5rem' }}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
