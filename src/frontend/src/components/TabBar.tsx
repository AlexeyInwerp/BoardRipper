import { useCallback } from 'react';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from './BindLink';
import { ensurePdfPanel } from '../store/dockview-api';

export function TabBar() {
  const { tabs, activeTabId, pdfFileNames } = useBoardStore();

  const handleTogglePdf = useCallback((tabId: number, pdfFileName: string | null) => {
    if (pdfFileName === null) {
      boardStore.clearPdfBindings(tabId);
      if (tabId === activeTabId) pdfStore.switchTo(null);
    } else {
      boardStore.togglePdfBinding(tabId, pdfFileName);
      if (tabId === activeTabId) {
        pdfStore.switchTo(pdfFileName);
        ensurePdfPanel(pdfFileName);
      }
    }
  }, [activeTabId]);

  if (tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map(tab => (
        <div
          key={tab.id}
          className={`tab-item ${tab.id === activeTabId ? 'active' : ''}`}
          onClick={() => boardStore.switchTab(tab.id)}
        >
          {pdfFileNames.length > 0 && (
            <BindLink
              boundNames={tab.pdfFileNames}
              options={pdfFileNames}
              onToggle={(name) => handleTogglePdf(tab.id, name)}
              title={tab.pdfFileNames.length > 0 ? `PDFs: ${tab.pdfFileNames.join(', ')}` : 'No PDF linked'}
            />
          )}
          <span className="tab-name" title={tab.fileName}>
            {tab.fileName}
          </span>
          <button
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              boardStore.closeTab(tab.id);
            }}
            title="Close"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
