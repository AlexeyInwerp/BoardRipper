/** Reactive store for update checking — polls /api/update/status */
import { Emitter } from './emitter';
import { log } from './log-store';

export interface Manifest {
  version: string;
  counter: number;
  released_at: string;
  not_after: string;
  important: boolean;
  important_reason?: string;
  notes_url?: string;
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

  get state(): UpdateState { return this._state; }
  get updating(): boolean { return this._updating; }
  get progress(): ProgressEntry[] { return this._progress; }

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
    if (this._updating) return;
    this._updating = true;
    this._progress = [];
    log.update.log(`Starting update to ${this._state.latest_version}...`);
    this.notify();

    try {
      const res = await apiFetch('/api/update/apply', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        log.update.error(`Apply failed: ${err.error}`);
        this._progress.push({ time: new Date().toISOString(), message: err.error, status: 'error' });
        this._updating = false;
        this.notify();
        return;
      }
    } catch {
      log.update.error('Apply request failed');
      this._progress.push({ time: new Date().toISOString(), message: 'Request failed', status: 'error' });
      this._updating = false;
      this.notify();
      return;
    }

    // Stream progress via SSE
    log.update.log('Streaming update progress...');
    const es = new EventSource('/api/update/progress');
    es.onmessage = (e) => {
      const entry: ProgressEntry = JSON.parse(e.data);
      this._progress.push(entry);

      // Mirror progress to debug log
      if (entry.status === 'error') {
        log.update.error(entry.message);
      } else {
        log.update.log(entry.message);
      }
      this.notify();

      if (entry.status === 'done' || entry.status === 'error') {
        es.close();
        this._updating = false;
        this.notify();

        // If update succeeded, auto-reload after 30s
        if (entry.status === 'done') {
          log.update.log('Update complete — reloading in 30s...');
          setTimeout(() => window.location.reload(), 30_000);
        }
      }
    };
    es.onerror = () => {
      log.update.warn('SSE connection lost');
      es.close();
      this._updating = false;
      this.notify();
    };
  }
}

export const updateStore = new UpdateStore();

// Initial fetch + periodic poll every 30 minutes (skip in test environments)
if (typeof window !== 'undefined' && !import.meta.env.SSR) {
  updateStore.fetchStatus();
  setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
}
