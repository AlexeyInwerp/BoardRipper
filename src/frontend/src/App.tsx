import { useCallback, useState, useRef, useEffect, useSyncExternalStore } from 'react';
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
import { BoardViewerPanel } from './panels/BoardViewerPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { PdfViewerPanel } from './panels/PdfViewerPanel';
import { DebugPanel } from './panels/DebugPanel';
import { LibraryPanel } from './panels/LibraryPanel';
import { setDockviewApi, ensureBoardPanel, ensurePdfPanel, ensureLibraryPanel, boardPanelId, toggleSidebar, isSidebarCollapsed, onSidebarChange, getSidebarWidth } from './store/dockview-api';
import { boardStore } from './store/board-store';
import { pdfStore } from './store/pdf-store';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { getAllExtensions, getFileExtension } from './parsers';
import { log } from './store/log-store';

const components: Record<string, React.FC<IDockviewPanelProps>> = {
  boardViewer: (props) => <BoardViewerPanel {...props} />,
  settings: () => <SettingsPanel />,
  pdfViewer: (props) => <PdfViewerPanel {...props} />,
  debug: () => <DebugPanel />,
  library: () => <LibraryPanel />,
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

function App() {
  useKeyboardShortcuts();
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  const sidebarCollapsed = useSyncExternalStore(onSidebarChange, isSidebarCollapsed);
  const [sidebarLeft, setSidebarLeft] = useState(0);

  // Track sidebar group width to position the toggle button at its right edge
  useEffect(() => {
    const update = () => setSidebarLeft(getSidebarWidth());
    // Poll sidebar width — dockview doesn't expose group resize events,
    // so we check periodically (lightweight: just reads one property)
    let lastWidth = -1;
    const poll = setInterval(() => {
      const w = getSidebarWidth();
      if (w !== lastWidth) { lastWidth = w; setSidebarLeft(w); }
    }, 200);
    // Also update immediately when sidebar state changes (toggle)
    const unsub = onSidebarChange(update);
    update();
    return () => { clearInterval(poll); unsub(); };
  }, []);

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

    const boardFiles: File[] = [];
    const pdfFiles: File[] = [];

    for (const file of files) {
      const type = isSupportedFile(file.name);
      if (type === 'board') boardFiles.push(file);
      else if (type === 'pdf') pdfFiles.push(file);
    }

    // Load board files
    if (boardFiles.length > 0) {
      await boardStore.loadFiles(boardFiles);
    }

    // Load PDF files (same flow as Toolbar)
    if (pdfFiles.length > 0) {
      for (const file of pdfFiles) {
        boardStore.addPdf(file);
        boardStore.autoBindPdf(file.name);
      }

      const activeTabId = boardStore.activeTabId;
      const lastFile = pdfFiles[pdfFiles.length - 1];
      if (activeTabId !== null) {
        boardStore.addPdfBinding(activeTabId, lastFile.name);
      }

      for (const file of pdfFiles) {
        try {
          await pdfStore.loadFile(file);
          ensurePdfPanel(file.name);
        } catch (err) {
          log.ui.error('Failed to load PDF:', err);
        }
      }

      try {
        pdfStore.switchTo(lastFile.name);
        ensurePdfPanel(lastFile.name);
      } catch (err) {
        log.ui.error('Failed to activate PDF:', err);
      }

      // Re-activate the board panel so PDFs don't steal focus
      if (boardFiles.length > 0) {
        const activeTab = boardStore.activeTabId;
        if (activeTab != null) {
          ensureBoardPanel(activeTab, boardFiles[boardFiles.length - 1].name);
        }
      }
    }
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
        // Remove PDF binding from all board tabs that reference this PDF
        const pdfFileName = (e.params as Record<string, unknown>)?.pdfFileName as string | undefined;
        if (pdfFileName) {
          for (const tab of boardStore.tabs) {
            if (tab.pdfFileNames.includes(pdfFileName)) {
              boardStore.removePdfBinding(tab.id, pdfFileName);
            }
          }
        }
      }
    });

    // Auto-open Library as the first (leftmost) panel on page load
    ensureLibraryPanel();
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
        <button
          className={`sidebar-toggle${sidebarCollapsed ? ' collapsed' : ''}`}
          style={{ left: sidebarLeft }}
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
        >
          {sidebarCollapsed ? '\u25B6' : '\u25C0'}
        </button>
        <div className="dockview-container">
          <DockviewReact
            className="dockview-theme-dark"
            onReady={onReady}
            components={components}
            disableFloatingGroups={false}
          />
        </div>
      </div>
      <StatusBar />
      <ContextMenu />
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-content">
            Drop board or PDF files here
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
