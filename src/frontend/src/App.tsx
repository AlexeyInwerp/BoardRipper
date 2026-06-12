import { useCallback, useState, useRef, useEffect } from 'react';
import {
  DockviewReact,
} from 'dockview-react';
import type {
  DockviewReadyEvent,
  IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { ContextMenu } from './components/ContextMenu';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { Sidebar } from './components/Sidebar';
import { isSidebarCollapsed, toggleSidebar, onSidebarChange, getSidebarSide } from './components/Sidebar.utils';
import { PanelErrorBoundary } from './components/PanelErrorBoundary';
import { BoardViewerPanel } from './panels/BoardViewerPanel';
import { PdfViewerPanel } from './panels/PdfViewerPanel';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel';
import { WorklistPanel } from './panels/WorklistPanel';
import { BoardTab } from './components/BoardTab';
import { HomeBackdrop } from './components/home/HomeBackdrop';
import { UpdateProgressOverlay } from './components/UpdateProgressOverlay';
import { LoadProgressOverlay } from './components/LoadProgressOverlay';
import { PeekHintChip } from './components/PeekHintChip';
import { FZKeyDialog } from './components/FZKeyDialog';
import { WelcomeSetup } from './components/WelcomeSetup';
import { setDockviewApi, ensureBoardPanel, boardPanelId, isRedockingPdf } from './store/dockview-api';
import { boardStore } from './store/board-store';
import { useBoardStore } from './hooks/useBoardStore';
import { pdfStore } from './store/pdf-store';
import { openPdfFiles } from './store/file-actions';
import { saveDroppedToIncoming } from './store/incoming-upload';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { getAllExtensions, getFileExtension } from './parsers';
import { themeStore } from './store/themes';
import { updateStore } from './store/update-store';
import { databankStore } from './store/databank-store';

// Every Dockview panel is wrapped in a PanelErrorBoundary so one bad board
// file / render-time throw in a single panel can't white-screen the whole app
// (an uncaught exception would otherwise unmount the entire React tree).
const components: Record<string, React.FC<IDockviewPanelProps>> = {
  boardViewer: (props) => (
    <PanelErrorBoundary label="Board Viewer">
      <BoardViewerPanel {...props} />
    </PanelErrorBoundary>
  ),
  pdfViewer: (props) => (
    <PanelErrorBoundary label="PDF Viewer">
      <PdfViewerPanel {...props} />
    </PanelErrorBoundary>
  ),
  databaseEditor: (props) => (
    <PanelErrorBoundary label="Database Editor">
      <DatabaseEditorPanel {...props} />
    </PanelErrorBoundary>
  ),
  worklist: () => (
    <PanelErrorBoundary label="Worklist">
      <WorklistPanel />
    </PanelErrorBoundary>
  ),
};

const tabComponents = {
  boardTab: BoardTab,
};

const BOARD_EXTS = new Set<string>(); // populated lazily
const PDF_EXT = '.pdf';

function isFileDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes('Files');
}

function isSupportedFile(name: string): 'board' | 'pdf' | null {
  if (BOARD_EXTS.size === 0) getAllExtensions().forEach(e => BOARD_EXTS.add(e.toLowerCase()));
  const ext = getFileExtension(name);
  if (ext === PDF_EXT) return 'pdf';
  if (BOARD_EXTS.has(ext)) return 'board';
  return null;
}

/** Match update bundles created by scripts/release.sh:
 *    boardripper-update-vX.Y.Z.tar       (canonical versioned)
 *    boardripper-update-vX.Y.Z.brupdate  (alias extension)
 *    latest-update.tar                   (stable-alias on ripperdoc.de)
 *    latest-update.brupdate              (stable-alias, brupdate ext)
 *    *.brupdate                          (our own extension — strong signal
 *                                         even after a rename)
 *  The signature inside is what grants trust — the filename is just a
 *  routing hint for the drop dispatcher. Reject only on names that can't
 *  plausibly be ours; let `applyBundle` reject the bytes if the signature
 *  doesn't verify. */
function isUpdateBundle(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.brupdate')) return true;
  if (!lower.endsWith('.tar')) return false;
  return /^boardripper-update-v[0-9]/.test(lower) || lower === 'latest-update.tar';
}

/** The Docker image tarball — same releases directory as the update bundle,
 *  but for `docker load`, NOT for drop-to-update. Users hit "boardripper-
 *  v0.30.8.tar.gz" first alphabetically and drop it expecting an update.
 *  Detect and redirect them to the right file instead of silently ignoring. */
function isDockerImageTarball(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === 'latest.tar.gz') return true;
  // boardripper-vX.Y.Z.tar.gz — note no 'update-' between 'boardripper-' and 'v'
  return /^boardripper-v[0-9][^/]*\.tar\.gz$/.test(lower);
}

function App() {
  themeStore.init();
  useKeyboardShortcuts();
  const { toasts } = useBoardStore();
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // Subscribe to all sidebar changes (collapse, side flip, tab switch)
  const [, sidebarTick] = useState(0);
  useEffect(() => onSidebarChange(() => sidebarTick(n => n + 1)), []);

  // Pre-load the library at app boot so the sidebar's Library tab is
  // ready by the time the user opens it. ensureLoaded is idempotent —
  // safe to call from a mount effect even if other code has already
  // triggered the load. See databank-store.ts:_runStartupLoad.
  useEffect(() => {
    void databankStore.ensureLoaded();
  }, []);

  const sidebarCollapsed = isSidebarCollapsed();
  const sidebarSide = getSidebarSide();

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    dragCounter.current++;
    if (dragCounter.current === 1) setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!isFileDrag(e)) return;
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current = 0;
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    // Update-bundle drop takes priority over board/PDF dispatch. If the user
    // drops an update bundle (with or without other files alongside), we
    // confirm and apply it; the other files are ignored — restarting mid-load
    // would be confusing.
    for (const file of files) {
      if (isUpdateBundle(file.name)) {
        const sizeMiB = (file.size / (1024 * 1024)).toFixed(1);
        const ok = window.confirm(
          `Install update bundle?\n\n` +
          `File: ${file.name}\n` +
          `Size: ${sizeMiB} MiB\n\n` +
          `The container will verify the bundle's signature, ` +
          `apply the update, and restart. The browser will reload after ~30 s.`
        );
        if (ok) await updateStore.applyBundle(file);
        return;
      }
      if (isDockerImageTarball(file.name)) {
        // Friendly redirect — same directory ships both files and the
        // alphabetised listing puts the image first.
        boardStore.addToast(
          `'${file.name}' is the Docker image tarball, not the drop-to-update bundle. ` +
          `Download 'boardripper-update-v*.tar' (or the 'latest-update.tar' alias) from the ` +
          `releases directory and drop that instead.`,
          'error',
        );
        return;
      }
    }

    const boardFiles: File[] = [];
    const pdfFiles: File[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const type = isSupportedFile(file.name);
      if (type === 'board') boardFiles.push(file);
      else if (type === 'pdf') pdfFiles.push(file);
      else skipped.push(file.name);
    }

    // Never discard a drop silently — name what was ignored and why.
    if (skipped.length > 0) {
      const shown = skipped.slice(0, 3).join(', ');
      const more = skipped.length > 3 ? ` (+${skipped.length - 3} more)` : '';
      boardStore.addToast(
        `Ignored ${skipped.length === 1 ? 'unsupported file' : `${skipped.length} unsupported files`}: ` +
        `${shown}${more}. BoardRipper opens boardview files and PDFs.`,
        'error',
      );
    }

    // Load board files
    if (boardFiles.length > 0) {
      await boardStore.loadFiles(boardFiles);
    }

    // Load PDF files
    if (pdfFiles.length > 0) {
      await openPdfFiles(pdfFiles);

      // Re-activate the board panel so PDFs don't steal focus
      if (boardFiles.length > 0) {
        const activeTab = boardStore.activeTabId;
        if (activeTab != null) {
          ensureBoardPanel(activeTab, boardFiles[boardFiles.length - 1].name);
        }
      }
    }

    // Persist the dropped files into the server library's incoming/ folder so
    // they survive reload and appear in the Library panel. Rendering above has
    // already happened; this is best-effort and runs in the background.
    void saveDroppedToIncoming([...boardFiles, ...pdfFiles]);
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    setDockviewApi(api);

    // Wire up board-store callbacks for dockview panel lifecycle
    boardStore.onTabCreated = (tabId, fileName) => {
      ensureBoardPanel(tabId, fileName);
    };
    boardStore.onTabClosed = (tabId) => {
      try {
        const panel = api.getPanel(boardPanelId(tabId));
        if (panel) api.removePanel(panel);
      } catch { /* panel already removed */ }
    };

    // When user closes a panel via dockview X button, clean up store state
    api.onDidRemovePanel((e) => {
      if (e.id.startsWith('board-')) {
        const tabId = parseInt(e.id.slice('board-'.length), 10);
        if (!isNaN(tabId)) {
          boardStore.closeTab(tabId);
        }
      } else if (e.id.startsWith('pdf-')) {
        const pdfFileName = (e.params as Record<string, unknown>)?.pdfFileName as string | undefined;
        if (pdfFileName) {
          // Skip cleanup if the panel is in transit (2-window-mode redock):
          // we just close+re-add to move it; the user did not close the PDF.
          if (isRedockingPdf(pdfFileName)) return;
          for (const tab of boardStore.tabs) {
            if (tab.pdfFileNames.includes(pdfFileName)) {
              boardStore.removePdfBinding(tab.id, pdfFileName);
            }
          }
          pdfStore.closeFile(pdfFileName);
          boardStore.removePdf(pdfFileName);
        }
      }
    });
  }, []);

  return (
    <div
      className="app-container"
      data-testid="app"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <Toolbar />
      <div className="dockview-wrapper">
        {sidebarCollapsed && (
          <button
            className={`sidebar-toggle collapsed sidebar-toggle-${sidebarSide}`}
            style={{ order: sidebarSide === 'left' ? 0 : 2 }}
            onClick={toggleSidebar}
            title="Show sidebar"
          >
            {sidebarSide === 'left' ? '▶' : '◀'}
          </button>
        )}
        <PanelErrorBoundary label="Sidebar">
          <Sidebar />
        </PanelErrorBoundary>
        <div className="dockview-container" style={{ order: sidebarSide === 'left' ? 1 : 0 }}>
          <DockviewReact
            className="dockview-theme-dark"
            onReady={onReady}
            components={components}
            tabComponents={tabComponents}
            disableFloatingGroups={false}
            popoutUrl="popout.html"
          />
          <HomeBackdrop />
        </div>
      </div>
      <StatusBar />
      <ContextMenu />
      <ShortcutsOverlay />
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.type}`} onClick={() => boardStore.dismissToast(t.id)}>
              {t.message}
              {t.action && (
                <button
                  className="toast-action"
                  onClick={(e) => { e.stopPropagation(); t.action?.run(); boardStore.dismissToast(t.id); }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            Drop board files, PDFs, or an update bundle
            <div className="drop-overlay-hint">
              boards · pdfs · boardripper-update-v*.tar · latest-update.tar · *.brupdate
            </div>
          </div>
        </div>
      )}
      <UpdateProgressOverlay />
      <LoadProgressOverlay />
      <PeekHintChip />
      <FZKeyDialog />
      <WelcomeSetup />
    </div>
  );
}

export default App;
