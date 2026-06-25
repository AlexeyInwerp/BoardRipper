import { useState } from 'react';
import { readSession, clearSession, restoreSession, type SavedSession } from '../store/session-store';

/** Boot prompt: if a previous session's boards/PDFs were open, ask whether to
 *  reopen or discard. Never auto-restores — so a board that hung the app last
 *  time can't re-hang on load (the user discards first). */
export function SessionRestorePrompt() {
  // Read once at mount: a non-empty saved session means we should ask.
  const [session, setSession] = useState<SavedSession | null>(() => {
    const s = readSession();
    return s && s.entries.length > 0 ? s : null;
  });
  const [busy, setBusy] = useState(false);

  if (!session) return null;

  const boards = session.entries.filter(e => e.kind === 'board').length;
  const pdfs = session.entries.filter(e => e.kind === 'pdf').length;
  const parts = [
    boards > 0 ? `${boards} board${boards > 1 ? 's' : ''}` : '',
    pdfs > 0 ? `${pdfs} PDF${pdfs > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' and ');

  const onReopen = async () => {
    setBusy(true);
    try { await restoreSession(session); } finally { setSession(null); }
  };
  const onDiscard = () => { clearSession(); setSession(null); };

  return (
    <div className="session-restore-backdrop" role="dialog" aria-modal="true" data-testid="session-restore-prompt">
      <div className="session-restore-card">
        <div className="session-restore-title">Reopen your last session?</div>
        <div className="session-restore-body">{parts} were open.</div>
        <div className="session-restore-actions">
          <button className="session-restore-btn" data-testid="session-discard" onClick={onDiscard} disabled={busy}>
            Discard
          </button>
          <button className="session-restore-btn primary" data-testid="session-reopen" onClick={onReopen} disabled={busy}>
            {busy ? 'Reopening…' : 'Reopen'}
          </button>
        </div>
      </div>
    </div>
  );
}
