import { useRef } from 'react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { pdfStore } from '../store/pdf-store';
import { getDockviewApi } from '../store/dockview-api';

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { showTop, showBottom, board } = useBoardStore();

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
    const file = e.target.files?.[0];
    if (!file) return;

    await pdfStore.loadFile(file);

    // Open or activate the PDF panel in dockview
    const api = getDockviewApi();
    if (api) {
      const existing = api.getPanel('pdfViewer');
      if (existing) {
        existing.api.setActive();
      } else {
        api.addPanel({
          id: 'pdfViewer',
          component: 'pdfViewer',
          title: 'PDF: ' + file.name,
          position: { referencePanel: 'board', direction: 'below' },
          initialHeight: 400,
        });
      }
    }

    e.target.value = '';
  };

  return (
    <div className="toolbar" data-testid="toolbar">
      <input
        ref={fileInputRef}
        type="file"
        accept=".bvr,.bv"
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
        data-testid="file-input"
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf"
        onChange={handlePdfChange}
        style={{ display: 'none' }}
      />
      <button onClick={handleFileOpen} className="toolbar-btn" data-testid="open-btn">
        Open BVR
      </button>
      <button onClick={handlePdfOpen} className="toolbar-btn">
        Open PDF
      </button>
      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.toggleTop()}
        className={`toolbar-btn ${showTop ? 'active' : ''}`}
        title="Toggle top layer"
      >
        Top
      </button>
      <button
        onClick={() => boardStore.toggleBottom()}
        className={`toolbar-btn ${showBottom ? 'active' : ''}`}
        title="Toggle bottom layer"
      >
        Bottom
      </button>

      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.rotateCCW()}
        className="toolbar-btn"
        title="Rotate 90° counter-clockwise"
      >
        ↺
      </button>
      <button
        onClick={() => boardStore.rotateCW()}
        className="toolbar-btn"
        title="Rotate 90° clockwise"
      >
        ↻
      </button>
      <button
        onClick={() => boardStore.flipHorizontal()}
        className="toolbar-btn"
        title="Mirror horizontal"
      >
        ⇔
      </button>
      <button
        onClick={() => boardStore.flipVertical()}
        className="toolbar-btn"
        title="Mirror vertical"
      >
        ⇕
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
        <span className="toolbar-stats" data-testid="file-name">
          {board.parts.length} parts | {board.nets.size} nets
        </span>
      )}
    </div>
  );
}
