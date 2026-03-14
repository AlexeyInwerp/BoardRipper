import { useRef, useEffect } from 'react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel } from '../store/dockview-api';
import { exportToBVR3, getAllExtensions } from '../parsers';

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { showTop, showBottom, butterfly, board, showNetLines, activeTabId, pdfFile } = useBoardStore();

  // Sync pdfStore with the active board tab's PDF on tab switch (instant, no reload).
  useEffect(() => {
    if (pdfFile) {
      pdfStore.switchTo(pdfFile.name);
      ensurePdfPanel(pdfFile.name);
    } else {
      pdfStore.switchTo(null);
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

    // Add all files to registry and auto-bind unbound tabs by name
    for (const file of files) {
      boardStore.addPdf(file);
      boardStore.autoBindPdf(file.name);
    }

    // Bind the last opened PDF to the active tab (explicit user action overrides)
    const lastFile = files[files.length - 1];
    if (activeTabId !== null) {
      boardStore.bindPdf(lastFile.name);
    }

    // Load all PDFs into pdfStore and create panels
    for (const file of files) {
      try {
        await pdfStore.loadFile(file);
        ensurePdfPanel(file.name);
      } catch (err) {
        console.error('[Toolbar] Failed to load PDF:', err);
      }
    }

    // Activate the last opened PDF's panel
    try {
      pdfStore.switchTo(lastFile.name);
      ensurePdfPanel(lastFile.name);
    } catch (err) {
      console.error('[Toolbar] Failed to load PDF:', err);
    }

    e.target.value = '';
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
