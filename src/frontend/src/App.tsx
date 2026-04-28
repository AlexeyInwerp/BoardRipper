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
import { Sidebar, isSidebarCollapsed, toggleSidebar, onSidebarChange, getSidebarSide } from './components/Sidebar';
import { BoardViewerPanel } from './panels/BoardViewerPanel';
import { PdfViewerPanel } from './panels/PdfViewerPanel';
import { DatabaseEditorPanel } from './panels/DatabaseEditorPanel';
import { BoardTab } from './components/BoardTab';
import { HomeBackdrop } from './components/home/HomeBackdrop';
import { setDockviewApi, ensureBoardPanel, boardPanelId } from './store/dockview-api';
import { boardStore } from './store/board-store';
import { useBoardStore } from './hooks/useBoardStore';
import { pdfStore } from './store/pdf-store';
import { openPdfFiles } from './store/file-actions';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { getAllExtensions, getFileExtension } from './parsers';
import { themeStore } from './store/themes';

const components: Record<string, React.FC<IDockviewPanelProps>> = {
  boardViewer: (props) => <BoardViewerPanel {...props} />,
  pdfViewer: (props) => <PdfViewerPanel {...props} />,
  databaseEditor: (props) => <DatabaseEditorPanel {...props} />,
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

function App() {
  themeStore.init();
  useKeyboardShortcuts();
  const { toasts } = useBoardStore();
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // Subscribe to all sidebar changes (collapse, side flip, tab switch)
  const [, sidebarTick] = useState(0);
  useEffect(() => onSidebarChange(() => sidebarTick(n => n + 1)), []);
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
        <Sidebar />
        <div className="dockview-container" style={{ order: sidebarSide === 'left' ? 1 : 0 }}>
          <DockviewReact
            className="dockview-theme-dark"
            onReady={onReady}
            components={components}
            tabComponents={tabComponents}
            disableFloatingGroups={false}
          />
          <HomeBackdrop />
        </div>
      </div>
      <StatusBar />
      <ContextMenu />
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map(t => (
            <div key={t.id} className={`toast toast-${t.type}`} onClick={() => boardStore.dismissToast(t.id)}>
              {t.message}
            </div>
          ))}
        </div>
      )}
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
