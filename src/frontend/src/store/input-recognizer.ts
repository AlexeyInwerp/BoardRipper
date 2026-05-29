/**
 * Input gesture recognizer — classifies wheel/pointer input and maps a
 * demonstrated gesture onto BoardRipper's pan/zoom settings.
 *
 * This is the foundation for the first-run "set up your input" popup. It is
 * surfaced first in a verbose Debug-panel recognizer so the classification and
 * the resulting setting patch can be validated against real hardware before
 * the polished onboarding UI is built on top of it.
 *
 * The bare-scroll device classifier mirrors the thresholds and burst-latch
 * semantics of `looksLikeMouseWheel` in `scroll-mode.ts` (the live safety-net
 * path) so what the recognizer reports matches what the viewers actually do.
 */

// ── Thresholds (kept in lock-step with scroll-mode.ts) ──────────────────────
const QUIET_GAP_MS = 250;
const HIGH_CADENCE_MS = 35;
const SUSTAINED_FAST_THRESHOLD = 6;
const WHEEL_MIN_MAGNITUDE = 50;

export type GestureDevice =
  | 'mouse-wheel'
  | 'trackpad-swipe'
  | 'trackpad-pinch'
  | 'drag'
  | 'unknown';

export type GestureModifier = 'none' | 'shift' | 'meta' | 'ctrl';

/** Raw, verbose snapshot of a single wheel event. */
export interface WheelSample {
  kind: 'wheel';
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  deltaModeLabel: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  gapMs: number;
}

/** Raw, verbose snapshot of a completed pointer drag. */
export interface PointerSample {
  kind: 'pointer';
  pointerType: string;
  button: number;
  buttons: number;
  totalDx: number;
  totalDy: number;
  distance: number;
  durationMs: number;
  moveCount: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export type InputSample = WheelSample | PointerSample;

export interface GestureVerdict {
  device: GestureDevice;
  modifier: GestureModifier;
  /** Short human label, e.g. "Shift + mouse wheel". */
  label: string;
  /** Verbose explanation lines for the debug readout. */
  reasons: string[];
  /** False when the signal is too weak to act on (e.g. drag below threshold). */
  confident: boolean;
}

export function deltaModeLabel(mode: number): string {
  switch (mode) {
    case 0: return 'pixel';
    case 1: return 'line';
    case 2: return 'page';
    default: return `mode ${mode}`;
  }
}

function modifierOf(e: { shiftKey: boolean; metaKey: boolean }): GestureModifier {
  if (e.metaKey) return 'meta';
  if (e.shiftKey) return 'shift';
  return 'none';
}

function modifierLabel(m: GestureModifier): string {
  switch (m) {
    case 'shift': return 'Shift + ';
    case 'meta': return 'Cmd/Ctrl + ';
    case 'ctrl': return 'Ctrl + ';
    case 'none': return '';
  }
}

/**
 * Stateful burst classifier for wheel events. One instance tracks one input
 * stream (the debug capture area). Mirrors the burst-latch logic of
 * `looksLikeMouseWheel` but exposes verbose intermediate state.
 */
export class WheelGestureClassifier {
  private burstActive = false;
  private burstIsWheel = false;
  private consecutiveFast = 0;
  private lastEventTime = 0;

  reset(): void {
    this.burstActive = false;
    this.burstIsWheel = false;
    this.consecutiveFast = 0;
    this.lastEventTime = 0;
  }

  private signatureLooksLikeWheel(e: WheelEvent): boolean {
    if (e.ctrlKey) return false;
    if (e.deltaX !== 0) return false;
    if (Math.abs(e.deltaY) < WHEEL_MIN_MAGNITUDE) return false;
    if (e.deltaY !== Math.trunc(e.deltaY)) return false;
    return true;
  }

  feed(e: WheelEvent): { sample: WheelSample; verdict: GestureVerdict } {
    const now = performance.now();
    const gap = this.lastEventTime > 0 ? now - this.lastEventTime : Infinity;
    this.lastEventTime = now;

    const sample: WheelSample = {
      kind: 'wheel',
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaZ: e.deltaZ,
      deltaMode: e.deltaMode,
      deltaModeLabel: deltaModeLabel(e.deltaMode),
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      altKey: e.altKey,
      gapMs: Number.isFinite(gap) ? Math.round(gap) : -1,
    };

    const reasons: string[] = [];

    // ctrlKey wheel = browser-synthesized pinch (Chrome/FF). On Mac a real
    // Ctrl+wheel also lands here, but both should map to zoom, so we treat it
    // as a pinch/zoom gesture and note the ambiguity.
    if (e.ctrlKey) {
      this.burstActive = true;
      this.burstIsWheel = false;
      this.consecutiveFast = SUSTAINED_FAST_THRESHOLD;
      reasons.push('ctrlKey set on wheel event → trackpad pinch (or Ctrl+scroll); both zoom.');
      reasons.push(`|deltaY|=${Math.abs(e.deltaY).toFixed(2)} (pinch deltas are small/fractional).`);
      return {
        sample,
        verdict: {
          device: 'trackpad-pinch',
          modifier: 'ctrl',
          label: 'Trackpad pinch',
          reasons,
          confident: true,
        },
      };
    }

    if (gap > QUIET_GAP_MS) {
      this.burstActive = false;
      this.consecutiveFast = 0;
      reasons.push(`gap ${sample.gapMs}ms > ${QUIET_GAP_MS}ms → new burst.`);
    }

    if (!this.burstActive) {
      this.burstActive = true;
      this.burstIsWheel = this.signatureLooksLikeWheel(e);
      this.consecutiveFast = 0;
      reasons.push(
        this.burstIsWheel
          ? `first event: |deltaY|=${Math.abs(e.deltaY)} ≥ ${WHEEL_MIN_MAGNITUDE}, integer, no deltaX → wheel signature.`
          : `first event: small/fractional/has-deltaX → trackpad signature.`,
      );
    } else {
      reasons.push(`continuing burst (latched as ${this.burstIsWheel ? 'wheel' : 'trackpad'}).`);
    }

    if (gap < HIGH_CADENCE_MS) {
      this.consecutiveFast++;
    } else {
      this.consecutiveFast = 0;
    }

    if (this.consecutiveFast >= SUSTAINED_FAST_THRESHOLD && this.burstIsWheel) {
      this.burstIsWheel = false;
      reasons.push(`≥${SUSTAINED_FAST_THRESHOLD} fast events (<${HIGH_CADENCE_MS}ms) → demoted to trackpad.`);
    }

    const device: GestureDevice = this.burstIsWheel ? 'mouse-wheel' : 'trackpad-swipe';
    const modifier = modifierOf(e);
    const deviceLabel = device === 'mouse-wheel' ? 'mouse wheel' : 'trackpad swipe';

    return {
      sample,
      verdict: {
        device,
        modifier,
        label: `${modifierLabel(modifier)}${deviceLabel}`,
        reasons,
        confident: true,
      },
    };
  }
}

/** Distance (px) a pointer must travel before we call it a drag. */
export const DRAG_MIN_DISTANCE = 6;

export function classifyPointerDrag(s: PointerSample): GestureVerdict {
  const reasons: string[] = [
    `pointerType=${s.pointerType}, button=${s.button}, moved ${s.distance.toFixed(0)}px over ${Math.round(s.durationMs)}ms (${s.moveCount} moves).`,
  ];
  const confident = s.distance >= DRAG_MIN_DISTANCE;
  if (!confident) reasons.push(`distance < ${DRAG_MIN_DISTANCE}px → looks like a click, not a drag.`);
  const modifier = modifierOf(s);
  const buttonName = s.button === 0 ? 'Left' : s.button === 1 ? 'Middle' : s.button === 2 ? 'Right' : `Btn${s.button}`;
  return {
    device: 'drag',
    modifier,
    label: `${modifierLabel(modifier)}${buttonName}-drag (${s.pointerType})`,
    reasons,
    confident,
  };
}

// ── Inertia / momentum detection ────────────────────────────────────────────
//
// OS momentum scrolling (trackpad fling) emits a long tail of wheel events
// after the fingers lift: |deltaY| decays smoothly toward zero at a steady high
// cadence. A classic mouse wheel emits discrete notches — constant magnitude,
// large gaps, no decay — so a sustained decaying high-cadence tail is a strong
// trackpad signal and tells us the OS already provides glide.

const INERTIA_FAST_GAP_MS = 40;
const INERTIA_MIN_BURST = 8;
const INERTIA_MIN_DECAY_RUN = 5;
const INERTIA_DECAY_TOLERANCE = 1.05; // allow 5% jitter while still "non-increasing"

export interface InertiaState {
  /** A wheel burst is currently in progress. */
  active: boolean;
  eventCount: number;
  peakAbs: number;
  currentAbs: number;
  /** Consecutive non-increasing fast events at the tail (the decay run). */
  decayRun: number;
  avgGapMs: number;
  /** Momentum tail detected this burst. */
  hasInertia: boolean;
  reasons: string[];
}

/** Stateful momentum detector. One instance per input stream. */
export class InertiaDetector {
  private lastT = 0;
  private count = 0;
  private peak = 0;
  private prevAbs = Infinity;
  private decayRun = 0;
  private gapSum = 0;
  private gapCount = 0;
  private latched = false;

  reset(): void {
    this.lastT = 0;
    this.count = 0;
    this.peak = 0;
    this.prevAbs = Infinity;
    this.decayRun = 0;
    this.gapSum = 0;
    this.gapCount = 0;
    this.latched = false;
  }

  feed(e: WheelEvent): InertiaState {
    const now = performance.now();
    const gap = this.lastT > 0 ? now - this.lastT : Infinity;
    this.lastT = now;
    const abs = Math.abs(e.deltaY);

    // Pinch (ctrlKey) and a quiet gap both start a fresh burst.
    if (e.ctrlKey || gap > QUIET_GAP_MS) {
      this.count = 0;
      this.peak = 0;
      this.prevAbs = Infinity;
      this.decayRun = 0;
      this.gapSum = 0;
      this.gapCount = 0;
      this.latched = false;
    }

    this.count++;
    if (Number.isFinite(gap)) {
      this.gapSum += gap;
      this.gapCount++;
    }
    this.peak = Math.max(this.peak, abs);

    const fast = gap < INERTIA_FAST_GAP_MS;
    const decaying = abs > 0 && abs <= this.prevAbs * INERTIA_DECAY_TOLERANCE && abs < this.peak * 0.9;
    if (fast && decaying) this.decayRun++;
    else this.decayRun = 0;
    this.prevAbs = abs;

    const avgGap = this.gapCount > 0 ? this.gapSum / this.gapCount : 0;
    const hasInertia =
      this.count >= INERTIA_MIN_BURST &&
      this.decayRun >= INERTIA_MIN_DECAY_RUN &&
      abs < this.peak * 0.5;
    if (hasInertia) this.latched = true;

    const reasons: string[] = [
      `burst: ${this.count} event(s), avg gap ${avgGap.toFixed(0)}ms.`,
      `|deltaY| peak ${this.peak.toFixed(1)} → current ${abs.toFixed(1)} (${this.peak > 0 ? Math.round((abs / this.peak) * 100) : 0}% of peak).`,
      `decay run: ${this.decayRun} consecutive non-increasing fast event(s) (need ≥${INERTIA_MIN_DECAY_RUN}).`,
    ];
    if (this.latched) {
      reasons.push('→ momentum tail detected: this device has OS inertia scrolling (trackpad).');
    } else if (this.count < INERTIA_MIN_BURST) {
      reasons.push(`→ too few events so far (need ≥${INERTIA_MIN_BURST}); a discrete mouse wheel never reaches this.`);
    } else {
      reasons.push('→ no decaying tail yet (looks like discrete notches / abrupt stop).');
    }

    return {
      active: true,
      eventCount: this.count,
      peakAbs: this.peak,
      currentAbs: abs,
      decayRun: this.decayRun,
      avgGapMs: avgGap,
      hasInertia: this.latched,
      reasons,
    };
  }
}

export interface InertiaRecommendation {
  /** False when there's nothing to apply (no momentum detected). */
  applicable: boolean;
  summary: string;
  board?: { disableInertia: boolean };
  pdfInertia?: boolean;
}

/**
 * When the OS already provides momentum scrolling, BoardRipper should NOT add
 * its own glide on top — the two would compound into a doubled/janky feel. So a
 * detected OS momentum tail recommends leaving the app glide OFF. With no OS
 * momentum, the app glide is a pure preference (off by default). Kept in
 * lock-step with the WelcomeSetup "BoardRipper momentum" checkbox.
 */
export function recommendInertia(input: { surface: Surface; hasInertia: boolean }): InertiaRecommendation {
  if (!input.hasInertia) {
    return {
      applicable: false,
      summary: 'No OS momentum detected — the app’s own glide is a preference (off by default).',
    };
  }
  return input.surface === 'board'
    ? {
        applicable: true,
        summary: 'Your device already scrolls with momentum — leaving the board’s own glide OFF so they don’t double up.',
        board: { disableInertia: true },
      }
    : {
        applicable: true,
        summary: 'Your device already scrolls with momentum — leaving the PDF’s own inertia OFF so they don’t double up.',
        pdfInertia: false,
      };
}

// ── Setting recommendation ──────────────────────────────────────────────────

export type Surface = 'board' | 'pdf';
export type Action = 'pan' | 'zoom';
export type PdfScrollAction = 'zoom' | 'pan' | 'switch';

export interface PdfBindings {
  bare: PdfScrollAction;
  shift: PdfScrollAction;
  meta: PdfScrollAction;
}

export interface BoardSettingPatch {
  twoFingerPan?: boolean;
  wheelDetection?: boolean;
  dragToZoom?: boolean;
}

export interface Recommendation {
  /** False when the gesture cannot drive the requested action. */
  ok: boolean;
  /** Human-readable description of the resulting change (shown in the UI). */
  summary: string;
  /** Partial board patch to merge into global render settings. */
  board?: BoardSettingPatch;
  /** Full resulting PDF bindings (a valid 3-action permutation) to persist. */
  pdf?: PdfBindings;
}

const PDF_SLOTS = ['bare', 'shift', 'meta'] as const;

/** Assign `action` to `slot`, swapping to keep a valid 3-action permutation. */
function assignPdfSlot(cur: PdfBindings, slot: keyof PdfBindings, action: PdfScrollAction): PdfBindings {
  if (cur[slot] === action) return { ...cur };
  const displaced = PDF_SLOTS.find(s => cur[s] === action)!;
  const next: PdfBindings = { ...cur };
  next[displaced] = cur[slot];
  next[slot] = action;
  return next;
}

function modifierToPdfSlot(m: GestureModifier): keyof PdfBindings | null {
  switch (m) {
    case 'none': return 'bare';
    case 'shift': return 'shift';
    case 'meta': return 'meta';
    case 'ctrl': return null; // pinch — handled separately
  }
}

/**
 * Map a demonstrated gesture onto a setting change. `currentPdf` is required
 * so PDF recommendations return a complete, valid binding permutation.
 */
export function recommendSetting(input: {
  surface: Surface;
  action: Action;
  verdict: GestureVerdict;
  currentPdf: PdfBindings;
}): Recommendation {
  const { surface, action, verdict, currentPdf } = input;
  const { device, modifier } = verdict;

  if (surface === 'board') return recommendBoard(action, device, modifier);
  return recommendPdf(action, device, modifier, currentPdf);
}

function recommendBoard(action: Action, device: GestureDevice, modifier: GestureModifier): Recommendation {
  // Pinch always zooms; it can't be bound to pan.
  if (device === 'trackpad-pinch') {
    return action === 'zoom'
      ? { ok: true, summary: 'Pinch already zooms. Bare scroll set to PAN (trackpad layout).', board: { twoFingerPan: true } }
      : { ok: false, summary: 'Pinch is a zoom gesture — it can’t be assigned to pan.' };
  }

  if (device === 'drag') {
    return action === 'pan'
      ? { ok: true, summary: 'Bare drag will PAN the board (Shift+drag zooms).', board: { dragToZoom: false } }
      : { ok: true, summary: 'Bare drag will ZOOM the board (Shift+drag pans).', board: { dragToZoom: true } };
  }

  // Wheel / swipe.
  if (modifier === 'meta') {
    return { ok: false, summary: 'The board has no Cmd/Ctrl+scroll binding — use plain scroll or Shift+scroll.' };
  }

  if (action === 'pan') {
    if (modifier === 'none') {
      // Bare scroll pans. If it's a mouse wheel, leave the safety net off so
      // the wheel genuinely pans rather than being re-routed to zoom.
      const board: BoardSettingPatch = { twoFingerPan: true };
      if (device === 'mouse-wheel') board.wheelDetection = false;
      return { ok: true, summary: 'Bare scroll will PAN the board (Shift+scroll zooms).', board };
    }
    // shift+scroll pans ⇒ bare scroll zooms.
    return { ok: true, summary: 'Shift+scroll will PAN; bare scroll will ZOOM the board.', board: { twoFingerPan: false } };
  }

  // action === 'zoom'
  if (modifier === 'none') {
    // Bare scroll zooms ⇒ classic mouse layout.
    return { ok: true, summary: 'Bare scroll will ZOOM the board (Shift+scroll pans).', board: { twoFingerPan: false } };
  }
  // shift+scroll zooms ⇒ bare scroll pans.
  return { ok: true, summary: 'Shift+scroll will ZOOM; bare scroll will PAN the board.', board: { twoFingerPan: true } };
}

function recommendPdf(action: Action, device: GestureDevice, modifier: GestureModifier, currentPdf: PdfBindings): Recommendation {
  const pdfAction: PdfScrollAction = action; // 'pan' | 'zoom' are both valid PDF actions

  if (device === 'trackpad-pinch') {
    return action === 'zoom'
      ? { ok: true, summary: 'Pinch already zooms the PDF (built-in) — no change needed.' }
      : { ok: false, summary: 'Pinch is a zoom gesture — it can’t be assigned to pan.' };
  }

  if (device === 'drag') {
    return action === 'pan'
      ? { ok: true, summary: 'The PDF already pans by dragging (built-in) — no change needed.' }
      : { ok: false, summary: 'The PDF can’t zoom by dragging — use scroll or pinch for zoom.' };
  }

  // Wheel / swipe → assign the matching modifier slot.
  const slot = modifierToPdfSlot(modifier);
  if (!slot) {
    return { ok: false, summary: 'Unsupported modifier for PDF scroll binding.' };
  }
  const next = assignPdfSlot(currentPdf, slot, pdfAction);
  const slotLabel = slot === 'bare' ? 'Bare scroll' : slot === 'shift' ? 'Shift+scroll' : 'Cmd/Ctrl+scroll';
  return {
    ok: true,
    summary: `${slotLabel} will ${action.toUpperCase()} the PDF.`,
    pdf: next,
  };
}
