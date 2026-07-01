import { useState } from 'react';
import { readSession, clearSession, restoreSession, type SavedSession } from '../store/session-store';

/** Boot prompt: if a previous session's boards/PDFs were open, ask whether to
 *  reopen or discard. Never auto-restores — so a board that hung the app last
 *  time can't re-hang on load (the user discards first). The file list lets the
 *  user de-select individual boards/PDFs before reopening. */
export function SessionRestorePrompt() {
  // Read once at mount: a non-empty saved session means we should ask.
  const [session, setSession] = useState<SavedSession | null>(() => {
    const s = readSession();
    return s && s.entries.length > 0 ? s : null;
  });
  const [busy, setBusy] = useState(false);
  // Default: everything checked; the user unchecks what they don't want.
  const [selected, setSelected] = useState<Set<number>>(() => new Set(session?.entries.map((_, i) => i) ?? []));

  if (!session) return null;

  const boards = session.entries.filter(e => e.kind === 'board').length;
  const pdfs = session.entries.filter(e => e.kind === 'pdf').length;
  const parts = [
    boards > 0 ? `${boards} board${boards > 1 ? 's' : ''}` : '',
    pdfs > 0 ? `${pdfs} PDF${pdfs > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' and ');

  const toggle = (i: number) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const onReopen = async () => {
    const entries = session.entries.filter((_, i) => selected.has(i));
    if (entries.length === 0) { clearSession(); setSession(null); return; }
    setBusy(true);
    try { await restoreSession({ ...session, entries }); } finally { setSession(null); }
  };
  const onDiscard = () => { clearSession(); setSession(null); };

  const allSelected = selected.size === session.entries.length;

  return (
    <div className="session-restore-backdrop" role="dialog" aria-modal="true" data-testid="session-restore-prompt">
      <div className="session-restore-card">
        <div className="session-restore-title">Reopen your last session?</div>
        <div className="session-restore-body">{parts} were open — uncheck any you don't want to reopen.</div>
        <div className="session-restore-list" data-testid="session-restore-list">
          {session.entries.map((e, i) => (
            <label key={`${e.kind}:${e.fileName}:${i}`} className="session-restore-item">
              <input
                type="checkbox"
                checked={selected.has(i)}
                onChange={() => toggle(i)}
                disabled={busy}
                data-testid="session-restore-check"
              />
              <span className="session-restore-item-kind">{e.kind === 'pdf' ? 'PDF' : 'Board'}</span>
              <span className="session-restore-item-name" title={e.fileName}>{e.fileName}</span>
            </label>
          ))}
        </div>
        <div className="session-restore-actions">
          <button className="session-restore-btn" data-testid="session-discard" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
          <button
            className="session-restore-btn primary"
            data-testid="session-reopen"
            onClick={onReopen}
            disabled={busy || selected.size === 0}
          >
            {busy ? 'Reopening…' : allSelected ? 'Reopen' : `Reopen (${selected.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}
