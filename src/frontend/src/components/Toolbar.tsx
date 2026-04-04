import { useRef, useEffect, useState, useSyncExternalStore } from 'react';
import { IconFlipHorizontal } from '@tabler/icons-react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { ensureUtilityPanel, ensureLibraryPanel } from '../store/dockview-api';
import { exportToBVR3, getAllExtensions, getFormat } from '../parsers';
import { fileInputRefs } from '../store/file-inputs';
import { formatShortcut } from '../store/keyboard-shortcuts';
import { openPdfFiles } from '../store/file-actions';
import { updateStore } from '../store/update-store';

/** Dropdown showing release notes + update/download action */
function UpdateBadge({ update }: { update: ReturnType<typeof updateStore.getSnapshot> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { state, updating, progress } = update;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (!state.has_update && !updating) return null;

  const rel = state.release_info;
  const body = rel?.body ?? '';

  return (
    <div className="update-badge-wrap" ref={ref}>
      <button
        className="toolbar-btn toolbar-update-badge"
        onClick={() => setOpen(v => !v)}
      >
        {updating ? 'Updating...' : `${state.latest_version}`}
      </button>

      {open && (
        <div className="update-dropdown">
          <div className="update-dropdown-header">
            <span>{rel?.name || state.latest_version}</span>
            <button className="update-dropdown-close" onClick={() => setOpen(false)}>x</button>
          </div>

          {body && (
            <div className="update-dropdown-body">
              {body.split('\n').map((line, i) => {
                if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
                if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
                if (line.startsWith('- ')) return <li key={i}>{line.slice(2)}</li>;
                if (line.startsWith('| ') || line.startsWith('---')) return null;
                if (!line.trim()) return <br key={i} />;
                return <p key={i}>{line}</p>;
              })}
            </div>
          )}

          {updating && progress.length > 0 && (
            <div className="update-dropdown-progress">
              {progress.map((e, i) => (
                <div key={i} className={`update-progress-line update-progress-${e.status}`}>
                  {e.message}
                </div>
              ))}
            </div>
          )}

          {!updating && (
            <div className="update-dropdown-actions">
              {state.docker_available ? (
                <button
                  className="update-dropdown-btn"
                  onClick={() => updateStore.apply()}
                >
                  Update &amp; Restart
                </button>
              ) : (
                <a
                  className="update-dropdown-btn"
                  href={rel?.html_url ?? '#'}
                  target="_blank"
                  rel="noopener"
                >
                  Download from GitHub
                </a>
              )}
              <span className="update-dropdown-version">
                {state.current_version} &#8594; {state.latest_version}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfInputRef = useRef<HTMLInputElement>(null);
  const { showTop, showBottom, butterfly, board, showNetLines, showTraces, activeTabId, flipAxis } = useBoardStore();
  const update = useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
  const fmt = board ? getFormat(board.format) : undefined;
  const hasLayers = fmt?.hasLayers ?? false;
  const hasTraces = fmt?.hasTraces ?? false;

  useEffect(() => {
    fileInputRefs.board = fileInputRef.current;
    fileInputRefs.pdf = pdfInputRef.current;
    return () => { fileInputRefs.board = null; fileInputRefs.pdf = null; };
  }, []);

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
    await openPdfFiles(Array.from(files), { activeTabId });
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
        data-testid="pdf-input"
      />
      <button
        onClick={() => ensureLibraryPanel()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Board library / databank"
      >
        &#x2261;
      </button>
      <button onClick={handleFileOpen} className="toolbar-btn" data-testid="open-btn" data-tooltip={formatShortcut('openBoard')}>
        Open Board
      </button>
      <button onClick={handlePdfOpen} className="toolbar-btn" data-tooltip={formatShortcut('openPdf')}>
        Open PDF
      </button>

      <div className="toolbar-separator" />

      <button
        onClick={(e) => boardStore.selectTop(e.shiftKey)}
        className={`toolbar-btn ${showTop ? 'active' : ''}`}
        data-tooltip={`${formatShortcut('flipBoard')} flip \u00B7 Shift both`}
      >
        Top
      </button>
      <button
        onClick={() => boardStore.toggleFlipAxis()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip={`Flip axis: ${flipAxis.toUpperCase()}`}
        style={{ fontSize: '0.75em', padding: '0 4px', minWidth: 0 }}
      >
        {flipAxis === 'x' ? '⇅' : '⇄'}
      </button>
      <button
        onClick={(e) => boardStore.selectBottom(e.shiftKey)}
        className={`toolbar-btn ${showBottom ? 'active' : ''}`}
        data-tooltip={`${formatShortcut('flipBoard')} flip \u00B7 Shift both`}
      >
        Bottom
      </button>
      {!hasLayers && (
        <button
          onClick={() => boardStore.toggleButterfly()}
          className={`toolbar-btn toolbar-btn-icon ${butterfly ? 'active' : ''}`}
          data-tooltip="Butterfly (side by side)"
        >
          <IconFlipHorizontal size={18} />
        </button>
      )}

      {hasTraces && !hasLayers && (
        <button
          onClick={() => boardStore.toggleTraces()}
          className={`toolbar-btn ${showTraces ? 'active' : ''}`}
          data-tooltip="Toggle PCB traces"
          data-testid="traces-btn"
        >
          Traces
        </button>
      )}

      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.rotateCCW()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Rotate CCW"
      >
        ↺
      </button>
      <button
        onClick={() => boardStore.rotateCW()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Rotate CW"
      >
        ↻
      </button>
      <button
        onClick={() => boardStore.flipHorizontal()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Mirror H"
      >
        ⇔
      </button>
      <button
        onClick={() => boardStore.flipVertical()}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Mirror V"
      >
        ⇕
      </button>

      <div className="toolbar-separator" />

      <button
        onClick={() => boardStore.toggleNetLines()}
        className={`toolbar-btn ${showNetLines ? 'active' : ''}`}
        data-tooltip="Toggle net lines"
      >
        Net Lines
      </button>

      <div className="toolbar-separator" />

      <input
        type="text"
        placeholder="Search component or net..."
        className="toolbar-search"
        onChange={(e) => boardStore.setSearch(e.target.value)}
        ref={(el) => { fileInputRefs.search = el; }}
        data-testid="search-input"
      />

      <div className="toolbar-separator" />

      <button
        onClick={() => ensureUtilityPanel('settings', 'settings', 'Settings')}
        className="toolbar-btn toolbar-btn-icon"
        data-tooltip="Settings"
      >
        ⚙
      </button>
      <button
        onClick={() => ensureUtilityPanel('debug', 'debug', 'Debug')}
        className="toolbar-btn"
        data-tooltip="Debug log"
        style={{ fontFamily: 'monospace', fontSize: '0.85em' }}
      >
        &gt;_
      </button>

      <div className="toolbar-spacer" />

      {board && (
        <>
          {board.format !== 'BVR3' && (
            <button
              className="toolbar-btn"
              data-tooltip={`Save this ${board.format} board as BVR3 for archival`}
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

      <UpdateBadge update={update} />
    </div>
  );
}
