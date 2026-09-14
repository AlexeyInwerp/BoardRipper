/**
 * First-run library setup gate.
 *
 * Unlike the gesture wizard (welcome-store), this is NOT a localStorage
 * "done" flag: the modal shows whenever the BACKEND reports a library that
 * was never indexed (no scan, no files), so it comes back by itself after a
 * database reset. "Skip for now" hides it for this page load; "Don't show
 * again" persists and is cleared by the reset path.
 */

import { Emitter } from './emitter';

const NEVER_KEY = 'boardripper-firstrun-never';
const FORCE_KEY = 'boardripper-firstrun-force';
const SESSION_KEY = 'boardripper-firstrun-skipped';

class FirstRunStore extends Emitter {
  /** true = opened from Settings / start page regardless of library state. */
  forced = false;
  skipped = (() => { try { return sessionStorage.getItem(SESSION_KEY) === '1'; } catch { return false; } })();
  never = (() => { try { return localStorage.getItem(NEVER_KEY) === '1'; } catch { return false; } })();

  getSnapshot = () => this._snap;
  private _snap = this.build();
  private build() { return { forced: this.forced, skipped: this.skipped, never: this.never }; }
  private bump() { this._snap = this.build(); this.notify(); }

  /** E2E runs under WebDriver, where the auto-show is suppressed so unrelated
   *  specs are never blocked; a spec that tests the modal sets the force key. */
  automated(): boolean {
    const wd = typeof navigator !== 'undefined' && navigator.webdriver === true;
    if (!wd) return false;
    try { return localStorage.getItem(FORCE_KEY) !== '1'; } catch { return true; }
  }

  show(): void { this.forced = true; this.bump(); }

  /** Hide for this page load only. */
  skip(): void {
    this.forced = false;
    this.skipped = true;
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    this.bump();
  }

  /** Hide until a reset brings the library back to "never indexed". */
  neverAgain(): void {
    this.forced = false;
    this.never = true;
    try { localStorage.setItem(NEVER_KEY, '1'); } catch { /* ignore */ }
    this.bump();
  }

  /** Called by the reset path so the setup shows after the reload. */
  clearNever(): void {
    this.never = false;
    try { localStorage.removeItem(NEVER_KEY); sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    this.bump();
  }

  /** Close after Start — the scan is running, the Library shows it. */
  close(): void { this.forced = false; this.skipped = true; this.bump(); }
}

export const firstRunStore = new FirstRunStore();
