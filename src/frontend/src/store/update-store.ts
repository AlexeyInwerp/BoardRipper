/** Reactive store for update checking — polls /api/update/status */
import { Emitter } from './emitter';
import { log } from './log-store';
import { isLiteBuild } from './build-mode';

// Update-in-progress persistence. When the orchestrator stops the running
// container, the SSE stream dies; the page may also be refreshed before the
// new container is up. The flag below lets us re-show the "Update in progress"
// overlay across that gap so the user doesn't think the update failed and
// click "Update" again.
const RESTART_FLAG_KEY = 'boardripper-update-in-flight';
const RESTART_FLAG_MAX_AGE_MS = 5 * 60 * 1000;     // 5 min: older flags are stale
const HEALTH_POLL_INTERVAL_MS = 2_000;
const HEALTH_POLL_TIMEOUT_MS = 120_000;            // give the new container up to 2 min

interface RestartFlag {
  startedAt: number;       // Date.now() when Apply was kicked off
  fromVersion: string;     // version we updated *from* (for post-reload diff)
  expectedVersion?: string;
}

function saveRestartFlag(flag: RestartFlag) {
  try { localStorage.setItem(RESTART_FLAG_KEY, JSON.stringify(flag)); } catch { /* quota */ }
}
function loadRestartFlag(): RestartFlag | null {
  try {
    const raw = localStorage.getItem(RESTART_FLAG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RestartFlag;
    if (typeof parsed.startedAt !== 'number' ||
        Date.now() - parsed.startedAt > RESTART_FLAG_MAX_AGE_MS) {
      localStorage.removeItem(RESTART_FLAG_KEY);
      return null;
    }
    return parsed;
  } catch { return null; }
}
function clearRestartFlag() {
  try { localStorage.removeItem(RESTART_FLAG_KEY); } catch { /* nothing */ }
}

export interface Manifest {
  version: string;
  counter: number;
  released_at: string;
  not_after: string;
  important: boolean;
  important_reason?: string;
  notes_url?: string;
  notes?: string;
  tarball: { url_primary: string; sha256: string; size_bytes: number };
  image: { registry: string; tag: string; digest: string };
}

type UpdateState = {
  current_version: string;
  latest_version?: string;
  has_update: boolean;
  checked_at?: string;
  manifest?: Manifest | null;
  docker_available: boolean;
  error?: string;
};

type ProgressEntry = {
  time: string;
  message: string;
  status: 'info' | 'error' | 'done';
};

let bootstrapped = false;
async function ensureBootstrap(): Promise<void> {
  if (bootstrapped) return;
  try {
    await fetch('/api/update/bootstrap', { credentials: 'same-origin' });
    bootstrapped = true;
  } catch {
    // Will be retried on next call.
  }
}

async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  await ensureBootstrap();
  return fetch(input, { ...init, credentials: 'same-origin' });
}

class UpdateStore extends Emitter {
  private _state: UpdateState = {
    current_version: 'dev',
    has_update: false,
    docker_available: false,
  };
  private _updating = false;
  private _progress: ProgressEntry[] = [];
  private _restarting = false;            // true while the new container is coming up
  private _restartingFromVersion = '';
  private _terminalSeen = false;          // true once SSE delivered done|error
  private _settleUntil = 0;               // ms-epoch; while in the future, peer
                                          // stores should treat transient HTTP
                                          // failures as expected (proxy → new
                                          // container handoff) rather than logging
                                          // them as real warnings.

  get state(): UpdateState { return this._state; }
  get updating(): boolean { return this._updating; }
  get progress(): ProgressEntry[] { return this._progress; }
  get restarting(): boolean { return this._restarting; }
  get restartingFromVersion(): string { return this._restartingFromVersion; }
  /** True for the brief window after a self-update reload where the
   *  proxy/backend handoff may produce transient 502/503/network errors.
   *  Other stores can use this to suppress noisy `log.X.warn(...)` calls
   *  for fetch failures that would otherwise read as a "broken update". */
  get isPostRestartSettling(): boolean { return Date.now() < this._settleUntil; }

  async fetchStatus() {
    try {
      const res = await apiFetch('/api/update/status');
      if (!res.ok) return;
      this._state = await res.json();
      if (this._state.has_update) {
        log.update.log(`Update available: ${this._state.current_version} → ${this._state.latest_version}`);
      } else if (this._state.current_version !== 'dev') {
        log.update.log(`Running ${this._state.current_version} (up to date)`);
      }
      this.notify();
    } catch { /* offline — dev mode or no backend */ }
  }

  async check() {
    log.update.log('Checking for updates...');
    try {
      const res = await apiFetch('/api/update/check', { method: 'POST' });
      if (!res.ok) {
        log.update.error(`Check failed: HTTP ${res.status}`);
        return;
      }
      this._state = await res.json();
      if (this._state.has_update) {
        log.update.log(`New version found: ${this._state.latest_version}`);
      } else {
        log.update.log(`Already on latest (${this._state.current_version})`);
      }
      this.notify();
    } catch (e) {
      log.update.error('Check failed:', e);
    }
  }

  async apply() {
    if (this._updating || this._restarting) return;
    this._updating = true;
    this._progress = [];
    this._terminalSeen = false;
    log.update.log(`Starting update to ${this._state.latest_version}...`);
    saveRestartFlag({
      startedAt: Date.now(),
      fromVersion: this._state.current_version,
      expectedVersion: this._state.latest_version,
    });
    this.notify();

    try {
      const res = await apiFetch('/api/update/apply', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        log.update.error(`Apply failed: ${err.error}`);
        this._progress.push({ time: new Date().toISOString(), message: err.error, status: 'error' });
        this._updating = false;
        clearRestartFlag();
        this.notify();
        return;
      }
    } catch {
      log.update.error('Apply request failed');
      this._progress.push({ time: new Date().toISOString(), message: 'Request failed', status: 'error' });
      this._updating = false;
      clearRestartFlag();
      this.notify();
      return;
    }

    this.streamProgress();
  }

  /**
   * Apply an update bundle the user dropped onto the UI. Same wire shape as
   * apply() — multipart POST instead of empty POST, then the same SSE stream
   * for progress. Recovery path when the network-fetched update can't reach
   * GHCR / ripperdoc.de or when the in-binary updater is broken.
   */
  async applyBundle(file: File) {
    if (this._updating || this._restarting) return;
    this._updating = true;
    this._progress = [];
    this._terminalSeen = false;
    log.update.log(`Uploading bundle ${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MiB)...`);
    saveRestartFlag({
      startedAt: Date.now(),
      fromVersion: this._state.current_version,
      // expectedVersion unknown until the backend parses the bundle's
      // manifest — we'll find out post-reload by querying status.
    });
    this.notify();

    const form = new FormData();
    form.append('bundle', file);

    try {
      const res = await apiFetch('/api/update/apply-bundle', { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        log.update.error(`Bundle apply failed: ${err.error}`);
        this._progress.push({ time: new Date().toISOString(), message: err.error, status: 'error' });
        this._updating = false;
        clearRestartFlag();
        this.notify();
        return;
      }
    } catch {
      log.update.error('Bundle upload failed');
      this._progress.push({ time: new Date().toISOString(), message: 'Upload failed', status: 'error' });
      this._updating = false;
      clearRestartFlag();
      this.notify();
      return;
    }

    this.streamProgress();
  }

  // Common SSE consumption used by both apply() and applyBundle(). The SSE
  // stream typically dies before reaching a terminal entry because the
  // orchestrator stops our container; that's the expected success path. When
  // that happens we transition into the "restarting" state and poll
  // /api/health until the new container responds, then reload.
  private streamProgress() {
    log.update.log('Streaming update progress...');
    const es = new EventSource('/api/update/progress');
    es.onmessage = (e) => {
      const entry: ProgressEntry = JSON.parse(e.data);
      this._progress.push(entry);
      if (entry.status === 'error') log.update.error(entry.message);
      else log.update.log(entry.message);
      this.notify();
      if (entry.status === 'done' || entry.status === 'error') {
        this._terminalSeen = true;
        es.close();
        if (entry.status === 'done') {
          // Successful in-process completion (rare — orchestrator usually
          // kills our container before this fires). Treat the same as
          // disconnect-during-update: enter the restarting state and poll.
          this.enterRestartingState();
        } else {
          // Hard failure — backend is still alive, no restart needed.
          this._updating = false;
          clearRestartFlag();
          this.notify();
        }
      }
    };
    es.onerror = () => {
      // SSE close happens for two reasons:
      // 1. Backend stopped (orchestrator killed our container) — expected
      // 2. Network blip while update was still queued — much rarer
      // Either way, transition to the restarting state and poll /api/health.
      es.close();
      if (!this._terminalSeen) {
        log.update.log('SSE closed — backend restarting; polling /api/health...');
        this.enterRestartingState();
      }
    };
  }

  private enterRestartingState() {
    this._updating = false;
    this._restarting = true;
    this._restartingFromVersion = this._state.current_version;
    this.notify();
    this.waitForRestart();
  }

  // Wait for the orchestrator to actually swap containers, then reload.
  //
  // The earlier "first /api/health response wins" approach reloaded against
  // the *old* backend in the (typical) window where Apply has launched the
  // orchestrator container but the orchestrator's `containers/<self>/stop`
  // call hasn't yet propagated. The page would reload, see the same old
  // version, log "rolled back" via verifyResumeOutcome, and the user would
  // sit on the apparently-unchanged UI for another 30 minutes (next
  // background fetchStatus tick) before noticing the version had changed.
  //
  // Reload ONLY when we have real evidence of a swap. Two paths satisfy that:
  //
  //   (a) /api/update/status returns the manifest's expected new version.
  //       The data volume holds the per-install secret so the cookie stays
  //       valid across the swap; this is the authoritative signal.
  //   (b) /api/health was observed down at least once, then up. Covers the
  //       case where /api/update/status auth races and we can't read it
  //       (rare, but the original poll-by-health flow was the prior shape
  //       so keep it as a fallback).
  //
  // Polling stops at HEALTH_POLL_TIMEOUT_MS so a never-returning backend
  // leaves the overlay up for manual refresh instead of looping forever.
  private async waitForRestart() {
    const start = Date.now();
    const fromVersion = this._restartingFromVersion;
    const expectedVersion = (() => {
      const f = loadRestartFlag();
      return f?.expectedVersion ?? '';
    })();
    let sawDown = false;
    while (Date.now() - start < HEALTH_POLL_TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL_MS));

      // Path (a): authoritative version probe.
      try {
        const r = await fetch('/api/update/status', { credentials: 'same-origin', cache: 'no-store' });
        if (r.ok) {
          const s = await r.json().catch(() => null) as { current_version?: string } | null;
          const cur = s?.current_version;
          if (cur && cur !== 'dev' && cur !== fromVersion && (!expectedVersion || cur === expectedVersion)) {
            log.update.log(`Backend now ${cur} — reloading`);
            window.location.reload();
            return;
          }
        } else if (r.status >= 500 || r.status === 0) {
          sawDown = true;
        }
      } catch {
        sawDown = true;
      }

      // Path (b): downtime-then-up health check.
      try {
        const r = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) {
          sawDown = true;
          continue;
        }
        if (sawDown) {
          log.update.log('Backend healthy after downtime — reloading');
          window.location.reload();
          return;
        }
      } catch {
        sawDown = true;
      }
    }
    log.update.warn(`Restart timeout (${HEALTH_POLL_TIMEOUT_MS / 1000}s) — backend did not return`);
  }

  // Called from init code at module bottom: if there is a recent restart
  // flag in localStorage, fetch status and log whether the orchestration
  // succeeded. Public because we call it via the exported singleton from
  // outside the class.
  //
  // The page may have rendered against a Synology DSM Reverse Proxy /
  // ingress cache while the container itself is still in handoff (old stop
  // → new start). The first /api/update/status call can therefore 502 or
  // return stale data while the backend finishes binding port 8080. We
  // retry until we see a real backend version (not the default 'dev'
  // sentinel from this store's initial state) so the success/failure
  // verdict isn't decided on the boot-time race; otherwise a clean update
  // can read as "rollback or failure" purely because the bootstrap fetch
  // landed in the wrong half-second.
  resumeIfRestarting() {
    const flag = loadRestartFlag();
    if (!flag) return;

    // Open the settle window before the first fetch attempt so peer stores
    // hitting fetch the same instant don't warn-log their own 502s.
    this._settleUntil = Date.now() + 30_000;
    this.notify();

    void this.verifyResumeOutcome(flag);
  }

  private async verifyResumeOutcome(flag: RestartFlag) {
    const start = Date.now();
    const maxWaitMs = 30_000;
    const pollIntervalMs = 1_500;

    while (Date.now() - start < maxWaitMs) {
      await this.fetchStatus();
      const post = this._state.current_version;
      if (post && post !== 'dev') {
        // Real backend response. Issue the verdict.
        if (post !== flag.fromVersion) {
          log.update.log(`Update applied: ${flag.fromVersion} → ${post}`);
        } else {
          // Backend reports the same version we started from. Could be a
          // legitimate rollback (orchestrator's 60 s healthcheck failed
          // and it restored the previous container), or the orchestrator
          // never reached the swap. Either way the user is on the old
          // version — softer wording, since the user already knows the
          // headline ("update did not take") from the version string.
          log.update.warn(`Still on ${flag.fromVersion} after restart — orchestrator likely rolled back. Check Debug → updater logs.`);
        }
        clearRestartFlag();
        return;
      }
      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    // Timed out waiting for a stable backend response. Don't lie about the
    // outcome — neither success nor rollback is established. Most often
    // the proxy is still warming up; the next periodic fetchStatus will
    // resolve the UI normally.
    log.update.log(`Restart settled without a confirmed status response — refresh manually if the version looks wrong.`);
    clearRestartFlag();
  }
}

export const updateStore = new UpdateStore();

// Test-harness hook: expose the singleton on window so e2e tests can probe
// `updating` / `restarting` / `progress.length` without having to drive
// React-DevTools or walk the fiber tree. No security concern — every method
// the store calls is already reachable from any in-page script with the
// installed cookie. Kept under a `__br` prefix so it's clearly marked
// internal and unlikely to collide with anything user code touches.
if (typeof window !== 'undefined') {
  (window as unknown as { __brUpdateStore?: UpdateStore }).__brUpdateStore = updateStore;
}

// Initial fetch + periodic poll every 30 minutes (skip in test environments).
// The resumeIfRestarting() call comes first so the in-progress modal can
// re-appear before the first status fetch completes — the modal disappears
// once the post-restart status comes back and we know the new version.
if (typeof window !== 'undefined' && !import.meta.env.SSR && !isLiteBuild()) {
  updateStore.resumeIfRestarting();
  updateStore.fetchStatus();
  setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
}
