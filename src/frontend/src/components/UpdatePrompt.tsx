import { useEffect } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { boardStore } from '../store/board-store';
import { log } from '../store/log-store';

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
  const { needRefresh: [needRefresh, setNeedRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(url) { log.ui.log(`sw registered: ${url}`); },
    onRegisterError(err) { log.ui.warn('sw registration failed', err); },
  });

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
