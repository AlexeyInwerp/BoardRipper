import { useRef, useEffect, useState } from 'react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { pdfStore } from '../store/pdf-store';
import { getDockviewApi } from '../store/dockview-api';
import { exportToBVR3, getAllExtensions } from '../parsers';

function ensurePdfPanel(title: string) {
  try {
    const api = getDockviewApi();
    if (!api) return;
    const existing = api.getPanel('pdfViewer');
    if (existing) {
      existing.api.setActive();
      existing.setTitle(title);
    } else {
      api.addPanel({
        id: 'pdfViewer',
        component: 'pdfViewer',
        title,
        position: { referencePanel: 'board', direction: 'below' },
        initialHeight: 400,
      });
    }
  } catch (err) {
    console.error('[Toolbar] Failed to open PDF panel:', err);
  }
}

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { showTop, showBottom, butterfly, board, showNetLines, activeTabId, pdfFile, pdfFileNames } = useBoardStore();
  const [showPdfPicker, setShowPdfPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close PDF picker on click outside
  useEffect(() => {
    if (!showPdfPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPdfPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPdfPicker]);

  // Sync pdfStore with the active board tab's PDF on tab switch.
  useEffect(() => {
    if (pdfFile) {
      if (pdfFile.name !== pdfStore.fileName) {
        pdfStore.loadFile(pdfFile).catch(console.error);
        ensurePdfPanel('PDF: ' + pdfFile.name);
      }
    } else if (pdfStore.isLoaded) {
      pdfStore.close();
    }
  }, [activeTabId]); // intentionally omit pdfFile — only run on tab switch

  const handleFileOpen = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      await boardStore.loadFiles(files);
    }
    e.target.value = '';
  };

  const handlePdfOpen = () => {
    pdfInputRef.current?.click();
  };

  const handlePdfChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) { e.target.value = ''; return; }

    for (const file of files) {
      // Add to registry
      boardStore.addPdf(file);
      // Auto-bind by name match
      boardStore.autoBindPdf(file.name);
    }

    // Show the PDF bound to current tab, or last opened
    const currentPdf = boardStore.pdfFile;
    const fileToShow = currentPdf ?? files[files.length - 1];

    // If no PDF was auto-bound, bind last opened to current tab
    if (!currentPdf && activeTabId !== null) {
      boardStore.bindPdf(fileToShow.name);
    }

    try {
      await pdfStore.loadFile(fileToShow);
      ensurePdfPanel('PDF: ' + fileToShow.name);
    } catch (err) {
      console.error('[Toolbar] Failed to load PDF:', err);
    }

    e.target.value = '';
  };

  const handleBindPdf = async (pdfFileName: string | null) => {
    setShowPdfPicker(false);
    boardStore.bindPdf(pdfFileName);
    if (pdfFileName) {
      const entry = boardStore.pdfFiles.get(pdfFileName);
      if (entry) {
        await pdfStore.loadFile(entry.file);
        ensurePdfPanel('PDF: ' + pdfFileName);
      }
    } else {
      pdfStore.close();
    }
  };

  return (
    <div className="toolbar" data-testid="toolbar">
      <input
        ref={fileInputRef}
        type="file"
        accept={getAllExtensions().join(',')}
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
        data-testid="file-input"
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf"
        multiple
        onChange={handlePdfChange}
        style={{ display: 'none' }}
      />
      <button onClick={handleFileOpen} className="toolbar-btn" data-testid="open-btn">
        Open Board
      </button>
      <button onClick={handlePdfOpen} className="toolbar-btn">
        Open PDF
      </button>

      {/* PDF binding indicator / picker */}
      {pdfFileNames.length > 0 && (
        <div className="toolbar-pdf-bind" ref={pickerRef}>
          <button
            className={`toolbar-btn toolbar-btn-pdf ${pdfFile ? 'active' : ''}`}
            onClick={() => setShowPdfPicker(!showPdfPicker)}
            title={pdfFile ? `PDF: ${pdfFile.name} (click to change)` : 'No PDF bound (click to bind)'}
          >
            {pdfFile ? pdfFile.name.replace(/\.pdf$/i, '') : 'Bind PDF'}
            <span className="toolbar-btn-caret"> ▾</span>
          </button>
          {showPdfPicker && (
            <div className="toolbar-pdf-dropdown">
              <div
                className={`toolbar-pdf-option ${!pdfFile ? 'active' : ''}`}
                onClick={() => handleBindPdf(null)}
              >
                (none)
              </div>
              {pdfFileNames.map(name => (
                <div
                  key={name}
                  className={`toolbar-pdf-option ${pdfFile?.name === name ? 'active' : ''}`}
                  onClick={() => handleBindPdf(name)}
                >
                  {name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="toolbar-separator" />

      <button
        onClick={(e) => boardStore.selectTop(e.shiftKey)}
        className={`toolbar-btn ${showTop ? 'active' : ''}`}
        title="Top layer (Shift+click for both)"
      >
        Top
      </button>
      <button
        onClick={(e) => boardStore.selectBottom(e.shiftKey)}
        className={`toolbar-btn ${showBottom ? 'active' : ''}`}
        title="Bottom layer (Shift+click for both)"
      >
        Bottom
      </button>
      <button
        onClick={() => boardStore.toggleButterfly()}
        className={`toolbar-btn ${butterfly ? 'active' : ''}`}
        title="Butterfly mode: top and bottom side by side"
      >
        Butterfly
      </button>

      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.rotateCCW()}
        className="toolbar-btn toolbar-btn-icon"
        title="Rotate 90° counter-clockwise"
      >
        ↺
      </button>
      <button
        onClick={() => boardStore.rotateCW()}
        className="toolbar-btn toolbar-btn-icon"
        title="Rotate 90° clockwise"
      >
        ↻
      </button>
      <button
        onClick={() => boardStore.flipHorizontal()}
        className="toolbar-btn toolbar-btn-icon"
        title="Mirror horizontal"
      >
        ⇔
      </button>
      <button
        onClick={() => boardStore.flipVertical()}
        className="toolbar-btn toolbar-btn-icon"
        title="Mirror vertical"
      >
        ⇕
      </button>

      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.toggleNetLines()}
        className={`toolbar-btn ${showNetLines ? 'active' : ''}`}
        title="Show net connection lines between components"
      >
        Net Lines
      </button>

      <div className="toolbar-separator" />

      <input
        type="text"
        placeholder="Search component or net..."
        className="toolbar-search"
        onChange={(e) => boardStore.setSearch(e.target.value)}
        data-testid="search-input"
      />

      <div className="toolbar-spacer" />

      {board && (
        <>
          {board.format !== 'BVR3' && (
            <button
              className="toolbar-btn"
              title={`Save this ${board.format} board as BVR3 for archival`}
              onClick={() => {
                const bvr3 = exportToBVR3(board);
                const blob = new Blob([bvr3], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                const base = boardStore.fileName.replace(/\.[^.]+$/, '');
                a.download = `${base}.bvr`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Save as BVR3
            </button>
          )}
          <span className="toolbar-stats" data-testid="file-name">
            {board.parts.length} parts | {board.nets.size} nets
          </span>
        </>
      )}
    </div>
  );
}
