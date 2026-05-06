/**
 * Centered modal shown while a self-update is restarting the container.
 *
 * After the user clicks "Update Now," the backend orchestrator stops
 * the running container, the SSE progress stream dies, and the new
 * container takes ~30–60 seconds to come up (image load, databank reopen,
 * library scan restore). Without this overlay the user sees "SSE
 * connection lost," assumes the update failed, and may click "Update"
 * again on a stale tab.
 *
 * Visible whenever updateStore.restarting === true. Cleared by a full
 * page reload once the backend's /api/health responds.
 */

import { useSyncExternalStore } from 'react';
import { updateStore } from '../store/update-store';

function subscribe(cb: () => void): () => void {
  return updateStore.subscribe(cb);
}
function getSnapshot(): boolean {
  return updateStore.restarting;
}

export function UpdateProgressOverlay() {
  const restarting = useSyncExternalStore(subscribe, getSnapshot);
  if (!restarting) return null;

  const fromVersion = updateStore.restartingFromVersion || updateStore.state.current_version;
  return (
    <div className="update-progress-overlay" role="alertdialog" aria-modal="true" aria-labelledby="update-progress-title">
      <div className="update-progress-modal">
        <div className="update-progress-spinner" aria-hidden="true" />
        <h2 id="update-progress-title">Update in progress</h2>
        <p>
          BoardRipper is restarting on the new version.
        </p>
        <p className="update-progress-note">
          The page will reload automatically in 30–60 seconds. You can leave this tab open and continue using the rest of your machine.
        </p>
        <p className="update-progress-version">From <code>{fromVersion}</code></p>
      </div>
    </div>
  );
}
