/**
 * Ask the browser to re-check `sw.js` at the moments a long-lived page would
 * otherwise never do it.
 *
 * A registered service worker is only re-checked on navigation (and, at most,
 * once a day by the browser's own byte-check on fetch). `useRegisterSW`
 * registers once and never asks again. That is fine on a desktop, where a
 * tab is reloaded many times a day. It is not fine on an iPad: a Safari tab
 * lives for weeks, and an installed home-screen app is *resumed*, not
 * relaunched — no navigation ever happens, so the worker installed on the
 * first visit keeps serving its precached app shell indefinitely. Found
 * 2026-09-23 with an iPad still on 0.40 three releases later, while the host
 * served 0.43.2 with `sw.js` at `no-cache`: nothing on the server could reach
 * a page that never asked.
 *
 * Three triggers, in the order they matter on a tablet:
 *  - the page becoming visible again — that IS the resume;
 *  - the network coming back — an update check while offline just fails;
 *  - an hourly timer, for a page that stays visible and online.
 *
 * `update()` only *fetches* `sw.js` and installs a new worker if it differs.
 * With `registerType: 'prompt'` the new worker then waits, and
 * `UpdatePrompt` turns that into the "new version — Reload" toast. This
 * module does not decide anything; it only makes sure the question gets asked.
 */

export interface SwUpdateTarget {
  update(): Promise<unknown>;
}

/** The two DOM surfaces this module touches, reduced to what it calls — so a
 *  test can hand in a plain object instead of a Document. */
export interface EventHost {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface VisibilityHost extends EventHost {
  visibilityState: DocumentVisibilityState;
}

export interface SwUpdateOptions {
  /** How often to re-check while the page stays visible. Default one hour. */
  intervalMs?: number;
  /** The document to watch for visibility; `globalThis.document` by default. */
  doc?: VisibilityHost;
  /** The window to watch for `online`; `globalThis.window` by default. */
  win?: EventHost;
  /** Timer functions, injectable for tests. */
  timers?: {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  /** Where a failed check is reported; a rejected `update()` is not an error
   *  the user can act on (offline, host down), so it is logged, not thrown. */
  onError?: (err: unknown) => void;
}

/** Start the checks. Returns the function that stops them all. */
export function scheduleSwUpdateChecks(reg: SwUpdateTarget, opts: SwUpdateOptions = {}): () => void {
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  const timers = opts.timers ?? { setInterval, clearInterval };
  const onError = opts.onError ?? (() => {});

  const check = () => {
    // Never check a page the user cannot see: the answer would arrive as a
    // toast into a background tab, and the browser may throttle the fetch
    // anyway. The visibility trigger below runs the check on return.
    if (doc && doc.visibilityState !== 'visible') return;
    let p: Promise<unknown>;
    try { p = reg.update(); } catch (err) { onError(err); return; }
    p.catch(onError);
  };

  const onVisible = () => { if (doc?.visibilityState === 'visible') check(); };
  const onOnline = () => check();

  doc?.addEventListener('visibilitychange', onVisible);
  win?.addEventListener('online', onOnline);
  const timer = timers.setInterval(check, intervalMs);

  return () => {
    doc?.removeEventListener('visibilitychange', onVisible);
    win?.removeEventListener('online', onOnline);
    timers.clearInterval(timer);
  };
}
