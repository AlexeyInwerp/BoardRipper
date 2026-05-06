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
 * Strategy — burst-latched timing analysis. The previous per-event signature
 * (fractional deltaY, non-zero deltaX, magnitude<50) misfired on macOS/Safari
 * where smooth-scrolling expands a single wheel click into 5-8 fractional
 * events: the first event would classify as wheel (zoom), then the burst
 * tail flipped to trackpad (pan), splitting one physical click into mixed
 * pan + zoom frames.
 *
 * The new heuristic looks at *cadence over a burst*, not the shape of any
 * single event:
 *
 *   - A new burst starts after a quiet gap (>250ms since last wheel event).
 *   - The first event of a burst latches as "wheel" (the safety net's
 *     intended target — users who enable wheelDetection are wheel users).
 *   - The classification stays latched for the entire burst — every event
 *     in the burst returns the same answer, so one physical input never
 *     splits across pan/zoom paths.
 *   - Sustained high-cadence input (≥6 consecutive gaps under 35ms — only
 *     trackpad scrolls and pinches sustain this) demotes the burst to
 *     "trackpad" one-way; demotion never reverses within the burst.
 *   - Trackpad pinch (ctrlKey) is always trackpad immediately.
 *
 * Mac/Safari smooth-scroll wheel click = 5-8 events at ~16ms cadence over
 * ~150ms total. Won't reach the 6-fast-gap threshold before the burst ends,
 * so it stays latched as wheel. Trackpad swipes (30+ events at 16ms) cross
 * the threshold quickly and flip to trackpad.
 */
const QUIET_GAP_MS = 250;
const HIGH_CADENCE_MS = 35;
const SUSTAINED_FAST_THRESHOLD = 6;

let burstActive = false;
let burstIsWheel = true;
let consecutiveFast = 0;
let lastEventTime = 0;

export function looksLikeMouseWheel(e: WheelEvent): boolean {
  const now = performance.now();
  const gap = lastEventTime > 0 ? now - lastEventTime : Infinity;
  lastEventTime = now;

  // Pinch is always trackpad — ctrlKey wheel events are the synthesized
  // pinch signal in Chrome/FF (Safari fires gesture* events instead, which
  // never reach this heuristic).
  if (e.ctrlKey) {
    burstActive = true;
    burstIsWheel = false;
    consecutiveFast = SUSTAINED_FAST_THRESHOLD;
    return false;
  }

  // Quiet gap → start of a new burst.
  if (gap > QUIET_GAP_MS) {
    burstActive = false;
    consecutiveFast = 0;
  }

  if (!burstActive) {
    burstActive = true;
    // Default classification for a new burst: wheel. Users who opted into
    // wheelDetection want sparse classic-wheel clicks reinterpreted as
    // zoom. Sustained-cadence detection below demotes if it's actually a
    // trackpad gesture.
    burstIsWheel = true;
    consecutiveFast = 0;
  }

  if (gap < HIGH_CADENCE_MS) {
    consecutiveFast++;
  } else {
    consecutiveFast = 0;
  }

  if (consecutiveFast >= SUSTAINED_FAST_THRESHOLD) {
    burstIsWheel = false; // one-way demotion for the rest of this burst
  }

  return burstIsWheel;
}

/** Test/diagnostic helper: reset burst state between scenarios. */
export function _resetTrackpadMode(): void {
  burstActive = false;
  burstIsWheel = true;
  consecutiveFast = 0;
  lastEventTime = 0;
}

/** React hook returning the current bare scroll action. Re-renders on change. */
export function useBareScrollAction(): 'pan' | 'zoom' {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    getBareScrollAction,
  );
}
