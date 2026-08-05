/**
 * Modal that prompts the user to provide the RC6 key needed to decrypt
 * encrypted ASUS `.fz` — or ASRock `.cae` — boardview files.
 *
 * The two formats share a container and a cipher and differ only in the key
 * (issue #25), so the dialog serves both and names whichever one the file
 * being opened needs. Only the FZ key has public mirrors and a parity
 * fingerprint; the CAE key is paste-only and proven functionally, when a file
 * actually decrypts with it.
 *
 * BoardRipper does not bundle this key. The dialog offers two paths:
 *   1. Fetch from a public GitHub mirror.
 *   2. Paste manually (from any source the user trusts).
 *
 * Both paths run through the parity-check validator before persisting to
 * localStorage. Visible whenever `fzKeyStore.dialogOpen === true`.
 *
 * Styling reuses the existing .library-modal-* classes — see index.css.
 */

import { useSyncExternalStore, useState } from 'react';
import { fzKeyStore, FZ_KEY_SOURCES, KEY_KIND_LABEL } from '../store/fz-key-store';

function subscribe(cb: () => void) {
  return fzKeyStore.subscribe(cb);
}

export function FZKeyDialog() {
  const open = useSyncExternalStore(subscribe, () => fzKeyStore.dialogOpen);
  if (!open) return null;
  return <FZKeyDialogBody />;
}

function FZKeyDialogBody() {
  const kind = useSyncExternalStore(subscribe, () => fzKeyStore.dialogKind);
  const hasKey = useSyncExternalStore(subscribe, () => fzKeyStore.hasKey(kind));
  const label = KEY_KIND_LABEL[kind];
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const onFetch = async () => {
    setError(null); setInfo(null); setBusy(true);
    const err = await fzKeyStore.fetchAndApply();
    setBusy(false);
    if (err) setError(err);
    else { setInfo('Key fetched and validated.'); window.setTimeout(() => fzKeyStore.closeDialog(), 500); }
  };

  const onSave = () => {
    setError(null); setInfo(null);
    const err = fzKeyStore.setKeyFromText(pasted, kind);
    if (err) setError(err);
    else { setInfo('Key saved.'); window.setTimeout(() => fzKeyStore.closeDialog(), 500); }
  };

  return (
    <div className="library-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="fz-key-title">
      <div className="library-modal library-modal-wide">
        <div className="library-modal-title" id="fz-key-title">{label} decryption key required</div>
        <div className="library-modal-filename">
          {label} boardview files are RC6-encrypted. BoardRipper does not ship the key —
          {kind === 'fz'
            ? ' fetch it from a public mirror or paste it from any source you trust.'
            : ' paste it from any source you trust. This one has no public mirror here, and no parity fingerprint to check it against, so it is accepted on structure and proven when a file actually decrypts with it.'}
          {hasKey && ' A key is already stored.'}
        </div>

        <details>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)' }}>
            Why isn't the key bundled?
          </summary>
          <div className="library-modal-filename" style={{ marginTop: 6 }}>
            Anti-circumvention laws in some jurisdictions — DMCA §1201 in the US,
            InfoSoc Directive Art. 6 / CDSM in the EU — restrict the distribution
            of tools that decrypt protected files, even for repair or
            interoperability. Upstream OpenBoardView takes the same position
            (<code>FZFile::getBuiltinKey()</code> returns empty). The key is
            mirrored publicly on GitHub; retrieving and using it is the user's
            decision, not BoardRipper's. BoardRipper makes no legal claim to
            the key and provides no warranty for its use.
          </div>
        </details>


        {kind === 'fz' && <div className="library-modal-field">
          <span>Fetch from a public GitHub mirror (tries {FZ_KEY_SOURCES.length} in order)</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="library-modal-save"
              onClick={onFetch}
              disabled={busy}
              style={{ padding: '4px 12px', borderRadius: 3, cursor: busy ? 'not-allowed' : 'pointer', fontSize: 12 }}
            >
              {busy ? 'Fetching…' : 'Fetch'}
            </button>
            {FZ_KEY_SOURCES.map((s, i) => (
              <a key={s.url} href={s.url} target="_blank" rel="noreferrer noopener" style={{ fontSize: 11, color: 'var(--accent)' }}>
                {i === 0 ? 'primary' : `mirror ${i + 1}`}
              </a>
            ))}
          </div>
        </div>}

        <div className="library-modal-field">
          <span>{kind === 'fz' ? 'Or paste' : 'Paste'} 44 hex words (0x… tokens, any whitespace)</span>
          <textarea
            spellCheck={false}
            placeholder="0x25d8d248 0xe1502405 0x56b5d486 0x69213fe0&#10;…44 words total…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        </div>

        {error && <div className="library-modal-message-err">{error}</div>}
        {info && <div className="library-modal-message-ok">{info}</div>}

        <div className="library-modal-actions">
          {hasKey && (
            <button type="button" onClick={() => { fzKeyStore.clearKey(kind); setInfo('Stored key cleared.'); }} disabled={busy}>
              Clear stored
            </button>
          )}
          <button type="button" onClick={() => fzKeyStore.closeDialog()} disabled={busy}>
            {hasKey ? 'Close' : 'Cancel'}
          </button>
          <button type="button" className="library-modal-save" onClick={onSave} disabled={busy || pasted.trim().length === 0}>
            Validate & save
          </button>
        </div>
      </div>
    </div>
  );
}
