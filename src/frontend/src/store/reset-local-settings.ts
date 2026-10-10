/**
 * "Reset all local settings": every preference this browser keeps for
 * BoardRipper lives in localStorage under `boardripper-*`, and a bad value
 * there (2026-10-09: a board drawing no components at all, fixed only by
 * clearing site data by hand) had no way back from inside the app.
 *
 * Clears every `boardripper-*` key except the ones that hold the user's own
 * data rather than a preference — recent files, favourites, navigation
 * history, the open-tab session, PDF bookmarks, typed FZ/CAE keys, and an
 * update in flight. Worklists and the board/PDF caches are IndexedDB and the
 * MCP pairing id is `br-mcp-*`, so none of them are touched.
 */

const KEEP = new Set([
  'boardripper-history',
  'boardripper-history-depth',
  'boardripper-favorites',
  'boardripper-nav-history',
  'boardripper-session',
  'boardripper-fz-key',
  'boardripper-cae-key',
  'boardripper-update-in-flight',
  'boardripper-folder-library',
]);
const KEEP_PREFIXES = ['boardripper-pdf-bookmarks-'];

/** The keys a reset would remove, from a list of storage keys. */
export function localSettingsKeys(keys: readonly string[]): string[] {
  return keys.filter(k => k.startsWith('boardripper-')
    && !KEEP.has(k)
    && !KEEP_PREFIXES.some(p => k.startsWith(p)));
}

/** Removes every local setting and reloads, so every store starts from its
 *  defaults (they read storage once, at module load). */
export function resetLocalSettings(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) keys.push(k);
    }
    for (const k of localSettingsKeys(keys)) localStorage.removeItem(k);
  } catch { /* storage blocked — nothing stored to reset */ }
  location.reload();
}
