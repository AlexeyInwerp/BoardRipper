import { useSyncExternalStore } from 'react';
import { renderSettingsStore } from './render-settings';
import {
  loadScrollBindings,
  SCROLL_BINDINGS_KEY,
  type ScrollBindings,
} from '../panels/PdfViewerPanel';

/**
 * Returns the current "bare" scroll action. Board's `twoFingerPan` is the
 * authoritative source — it only has two possible values (pan | zoom), which
 * is exactly what we need for a two-icon button. PDF may have an exotic
 * `bare='switch'` configuration via Settings; if so, the icon still reflects
 * board state and the tooltip covers the rest.
 */
export function getBareScrollAction(): 'pan' | 'zoom' {
  return renderSettingsStore.globalSettings.twoFingerPan ? 'pan' : 'zoom';
}

/**
 * Swap `bare` ↔ `shift` in both stores. PDF's `meta` slot is preserved so
 * any user customization in the Settings 3-slot editor survives.
 */
export function invertScrollBindings(): void {
  const cur = renderSettingsStore.globalSnapshot();
  renderSettingsStore.applyGlobal({ ...cur, twoFingerPan: !cur.twoFingerPan });

  const b = loadScrollBindings();
  const next: ScrollBindings = { bare: b.shift, shift: b.bare, meta: b.meta };
  localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('pdf-scroll-bindings-changed', { detail: next }));
}

/**
 * Heuristic: does this wheel event look like a classic mouse wheel?
 * Used by the safety net to avoid jerky pan when the configured mode is
 * pan-on-bare but the user is actually on a scroll wheel.
 *
 * Conservative: only fires for obviously-discrete wheels.
 *   - no ctrlKey (pinch-to-zoom handled elsewhere)
 *   - no deltaX (trackpads often emit both axes)
 *   - |deltaY| >= 50 (fine-grained wheels stay under this threshold)
 *   - integer deltaY (macOS trackpads commonly emit fractional values)
 */
export function looksLikeMouseWheel(e: WheelEvent): boolean {
  return (
    !e.ctrlKey &&
    e.deltaX === 0 &&
    Math.abs(e.deltaY) >= 50 &&
    Number.isInteger(e.deltaY)
  );
}

/** React hook returning the current bare scroll action. Re-renders on change. */
export function useBareScrollAction(): 'pan' | 'zoom' {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    getBareScrollAction,
  );
}
