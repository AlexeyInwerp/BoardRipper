import { useRef, useEffect, useState, useCallback } from 'react';
import { IconFlipHorizontal, IconUpload } from '@tabler/icons-react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { useDatabank } from '../hooks/useDatabank';
import { useUpdateStore } from '../hooks/useUpdateStore';
import { toggleSidebar, showSidebarTab } from './Sidebar';
import { exportToBVR3, getAllExtensions, getFileExtension, getFormat } from '../parsers';
import { fileInputRefs } from '../store/file-inputs';
import { formatShortcut } from '../store/keyboard-shortcuts';
import { openPdfFiles } from '../store/file-actions';
import { updateStore } from '../store/update-store';
import { pdfStore } from '../store/pdf-store';
import { openBoardSidebarTab } from '../panels/BoardViewerPanel';
import { databankStore } from '../store/databank-store';
import { setLibrarySearch } from '../panels/LibraryPanel';
import { countInBoardTab, countInPdf, findInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge, type SearchScope } from './SearchScopeBadge';

/** Dropdown showing release notes + update/download action */
function UpdateBadge({ update }: { update: ReturnType<typeof useUpdateStore> }) {
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

  const manifest = state.manifest;
  const isImportant = manifest?.important === true;
  const bodyLines: string[] = [];

  return (
    <div className="update-badge-wrap" ref={ref}>
      <button
        className={`toolbar-btn toolbar-update-badge${state.has_update ? ' has-update' : ''}${isImportant ? ' is-important' : ''}${updating ? ' is-updating' : ''}`}
        onClick={() => {
          // Mid-update the badge becomes a shortcut to the live progress
          // view: jump straight to the Debug tab instead of opening the
          // dropdown (which would show stale "Update & Restart" actions).
          if (updating) { showSidebarTab('debug'); return; }
          if (!open) updateStore.check();
          setOpen(v => !v);
        }}
        title={updating ? 'Updating — see Debug tab' : state.has_update ? (isImportant ? `Important update: ${state.latest_version}` : `Update available: ${state.latest_version}`) : `v${state.current_version} — click to check`}
      >
        {updating ? 'Updating…' : state.has_update ? `${state.latest_version}` : `v${state.current_version}`}
      </button>

      {open && (
        <div className={`update-dropdown${isImportant && state.has_update ? ' update-dropdown-important' : ''}`}>
          <div className="update-dropdown-header">
            <div className="update-dropdown-header-main">
              <span>{state.has_update ? (isImportant ? 'Important update' : 'Update available') : `v${state.current_version}`}</span>
              {state.has_update && <span className="update-dropdown-version-tag">{manifest?.version || state.latest_version}</span>}
            </div>
            {isImportant && manifest?.important_reason && (
              <span className="update-dropdown-important-reason">{manifest.important_reason}</span>
            )}
            <button className="update-dropdown-close" onClick={() => setOpen(false)}>x</button>
          </div>

          {bodyLines.length > 0 && (
            <div className="update-dropdown-body">
              {!state.has_update && !updating && <h4>What&apos;s in this version</h4>}
              {bodyLines.map((line, i) => {
                if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
                if (line.startsWith('### ')) return <h4 key={i}>{line.slice(4)}</h4>;
                if (line.startsWith('- ')) return <li key={i}>{line.slice(2)}</li>;
                if (line.startsWith('| ') || line.startsWith('---')) return null;
                return <p key={i}>{line}</p>;
              })}
            </div>
          )}

          {!state.has_update && !updating && bodyLines.length === 0 && (
            <div className="update-dropdown-body">
              <p>You are on the latest version.</p>
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

          {state.has_update && (
            <div className="update-dropdown-actions">
              {state.docker_available ? (
                <button
                  className="update-dropdown-btn"
                  disabled={updating}
                  onClick={() => {
                    // Reveal the Debug tab so the operator can watch the
                    // verbose progress log scroll as the orchestrator
                    // pulls images, swaps the container, and restarts.
                    showSidebarTab('debug');
                    updateStore.apply();
                    setOpen(false);
                  }}
                >
                  {updating ? 'Updating…' : 'Update & Restart'}
                </button>
              ) : (
                <a
                  className="update-dropdown-btn"
                  href="https://www.ripperdoc.de/boardripper/"
                  target="_blank"
                  rel="noopener"
                >
                  Download from ripperdoc.de
                </a>
              )}
              <div className="update-dropdown-actions-right">
                {state.docker_available && manifest?.notes_url && (
                  <a
                    className="update-dropdown-notes-link"
                    href={manifest.notes_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Release notes ↗
                  </a>
                )}
                <span className="update-dropdown-version">
                  {state.current_version} &#8594; {state.latest_version}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface SearchResult { label: string; count: number; action: () => void; group: string }

/** Global search — searches board tabs, open PDFs, and library. Shows per-tab dropdown. */
function GlobalSearch() {
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Register search input ref for Cmd+F shortcut
  useEffect(() => {
    fileInputRefs.search = inputRef.current;
    return () => { if (fileInputRefs.search === inputRef.current) fileInputRefs.search = null; };
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const runSearch = useCallback((q: string) => {
    const ql = q.toLowerCase().trim();
    if (!ql) { setResults([]); setOpen(false); return; }

    const items: SearchResult[] = [];

    // Board tabs: count matching parts + nets per tab
    for (const tab of boardStore.tabs) {
      if (!tab.board) continue;
      const count = countInBoardTab(ql, tab.id);
      const label = tab.fileName.replace(/\.[^.]+$/, '');
      items.push({
        label, count, group: 'Board',
        action: () => { findInBoardTab(q, tab.id); },
      });
    }

    // PDF tabs: count matches per open document
    for (const fileName of pdfStore.loadedFileNames) {
      const count = countInPdf(ql, fileName);
      const label = fileName.replace(/\.[^.]+$/, '');
      items.push({
        label, count, group: 'PDF',
        action: () => { findInPdf(q, fileName); },
      });
    }

    // Library: count by board_number, filename, manufacturer, model (same filter as LibraryPanel)
    let libraryCount = 0;
    for (const f of databankStore.files) {
      if (f.filename.toLowerCase().includes(ql) ||
          f.board_number?.toLowerCase().includes(ql) ||
          f.manufacturer?.toLowerCase().includes(ql) ||
          f.model?.toLowerCase().includes(ql)) {
        libraryCount++;
      }
    }
    items.push({
      label: 'Library', count: libraryCount, group: 'Library',
      action: () => {
        databankStore.setViewMode('metadata');
        showSidebarTab('library');
        setLibrarySearch(q);
      },
    });
    setResults(items);
    setOpen(true);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => runSearch(v), 250);
  };

  // Group results by category
  const groups = ['Board', 'PDF', 'Library'];

  return (
    <div className="toolbar-search-wrap" ref={wrapRef}>
      <input
        ref={inputRef}
        type="text"
        placeholder="Global search..."
        className="toolbar-search"
        value={query}
        onChange={handleChange}
        onFocus={() => { if (query.trim()) runSearch(query); }}
        data-testid="search-input"
      />
      {open && query.trim() && results.length > 0 && (
        <div className="toolbar-search-dropdown">
          {groups.map(group => {
            const groupItems = results.filter(r => r.group === group);
            if (groupItems.length === 0) return null;
            return groupItems.map((item, i) => (
              <button
                key={`${group}-${i}`}
                className="toolbar-search-option"
                onClick={() => { setOpen(false); item.action(); }}
              >
                <span className="toolbar-search-label">
                  <SearchScopeBadge scope={group.toLowerCase() as SearchScope} />
                  {item.label}
                </span>
                <span className="toolbar-search-count">{item.count}</span>
              </button>
            ));
          })}
        </div>
      )}
    </div>
  );
}

export function Toolbar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // pdfInputRef removed — single Open button + unified file picker now.
  const { showTop, showBottom, butterfly, board, showTraces, activeTabId, flipAxis, rotation } = useBoardStore();
  const { electronMode } = useDatabank();

  // For files where the label convention is inverted (primarySide='bottom'),
  // the UI presents the physical CPU side as "Top". The store's showTop flag
  // still tracks the file's side='top' layer, so swap the active highlight.
  const uiShowTop    = board?.primarySide === 'bottom' ? showBottom : showTop;
  const uiShowBottom = board?.primarySide === 'bottom' ? showTop    : showBottom;
  const update = useUpdateStore();
  const fmt = board ? getFormat(board.format) : undefined;
  const hasLayers = fmt?.hasLayers ?? false;
  const hasTraces = fmt?.hasTraces ?? false;

  useEffect(() => {
    fileInputRefs.board = fileInputRef.current;
    // Both Open Board and Open PDF shortcuts now route through the unified
    // file input — picker shows boards + PDFs together and the change handler
    // splits them by extension.
    fileInputRefs.pdf = fileInputRef.current;
    return () => { fileInputRefs.board = null; fileInputRefs.pdf = null; };
  }, []);

  const handleFileOpen = () => {
    fileInputRef.current?.click();
  };

  /**
   * Single Open button — accepts both board files and PDFs in the same picker.
   * Splits selected files by extension and routes each to the right loader.
   */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) { e.target.value = ''; return; }
    const all = Array.from(files);
    const pdfs: File[] = [];
    const boards: File[] = [];
    for (const f of all) {
      if (getFileExtension(f.name).toLowerCase() === '.pdf') {
        pdfs.push(f);
      } else {
        boards.push(f);
      }
    }
    if (boards.length > 0) {
      // Reuse the existing FileList-based loader by feeding it just the boards.
      // boardStore.loadFiles wants a FileList — synthesise one via DataTransfer.
      const dt = new DataTransfer();
      for (const f of boards) dt.items.add(f);
      await boardStore.loadFiles(dt.files);
    }
    if (pdfs.length > 0) {
      await openPdfFiles(pdfs, { activeTabId });
    }
    e.target.value = '';
  };

  return (
    <div className="toolbar" data-testid="toolbar">
      <input
        ref={fileInputRef}
        type="file"
        accept={[...getAllExtensions(), '.pdf'].join(',')}
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
        data-testid="file-input"
      />
      {/* ── Files ── */}
      <div className="toolbar-group">
        <button
          onClick={toggleSidebar}
          className="toolbar-btn toolbar-btn-icon"
          data-tooltip="Toggle sidebar"
        >
          &#x2261;
        </button>
        {/* In Electron the picker reaches into the local filesystem (truly "Open").
         *  In a browser the file is read into memory client-side — closer to an
         *  upload from the user's mental model — so the web build uses an
         *  IconUpload-prefixed "Upload" label. testid stays `open-btn` to keep
         *  Playwright tests stable across both modes. */}
        <button
          onClick={handleFileOpen}
          className="toolbar-btn"
          data-testid="open-btn"
          data-tooltip={electronMode ? 'Open boards or PDFs' : 'Upload boards or PDFs from your device'}
          style={electronMode ? undefined : { gap: 6 }}
        >
          {electronMode ? 'Open' : (<><IconUpload size={14} stroke={1.75} />Upload</>)}
        </button>
        <button
          onClick={() => openBoardSidebarTab('worklist')}
          className="toolbar-btn"
          data-testid="worklist-btn"
          data-tooltip="Open Worklist sidebar tab (multi-select / mark / export)"
        >
          Worklist
        </button>
      </div>

      {/* ── Side selection ── */}
      <div className="toolbar-group">
        <button
          onClick={(e) => boardStore.selectTop(e.shiftKey)}
          className={`toolbar-btn ${uiShowTop ? 'active' : ''}`}
          data-tooltip={`${formatShortcut('flipBoard')} flip \u00B7 Shift both`}
        >
          Top
        </button>
        {(() => {
          // Icon reflects the SCREEN flip direction, not the internal board axis.
          // Under 90°/270° rotation board X↔screen Y, so flipAxis='x' produces a
          // horizontal screen flip — invert the icon to match what the user sees.
          const axesSwapped = Math.round(rotation / 90) % 2 === 1;
          const screenVertical = (flipAxis === 'x') !== axesSwapped;
          return (
            <button
              onClick={() => boardStore.toggleFlipAxis()}
              className="toolbar-btn toolbar-btn-icon"
              data-tooltip={`Flip axis: ${screenVertical ? 'Vertical' : 'Horizontal'}`}
              style={{ fontSize: '0.75em', padding: '0 4px', minWidth: 0 }}
            >
              {screenVertical ? '⇅' : '⇄'}
            </button>
          );
        })()}
        <button
          onClick={(e) => boardStore.selectBottom(e.shiftKey)}
          className={`toolbar-btn ${uiShowBottom ? 'active' : ''}`}
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
      </div>

      <div className="toolbar-group">
        <button
          onClick={() => boardStore.rotateCCW()}
          className="toolbar-btn toolbar-btn-icon"
          data-tooltip="Rotate CCW (90°)"
        >
          ↺
        </button>
        <button
          onClick={() => boardStore.rotate180()}
          className="toolbar-btn toolbar-btn-icon"
          data-tooltip="Rotate 180°"
          style={{ fontSize: '0.7em', padding: '0 4px', minWidth: 0, fontWeight: 600 }}
        >
          180°
        </button>
        <button
          onClick={() => boardStore.rotateCW()}
          className="toolbar-btn toolbar-btn-icon"
          data-tooltip="Rotate CW (90°)"
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
      </div>

      {/* ── Search ── */}
      <GlobalSearch />

      <div className="toolbar-spacer" />

      {board && board.format !== 'BVR3' && (
        <button
          className="toolbar-btn"
          data-tooltip="Not yet implemented"
          disabled
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

      <UpdateBadge update={update} />
    </div>
  );
}
