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

/** Shared by the empty state and the chip: opens whichever picker this
 *  browser has. Returns a ref to attach to the hidden input. */
function useFolderPicker(testId: string) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  // `webkitdirectory` is not a React prop — set it on the element itself.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.setAttribute('webkitdirectory', '');
    el.setAttribute('directory', '');
  }, []);

  const pick = useCallback(async () => {
    if (busy) return;
    if (databankStore.folderPickMode === 'handle') {
      setBusy(true);
      try {
        await databankStore.pickLibraryFolder();
        return;
      } catch {
        // The picker exists but this context is not allowed to use it —
        // `file://` most of all. The input works everywhere; fall through to
        // it rather than leaving a button that does nothing.
      } finally {
        setBusy(false);
      }
    }
    inputRef.current?.click();
  }, [busy]);

  const onInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    setBusy(true);
    try {
      await databankStore.adoptFolderFiles(list);
    } catch (err) {
      boardStore.addToast(`Could not read that folder: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
      // Let the same folder be picked again (change events need a new value).
      e.target.value = '';
    }
  }, []);

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      hidden
      data-testid={testId}
      onChange={onInputChange}
    />
  );

  return { pick, busy, input };
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
    </div>
  );
}

/** The one-line folder control above the stats bar, once a folder is known. */
export function FolderLibraryChip() {
  const { folderState, files } = useDatabank();
  const { pick, busy, input } = useFolderPicker('folder-library-input-chip');
  const [working, setWorking] = useState(false);

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
            onClick={() => run(() => databankStore.reconnectFolderLibrary())}
            title="Grant read access to this folder again"
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
