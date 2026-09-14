/**
 * First-run library setup modal.
 *
 * Shown when the backend reports a library that was never indexed: no scan
 * recorded and no files. It explains the two indexes (files now, PDF text in
 * the background afterwards), offers automatic board↔PDF linking and the
 * OpenBoardData download — both on by default — and starts the scan. The
 * trigger is server state, so a database reset brings it back on reload.
 * Reuses the `.library-modal-*` shell like the FZ key dialog.
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { firstRunStore } from '../store/first-run-store';
import { welcomeStore } from '../store/welcome-store';
import { databankStore, hasBackend } from '../store/databank-store';
import { useDatabank } from '../hooks/useDatabank';
import { obdStore } from '../store/obd-store';
import { isLiteBuild } from '../store/build-mode';
import { log } from '../store/log-store';

export function FirstRunSetup() {
  const fr = useSyncExternalStore((cb) => firstRunStore.subscribe(cb), firstRunStore.getSnapshot);
  const welcomeOpen = useSyncExternalStore(welcomeStore.subscribe, welcomeStore.getSnapshot);
  const { stats, scanStatus, backendAvailable, electronMode, loadStatus } = useDatabank();

  // Fetch stats once when nothing is loaded yet, so the gate can decide.
  useEffect(() => {
    if (backendAvailable && hasBackend() && !stats) void databankStore.fetchStats();
  }, [backendAvailable, stats]);

  if (isLiteBuild() || electronMode || !hasBackend()) return null;
  if (welcomeOpen) return null; // the gesture wizard goes first
  const neverIndexed = !!stats && stats.last_file_scan_at === 0 && stats.boards + stats.pdfs === 0
    && !scanStatus?.running && loadStatus !== 'loading';
  // Opened from Settings / the start page it shows regardless of backend
  // state; the automatic case needs a reachable backend that reports a
  // never-indexed library.
  const auto = backendAvailable && neverIndexed && !fr.skipped && !fr.never && !firstRunStore.automated();
  if (!fr.forced && !auto) return null;
  return <FirstRunBody neverIndexed={neverIndexed} />;
}

function FirstRunBody({ neverIndexed }: { neverIndexed: boolean }) {
  const { libraryPath } = useDatabank();
  const [folders, setFolders] = useState<string[] | null>(null);
  const [bind, setBind] = useState(true);
  const [obd, setObd] = useState(true);
  const [rescan, setRescan] = useState(true);
  const [busy, setBusy] = useState(false);

  // The mounted top-level folders come from the live browse endpoint, which
  // needs no index — so the user sees the mount worked before indexing.
  useEffect(() => {
    let alive = true;
    fetch('/api/databank/browse?path=')
      .then(r => r.ok ? r.json() : null)
      .then((res: { entries?: { name: string; is_dir: boolean }[] } | null) => {
        if (!alive) return;
        setFolders((res?.entries ?? []).filter(e => e.is_dir).map(e => e.name));
      })
      .catch(() => { if (alive) setFolders([]); });
    return () => { alive = false; };
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      await databankStore.setConfig('auto_bind', bind ? 'true' : '');
      await databankStore.setConfig('auto_scan', rescan ? 'true' : '');
      await databankStore.triggerFileScan();
      if (obd) void obdStore.fetchAll();
      log.scan.log(`[first-run] started: auto_bind=${bind} auto_scan=${rescan} obd=${obd}`);
      firstRunStore.close();
    } finally {
      setBusy(false);
    }
  };

  const folderText = folders === null ? '…'
    : folders.length === 0 ? 'nothing mounted yet'
    : folders.slice(0, 6).join(', ') + (folders.length > 6 ? `, +${folders.length - 6}` : '');

  return (
    <div className="library-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="firstrun-title" data-testid="firstrun-modal">
      <div className="library-modal library-modal-wide firstrun-modal">
        <div className="library-modal-title" id="firstrun-title">Set up your library</div>
        <div className="library-modal-filename">
          BoardRipper reads the folders mounted at <code>{libraryPath ?? '/library'}</code>. Nothing is imported or copied.
          {' '}Mounted: <span data-testid="firstrun-folders">{folderText}</span>
          {folders !== null && folders.length === 0 && (
            <span className="firstrun-warn"> — mount your board folders as subfolders of <code>/library</code> (see Getting started) and reload.</span>
          )}
        </div>

        <ol className="firstrun-steps">
          <li>
            <b>Index files</b>
            <span>Walks the folders and builds the board and PDF list. About 200 files a second; everything else depends on it. Starts when you press Start.</span>
          </li>
          <li>
            <b>Index PDF text</b>
            <span>Extracts the text of every schematic for full-text search. Slow, runs in the background, starts by itself when step 1 finishes. Nothing to click.</span>
          </li>
          <li>
            <label className="welcome-check">
              <input type="checkbox" checked={bind} onChange={e => setBind(e.target.checked)} data-testid="firstrun-bind" />
              <span className="welcome-check-text">
                <b>Link boards to their PDFs automatically</b> — by name, board number, similarity, or the only PDF in a folder. Rules and a preview live in Settings ▸ Library.
              </span>
            </label>
          </li>
          <li>
            <label className="welcome-check">
              <input type="checkbox" checked={obd} onChange={e => setObd(e.target.checked)} data-testid="firstrun-obd" />
              <span className="welcome-check-text">
                <b>Download OpenBoardData</b> — community diode and voltage readings for about a hundred boards, a couple of minutes, from{' '}
                <a href="https://openboarddata.org" target="_blank" rel="noopener noreferrer">openboarddata.org</a> under the ODbL licence. Readings appear on matching boards by themselves.
              </span>
            </label>
          </li>
        </ol>

        <label className="welcome-check firstrun-rescan">
          <input type="checkbox" checked={rescan} onChange={e => setRescan(e.target.checked)} data-testid="firstrun-rescan" />
          <span className="welcome-check-text"><b>Re-index on every start</b> — picks up files added since the last run.</span>
        </label>

        <div className="library-modal-actions">
          {neverIndexed && (
            <button type="button" className="welcome-never-btn" onClick={() => firstRunStore.neverAgain()} disabled={busy}>
              Don&apos;t show again
            </button>
          )}
          <button type="button" onClick={() => firstRunStore.skip()} disabled={busy}>Skip for now</button>
          <button type="button" className="library-modal-save" onClick={start} disabled={busy} data-testid="firstrun-start">
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </div>
    </div>
  );
}
