import { useSyncExternalStore } from 'react';
import { Emitter } from './emitter';
import { log } from './log-store';

/** Mirrors the backend ContribDBStatus shape exactly (see §5.5 of the spec). */
export interface ContribDBStatus {
  enabled: boolean;
  base_url: string;
  install_uuid?: string;
  registered: boolean;
  last_sync_at?: string;        // ISO8601, omitempty
  last_sync_error?: string;
  snapshot_counter: number;
  outbox_pending: number;
  outbox_failed: number;
  recent_errors?: string[];
}

export type SubmissionStatus =
  | 'pending_send'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'withdrawn'
  | 'superseded'
  | 'failed';

/** Terminal statuses — pending badges should clear once a row reaches one of these. */
const TERMINAL_STATUSES: ReadonlySet<SubmissionStatus> = new Set<SubmissionStatus>([
  'accepted',
  'rejected',
  'withdrawn',
  'superseded',
]);

export interface SubmissionRow {
  local_uuid: string;
  server_uuid?: string;
  target_type: string;
  target_uuid: string;
  target_field: string;
  value_to: string;
  value_from: string;
  status: SubmissionStatus;
  created_at: string;
  last_error?: string;
}

/** Patch body sent to POST /api/contribdb/submit. The backend assigns the
 *  local_uuid in the returned envelope. */
export interface SubmissionPatch {
  target_type: string;
  target_uuid: string;
  target_field: string;
  value_to: string;
  value_from: string;
  /** Evidence block — at least one of source_url / board_in_hand / rationale required. */
  evidence: {
    source_url?: string;
    board_in_hand?: boolean;
    board_in_hand_ctx?: Record<string, unknown>;
    rationale?: string;
  };
}

interface UserTokenInfo {
  linked: boolean;
  handle?: string;
}

interface InstallTokenInfo {
  install_token: string;
  install_uuid: string;
}

/** Default disabled-state status — used until the first refreshStatus() returns. */
const DEFAULT_STATUS: ContribDBStatus = {
  enabled: false,
  base_url: '',
  registered: false,
  snapshot_counter: 0,
  outbox_pending: 0,
  outbox_failed: 0,
};

class ContribDBStore extends Emitter {
  private _status: ContribDBStatus = DEFAULT_STATUS;
  private _submissions: Map<string, SubmissionRow> = new Map();
  private _userToken: UserTokenInfo = { linked: false };
  private _installToken: InstallTokenInfo | null = null;
  private _syncing = false;
  private _snapshot = this._buildSnapshot();

  // Reference-counted polling — Settings and DatabaseEditor each hold one ref
  // while mounted; polling stops when count reaches zero.
  private _pollRefCount = 0;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _pollIntervalMs = 30_000;

  getSnapshot() { return this._snapshot; }

  private _buildSnapshot() {
    return {
      status: this._status,
      submissions: this._submissions,
      userToken: this._userToken,
      installToken: this._installToken,
      syncing: this._syncing,
    };
  }

  private _bump() {
    this._snapshot = this._buildSnapshot();
    this.notify();
  }

  /** GET /api/contribdb/status — silent on transport errors, populates status. */
  async refreshStatus(): Promise<void> {
    try {
      const res = await fetch('/api/contribdb/status');
      if (!res.ok) {
        log.contribdb.warn('refreshStatus failed', res.status);
        return;
      }
      const json = (await res.json()) as ContribDBStatus;
      this._status = json;
      this._bump();
    } catch (e) {
      log.contribdb.warn('refreshStatus error', e);
    }
  }

  /** GET /api/contribdb/mine — replaces the local submissions map. */
  async refreshMine(): Promise<void> {
    try {
      const res = await fetch('/api/contribdb/mine');
      if (!res.ok) {
        log.contribdb.warn('refreshMine failed', res.status);
        return;
      }
      const json = (await res.json()) as { submissions?: SubmissionRow[] };
      const rows = json.submissions ?? [];
      const next = new Map<string, SubmissionRow>();
      for (const r of rows) next.set(r.local_uuid, r);
      this._submissions = next;
      this._bump();
    } catch (e) {
      log.contribdb.warn('refreshMine error', e);
    }
  }

  /** GET /api/contribdb/user-token-status + lazy GET /api/contribdb/install-token. */
  async refreshUserToken(): Promise<void> {
    try {
      const res = await fetch('/api/contribdb/user-token-status');
      if (res.ok) {
        const json = (await res.json()) as UserTokenInfo;
        this._userToken = { linked: !!json.linked, handle: json.handle };
        this._bump();
      } else {
        log.contribdb.warn('user-token-status failed', res.status);
      }
    } catch (e) {
      log.contribdb.warn('user-token-status error', e);
    }

    // Install token is read-only — only fetch once.
    if (this._installToken == null) {
      try {
        const res = await fetch('/api/contribdb/install-token');
        if (res.ok) {
          const json = (await res.json()) as InstallTokenInfo;
          this._installToken = { install_token: json.install_token, install_uuid: json.install_uuid };
          this._bump();
        } else {
          log.contribdb.warn('install-token failed', res.status);
        }
      } catch (e) {
        log.contribdb.warn('install-token error', e);
      }
    }
  }

  /** POST /api/contribdb/submit — returns true on success. */
  async submit(patch: SubmissionPatch): Promise<{ ok: boolean; local_uuid?: string; status?: SubmissionStatus; error?: string }> {
    try {
      const res = await fetch('/api/contribdb/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.text();
        log.contribdb.warn('submit failed', res.status, body);
        return { ok: false, error: body || res.statusText };
      }
      const json = (await res.json()) as { local_uuid: string; status: SubmissionStatus };
      // Refresh dependents so the pending badge appears immediately.
      await Promise.all([this.refreshMine(), this.refreshStatus()]);
      return { ok: true, local_uuid: json.local_uuid, status: json.status };
    } catch (e) {
      log.contribdb.error('submit error', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** POST /api/contribdb/sync — manual trigger. Long-running, no client timeout. */
  async sync(): Promise<void> {
    if (this._syncing) return;
    this._syncing = true;
    this._bump();
    try {
      const res = await fetch('/api/contribdb/sync', { method: 'POST' });
      if (!res.ok) {
        const body = await res.text();
        log.contribdb.warn('sync failed', res.status, body);
        // Still refresh status so user sees backend's last_sync_error.
        await this.refreshStatus();
        return;
      }
      const json = (await res.json()) as ContribDBStatus;
      this._status = json;
      // Outbox state likely changed — pull fresh submissions too.
      await this.refreshMine();
    } catch (e) {
      log.contribdb.error('sync error', e);
    } finally {
      this._syncing = false;
      this._bump();
    }
  }

  /** POST /api/contribdb/user-token — pass empty string to unlink. */
  async setUserToken(token: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('/api/contribdb/user-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const body = await res.text();
        log.contribdb.warn('setUserToken failed', res.status, body);
        return { ok: false, error: body || res.statusText };
      }
      await Promise.all([this.refreshUserToken(), this.refreshStatus()]);
      return { ok: true };
    } catch (e) {
      log.contribdb.error('setUserToken error', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Find the user's most-recent non-terminal submission targeting one field. */
  pendingForField(targetType: string, targetUuid: string, targetField: string): SubmissionRow | undefined {
    let best: SubmissionRow | undefined;
    let bestTs = -Infinity;
    for (const row of this._submissions.values()) {
      if (row.target_type !== targetType) continue;
      if (row.target_uuid !== targetUuid) continue;
      if (row.target_field !== targetField) continue;
      if (TERMINAL_STATUSES.has(row.status)) continue;
      const ts = Date.parse(row.created_at);
      // Date.parse returns NaN on invalid; treat NaN as "older than anything".
      const t = Number.isFinite(ts) ? ts : 0;
      if (t >= bestTs) {
        best = row;
        bestTs = t;
      }
    }
    return best;
  }

  /** Reference-counted polling. Settings and Editor each call start on mount /
   *  stop on unmount; polling continues while at least one consumer is alive. */
  startPolling(intervalMs = 30_000): void {
    this._pollRefCount++;
    this._pollIntervalMs = intervalMs;
    if (this._pollTimer != null) return;
    // Immediate refresh so consumers don't wait an interval for first paint.
    void this.refreshStatus();
    void this.refreshMine();
    this._pollTimer = setInterval(() => {
      void this.refreshStatus();
      void this.refreshMine();
    }, this._pollIntervalMs);
  }

  stopPolling(): void {
    if (this._pollRefCount > 0) this._pollRefCount--;
    if (this._pollRefCount === 0 && this._pollTimer != null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }
}

export const contribdbStore = new ContribDBStore();

// Dev-only window handle for console debugging, mirrors obdStore convention.
if (typeof window !== 'undefined') {
  (window as { __contribdbStore?: ContribDBStore }).__contribdbStore = contribdbStore;
}

// ---- React hooks ----------------------------------------------------------

/** Live status from /api/contribdb/status (poll-driven). Falls back to a
 *  disabled-shape default until the first response lands. */
export function useContribDBStatus(): ContribDBStatus {
  const snap = useSyncExternalStore(
    (cb) => contribdbStore.subscribe(cb),
    () => contribdbStore.getSnapshot(),
  );
  return snap.status;
}

/** All of the install's submissions, sorted newest first. */
export function useContribDBMine(): SubmissionRow[] {
  const snap = useSyncExternalStore(
    (cb) => contribdbStore.subscribe(cb),
    () => contribdbStore.getSnapshot(),
  );
  // Map preserves insertion order; we want newest-first for UI rendering.
  return Array.from(snap.submissions.values()).sort((a, b) => {
    const ta = Date.parse(a.created_at) || 0;
    const tb = Date.parse(b.created_at) || 0;
    return tb - ta;
  });
}

/** Returns the user's most-recent non-terminal submission for a field, or
 *  undefined when no pending submission exists. */
export function useContribDBPendingForField(
  targetType: string,
  targetUuid: string,
  targetField: string,
): SubmissionRow | undefined {
  const snap = useSyncExternalStore(
    (cb) => contribdbStore.subscribe(cb),
    () => contribdbStore.getSnapshot(),
  );
  // Inline the lookup so the dependency on the snapshot is explicit to React.
  let best: SubmissionRow | undefined;
  let bestTs = -Infinity;
  for (const row of snap.submissions.values()) {
    if (row.target_type !== targetType) continue;
    if (row.target_uuid !== targetUuid) continue;
    if (row.target_field !== targetField) continue;
    if (TERMINAL_STATUSES.has(row.status)) continue;
    const ts = Date.parse(row.created_at);
    const t = Number.isFinite(ts) ? ts : 0;
    if (t >= bestTs) {
      best = row;
      bestTs = t;
    }
  }
  return best;
}

/** Read user-token + install-token state without subscribing (for sections
 *  that only need these on render). */
export function useContribDBUserToken() {
  const snap = useSyncExternalStore(
    (cb) => contribdbStore.subscribe(cb),
    () => contribdbStore.getSnapshot(),
  );
  return {
    linked: snap.userToken.linked,
    handle: snap.userToken.handle,
    installToken: snap.installToken?.install_token,
    installUuid: snap.installToken?.install_uuid,
    syncing: snap.syncing,
  };
}
