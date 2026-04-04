/** Reactive store for update checking — polls /api/update/status */

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
      notify();
    } catch { /* offline */ }
  },

  async check() {
    try {
      const res = await fetch('/api/update/check', { method: 'POST' });
      if (!res.ok) return;
      state = await res.json();
      notify();
    } catch { /* offline */ }
  },

  async apply() {
    if (updating) return;
    updating = true;
    progress = [];
    notify();

    try {
      const res = await fetch('/api/update/apply', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'unknown' }));
        progress.push({ time: new Date().toISOString(), message: err.error, status: 'error' });
        updating = false;
        notify();
        return;
      }
    } catch {
      progress.push({ time: new Date().toISOString(), message: 'Request failed', status: 'error' });
      updating = false;
      notify();
      return;
    }

    // Stream progress via SSE
    const es = new EventSource('/api/update/progress');
    es.onmessage = (e) => {
      const entry: ProgressEntry = JSON.parse(e.data);
      progress.push(entry);
      notify();

      if (entry.status === 'done' || entry.status === 'error') {
        es.close();
        updating = false;
        notify();

        // If update succeeded, auto-reload after 30s
        if (entry.status === 'done') {
          setTimeout(() => window.location.reload(), 30_000);
        }
      }
    };
    es.onerror = () => {
      es.close();
      updating = false;
      notify();
    };
  },
};

// Initial fetch + periodic poll every 30 minutes
updateStore.fetchStatus();
setInterval(() => updateStore.fetchStatus(), 30 * 60 * 1000);
