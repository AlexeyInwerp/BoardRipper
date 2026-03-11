import { useCallback } from 'react';
import {
  DockviewReact,
} from 'dockview-react';
import type {
  DockviewReadyEvent,
  IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { BoardCanvas } from './components/BoardCanvas';
import { Toolbar } from './components/Toolbar';
import { TabBar } from './components/TabBar';
import { StatusBar } from './components/StatusBar';
import { ContextMenu } from './components/ContextMenu';
import { ComponentInfoPanel } from './panels/ComponentInfoPanel';
import { NetListPanel } from './panels/NetListPanel';
import { SearchResultsPanel } from './panels/SearchResultsPanel';
import { SettingsPanel } from './panels/SettingsPanel';
import { PdfViewerPanel } from './panels/PdfViewerPanel';
import { setDockviewApi } from './store/dockview-api';

const components: Record<string, React.FC<IDockviewPanelProps>> = {
  boardCanvas: () => <BoardCanvas />,
  componentInfo: () => <ComponentInfoPanel />,
  netList: () => <NetListPanel />,
  searchResults: () => <SearchResultsPanel />,
  settings: () => <SettingsPanel />,
  pdfViewer: () => <PdfViewerPanel />,
};

function App() {
  const onReady = useCallback((event: DockviewReadyEvent) => {
    const api = event.api;
    setDockviewApi(api);

    // Main board canvas panel
    api.addPanel({
      id: 'board',
      component: 'boardCanvas',
      title: 'Board View',
    });

    // Right sidebar - component info
    api.addPanel({
      id: 'componentInfo',
      component: 'componentInfo',
      title: 'Component Info',
      position: { referencePanel: 'board', direction: 'right' },
      initialWidth: 320,
    });

    // Right sidebar - net list (tabbed with component info)
    api.addPanel({
      id: 'netList',
      component: 'netList',
      title: 'Net List',
      position: { referencePanel: 'componentInfo' },
    });

    // Right sidebar - search results (tabbed)
    api.addPanel({
      id: 'searchResults',
      component: 'searchResults',
      title: 'Search',
      position: { referencePanel: 'componentInfo' },
    });

    // Settings panel (tabbed with right sidebar)
    api.addPanel({
      id: 'settings',
      component: 'settings',
      title: 'Settings',
      position: { referencePanel: 'componentInfo' },
    });

    // Activate component info tab by default
    const compPanel = api.getPanel('componentInfo');
    compPanel?.api.setActive();
  }, []);

  return (
    <div className="app-container" data-testid="app">
      <Toolbar />
      <TabBar />
      <div className="dockview-container">
        <DockviewReact
          className="dockview-theme-dark"
          onReady={onReady}
          components={components}
          disableFloatingGroups={false}
        />
      </div>
      <StatusBar />
      <ContextMenu />
    </div>
  );
}

export default App;
