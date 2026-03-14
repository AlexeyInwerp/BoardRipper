import { useCallback } from 'react';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { BindLink } from './BindLink';
import { ensurePdfPanel } from '../store/dockview-api';

export function TabBar() {
  const { tabs, activeTabId, pdfFileNames } = useBoardStore();

  const handleBindPdf = useCallback((tabId: number, pdfFileName: string | null) => {
    boardStore.bindPdfToTab(tabId, pdfFileName);
    if (tabId === activeTabId) {
      if (pdfFileName) {
        pdfStore.switchTo(pdfFileName);
        ensurePdfPanel(pdfFileName);
      } else {
        pdfStore.switchTo(null);
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
              boundName={tab.pdfFileName}
              options={pdfFileNames}
              onBind={(name) => handleBindPdf(tab.id, name)}
              title={tab.pdfFileName ? `PDF: ${tab.pdfFileName}` : 'No PDF linked'}
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
