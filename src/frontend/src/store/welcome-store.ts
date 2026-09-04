/**
 * First-run "welcome / input setup" gate.
 *
 * Shows the WelcomeSetup modal once per install (persisted in localStorage).
 * Auto-show is suppressed under WebDriver (Playwright) so the E2E suite isn't
 * blocked by a first-run overlay. Settings can re-open it later via `show()`.
 */

const DONE_KEY = 'boardripper-welcome-done';

type Listener = () => void;

class WelcomeStore {
  private listeners = new Set<Listener>();
  open = false;

  constructor() {
    let done = false;
    try {
      done = localStorage.getItem(DONE_KEY) === '1';
    } catch {
      done = true; // storage blocked — don't nag
    }
    const automated = typeof navigator !== 'undefined' && navigator.webdriver === true;
    // The wizard classifies wheel/trackpad gestures. A touch device has
    // neither, so on a coarse pointer there is nothing to set up — skip it and
    // mark it done so a later mouse (e.g. iPad + trackpad) can still be
    // calibrated from Settings rather than nagged on first launch.
    const coarse = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(pointer: coarse)').matches;
    this.open = !done && !automated && !coarse;
    if (coarse && !done) {
      try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    }
  }

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): boolean => this.open;

  private notify(): void {
    this.listeners.forEach(l => l());
  }

  /** Force-open (e.g. a "Re-run setup" button in Settings). */
  show(): void {
    this.open = true;
    this.notify();
  }

  /** Close WITHOUT persisting — "Skip for now" must mean now, not forever.
   *  The modal may auto-show again next launch. */
  dismiss(): void {
    this.open = false;
    this.notify();
  }

  /** Close and mark complete so it never auto-shows again. */
  finish(): void {
    this.open = false;
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* ignore */ }
    this.notify();
  }
}

export const welcomeStore = new WelcomeStore();
