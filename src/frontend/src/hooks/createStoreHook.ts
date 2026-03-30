import { useSyncExternalStore } from 'react';

/**
 * Generic factory for creating a React hook from any store that implements
 * subscribe/notify pattern. Encapsulates the version-counter caching boilerplate
 * that useSyncExternalStore requires for stable snapshot references.
 *
 * @param store - Object with a `subscribe(cb: () => void): () => void` method
 * @param buildSnapshot - Function that reads current store state and returns a snapshot object
 * @returns A React hook that returns the latest snapshot, only rebuilding when the store notifies
 */
export function createStoreHook<T>(
  store: { subscribe(cb: () => void): () => void },
  buildSnapshot: () => T,
): () => T {
  let cachedSnapshot: T | null = null;
  let snapshotVersion = 0;
  let lastVersion = -1;

  store.subscribe(() => { snapshotVersion++; });

  function getSnapshot(): T {
    if (lastVersion !== snapshotVersion || !cachedSnapshot) {
      cachedSnapshot = buildSnapshot();
      lastVersion = snapshotVersion;
    }
    return cachedSnapshot;
  }

  function subscribe(cb: () => void) {
    return store.subscribe(cb);
  }

  return () => useSyncExternalStore(subscribe, getSnapshot);
}
