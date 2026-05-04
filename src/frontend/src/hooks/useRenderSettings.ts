// src/frontend/src/hooks/useRenderSettings.ts
import { renderSettingsStore } from '../store/render-settings';
import { createStoreHook } from './createStoreHook';
import type { RenderSettings } from '../store/render-settings';

/**
 * Hook returning the current effective render settings. Snapshot is rebuilt
 * only when the store notifies, courtesy of createStoreHook's version
 * counter (satisfies useSyncExternalStore's stable-reference requirement).
 */
export const useRenderSettings = createStoreHook<RenderSettings>(
  renderSettingsStore,
  () => renderSettingsStore.settings,
);
