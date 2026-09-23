import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { boardStore } from '../store/board-store';
import { log } from '../store/log-store';
import { scheduleSwUpdateChecks } from '../store/sw-update-checks';

/**
 * Lite (hosted PWA) build only: turns the service worker's "new version is
 * waiting" state into a toast with a Reload action. Until now a redeploy was
 * applied silently (`registerType: 'autoUpdate'`), which meant two things:
 * nobody on the lite build ever learned a version existed, and a page open
 * across a deploy could 404 on its first lazy chunk once the old hashed
 * assets were pruned from the host. With `registerType: 'prompt'` the new
 * worker waits until the user chooses to reload.
 *
 * Mounted by App.tsx under `isLiteBuild() && !isOfflineBuild()` — the virtual
 * module resolves in every build (the PWA plugin is present-but-disabled
 * outside lite), but there is nothing to register elsewhere.
 */
export function UpdatePrompt() {
  const stopChecksRef = useRef<(() => void) | null>(null);
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(url, registration) {
      log.ui.log(`sw registered: ${url}`);
      // Registering is not re-checking. A page that never navigates again — a
      // Safari tab on an iPad, an installed home-screen app that is resumed —
      // would keep the worker it got on its first visit for ever, and this
      // toast would never have a reason to appear. Ask again on every return
      // to the page, on reconnect, and hourly. See sw-update-checks.ts.
      if (!registration) return;
      stopChecksRef.current?.();
      stopChecksRef.current = scheduleSwUpdateChecks(registration, {
        onError: (err) => log.ui.log('sw update check failed (offline?)', err),
      });
    },
    onRegisterError(err) { log.ui.warn('sw registration failed', err); },
  });

  useEffect(() => () => { stopChecksRef.current?.(); stopChecksRef.current = null; }, []);

  useEffect(() => {
    if (!needRefresh) return;
    // No auto-dismiss: the toast IS the update notice. It goes away with the
    // reload, or when the user taps it.
    boardStore.addToast(
      'A new BoardRipper version is ready.',
      'info',
      { label: 'Reload', run: () => { void updateServiceWorker(true); } },
      24 * 60 * 60 * 1000,
    );
    setNeedRefresh(false);
  }, [needRefresh, setNeedRefresh, updateServiceWorker]);

  return null;
}
