/**
 * Per-file board-load progress tracker.
 *
 * When the user opens NM-G611 (29 MB TVW) the visible delay between
 * "click library row" and "first frame on canvas" has several contributors:
 * HTTP fetch through the backend, IndexedDB cache lookup, TVW parse,
 * cache serialisation, scene build, and the first GPU upload. Without
 * instrumentation it's impossible to tell whether the slow phase is
 * download, parse, or render — each call site logs to log.* but nothing
 * surfaces in the UI.
 *
 * This store collects timestamped phase markers from each call site and
 * a `LoadProgressOverlay` subscribes to it. Keeps the same shape as
 * update-store's progress entries so the overlay rendering can copy the
 * existing patterns.
 *
 * Lifecycle:
 *   start(fileName, fileSize)  → starts tracking; clears prior log
 *   setPhase(name, detail?)    → marks the previous phase as complete and
 *                                opens a new one. Each phase carries an
 *                                elapsedMs computed at finish time.
 *   pushLog(message)           → free-text entry inside the current phase
 *                                (e.g. "downloaded 5.2 MB / 29.4 MB").
 *   finish()                   → marks the current phase complete and
 *                                schedules dismissal after a brief
 *                                hold so the user sees the final totals.
 *   abort(reason)              → same as finish but tagged 'error'.
 *
 * Subscribers via subscribe() are notified on every mutation. The overlay
 * is mounted alongside <UpdateProgressOverlay /> and renders only when
 * `visible` is true.
 */

export type LoadPhaseStatus = 'running' | 'done' | 'error';

export interface LoadPhase {
  name: string;
  detail?: string;
  startedAt: number;     // performance.now()
  endedAt?: number;      // performance.now() when phase closed
  elapsedMs?: number;    // endedAt - startedAt
  status: LoadPhaseStatus;
}

export interface LoadLogEntry {
  /** wall-clock ms since load started — for display */
  tMs: number;
  message: string;
  phase: string;
}

interface LoadProgressState {
  visible: boolean;
  fileName: string | null;
  fileSize: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  phases: LoadPhase[];
  log: LoadLogEntry[];
}

const HOLD_AFTER_FINISH_MS = 1500;

class LoadProgressStore {
  private state: LoadProgressState = {
    visible: false,
    fileName: null,
    fileSize: null,
    startedAt: null,
    finishedAt: null,
    phases: [],
    log: [],
  };

  private subs = new Set<() => void>();
  private dismissTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic version bumped on every notify(). Subscribers reading via
   *  useSyncExternalStore use this primitive snapshot to detect changes —
   *  the state object itself is mutated in place for performance (phase
   *  log can have hundreds of entries) and would otherwise fail React's
   *  identity-equality snapshot comparison. */
  private version = 0;

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }

  /** Stable snapshot for useSyncExternalStore: bumps each mutation. */
  getVersion(): number { return this.version; }

  private notify() {
    this.version++;
    for (const cb of this.subs) cb();
  }

  getState(): LoadProgressState {
    return this.state;
  }

  /** Start tracking a new load. Wipes any previous in-progress state. */
  start(fileName: string, fileSize: number | null): void {
    if (this.dismissTimer) { clearTimeout(this.dismissTimer); this.dismissTimer = null; }
    this.state = {
      visible: true,
      fileName,
      fileSize,
      startedAt: performance.now(),
      finishedAt: null,
      phases: [],
      log: [],
    };
    this.notify();
  }

  /** Close the previous phase (if any) and open a new one. */
  setPhase(name: string, detail?: string): void {
    if (!this.state.visible) return;
    const now = performance.now();
    const last = this.state.phases[this.state.phases.length - 1];
    if (last && last.status === 'running') {
      last.endedAt = now;
      last.elapsedMs = now - last.startedAt;
      last.status = 'done';
    }
    this.state.phases.push({
      name,
      detail,
      startedAt: now,
      status: 'running',
    });
    this.notify();
  }

  /** Update the detail string of the current phase (e.g. download progress). */
  setPhaseDetail(detail: string): void {
    if (!this.state.visible) return;
    const last = this.state.phases[this.state.phases.length - 1];
    if (!last || last.status !== 'running') return;
    last.detail = detail;
    this.notify();
  }

  /** Free-text log entry inside the current phase. */
  pushLog(message: string): void {
    if (!this.state.visible || this.state.startedAt == null) return;
    const last = this.state.phases[this.state.phases.length - 1];
    this.state.log.push({
      tMs: performance.now() - this.state.startedAt,
      message,
      phase: last?.name ?? '',
    });
    this.notify();
  }

  /** Mark current phase complete; schedule overlay dismissal. */
  finish(): void {
    if (!this.state.visible) return;
    const now = performance.now();
    const last = this.state.phases[this.state.phases.length - 1];
    if (last && last.status === 'running') {
      last.endedAt = now;
      last.elapsedMs = now - last.startedAt;
      last.status = 'done';
    }
    this.state.finishedAt = now;
    this.notify();
    this.scheduleDismiss();
  }

  /** Mark current phase as failed; show overlay until user dismisses. */
  abort(reason: string): void {
    if (!this.state.visible) return;
    const now = performance.now();
    const last = this.state.phases[this.state.phases.length - 1];
    if (last && last.status === 'running') {
      last.endedAt = now;
      last.elapsedMs = now - last.startedAt;
      last.status = 'error';
      last.detail = reason;
    }
    this.state.finishedAt = now;
    this.notify();
  }

  /** User-triggered dismiss (X button on overlay). */
  dismiss(): void {
    if (this.dismissTimer) { clearTimeout(this.dismissTimer); this.dismissTimer = null; }
    this.state.visible = false;
    this.notify();
  }

  private scheduleDismiss(): void {
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = setTimeout(() => {
      this.dismissTimer = null;
      this.state.visible = false;
      this.notify();
    }, HOLD_AFTER_FINISH_MS);
  }
}

export const loadProgressStore = new LoadProgressStore();
