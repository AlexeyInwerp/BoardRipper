import { useSyncExternalStore } from 'react';
import { renderSettingsStore } from './render-settings';
import {
  loadScrollBindings,
  SCROLL_BINDINGS_KEY,
  type ScrollAction,
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

/** Tooltip for the swap button, built from the ACTUAL stored PDF bindings so
 *  a custom 3-slot config (e.g. bare='switch') is described truthfully —
 *  the old hardcoded "Pan/Zoom" pair lied whenever the third action was in
 *  one of the two visible slots. */
export function scrollSwapTooltip(): string {
  const b = loadScrollBindings();
  const name = (a: ScrollAction) => a === 'pan' ? 'Pan' : a === 'zoom' ? 'Zoom' : 'Flip pages';
  return `Scroll: ${name(b.bare)} · Shift+Scroll: ${name(b.shift)} · Ctrl/Cmd+Scroll: ${name(b.meta)} — click to swap Scroll and Shift+Scroll`;
}

/**
 * Heuristic: does this wheel event look like a classic mouse wheel?
 * Used by the safety net to avoid jerky pan when the configured mode is
 * pan-on-bare but the user is actually on a scroll wheel.
 *
 * Strategy — first-event signature, latched across the burst.
 *
 *   - A new burst starts after a quiet gap (>250ms since last wheel event).
 *   - The first event of a burst is classified by signature: large integer
 *     deltaY with no deltaX = wheel; everything else (small magnitude,
 *     fractional, has deltaX, ctrlKey) = trackpad. A bare slow two-finger
 *     trackpad scroll lands here and gets classified as trackpad on event 1,
 *     not silently latched as wheel.
 *   - The classification stays latched for the entire burst — every event
 *     in the burst returns the same answer, so one physical input never
 *     splits across pan/zoom paths (this was the original mid-burst-flip
 *     bug on Mac/Safari smooth-scroll: subsequent fractional events in a
 *     wheel-click burst would re-classify as trackpad).
 *   - Sustained high-cadence input (≥6 consecutive gaps under 35ms) demotes
 *     the burst to "trackpad" one-way; demotion never reverses. This is a
 *     safety net for wheel-shaped first events that turn out to be the
 *     leading edge of a fast trackpad swipe.
 *
 * Mac/Safari smooth-scroll wheel click: first event has large integer
 * deltaY (e.g. ±100/±120) → latched wheel → all 5-8 burst events return
 * wheel. Trackpad slow scroll: first event is small/fractional → latched
 * trackpad immediately, regardless of cadence.
 */
const QUIET_GAP_MS = 250;
const HIGH_CADENCE_MS = 35;
const SUSTAINED_FAST_THRESHOLD = 6;
const WHEEL_MIN_MAGNITUDE = 50;

function signatureLooksLikeWheel(e: WheelEvent): boolean {
  if (e.ctrlKey) return false;
  if (e.deltaX !== 0) return false;
  if (Math.abs(e.deltaY) < WHEEL_MIN_MAGNITUDE) return false;
  if (e.deltaY !== Math.trunc(e.deltaY)) return false;
  return true;
}

let burstActive = false;
let burstIsWheel = false;
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
    burstIsWheel = signatureLooksLikeWheel(e);
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
  burstIsWheel = false;
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
