import { useCallback, useEffect, useRef, useState } from 'react';
import { IconFolderOpen, IconRefresh, IconPlugConnected, IconX } from '@tabler/icons-react';
import { databankStore } from '../store/databank-store';
import { useDatabank } from '../hooks/useDatabank';
import { boardStore } from '../store/board-store';
import { showSidebarTab } from './Sidebar.utils';

/**
 * The user-facing half of the local-folder library (`store/folder-library.ts`)
 * — the only library the lite and offline builds have.
 *
 * One hidden `webkitdirectory` input serves every browser that has no
 * directory picker (Firefox, Safari, iOS Safari 18.4+, `file://`); Chromium
 * goes through `showDirectoryPicker()` instead and never mounts the input's
 * dialog. Both land in the same store call.
 */

/** A scan that finds nothing looks exactly like a scan that did not run, so
 *  it says so; a scan that found something confirms it in the same place. */
function reportScan(rootName: string, count: number): void {
  if (count > 0) {
    boardStore.addToast(`Library: ${rootName} — ${count} file${count === 1 ? '' : 's'}`, 'info');
  } else {
    boardStore.addToast(
      `No boards or PDFs in "${rootName}". Pick the folder that holds them, or one above it.`,
      'error',
    );
  }
}

/** Shared by the empty state and the chip: opens whichever picker this
 *  browser has. Returns a ref to attach to the hidden input. */
function useFolderPicker(testId: string) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);


  // A pick the STORE started (an open whose folder is gone) has to be
  // awaited by it, so the dialog's outcome is bridged back through a pending
  // resolver. Every exit from `pick` settles it — a promise left hanging
  // would freeze the open it belongs to.
  const pendingRef = useRef<((ok: boolean) => void) | null>(null);
  const settle = useCallback((ok: boolean) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    resolve?.(ok);
  }, []);
  const settleRef = useRef(settle);
  settleRef.current = settle;
  // Stable identity so the ref callback can add and remove the same one.
  const onNativeCancel = useRef(() => settleRef.current(false)).current;

  // Everything the input needs that React cannot express is done in the ref
  // callback, NOT in a mount effect: these components render `null` until
  // they have something to show (the chip only exists once a folder does),
  // so an effect with `[]` fires while the element is absent and never
  // again — which left the chip's input without `webkitdirectory` and
  // opened a FILE dialog where a folder dialog belongs.
  //   - `webkitdirectory`/`directory`: not React props.
  //   - `cancel`: no React handler exists; it is how a dismissed dialog
  //     tells a waiting open to stop waiting.
  const attachInput = useCallback((el: HTMLInputElement | null) => {
    const prev = inputRef.current;
    if (prev) prev.removeEventListener('cancel', onNativeCancel);
    inputRef.current = el;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
    el.addEventListener('cancel', onNativeCancel);
  }, []);

  const onInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) { settle(false); return; }
    setBusy(true);
    let ok = false;
    try {
      ok = await databankStore.adoptFolderFiles(list);
      reportScan(databankStore.folderState.kind === 'none' ? '' : databankStore.folderState.rootName, databankStore.files.length);
    } catch (err) {
      boardStore.addToast(`Could not read that folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
      // Let the same folder be picked again (change events need a new value).
      e.target.value = '';
      settle(ok);
    }
  }, [settle]);

  const pick = useCallback(async () => {
    if (busy) return false;
    if (databankStore.folderPickMode === 'handle') {
      setBusy(true);
      let res;
      try {
        res = await databankStore.pickLibraryFolder();
      } finally {
        setBusy(false);
      }
      if (res.ok) {
        reportScan(res.scan.rootName, res.scan.files.length);
        settle(true);
        return true;
      }
      switch (res.reason) {
        case 'cancelled':
          // A cancel and a folder the browser refuses to open arrive as the
          // same AbortError, and the browser shows nothing of its own for
          // the second. Saying which folders are off limits is the only way
          // the user can tell those apart.
          boardStore.addToast(
            'No folder opened. Note that browsers refuse some folders outright — ' +
            'your home folder, Desktop, Documents and the system folders. Pick the ' +
            'folder your boards are in, or one below it.',
            'info',
          );
          settle(false);
          return false;
        case 'fallback':
        case 'unsupported':
          break;   // the input below can do it, and settles when it closes
        default:
          boardStore.addToast(
            `Could not read that folder: ${res.error instanceof Error ? res.error.message : 'unknown error'}`,
            'error',
          );
          settle(false);
          return false;
      }
    }
    // Settles from the input's own change / cancel events. EVERY path out of
    // `pick` has to settle: an open waiting on a re-pick hangs for ever
    // otherwise, which is worse than the dead end it replaced.
    inputRef.current?.click();
    return false;
  }, [busy, settle]);

  const input = (
    <input
      ref={attachInput}
      type="file"
      multiple
      hidden
      data-testid={testId}
      onChange={onInputChange}
    />
  );

  return { pick, busy, input, pendingRef };
}

/** Standalone "hand over a folder" button — the home page's front door.
 *  Shows the Library once a folder is in, since that is where it landed. */
export function FolderLibraryOpenButton({ className, children }: { className?: string; children?: React.ReactNode }) {
  const { folderState } = useDatabank();
  const { pick, busy, input } = useFolderPicker('folder-library-input-home');
  if (!databankStore.folderLibrarySupported && folderState.kind === 'none') return null;
  return (
    <>
      {input}
      <button
        type="button"
        className={className}
        data-testid="home-open-folder-btn"
        disabled={busy}
        onClick={async () => {
          await pick();
          if (databankStore.folderMode) showSidebarTab('library');
        }}
        title="Index a folder of boards and schematics, read in this browser"
      >
        <IconFolderOpen size={18} stroke={1.75} /> {busy ? 'Reading folder…' : (children ?? 'Open a folder')}
      </button>
    </>
  );
}

/** Shown in place of the file list when no folder has been handed over. */
export function FolderLibraryEmptyState() {
  const { pick, busy, input } = useFolderPicker('folder-library-input');
  const mode = databankStore.folderPickMode;
  return (
    <div className="library-empty folder-lib-empty">
      {input}
      <div className="folder-lib-empty-title">No library folder yet</div>
      <div className="folder-lib-empty-text">
        Point BoardRipper at a folder of boardview files and schematics. It is read
        in the browser — nothing is uploaded, and nothing leaves this machine.
      </div>
      <button
        className="library-empty-action"
        data-testid="pick-library-folder"
        onClick={pick}
        disabled={busy}
      >
        <IconFolderOpen size={14} /> {busy ? 'Reading folder…' : 'Choose a folder'}
      </button>
      {mode === 'input' && (
        <div className="folder-lib-empty-note">
          This browser reads the folder once per visit. The list of files is
          remembered, so the library is still here after a reload — opening one
          then asks for the folder again.
        </div>
      )}
      {mode === 'handle' && (
        <div className="folder-lib-empty-note">
          The browser keeps access only until the last tab closes. Pick
          <em> Allow on every visit</em> when it asks, or install BoardRipper
          (browser menu ▸ Install) — an installed app keeps the folder for
          good and is never asked again.
        </div>
      )}
    </div>
  );
}

/** The one-line folder control above the stats bar, once a folder is known. */
export function FolderLibraryChip() {
  const { folderState, files } = useDatabank();
  const { pick, busy, input, pendingRef } = useFolderPicker('folder-library-input-chip');
  const [working, setWorking] = useState(false);

  // The chip is mounted for as long as a folder is known, which is exactly
  // when an open can find itself without one. It lends the store its dialog.
  useEffect(() => {
    databankStore.setFolderRepickHandler(() => new Promise<boolean>((resolve) => {
      pendingRef.current = resolve;
      boardStore.addToast('Choose the library folder again to open this file.', 'info');
      void pick();
    }));
    return () => databankStore.setFolderRepickHandler(null);
  }, [pick, pendingRef]);

  if (folderState.kind === 'none') return null;

  const run = async (fn: () => Promise<unknown>) => {
    setWorking(true);
    try { await fn(); } finally { setWorking(false); }
  };

  const detached = folderState.kind === 'detached';
  const canRescan = folderState.kind === 'active' && folderState.mode === 'handle';

  return (
    <div className={`folder-lib-chip ${detached ? 'detached' : ''}`} data-testid="folder-library-chip">
      {input}
      <IconFolderOpen size={13} className="folder-lib-chip-icon" />
      <span className="folder-lib-chip-name" title={folderState.rootName}>{folderState.rootName}</span>
      <span className="folder-lib-chip-count">{files.length}</span>
      {detached && (
        <span className="folder-lib-chip-state">
          {folderState.reason === 'permission' ? 'needs permission' : 'index only'}
        </span>
      )}
      <div className="folder-lib-chip-actions">
        {detached && folderState.reason === 'permission' && (
          <button
            className="library-scan-btn"
            data-testid="reconnect-library-folder"
            disabled={working}
            onClick={() => run(async () => {
              const ok = await databankStore.reconnectFolderLibrary();
              if (ok) reportScan(folderState.rootName, databankStore.files.length);
              else boardStore.addToast(
                'The browser did not restore access to that folder. Choose it again to reconnect.',
                'error',
              );
            })}
            title={
              'Grant access to this folder again. Chromium drops the grant when the last tab ' +
              'closes — pick "Allow on every visit" in the prompt, or install BoardRipper ' +
              '(browser menu ▸ Install), and it will not ask again.'
            }
          >
            <IconPlugConnected size={13} /> Reconnect
          </button>
        )}
        {canRescan && (
          <button
            className="library-scan-btn library-scan-icon"
            data-testid="rescan-library-folder"
            disabled={working}
            onClick={() => run(() => databankStore.rescanFolderLibrary())}
            title="Read the folder again — picks up files added or removed since"
          >
            <IconRefresh size={13} />
          </button>
        )}
        <button
          className="library-scan-btn"
          data-testid="change-library-folder"
          disabled={busy || working}
          onClick={pick}
          title="Choose a different folder"
        >
          {detached && folderState.reason === 'repick' ? 'Choose folder' : 'Change'}
        </button>
        <button
          className="library-scan-btn library-scan-icon"
          data-testid="forget-library-folder"
          disabled={working}
          onClick={() => run(() => databankStore.forgetFolderLibrary())}
          title="Forget this folder and its index"
        >
          <IconX size={13} />
        </button>
      </div>
    </div>
  );
}
