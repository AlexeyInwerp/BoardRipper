/** A page that outlives its build. Every chunk name carries a content hash,
 *  so when the server is updated under an open tab (a container update, a
 *  dev redeploy to :1234) the next lazy import asks for a file that no longer
 *  exists — and the first such import is PixiJS's WebGL renderer, so the
 *  symptom is a board that will not open. Vite reports every failed dynamic
 *  import as `vite:preloadError`; say what happened and offer the reload
 *  (session restore brings the open boards back) instead of letting it
 *  surface as a renderer crash. Once per page: a second failure is the same
 *  cause, already explained. */
import { boardStore } from './board-store';
import { log } from './log-store';

export function installStaleBuildGuard() {
  let told = false;
  window.addEventListener('vite:preloadError', (e) => {
    log.ui.error('a code chunk failed to load — the server was probably updated under this tab', (e as Event & { payload?: unknown }).payload);
    if (told) return;
    told = true;
    boardStore.addToast(
      'BoardRipper was updated on the server while this tab was open. Reload to continue.',
      'error',
      { label: 'Reload', run: () => location.reload() },
      600_000,
    );
  });
}
