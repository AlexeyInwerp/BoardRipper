/**
 * Scroll-wheel bindings for both viewers — the one place that knows what a
 * modifier + wheel does.
 *
 * Each viewer has three slots (bare, Shift, ⌘/Ctrl) and each slot holds one
 * action. The slots are independent: two slots may hold the same action.
 * They used to be a *permutation* — every action exactly once — which is
 * what made Shift+Scroll zoom whenever bare scroll panned, and issue #40 is
 * exactly that: every browser turns Shift+wheel into a horizontal `deltaX`
 * before the page sees it (macOS's own gesture, and Chrome/Firefox do the
 * same on Windows), so a viewer that intercepts Shift for zoom takes the
 * user's horizontal scroll away. A pan that consumes `deltaX`/`deltaY`
 * follows whatever the OS decided; it needs no axis rule of its own.
 *
 * Defaults therefore leave Shift on Pan and put zoom on ⌘+Scroll (Preview's
 * convention) — for *new* installs. An existing install keeps the layout it
 * had; `render-settings.ts` writes that legacy layout out explicitly once,
 * marker-gated, so nobody's Shift+Scroll changes meaning under them.
 *
 * Dependency-free on purpose: `render-settings.ts` imports the PDF key and
 * legacy layout for that migration, so this module must not import it back.
 */

// ── PDF ──────────────────────────────────────────────────────────────────

export type ScrollAction = 'zoom' | 'pan' | 'switch';
export const SCROLL_ACTIONS: ScrollAction[] = ['zoom', 'pan', 'switch'];

export type ScrollSlot = 'bare' | 'shift' | 'meta';
export const SCROLL_SLOTS: ScrollSlot[] = ['bare', 'shift', 'meta'];

/** Which action each modifier performs in the PDF viewer. */
export interface ScrollBindings {
  bare: ScrollAction;   // no modifier
  shift: ScrollAction;  // shift + scroll
  meta: ScrollAction;   // cmd (mac) / ctrl (win) + scroll
}

export const SCROLL_BINDINGS_KEY = 'boardripper-pdf-scroll-bindings';
export const SCROLL_BINDINGS_EVENT = 'pdf-scroll-bindings-changed';

/** New installs: Shift stays the browser's horizontal scroll, ⌘ zooms. */
export const DEFAULT_SCROLL_BINDINGS: ScrollBindings = { bare: 'pan', shift: 'pan', meta: 'zoom' };
/** What every install had before the slots became independent. */
export const LEGACY_SCROLL_BINDINGS: ScrollBindings = { bare: 'pan', shift: 'zoom', meta: 'switch' };

function isScrollAction(v: unknown): v is ScrollAction {
  return (SCROLL_ACTIONS as unknown[]).includes(v);
}

export function loadScrollBindings(): ScrollBindings {
  try {
    const raw = localStorage.getItem(SCROLL_BINDINGS_KEY);
    if (!raw) return DEFAULT_SCROLL_BINDINGS;
    const p = JSON.parse(raw) as Partial<ScrollBindings>;
    if (isScrollAction(p.bare) && isScrollAction(p.shift) && isScrollAction(p.meta)) {
      return { bare: p.bare, shift: p.shift, meta: p.meta };
    }
  } catch { /* ignore */ }
  return DEFAULT_SCROLL_BINDINGS;
}

/** Persist and tell every mounted editor and PDF panel. */
export function saveScrollBindings(next: ScrollBindings): void {
  try { localStorage.setItem(SCROLL_BINDINGS_KEY, JSON.stringify(next)); } catch { /* quota / private mode */ }
  window.dispatchEvent(new CustomEvent(SCROLL_BINDINGS_EVENT, { detail: next }));
}

export function sameScrollBindings(a: ScrollBindings, b: ScrollBindings): boolean {
  return a.bare === b.bare && a.shift === b.shift && a.meta === b.meta;
}

// ── Board ────────────────────────────────────────────────────────────────

export type BoardScrollAction = 'pan' | 'zoom';
export const BOARD_SCROLL_ACTIONS: BoardScrollAction[] = ['pan', 'zoom'];

export interface BoardScrollBindings {
  bare: BoardScrollAction;
  shift: BoardScrollAction;
  meta: BoardScrollAction;
}

/** The three render-settings keys the board bindings live in. `twoFingerPan`
 *  is the bare slot (it predates the other two and has many readers); the
 *  modifier slots are their own keys. */
export interface BoardScrollSettings {
  twoFingerPan: boolean;
  wheelShiftAction: BoardScrollAction;
  wheelMetaAction: BoardScrollAction;
}

export function boardScrollBindings(s: BoardScrollSettings): BoardScrollBindings {
  return {
    bare: s.twoFingerPan ? 'pan' : 'zoom',
    shift: s.wheelShiftAction,
    meta: s.wheelMetaAction,
  };
}

export function boardScrollSettings(b: BoardScrollBindings): BoardScrollSettings {
  return {
    twoFingerPan: b.bare === 'pan',
    wheelShiftAction: b.shift,
    wheelMetaAction: b.meta,
  };
}

export const DEFAULT_BOARD_SCROLL_BINDINGS: BoardScrollBindings = { bare: 'pan', shift: 'pan', meta: 'zoom' };

export function isBoardScrollAction(v: unknown): v is BoardScrollAction {
  return v === 'pan' || v === 'zoom';
}

// ── Shared behaviour ─────────────────────────────────────────────────────

/**
 * The ribbon button: flip the bare slot between Pan and Zoom. The other
 * slots are left alone — unless the action just displaced from bare would
 * be reachable from nowhere, in which case it moves to Shift. Zoom is also
 * always on pinch and Ctrl+wheel, pan on drag, so this is a courtesy, not a
 * safety rule; it keeps the toggle a pure toggle for the default layout
 * ({pan, pan, zoom} ⇄ {zoom, pan, zoom}).
 */
export function toggleBareAction<A extends string, B extends { bare: A; shift: A; meta: A }>(b: B): B {
  const next: A = (b.bare === 'pan' ? 'zoom' : 'pan') as A;
  const out = { ...b, bare: next };
  const displaced = b.bare;
  if ((displaced === 'pan' || displaced === 'zoom') && out.shift !== displaced && out.meta !== displaced) {
    out.shift = displaced;
  }
  return out;
}

export const isMacPlatform: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? '');

/** Human label per slot, shared by every editor so they cannot drift. */
export const SLOT_LABEL: Record<ScrollSlot, string> = {
  bare: 'Scroll',
  shift: 'Shift + Scroll',
  meta: isMacPlatform ? '⌘ + Scroll' : 'Ctrl + Scroll',
};

export const ACTION_LABEL: Record<ScrollAction, string> = { zoom: 'Zoom', pan: 'Pan', switch: 'Page' };
export const ACTION_COLOR: Record<ScrollAction, string> = { zoom: '#00d4ff', pan: '#ffd93d', switch: '#ff6b9d' };

/** Shown beside a Shift slot bound to anything but Pan (issue #40). */
export const SHIFT_SCROLL_NOTE =
  'Shift + Scroll is the browser’s horizontal scroll. Leave it on Pan to keep that gesture; '
  + (isMacPlatform ? '⌘ + Scroll' : 'Ctrl + Scroll') + ' and pinch still zoom.';

/** Next action in the cycle a click on a pill performs. */
export function nextAction<A extends string>(actions: readonly A[], cur: A): A {
  const i = actions.indexOf(cur);
  return actions[(i + 1) % actions.length];
}
