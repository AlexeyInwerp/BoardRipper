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
 * Strategy — per-event signature plus a "trackpad mode" time-decay flag:
 * any event that is clearly not a classic wheel (fractional deltaY, non-zero
 * deltaX, ctrlKey=pinch, small deltaY) flips trackpad mode on for 500 ms.
 * While the flag is active, even events that look wheel-shaped in isolation
 * are treated as trackpad — this suppresses the misclassification that
 * happens in the middle of a fast trackpad gesture where individual events
 * occasionally hit all four wheel-signature conditions.
 */
const TRACKPAD_MODE_MS = 500;
let trackpadModeUntil = 0;

export function looksLikeMouseWheel(e: WheelEvent): boolean {
  const now = performance.now();

  // Trackpad-signature detection: any of these → definitely not a classic wheel.
  const trackpadSignature =
    !Number.isInteger(e.deltaY) ||
    e.deltaX !== 0 ||
    e.ctrlKey ||
    Math.abs(e.deltaY) < 50;

  if (trackpadSignature) {
    trackpadModeUntil = now + TRACKPAD_MODE_MS;
    return false;
  }

  // Tail of a recent trackpad gesture — do not override pan.
  if (now < trackpadModeUntil) return false;

  // Looks like an isolated classic wheel click.
  return true;
}

/** Test/diagnostic helper: reset trackpad-mode state between scenarios. */
export function _resetTrackpadMode(): void {
  trackpadModeUntil = 0;
}

/** React hook returning the current bare scroll action. Re-renders on change. */
export function useBareScrollAction(): 'pan' | 'zoom' {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    getBareScrollAction,
  );
}
