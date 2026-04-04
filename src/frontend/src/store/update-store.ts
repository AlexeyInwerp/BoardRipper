/** Reactive store for update checking — polls /api/update/status */
import { log } from './log-store';

type UpdateState = {
  current_version: string;
  latest_version?: string;
  has_update: boolean;
  checked_at?: string;
  release_info?: {
    tag_name: string;
    name: string;
    body: string;
    html_url: string;
    published_at: string;
  };
  docker_available: boolean;
  error?: string;
};

type ProgressEntry = {
  time: string;
  message: string;
  status: 'info' | 'error' | 'done';
};

let state: UpdateState = {
  current_version: 'dev',
  has_update: false,
  docker_available: false,
};

let updating = false;
let progress: ProgressEntry[] = [];
const listeners = new Set<() => void>();
let version = 0;
let lastVer = -1;
let cached: { state: UpdateState; updating: boolean; progress: ProgressEntry[] } | null = null;

function notify() {
  version++;
  listeners.forEach(fn => fn());
}

export const updateStore = {
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },

  getSnapshot() {
    if (lastVer !== version || !cached) {
      cached = { state: { ...state }, updating, progress: [...progress] };
      lastVer = version;
    }
    return cached;
  },

  async fetchStatus() {
    try {
      const res = await fetch('/api/update/status');
      if (!res.ok) return;
      state = await res.json();
      if (state.has_update) {
        log.update.log(`Update available: ${state.current_version} → ${state.latest_version}`);
      } else if (state.current_version !== 'dev') {
        log.update.log(`Running ${state.current_version} (up to date)`);
      }
      notify();
    } catch { /* offline — dev mode or no backend */ }
  },

  async check() {
    log.update.log('Checking for updates...');
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      if (!res.ok) {
        log.update.error(`Check failed: HTTP ${res.status}`);
        return;
      }
      state = await res.json();
      if (state.has_update) {
        log.update.log(`New version found: ${state.latest_version}`);
      } else {
        log.update.log(`Already on latest (${state.current_version})`);
      }
      notify();
    } catch (e) {
      log.update.error('Check failed:', e);
    }
  },

  async apply() {
    if (updating) return;
    updating = true;
    progress = [];
    log.update.log(`Starting update to ${state.latest_version}...`);
    notify();

    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        log.update.error(`Apply failed: ${err.error}`);
        progress.push({ time: new Date().toISOString(), message: err.error, status: 'error' });
        updating = false;
        notify();
        return;
      }
    } catch {
      log.update.error('Apply request failed');
      progress.push({ time: new Date().toISOString(), message: 'Request failed', status: 'error' });
      updating = false;
      notify();
      return;
    }

    // Stream progress via SSE
    log.update.log('Streaming update progress...');
    const es = new EventSource('/api/update/progress');
    es.onmessage = (e) => {
      const entry: ProgressEntry = JSON.parse(e.data);
      progress.push(entry);

      // Mirror progress to debug log
      if (entry.status === 'error') {
        log.update.error(entry.message);
      } else {
        log.update.log(entry.message);
      }
      notify();

      if (entry.status === 'done' || entry.status === 'error') {
        es.close();
        updating = false;
        notify();

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
      updating = false;
      notify();
    };
  },
};

// Initial fetch + periodic poll every 30 minutes
updateStore.fetchStatus();
setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
