/**
 * Library Sync section — embedded into the Settings → Library tab.
 *
 * Surfaces three things in one block (per product spec):
 *   1. Library sync (download from a CopyParty/WebDAV source) — full config
 *      editor, schedule, target folder picker with RW/RO check, manual run,
 *      live progress.
 *   2. Indexing process — read-only mirror of databankStore.scanStatus, so
 *      the user can see when the scanner is busy without leaving this tab.
 *   3. Software-update status — read-only mirror of updateStore.
 */

import { useEffect, useMemo, useState } from 'react';
import { useDatabank } from '../hooks/useDatabank';
import { useLibrarySync } from '../hooks/useLibrarySync';
import { useUpdateStore } from '../hooks/useUpdateStore';
import {
  librarySyncStore,
  type SyncSchedule,
  type TargetCheck,
} from '../store/librarysync-store';

// ---- Helpers ----------------------------------------------------------------

function fmtBytes(n?: number): string {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n; let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function fmtTime(t?: string | number): string {
  if (t === undefined || t === null || t === '') return '—';
  const d = typeof t === 'number' ? new Date(t) : new Date(t);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}
function fmtNum(n?: number): string {
  return n === undefined || n === null ? '—' : n.toLocaleString();
}

// ---- Public component -------------------------------------------------------

export function LibrarySyncSection() {
  const { backendAvailable, electronMode } = useDatabank();
  if (electronMode) return null;
  if (!backendAvailable) {
    return (
      <div className="settings-section">
        <div className="settings-section-body">
          <h3 style={{ margin: '0 0 8px' }}>Library Sync</h3>
          <div className="color-rule-hint">
            Backend not available. Start the Docker container to configure library sync.
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <SyncConfigCard />
      <SyncProgressCard />
      <SyncErrorsCard />
      <IndexingStatusCard />
      <UpdateStatusCard />
    </>
  );
}

// ---- 1. Config card ---------------------------------------------------------

function SyncConfigCard() {
  const { config, configLoaded, status } = useLibrarySync();
  const [draft, setDraft] = useState(() => ({
    enabled: config.enabled,
    url: config.url,
    user: config.user,
    target: config.target,
    schedule: config.schedule,
    strict: config.strict,
    password: '',
    clearPassword: false,
  }));
  const [pristine, setPristine] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [tgtCheck, setTgtCheck] = useState<TargetCheck | null>(null);
  const [tgtChecking, setTgtChecking] = useState(false);

  // Re-sync local draft from server config whenever it loads/changes
  useEffect(() => {
    if (!configLoaded) return;
    setDraft(d => ({
      ...d,
      enabled: config.enabled,
      url: config.url,
      user: config.user,
      target: config.target,
      schedule: config.schedule,
      strict: config.strict,
      password: '',
      clearPassword: false,
    }));
    setPristine(true);
  }, [configLoaded, config.enabled, config.url, config.user, config.target, config.schedule, config.strict]);

  // Live RW/RO check on the candidate target
  useEffect(() => {
    if (!draft.target) { setTgtCheck(null); return; }
    let cancelled = false;
    setTgtChecking(true);
    const timer = setTimeout(async () => {
      try {
        const c = await librarySyncStore.checkTarget(draft.target);
        if (!cancelled) setTgtCheck(c);
      } finally {
        if (!cancelled) setTgtChecking(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [draft.target]);

  const update = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft(d => ({ ...d, [k]: v }));
    setPristine(false);
  };

  const onSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {
        enabled: draft.enabled,
        url: draft.url.trim(),
        user: draft.user.trim(),
        target: draft.target.trim(),
        schedule: draft.schedule,
        strict: draft.strict,
      };
      if (draft.clearPassword) patch.clear_password = true;
      else if (draft.password) patch.password = draft.password;
      await librarySyncStore.saveConfig(patch);
      setPristine(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    setTestResult('Testing…');
    try {
      // Save first if there are unsaved changes — test uses persisted creds
      if (!pristine) await onSave();
      const r = await librarySyncStore.testConnection();
      setTestResult(r.ok ? `OK — manifest is ${fmtBytes(r.manifest_bytes)}` : `FAILED — ${r.message}`);
    } catch (e) {
      setTestResult(`FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const targetHint = useMemo(() => {
    if (!draft.target) return { txt: 'Empty — falls back to library folder', kind: 'dim' as const };
    if (tgtChecking) return { txt: 'Checking…', kind: 'dim' as const };
    if (!tgtCheck) return { txt: '', kind: 'dim' as const };
    if (!tgtCheck.exists) return { txt: 'Path does not exist', kind: 'err' as const };
    if (!tgtCheck.is_dir) return { txt: 'Path is a file (need a directory)', kind: 'err' as const };
    if (!tgtCheck.writable) return { txt: `Read-only — ${fmtBytes(tgtCheck.free_bytes)} free`, kind: 'warn' as const };
    return { txt: `Writable · ${fmtBytes(tgtCheck.free_bytes)} free`, kind: 'ok' as const };
  }, [draft.target, tgtCheck, tgtChecking]);

  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 4px' }}>Library Sync</h3>
        <p style={{ fontSize: 12, color: '#888', lineHeight: 1.4, margin: '0 0 12px' }}>
          Pull schematic / boardview files from a remote WebDAV / CopyParty source into the library
          folder. One-way only — by default no local files are deleted (toggle <em>strict mirror</em>
          to change that).
        </p>

        <Row label="Enabled">
          <input type="checkbox"
            checked={draft.enabled}
            onChange={e => update('enabled', e.target.checked)}
            disabled={status.running} />
        </Row>

        <Row label="Server URL">
          <input type="text"
            className="settings-library-input"
            placeholder="https://example.com"
            value={draft.url}
            onChange={e => update('url', e.target.value)}
            spellCheck={false} autoComplete="off" />
        </Row>

        <Row label="Username">
          <input type="text"
            className="settings-library-input"
            placeholder="(empty for anonymous)"
            value={draft.user}
            onChange={e => update('user', e.target.value)}
            spellCheck={false} autoComplete="off" />
        </Row>

        <Row label="Password">
          <input type="password"
            className="settings-library-input"
            placeholder={config.has_password ? '(stored — leave blank to keep)' : '(not set)'}
            value={draft.password}
            onChange={e => { update('password', e.target.value); update('clearPassword', false); }}
            autoComplete="new-password" />
          {config.has_password && (
            <label style={{ marginLeft: 8, fontSize: 11, color: '#888' }}>
              <input type="checkbox" checked={draft.clearPassword}
                onChange={e => { update('clearPassword', e.target.checked); if (e.target.checked) update('password', ''); }} />
              {' '}clear stored
            </label>
          )}
        </Row>

        <Row label="Target folder">
          <input type="text"
            className="settings-library-input"
            placeholder="(empty = use library folder)"
            value={draft.target}
            onChange={e => update('target', e.target.value)}
            spellCheck={false} autoComplete="off" />
        </Row>
        <div style={{ marginLeft: 'calc(var(--settings-label-w, 140px) + 8px)', marginTop: -4, marginBottom: 8, fontSize: 11 }}>
          <span style={{ color: targetHint.kind === 'err' ? '#c33' : targetHint.kind === 'warn' ? '#c80' : targetHint.kind === 'ok' ? '#393' : '#888' }}>
            {targetHint.txt}
          </span>
        </div>

        <Row label="Schedule">
          <select value={draft.schedule}
            onChange={e => update('schedule', e.target.value as SyncSchedule)}>
            <option value="off">off (manual only)</option>
            <option value="daily">daily, 03:00 local</option>
            <option value="weekly">weekly, Sunday 03:00 local</option>
            <option value="monthly">monthly, 1st 03:00 local</option>
          </select>
        </Row>

        <Row label="Strict mirror">
          <input type="checkbox"
            checked={draft.strict}
            onChange={e => update('strict', e.target.checked)}
            disabled={status.running} />
          <span style={{ marginLeft: 6, fontSize: 11, color: draft.strict ? '#c80' : '#888' }}>
            {draft.strict ? 'WILL delete local files not on source' : 'never deletes (recommended)'}
          </span>
        </Row>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
          <button onClick={onSave} disabled={saving || pristine}>
            {saving ? 'Saving…' : pristine ? 'Saved' : 'Save'}
          </button>
          <button onClick={onTest} disabled={saving || !draft.url}>Test connection</button>
          {!status.running ? (
            <button onClick={() => librarySyncStore.start()} disabled={!draft.url || !pristine}>
              Sync now
            </button>
          ) : (
            <button onClick={() => librarySyncStore.stop()}>Cancel sync</button>
          )}
          {testResult && (
            <span style={{ fontSize: 12, color: testResult.startsWith('OK') ? '#393' : testResult.startsWith('Testing') ? '#888' : '#c33' }}>
              {testResult}
            </span>
          )}
          {error && <span style={{ fontSize: 12, color: '#c33' }}>{error}</span>}
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="settings-row settings-toggle-row" style={{ alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <label className="settings-label" style={{ minWidth: 'var(--settings-label-w, 140px)' }}>{label}</label>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>{children}</div>
    </div>
  );
}

// ---- 2. Live progress card --------------------------------------------------

function SyncProgressCard() {
  const { status } = useLibrarySync();
  const pct = status.files_total > 0 ? Math.round((status.files_done / status.files_total) * 100) : 0;
  const bytePct = status.bytes_total > 0 ? Math.round((status.bytes_done / status.bytes_total) * 100) : 0;
  const ranBefore = !!status.last_run_at_iso;
  const showLive = status.running || status.phase === 'done' || status.phase === 'error' || status.phase === 'cancelled';
  if (!showLive && !ranBefore) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 8px' }}>
          Sync progress
          {status.running && <span style={{ marginLeft: 8, fontSize: 12, color: '#393' }}>● running</span>}
          {!status.running && status.phase === 'error' && <span style={{ marginLeft: 8, fontSize: 12, color: '#c33' }}>✕ failed</span>}
          {!status.running && status.phase === 'done' && <span style={{ marginLeft: 8, fontSize: 12, color: '#393' }}>✓ done</span>}
          {!status.running && status.phase === 'cancelled' && <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>○ cancelled</span>}
        </h3>

        {showLive && (
          <>
            <DetailRow label="phase" value={status.phase} />
            <DetailRow label="description" value={status.description || '—'} />
            <DetailRow label="files" value={
              status.files_total > 0
                ? `${fmtNum(status.files_done)} / ${fmtNum(status.files_total)} (${pct}%)`
                : fmtNum(status.files_done)
            } />
            {status.files_total > 0 && <Bar value={pct} />}
            {status.bytes_total > 0 && (
              <>
                <DetailRow label="bytes" value={`${fmtBytes(status.bytes_done)} / ${fmtBytes(status.bytes_total)} (${bytePct}%)`} />
                <Bar value={bytePct} />
              </>
            )}
            {status.current_file && <DetailRow label="current" value={status.current_file} />}
            <DetailRow label="errors" value={fmtNum(status.errors)} />
            <DetailRow label="started" value={fmtTime(status.started_at_iso)} />
          </>
        )}

        {ranBefore && (
          <div style={{ marginTop: showLive ? 12 : 0, paddingTop: showLive ? 8 : 0, borderTop: showLive ? '1px solid var(--border-color, #333)' : 'none' }}>
            <DetailRow label="last run" value={fmtTime(status.last_run_at_iso)} />
            <DetailRow label="last files" value={fmtNum(status.last_run_files)} />
            <DetailRow label="last bytes" value={fmtBytes(status.last_run_bytes)} />
            <DetailRow label="last exit" value={status.last_run_exit === undefined ? '—' : String(status.last_run_exit)} />
            {status.last_run_message && <DetailRow label="last message" value={status.last_run_message} />}
            {status.next_run_at_iso && <DetailRow label="next run" value={fmtTime(status.next_run_at_iso)} />}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '1px 0' }}>
      <span style={{ color: '#888', minWidth: 110, textTransform: 'lowercase' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono, monospace)', wordBreak: 'break-all' }}>{value}</span>
    </div>
  );
}

function Bar({ value }: { value: number }) {
  return (
    <div style={{ height: 2, background: 'var(--border-color, #333)', margin: '4px 0 8px' }}>
      <div style={{ width: `${Math.min(100, Math.max(0, value))}%`, height: '100%', background: '#5b8def', transition: 'width 0.25s linear' }} />
    </div>
  );
}

// ---- 2b. Recent errors -----------------------------------------------------

function SyncErrorsCard() {
  const { status } = useLibrarySync();
  const errs = status.recent_errors || [];
  if (errs.length === 0 && status.errors === 0) return null;

  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 8px' }}>
          Recent sync errors
          <span style={{ marginLeft: 8, fontSize: 12, color: '#c33' }}>
            {status.errors > 0 ? `${status.errors} total` : ''}
          </span>
        </h3>
        {errs.length === 0 ? (
          <div style={{ fontSize: 12, color: '#888' }}>
            ({status.errors} earlier — buffer cleared on next run)
          </div>
        ) : (
          <div style={{
            background: 'var(--bg-primary, #0a0a0a)',
            border: '1px solid var(--border-color, #333)',
            maxHeight: 240,
            overflow: 'auto',
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
            padding: 8,
          }}>
            {errs.slice().reverse().map((e, i) => (
              <div key={`${e.time_iso}-${i}`} style={{ padding: '2px 0', borderBottom: i < errs.length - 1 ? '1px solid var(--border-color, #222)' : 'none' }}>
                <span style={{ color: '#888' }}>{new Date(e.time_iso).toLocaleTimeString()}</span>
                {' '}
                <span style={{ color: '#c33' }}>✕</span>
                {' '}
                <span style={{ color: '#ccc' }}>{e.path}</span>
                <div style={{ color: '#c66', paddingLeft: 8 }}>{e.message}</div>
              </div>
            ))}
          </div>
        )}
        <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>
          Showing last {errs.length} of {status.errors}. Full log: <code>docker logs boardripper</code> on the NAS.
        </div>
      </div>
    </div>
  );
}

// ---- 3. Indexing status (read-only mirror of databank scan) -----------------

function IndexingStatusCard() {
  const { scanStatus } = useDatabank();
  if (!scanStatus) return null;
  const running = scanStatus.running || scanStatus.pdf_running;

  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 8px' }}>
          Indexing
          {running && <span style={{ marginLeft: 8, fontSize: 12, color: '#393' }}>● scanning</span>}
          {!running && <span style={{ marginLeft: 8, fontSize: 12, color: '#888' }}>○ idle</span>}
        </h3>
        {running && (
          <>
            <DetailRow label="phase" value={scanStatus.phase || '—'} />
            <DetailRow label="files" value={`${fmtNum(scanStatus.scanned)} / ${fmtNum(scanStatus.total)}`} />
            <DetailRow label="added" value={fmtNum(scanStatus.added)} />
            <DetailRow label="updated" value={fmtNum(scanStatus.updated)} />
            <DetailRow label="errors" value={fmtNum(scanStatus.errors)} />
            {scanStatus.last_file && <DetailRow label="current" value={scanStatus.last_file} />}
            {scanStatus.pdf_running && (
              <>
                <DetailRow label="pdf phase" value={`${fmtNum(scanStatus.pdf_extracted)} / ${fmtNum(scanStatus.pdf_total)}`} />
                {scanStatus.pdf_current && <DetailRow label="pdf current" value={scanStatus.pdf_current} />}
              </>
            )}
          </>
        )}
        {!running && scanStatus.completed_at && (
          <DetailRow label="last completed" value={fmtTime(scanStatus.completed_at)} />
        )}
      </div>
    </div>
  );
}

// ---- 4. Software-update status ----------------------------------------------

function UpdateStatusCard() {
  const update = useUpdateStore();
  if (!update.state) return null;
  const has = update.state.has_update;
  return (
    <div className="settings-section">
      <div className="settings-section-body">
        <h3 style={{ margin: '0 0 8px' }}>
          Software updates
          {has && <span style={{ marginLeft: 8, fontSize: 12, color: '#c80' }}>● update available</span>}
          {!has && update.state.current_version !== 'dev' && <span style={{ marginLeft: 8, fontSize: 12, color: '#393' }}>● up to date</span>}
        </h3>
        <DetailRow label="current version" value={update.state.current_version} />
        {update.state.latest_version && <DetailRow label="latest version" value={update.state.latest_version} />}
        <DetailRow label="last checked" value={fmtTime(update.state.checked_at)} />
        {update.state.error && <DetailRow label="error" value={update.state.error} />}
      </div>
    </div>
  );
}
