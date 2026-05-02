/** Reactive store for the library-sync feature — polls /api/sync/status. */
import { Emitter } from './emitter';
import { log } from './log-store';

export type SyncSchedule = 'off' | 'daily' | 'weekly' | 'monthly';

export interface SyncConfig {
  enabled: boolean;
  url: string;
  user: string;
  has_password: boolean;
  target: string;
  schedule: SyncSchedule;
  strict: boolean;
}

export interface SyncStatus {
  running: boolean;
  phase: 'idle' | 'manifest' | 'diff' | 'download' | 'done' | 'error' | 'cancelled';
  description: string;
  started_at_iso?: string;
  files_total: number;
  files_done: number;
  bytes_total: number;
  bytes_done: number;
  current_file?: string;
  errors: number;
  last_run_at_iso?: string;
  last_run_files?: number;
  last_run_bytes?: number;
  last_run_exit?: number;
  last_run_message?: string;
  next_run_at_iso?: string;
}

export interface TargetCheck {
  exists: boolean;
  is_dir: boolean;
  writable: boolean;
  free_bytes: number;
}

const EMPTY_CONFIG: SyncConfig = {
  enabled: false,
  url: '',
  user: '',
  has_password: false,
  target: '',
  schedule: 'off',
  strict: false,
};

const EMPTY_STATUS: SyncStatus = {
  running: false,
  phase: 'idle',
  description: '',
  files_total: 0,
  files_done: 0,
  bytes_total: 0,
  bytes_done: 0,
  errors: 0,
};

class LibrarySyncStore extends Emitter {
  private _config: SyncConfig = EMPTY_CONFIG;
  private _status: SyncStatus = EMPTY_STATUS;
  private _configLoaded = false;
  private _backendAvailable = false;
  private _polling = false;
  private _pollHandle: ReturnType<typeof setInterval> | null = null;

  get config(): SyncConfig { return this._config; }
  get status(): SyncStatus { return this._status; }
  get configLoaded(): boolean { return this._configLoaded; }
  get backendAvailable(): boolean { return this._backendAvailable; }

  async fetchConfig() {
    try {
      const r = await fetch('/api/sync/config');
      if (!r.ok) { this._backendAvailable = false; this.notify(); return; }
      this._config = await r.json();
      this._configLoaded = true;
      this._backendAvailable = true;
      this.notify();
    } catch {
      this._backendAvailable = false;
      this.notify();
    }
  }

  async fetchStatus() {
    try {
      const r = await fetch('/api/sync/status');
      if (!r.ok) return;
      this._status = await r.json();
      this.notify();
    } catch { /* ignore */ }
  }

  async saveConfig(patch: Partial<SyncConfig> & { password?: string; clear_password?: boolean }) {
    const r = await fetch('/api/sync/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => 'save failed');
      throw new Error(text || `HTTP ${r.status}`);
    }
    this._config = await r.json();
    this.notify();
    log.update.log(`Library-sync config saved (schedule=${this._config.schedule}, enabled=${this._config.enabled})`);
  }

  async testConnection(): Promise<{ ok: boolean; manifest_bytes: number; message: string }> {
    const r = await fetch('/api/sync/test', { method: 'POST' });
    return r.json();
  }

  async checkTarget(path: string): Promise<TargetCheck> {
    const r = await fetch(`/api/sync/check-target?path=${encodeURIComponent(path)}`);
    if (!r.ok) return { exists: false, is_dir: false, writable: false, free_bytes: 0 };
    return r.json();
  }

  async start() {
    log.update.log('Library sync: starting…');
    const r = await fetch('/api/sync/start', { method: 'POST' });
    if (!r.ok && r.status !== 409) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    if (r.ok) this._status = await r.json();
    this.notify();
    this.startPolling();
  }

  async stop() {
    log.update.log('Library sync: cancelling…');
    const r = await fetch('/api/sync/stop', { method: 'POST' });
    if (r.ok) {
      this._status = await r.json();
      this.notify();
    }
  }

  /** Begin polling /status every 2 s. Stops automatically when sync is no longer running. */
  startPolling() {
    if (this._polling) return;
    this._polling = true;
    this._pollHandle = setInterval(async () => {
      await this.fetchStatus();
      if (!this._status.running && this._status.phase !== 'idle') {
        // settle one more tick then stop
        this._polling = false;
        if (this._pollHandle) clearInterval(this._pollHandle);
        this._pollHandle = null;
      }
    }, 2000);
  }
}

export const librarySyncStore = new LibrarySyncStore();

// Boot: fetch config + status once, then poll status every 30s when idle
// (to surface external runs — e.g. cron firing while the UI is open).
if (typeof window !== 'undefined' && !import.meta.env.SSR) {
  void librarySyncStore.fetchConfig();
  void librarySyncStore.fetchStatus();
  setInterval(() => {
    void librarySyncStore.fetchStatus();
    // If a sync starts behind our back, kick the fast poller.
    if (librarySyncStore.status.running) librarySyncStore.startPolling();
  }, 30_000);
}
