/**
 * Centered modal shown while a self-update is restarting the container.
 *
 * After the user clicks "Update Now," the backend orchestrator stops
 * the running container, the SSE progress stream dies, and the new
 * container takes ~5–30 seconds to come up (image load, databank reopen,
 * library scan restore). Without this overlay the user sees "SSE
 * connection lost," assumes the update failed, and may click "Update"
 * again on a stale tab.
 *
 * Renders:
 * - spinner + heading + reload note
 * - elapsed-time counter (ticks every second while restarting)
 * - the most-recent slice of `updateStore.progress[]` — the entries
 *   captured before SSE died, so the user can see what the orchestrator
 *   was doing instead of just staring at a spinner. Same styling as the
 *   toolbar's dropdown progress so visual identity is consistent.
 *
 * Visible whenever updateStore.restarting === true. Cleared by a full
 * page reload once the backend's /api/health responds.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { updateStore } from '../store/update-store';

function subscribe(cb: () => void): () => void {
  return updateStore.subscribe(cb);
}
function getRestarting(): boolean {
  return updateStore.restarting;
}
function getProgressLen(): number {
  return updateStore.progress.length;
}

export function UpdateProgressOverlay() {
  const restarting = useSyncExternalStore(subscribe, getRestarting);
  // progressLen drives re-render when entries arrive — primitive snapshot
  // keeps useSyncExternalStore's stability invariant intact (no new object
  // identities on every read). Read here (not in the inner component) so the
  // store subscription persists across restarting transitions.
  useSyncExternalStore(subscribe, getProgressLen);

  if (!restarting) return null;
  // Inner component owns `elapsed` state. Splitting the gate here means each
  // restart mounts a fresh instance, so `elapsed` naturally resets to 0
  // without a setState-in-effect.
  return <UpdateProgressActive />;
}

function UpdateProgressActive() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const fromVersion = updateStore.restartingFromVersion || updateStore.state.current_version;
  // Show only the tail — older entries are typically environment setup
  // ("Pulling alpine") that's less informative than the swap-window steps.
  const allEntries = updateStore.progress;
  const tailEntries = allEntries.slice(-14);

  return (
    <div className="update-progress-overlay" role="alertdialog" aria-modal="true" aria-labelledby="update-progress-title">
      <div className="update-progress-modal">
        <div className="update-progress-spinner" aria-hidden="true" />
        <h2 id="update-progress-title">Update in progress</h2>
        <p>BoardRipper is restarting on the new version.</p>
        <p className="update-progress-note">
          Page reloads automatically when the new container responds. <span className="update-progress-elapsed">Elapsed: {elapsed}s</span>
        </p>
        {tailEntries.length > 0 && (
          <div className="update-progress-modal-log-wrap">
            <div className="update-progress-modal-log-label">
              Progress log{allEntries.length > tailEntries.length ? ` (last ${tailEntries.length} of ${allEntries.length})` : ` (${tailEntries.length})`}
            </div>
            <ol className="update-progress-modal-log">
              {tailEntries.map((entry, i) => (
                <li key={i} className={`update-progress-line update-progress-${entry.status}`}>
                  <span className="update-progress-modal-log-time">{entry.time.split('T')[1]?.split('.')[0] ?? ''}</span>
                  <span className="update-progress-modal-log-msg">{entry.message}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <p className="update-progress-version">From <code>{fromVersion}</code></p>
      </div>
    </div>
  );
}
