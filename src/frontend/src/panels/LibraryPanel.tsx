import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useDatabank } from '../hooks/useDatabank';
import { databankStore } from '../store/databank-store';
import type { DatabankFile, FileDetail, FolderNode, MetadataGroup, ModelGroup } from '../store/databank-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel, ensureBoardPanel } from '../store/dockview-api';
import { lookupBoard } from '../store/apple-boards';
import { IconStack2, IconHistory, IconFolder, IconFolderSearch, IconFileText } from '@tabler/icons-react';
import { log } from '../store/log-store';

/** Persisted tree expansion state — survives tab switches and page reloads.
 *  Closing a parent keeps children's keys in the Set so re-opening restores them. */
function usePersistedExpanded(storageKey: string, defaultKeys: string[] = []): [Set<string>, (key: string) => void, () => void] {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch { /* ignore */ }
    return new Set(defaultKeys);
  });

  const toggle = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }, [storageKey]);

  const collapseAll = useCallback(() => {
    const empty = new Set<string>();
    setExpanded(empty);
    try { localStorage.setItem(storageKey, '[]'); } catch { /* ignore */ }
  }, [storageKey]);

  return [expanded, toggle, collapseAll];
}

const MULTILAYER_FORMATS = new Set(['TVW', 'ALLEGRO_BRD']);
/** Extensions that always indicate multi-layer formats (format_id may not be set by backend) */
const MULTILAYER_EXTENSIONS = new Set(['.tvw']);

function tailTruncate(s: string, max = 60) {
  return s.length > max ? '...' + s.slice(-(max - 3)) : s;
}

// Global setter for toolbar search integration
let _externalSearchSetter: ((q: string) => void) | null = null;
export function setLibrarySearch(query: string): void {
  _externalSearchSetter?.(query);
}

export function LibraryPanel() {
  const {
    files, folderTree, scanStatus, viewMode, selectedFileId,
    selectedFileDetail, loading, metadataTree,
    autoPdf, searchResults, searchQuery, modelTree, backendAvailable,
    libraryPath, electronMode,
    browseMode, browseResult, browsing,
  } = useDatabank();
  const [localSearch, setLocalSearch] = useState('');

  // Register external setter
  useEffect(() => {
    _externalSearchSetter = setLocalSearch;
    return () => { if (_externalSearchSetter === setLocalSearch) _externalSearchSetter = null; };
  }, []);
  const [pdfSearchMode, setPdfSearchMode] = useState(false);

  // Client-side filter: match filename, board_number, manufacturer, model (case-insensitive)
  const searchFilter = localSearch.trim().toLowerCase();
  const filterFile = useCallback((f: DatabankFile) => {
    if (!searchFilter) return true;
    return (
      f.filename.toLowerCase().includes(searchFilter) ||
      f.board_number?.toLowerCase().includes(searchFilter) ||
      f.manufacturer?.toLowerCase().includes(searchFilter) ||
      f.model?.toLowerCase().includes(searchFilter)
    );
  }, [searchFilter]);

  // Load data on mount
  useEffect(() => {
    if (typeof window !== 'undefined' && window.electronAPI?.scanLibrary) {
      databankStore.initElectron();
      return;
    }
    // loadConfig must run first: it discovers library_dir / _scan_root
    // and flips _backendAvailable. Files + scan status can race.
    databankStore.loadConfig().then(() => {
      Promise.all([
        databankStore.fetchFiles(),
        databankStore.checkScanStatus(),
      ]);
    });
    // folderTree fetch is deferred to first use (see the effect below)
  }, []);

  // Fetch folder tree only the first time the user opens the Folders tab
  // in database mode. For Electron mode the tree is built during _electronScan
  // and folderTree is already populated — no fetch needed.
  useEffect(() => {
    if (electronMode) return;
    if (viewMode !== 'folders' || browseMode !== 'database') return;
    if (folderTree) return;
    databankStore.fetchTree();
  }, [viewMode, browseMode, folderTree, electronMode]);

  // Normalize: entering history while PDF-search mode is active would leave
  // pdfSearchMode=true without any UI control to turn it off.
  useEffect(() => {
    if (viewMode === 'history' && pdfSearchMode) {
      setPdfSearchMode(false);
      if (searchQuery) databankStore.search('');
    }
  }, [viewMode, pdfSearchMode, searchQuery]);

  const handleFileScan = useCallback(() => {
    databankStore.triggerFileScan();
  }, []);

  const handleOpenFile = useCallback(async (file: DatabankFile, pageNum?: number) => {
    databankStore.selectFile(file.id);
    databankStore.addToHistory(file);
    try {
      const fileObj = await databankStore.fetchFileBuffer(file);
      if (file.file_type === 'board') {
        await boardStore.loadFiles([fileObj]);

        // Fetch bindings and auto-load bound PDFs (if enabled)
        if (autoPdf) {
          const detail = await databankStore.fetchFileDetail(file.id);
          if (detail?.bindings) {
            for (const binding of detail.bindings) {
              try {
                const pdfFile = files.find(f => f.id === binding.pdf_file_id);
                if (!pdfFile) continue;
                const pdfObj = await databankStore.fetchFileBuffer(pdfFile);
                boardStore.addPdf(pdfObj);
                boardStore.addPdfBinding(boardStore.activeTabId!, pdfObj.name);
                await pdfStore.loadFile(pdfObj);
                ensurePdfPanel(pdfObj.name);
              } catch (err) {
                log.ui.error('Failed to load bound PDF:', err);
              }
            }
            // Re-activate the board panel so auto-loaded PDFs don't steal focus
            const activeTab = boardStore.activeTabId;
            if (activeTab != null) {
              ensureBoardPanel(activeTab, fileObj.name);
            }
          }
        }
      } else if (file.file_type === 'pdf') {
        boardStore.addPdf(fileObj);
        boardStore.autoBindPdf(fileObj.name);
        await pdfStore.loadFile(fileObj);
        ensurePdfPanel(fileObj.name);
        pdfStore.switchTo(fileObj.name);
        // Pre-populate PDF viewer search with library search query
        if (pdfSearchMode && searchQuery) {
          pdfStore.searchText(searchQuery);
        }
        // Navigate to the specific page from the search result
        if (pageNum) {
          pdfStore.goToPage(pageNum);
        }
      }
    } catch (err) {
      log.ui.error('Failed to open file:', err);
    }
  }, [files, autoPdf]);

  const handleSelectFile = useCallback((file: DatabankFile) => {
    databankStore.selectFile(file.id);
    databankStore.fetchFileDetail(file.id);
  }, []);

  const handleCreateBinding = useCallback(async (boardFileId: number, pdfFileId: number) => {
    await databankStore.createBinding(boardFileId, pdfFileId);
    // Refresh the detail
    if (selectedFileId) databankStore.fetchFileDetail(selectedFileId);
  }, [selectedFileId]);

  const handleDeleteBinding = useCallback(async (bindingId: number) => {
    await databankStore.deleteBinding(bindingId);
    if (selectedFileId) databankStore.fetchFileDetail(selectedFileId);
  }, [selectedFileId]);

  const scanning = scanStatus?.running ?? false;
  const { boardCount, pdfCount } = useMemo(() => {
    let b = 0, p = 0;
    for (const f of files) { if (f.file_type === 'board') b++; else if (f.file_type === 'pdf') p++; }
    return { boardCount: b, pdfCount: p };
  }, [files]);

  return (
    <div className="library-panel">
      {/* Header bar */}
      <div className="library-header">
        <div className="library-tabs">
          <button
            className={`library-tab ${viewMode === 'history' ? 'active' : ''}`}
            onClick={() => databankStore.setViewMode('history')}
            title="Recently opened"
          >
            <IconHistory size={14} />
          </button>
          <button
            className={`library-tab ${viewMode === 'metadata' ? 'active' : ''}`}
            onClick={() => databankStore.setViewMode('metadata')}
          >
            Board #
          </button>
          <button
            className={`library-tab ${viewMode === 'model' ? 'active' : ''}`}
            onClick={() => databankStore.setViewMode('model')}
          >
            Model
          </button>
          <button
            className={`library-tab ${viewMode === 'folders' ? 'active' : ''}`}
            onClick={() => databankStore.setViewMode('folders')}
            title="Browse folders"
          >
            <IconFolder size={14} />
          </button>
        </div>
        {viewMode === 'folders' && (
          <div className="library-browse-toggle">
            <button className={`library-tab ${browseMode === 'database' ? 'active' : ''}`}
              onClick={() => databankStore.setBrowseMode('database')}>Database</button>
            <button className={`library-tab ${browseMode === 'live' ? 'active' : ''}`}
              onClick={() => databankStore.setBrowseMode('live')}>Live</button>
          </div>
        )}
        <div className="library-actions">
          <label className="library-donor-filter" title="Auto-load bound PDFs when opening a board">
            <input
              type="checkbox"
              checked={autoPdf}
              onChange={(e) => databankStore.setAutoPdf(e.target.checked)}
            />
            Auto PDF
          </label>
          {!(viewMode === 'folders' && browseMode === 'live') && (
            scanStatus?.running ? (
              <button className="library-scan-btn library-scan-stop" onClick={() => databankStore.stopScan()} title="Stop scan">Stop</button>
            ) : scanStatus?.pdf_running ? (
              <button className="library-scan-btn library-scan-stop" onClick={() => databankStore.stopScan()} title="Stop PDF extraction">Stop</button>
            ) : (
              <>
                <button className="library-scan-btn library-scan-icon" onClick={handleFileScan} title="Scan filesystem for board and PDF files">
                  <IconFolderSearch size={14} />
                </button>
                <button className="library-scan-btn library-scan-icon" onClick={() => databankStore.triggerPdfScan()} title="Extract text from PDFs for search">
                  <IconFileText size={14} />
                </button>
              </>
            )
          )}
        </div>
      </div>

      {/* Stats / indexing indicator */}
      <div className="library-stats">
        {scanning ? (
          <>
            <span className="library-indexing">
              Indexing{scanStatus && scanStatus.total > 0
                ? ` ${scanStatus.scanned}/${scanStatus.total}`
                : ''}
              {scanStatus?.phase ? ` — ${scanStatus.phase}` : '...'}
            </span>
            {scanStatus?.last_file && (
              <div className="library-indexing-file" title={scanStatus.last_file}>
                {tailTruncate(scanStatus.last_file)}
              </div>
            )}
          </>
        ) : (
          <>
            {boardCount} boards, {pdfCount} PDFs
            {scanStatus && scanStatus.duration_ms > 0 && (
              <span className="library-scan-result">
                {` — +${scanStatus.added} -${scanStatus.deleted} ~${scanStatus.updated} (${scanStatus.scanned}/${scanStatus.total}, ${scanStatus.duration_ms}ms)`}
              </span>
            )}
            {scanStatus?.pdf_running && (
              <span className="library-indexing" style={{ marginLeft: 8 }}>
                PDF indexing {scanStatus.pdf_extracted}/{scanStatus.pdf_total}
                {(scanStatus.pdf_errors ?? 0) > 0 && ` (${scanStatus.pdf_errors} err)`}
              </span>
            )}
            {scanStatus?.pdf_running && scanStatus?.pdf_current && (
              <div className="library-indexing-file" title={scanStatus.pdf_current}>
                {tailTruncate(scanStatus.pdf_current)}
              </div>
            )}
          </>
        )}
      </div>

      {/* Search */}
      <div className="library-search">
        <input
          type="text"
          placeholder={pdfSearchMode ? "Search PDF content (e.g. 10UF 25V)..." : "Filter files..."}
          className="library-search-input"
          value={localSearch}
          onChange={(e) => {
            setLocalSearch(e.target.value);
            // Clear PDF search results when typing in filter mode
            if (!pdfSearchMode && searchQuery) databankStore.search('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pdfSearchMode && localSearch.trim()) {
              databankStore.search(localSearch);
            }
          }}
        />
        {viewMode !== 'history' && (
          <label className="library-pdf-search-toggle" title="Toggle PDF content search (searches inside PDF text)">
            <input
              type="checkbox"
              checked={pdfSearchMode}
              onChange={(e) => {
                setPdfSearchMode(e.target.checked);
                if (!e.target.checked && searchQuery) databankStore.search('');
              }}
            />
            PDF
          </label>
        )}
        {pdfSearchMode && (
          <button
            className="library-search-btn"
            onClick={() => {
              if (localSearch.trim()) databankStore.search(localSearch);
            }}
          >
            Search
          </button>
        )}
        {(localSearch || searchQuery) && (
          <button
            className="library-search-clear"
            onClick={() => {
              setLocalSearch('');
              if (searchQuery) databankStore.search('');
            }}
            title="Clear search"
          >
            x
          </button>
        )}
      </div>

      {/* Electron library folder picker */}
      {electronMode && (
        <div className="library-folder-bar">
          <button
            className="library-folder-btn"
            onClick={() => databankStore.selectLibraryFolder()}
          >
            {libraryPath ? 'Change Folder' : 'Set Library Folder'}
          </button>
          {libraryPath && (
            <span className="library-folder-path" title={libraryPath}>
              {libraryPath.length > 40 ? '...' + libraryPath.slice(-37) : libraryPath}
            </span>
          )}
        </div>
      )}

      {/* Backend warning (web mode only) */}
      {!electronMode && !backendAvailable && (
        <div className="library-backend-warn">
          Backend unavailable — start Docker or run the Go server on :8080
        </div>
      )}

      {/* Content */}
      <div className="library-content">
        {pdfSearchMode && searchResults.length > 0 ? (
          <SearchResultsView results={searchResults} files={files} onOpenFile={handleOpenFile} />
        ) : loading && files.length === 0 ? (
          <div className="library-empty">Loading...</div>
        ) : files.length === 0 ? (
          <div className="library-empty">
            No files found. Click Scan to index your data directory.
          </div>
        ) : pdfSearchMode && searchQuery && searchResults.length === 0 ? (
          <div className="library-empty">No results for "{searchQuery}"</div>
        ) : viewMode === 'history' ? (
          <HistoryView onOpenFile={handleOpenFile} searchFilter={localSearch} />
        ) : viewMode === 'model' ? (
          <ModelView
            groups={modelTree}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
          />
        ) : viewMode === 'metadata' ? (
          <MetadataView
            groups={metadataTree}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
          />
        ) : viewMode === 'folders' && browseMode === 'live' ? (
          <LiveBrowser browseResult={browseResult} browsing={browsing} />
        ) : (
          <FolderView
            tree={folderTree}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            searchFilter={localSearch}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
          />
        )}
      </div>

      {/* File Detail Pane */}
      {selectedFileDetail && (
        <FileDetailPane
          detail={selectedFileDetail}
          files={files}
          onOpen={handleOpenFile}
          onCreateBinding={handleCreateBinding}
          onDeleteBinding={handleDeleteBinding}
        />
      )}
    </div>
  );
}

// --- Live Browser ---

function LiveBrowser({ browseResult, browsing }: {
  browseResult: import('../store/databank-store').BrowseResult | null;
  browsing: boolean;
}) {
  const [currentPath, setCurrentPath] = useState('');

  useEffect(() => {
    databankStore.browse(currentPath);
  }, [currentPath]);

  const navigateTo = useCallback((dir: string) => {
    if (currentPath) {
      setCurrentPath(currentPath + '/' + dir);
    } else {
      setCurrentPath(dir);
    }
  }, [currentPath]);

  const navigateUp = useCallback(() => {
    const idx = currentPath.lastIndexOf('/');
    setCurrentPath(idx > 0 ? currentPath.slice(0, idx) : '');
  }, [currentPath]);

  const handleOpenLiveFile = useCallback(async (entry: import('../store/databank-store').BrowseEntry) => {
    const fullPath = currentPath ? currentPath + '/' + entry.name : entry.name;
    try {
      const res = await fetch(`/api/files/path/${encodeURIComponent(fullPath)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = await res.arrayBuffer();
      const fileObj = new File([buffer], entry.name, {
        lastModified: entry.mod_time ? entry.mod_time * 1000 : Date.now(),
      });

      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'pdf') {
        boardStore.addPdf(fileObj);
        boardStore.autoBindPdf(fileObj.name);
        await pdfStore.loadFile(fileObj);
        ensurePdfPanel(fileObj.name);
        pdfStore.switchTo(fileObj.name);
      } else {
        await boardStore.loadFiles([fileObj]);
      }
    } catch (err) {
      log.ui.error('Failed to open live file:', err);
    }
  }, [currentPath]);

  if (browsing && !browseResult) return <div className="library-empty">Loading...</div>;
  if (!browseResult) return <div className="library-empty">Browse the live filesystem</div>;

  const entries = browseResult.entries || [];
  const dirs = entries.filter(e => e.is_dir).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => !e.is_dir).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="library-tree">
      {currentPath && (
        <div className="library-tree-node" onClick={navigateUp} style={{ cursor: 'pointer' }}>
          <span className="library-tree-arrow">▶</span>
          <span className="library-tree-folder">..</span>
        </div>
      )}
      {dirs.map(d => (
        <div key={d.name} className="library-tree-node" onClick={() => navigateTo(d.name)} style={{ cursor: 'pointer' }}>
          <span className="library-tree-arrow">▶</span>
          <span className="library-tree-folder">{d.name}</span>
        </div>
      ))}
      {files.map(f => {
        const icon = f.file_type === 'pdf' ? 'P' : 'B';
        const iconClass = f.file_type === 'pdf' ? 'library-icon-pdf' : 'library-icon-board';
        return (
          <div
            key={f.name}
            className="library-file-row"
            style={{ paddingLeft: 20, cursor: 'pointer' }}
            onDoubleClick={() => handleOpenLiveFile(f)}
            title={`${f.name}\n${f.size != null ? formatSize(f.size) : ''}`}
          >
            <span className={`library-file-icon ${iconClass}`}>{icon}</span>
            <span className="library-file-name">{f.name}</span>
            {f.size != null && <span className="library-file-meta">{formatSize(f.size)}</span>}
          </div>
        );
      })}
      {dirs.length === 0 && files.length === 0 && (
        <div className="library-empty">Empty directory</div>
      )}
    </div>
  );
}

// --- File Detail Pane ---

function FileDetailPane({ detail, files, onOpen, onCreateBinding, onDeleteBinding }: {
  detail: FileDetail;
  files: DatabankFile[];
  onOpen: (f: DatabankFile) => void;
  onCreateBinding: (boardId: number, pdfId: number) => void;
  onDeleteBinding: (bindingId: number) => void;
}) {
  const [showBindPicker, setShowBindPicker] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  const isBoard = detail.file_type === 'board';

  // Available files to bind (opposite type, not already bound)
  const boundIds = new Set(
    detail.bindings.map(b => isBoard ? b.pdf_file_id : b.board_file_id)
  );
  const bindCandidates = files.filter(f =>
    f.file_type === (isBoard ? 'pdf' : 'board') && !boundIds.has(f.id)
  );

  return (
    <div className="library-detail">
      <div className="library-detail-header">
        <span className="library-detail-filename">{detail.filename}</span>
        <button
          className="library-detail-edit"
          onClick={() => setShowEditModal(true)}
          title="Edit metadata"
        >
          Edit
        </button>
        <button
          className="library-detail-open"
          onClick={() => onOpen(detail)}
          title="Open in viewer"
        >
          Open
        </button>
      </div>

      {detail.has_preview && (
        <div className="library-detail-preview">
          <img src={databankStore.previewUrl(detail)!} alt="" />
        </div>
      )}

      <div className="library-detail-meta">
        {detail.board_number && <span>Board: {detail.board_number}</span>}
        {(() => {
          const resolved = detail.board_number ? lookupBoard(detail.board_number) : undefined;
          if (!resolved) return null;
          return <>
            <span className="library-detail-model-resolved">{resolved.a_number} {resolved.model}</span>
            <span className="library-detail-model-info" title={resolved.info}>{resolved.info}</span>
          </>;
        })()}
        {detail.manufacturer && <span>Mfr: {detail.manufacturer}</span>}
        {detail.model && <span>Model: {detail.model}</span>}
        {detail.part_count != null && <span>{detail.part_count} parts</span>}
        {detail.net_count != null && <span>{detail.net_count} nets</span>}
        <span>{formatSize(detail.size)}</span>
      </div>

      {showEditModal && (
        <MetadataEditModal detail={detail} onClose={() => setShowEditModal(false)} />
      )}

      {/* Bindings section */}
      <div className="library-detail-bindings">
        <div className="library-detail-bindings-header">
          <span>Bindings ({detail.bindings.length})</span>
          <button
            className="library-detail-bind-btn"
            onClick={() => setShowBindPicker(!showBindPicker)}
            title={isBoard ? 'Bind a PDF' : 'Bind to a board'}
          >
            +
          </button>
        </div>

        {detail.bindings.map(b => (
          <div key={b.id} className="library-binding-row">
            <span className={`library-file-icon ${isBoard ? 'library-icon-pdf' : 'library-icon-board'}`}>
              {isBoard ? 'P' : 'B'}
            </span>
            <span className="library-binding-name">
              {isBoard ? b.pdf_filename : b.board_filename}
            </span>
            {b.auto_matched && <span className="library-binding-auto" title="Auto-matched">A</span>}
            <button
              className="library-binding-remove"
              onClick={() => onDeleteBinding(b.id)}
              title="Remove binding"
            >
              x
            </button>
          </div>
        ))}

        {detail.bindings.length === 0 && !showBindPicker && (
          <div className="library-binding-empty">No bindings</div>
        )}

        {showBindPicker && (
          <div className="library-bind-picker">
            {bindCandidates.length === 0 ? (
              <div className="library-binding-empty">
                No {isBoard ? 'PDFs' : 'boards'} available to bind
              </div>
            ) : (
              bindCandidates.map(f => (
                <div
                  key={f.id}
                  className="library-bind-candidate"
                  onClick={() => {
                    if (isBoard) onCreateBinding(detail.id, f.id);
                    else onCreateBinding(f.id, detail.id);
                    setShowBindPicker(false);
                  }}
                >
                  <span className={`library-file-icon ${f.file_type === 'board' ? 'library-icon-board' : 'library-icon-pdf'}`}>
                    {f.file_type === 'board' ? 'B' : 'P'}
                  </span>
                  <span>{f.filename}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- History View ---

function HistoryView({ onOpenFile, searchFilter }: {
  onOpenFile: (f: DatabankFile) => void;
  searchFilter: string;
}) {
  const { recentItems, files } = useDatabank();

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  const filesByPath = useMemo(() => {
    const m = new Map<string, DatabankFile>();
    for (const f of files) m.set(f.path, f);
    return m;
  }, [files]);

  const filteredItems = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return recentItems;
    return recentItems.filter(item => {
      if (item.fileName.toLowerCase().includes(q)) return true;
      if (item.path.toLowerCase().includes(q)) return true;
      const dbFile = filesByPath.get(item.path);
      if (!dbFile) return false;
      return (
        dbFile.board_number?.toLowerCase().includes(q) ||
        dbFile.manufacturer?.toLowerCase().includes(q) ||
        dbFile.model?.toLowerCase().includes(q)
      ) ?? false;
    });
  }, [recentItems, filesByPath, searchFilter]);

  return (
    <div className="library-history">
      {recentItems.length === 0 ? (
        <div className="library-empty">No recently opened files.</div>
      ) : filteredItems.length === 0 ? (
        <div className="library-empty">No recent files match "{searchFilter}".</div>
      ) : (
        <div className="library-tree-children">
          {filteredItems.map((item, i) => {
            const dbFile = filesByPath.get(item.path);
            return (
              <div
                key={`${item.path}-${i}`}
                className={`library-file-row${dbFile ? '' : ' library-file-missing'}`}
                onClick={() => { if (dbFile) onOpenFile(dbFile); }}
                title={dbFile ? item.path : `${item.path} (not in library)`}
              >
                <span className={`library-file-icon ${item.fileType === 'pdf' ? 'library-icon-pdf' : 'library-icon-board'}`}>
                  {item.fileType === 'pdf' ? 'P' : 'B'}
                </span>
                <span className="library-file-name">{item.fileName}</span>
                <span className="library-history-time">{formatTime(item.openedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Search Results View ---

function SearchResultsView({ results, files, onOpenFile }: {
  results: import('../store/databank-store').SearchResult[];
  files: DatabankFile[];
  onOpenFile: (f: DatabankFile, pageNum?: number) => void;
}) {
  return (
    <div className="library-search-results">
      <div className="library-search-results-header">
        {results.length} result{results.length !== 1 ? 's' : ''}
      </div>
      {results.map((r, i) => (
        <div
          key={`${r.file_id}-${r.page_num}-${i}`}
          className="library-search-result"
          onClick={() => {
            const file = files.find(f => f.id === r.file_id);
            if (file) onOpenFile(file, r.page_num);
          }}
        >
          <div className="library-search-result-header">
            <span className="library-file-icon library-icon-pdf">P</span>
            <span className="library-search-result-file">{r.filename}</span>
            <span className="library-search-result-page">p{r.page_num}</span>
            <button
              className="library-dump-btn"
              onClick={(e) => { e.stopPropagation(); window.open(`/api/databank/files/${r.file_id}/dump`, '_blank'); }}
              title="Dump extracted text (debug)"
            >
              dump
            </button>
          </div>
          {r.snippet && (
            <div
              className="library-search-result-snippet"
              dangerouslySetInnerHTML={{ __html: r.snippet }}
            />
          )}
          {r.board_bindings && r.board_bindings.length > 0 && (
            <div className="library-search-result-boards">
              {r.board_bindings.map(bb => (
                <span key={bb.board_file_id} className="library-search-result-board">
                  {bb.board_filename}
                  {bb.donor_pool && <span className="library-donor-badge">D</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// --- Metadata Tree View ---

function MetadataView({ groups, selectedFileId, filterFile, onSelectFile, onOpenFile }: {
  groups: MetadataGroup[];
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const [expanded, toggle, collapseAll] = usePersistedExpanded('boardripper-tree-metadata');

  const filteredGroups = useMemo(() => groups.map(g => ({
    ...g,
    boardNumbers: g.boardNumbers.map(bn => ({
      ...bn,
      files: bn.files.filter(filterFile),
    })).filter(bn => bn.files.length > 0),
    ungrouped: g.ungrouped.filter(filterFile),
  })).filter(g => g.boardNumbers.length > 0 || g.ungrouped.length > 0), [groups, filterFile]);

  return (
    <div className="library-tree">
      {expanded.size > 0 && (
        <button className="library-collapse-all" onClick={collapseAll} title="Collapse all">⊟</button>
      )}
      {filteredGroups.map(group => {
        const mfrKey = `mfr:${group.manufacturer}`;
        const isExpanded = expanded.has(mfrKey);
        const totalFiles = group.boardNumbers.reduce((n, bn) => n + bn.files.length, 0) + group.ungrouped.length;

        return (
          <div key={mfrKey} className="library-tree-group">
            <div className="library-tree-node" onClick={() => toggle(mfrKey)}>
              <span className="library-tree-arrow">{isExpanded ? '▼' : '▶'}</span>
              <span className="library-tree-mfr">{group.manufacturer}</span>
              <span className="library-tree-count">{totalFiles}</span>
            </div>
            {isExpanded && (
              <div className="library-tree-children">
                {group.boardNumbers.map(bn => {
                  const bnKey = `bn:${group.manufacturer}:${bn.boardNumber}`;
                  const bnExpanded = expanded.has(bnKey);
                  return (
                    <div key={bnKey} className="library-tree-group">
                      <div className="library-tree-node library-tree-indent" onClick={() => toggle(bnKey)}>
                        <span className="library-tree-arrow">{bnExpanded ? '▼' : '▶'}</span>
                        <span className="library-tree-board-num">{bn.boardNumber}</span>
                        <span className="library-tree-count">{bn.files.length}</span>
                      </div>
                      {bnExpanded && (
                        <div className="library-tree-children">
                          {bn.files.map(f => (
                            <FileRow
                              key={f.id}
                              file={f}
                              selected={f.id === selectedFileId}
                              indent={2}
                              showPreview={f.file_type === 'pdf'}
                              onSelect={onSelectFile}
                              onOpen={onOpenFile}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {group.ungrouped.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    selected={f.id === selectedFileId}
                    indent={1}
                    showPreview={f.file_type === 'pdf'}
                    onSelect={onSelectFile}
                    onOpen={onOpenFile}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Model Tree View ---

function ModelView({ groups, selectedFileId, filterFile, onSelectFile, onOpenFile }: {
  groups: ModelGroup[];
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const [expanded, toggle, collapseAll] = usePersistedExpanded('boardripper-tree-model');

  const filteredGroups = useMemo(() => groups.map(g => ({
    ...g,
    variants: g.variants.map(v => ({
      ...v,
      files: v.files.filter(filterFile),
    })).filter(v => v.files.length > 0),
    unresolved: g.unresolved.filter(filterFile),
  })).filter(g => g.variants.length > 0 || g.unresolved.length > 0), [groups, filterFile]);

  return (
    <div className="library-tree">
      {expanded.size > 0 && (
        <button className="library-collapse-all" onClick={collapseAll} title="Collapse all">⊟</button>
      )}
      {filteredGroups.map(group => {
        const modelKey = `model:${group.modelLine}`;
        const isExpanded = expanded.has(modelKey);
        const totalFiles = group.variants.reduce((n, v) => n + v.files.length, 0) + group.unresolved.length;

        return (
          <div key={modelKey} className="library-tree-group">
            <div className="library-tree-node" onClick={() => toggle(modelKey)}>
              <span className="library-tree-arrow">{isExpanded ? '▼' : '▶'}</span>
              <span className="library-tree-model-line">{group.modelLine}</span>
              <span className="library-tree-count">{totalFiles}</span>
            </div>
            {isExpanded && (
              <div className="library-tree-children">
                {group.variants.map(variant => {
                  const varKey = `var:${variant.boardNumber}`;
                  const varExpanded = expanded.has(varKey);
                  return (
                    <div key={varKey} className="library-tree-group">
                      <div className="library-tree-node library-tree-indent" onClick={() => toggle(varKey)}>
                        <span className="library-tree-arrow">{varExpanded ? '▼' : '▶'}</span>
                        <span className="library-tree-variant-info">
                          <span className="library-tree-a-number">{variant.aNumber}</span>
                          {' '}
                          <span className="library-tree-board-num">{variant.boardNumber}</span>
                        </span>
                        <span className="library-tree-count">{variant.files.length}</span>
                      </div>
                      {varExpanded && (
                        <div className="library-tree-children">
                          <div className="library-tree-variant-detail">{variant.info}</div>
                          {variant.files.map(f => (
                            <FileRow
                              key={f.id}
                              file={f}
                              selected={f.id === selectedFileId}
                              indent={2}
                              showPreview={f.file_type === 'pdf'}
                              onSelect={onSelectFile}
                              onOpen={onOpenFile}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
                {group.unresolved.map(f => (
                  <FileRow
                    key={f.id}
                    file={f}
                    selected={f.id === selectedFileId}
                    indent={1}
                    showPreview={f.file_type === 'pdf'}
                    onSelect={onSelectFile}
                    onOpen={onOpenFile}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Folder Tree View ---

/** Recursively remove folders whose filtered file lists and all descendant
 *  folder file lists are empty. Used when a filter is active so empty
 *  directories disappear from the tree. */
function pruneEmptyFolders(node: FolderNode, filter: (f: DatabankFile) => boolean): FolderNode | null {
  const files = (node.files ?? []).filter(filter);
  const children = (node.children ?? [])
    .map(c => pruneEmptyFolders(c, filter))
    .filter((c): c is FolderNode => c !== null);
  if (files.length === 0 && children.length === 0) return null;
  return { ...node, files, children };
}

function FolderView({ tree, selectedFileId, filterFile, searchFilter, onSelectFile, onOpenFile }: {
  tree: FolderNode | null;
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  searchFilter: string;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const [expanded, toggle, collapseAll] = usePersistedExpanded('boardripper-tree-folders', ['']);

  // Only prune when the user is actively filtering — otherwise let empty
  // directories stay visible (browsing a fresh library should show structure).
  const visibleTree = useMemo(
    () => (searchFilter.trim() && tree ? pruneEmptyFolders(tree, filterFile) : tree),
    [searchFilter, tree, filterFile],
  );

  if (!visibleTree) {
    return <div className="library-empty">
      {searchFilter.trim() ? `No folders match "${searchFilter}".` : 'Loading folder tree...'}
    </div>;
  }

  return (
    <div className="library-tree">
      {expanded.size > 0 && (
        <button className="library-collapse-all" onClick={collapseAll} title="Collapse all folders">⊟</button>
      )}
      <FolderNodeView
        node={visibleTree}
        depth={0}
        expanded={expanded}
        selectedFileId={selectedFileId}
        filterFile={filterFile}
        onToggleExpand={toggle}
        onSelectFile={onSelectFile}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

function FolderNodeView({ node, depth, expanded, selectedFileId, filterFile, onToggleExpand, onSelectFile, onOpenFile }: {
  node: FolderNode;
  depth: number;
  expanded: Set<string>;
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  onToggleExpand: (path: string) => void;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const isExpanded = expanded.has(node.path);
  const hasChildren = (node.children && node.children.length > 0) || (node.files && node.files.length > 0);

  const filteredFiles = (node.files || []).filter(filterFile);

  return (
    <div className="library-tree-group">
      <div
        className="library-tree-node"
        style={{ paddingLeft: depth * 16 + 4 }}
        onClick={() => hasChildren && onToggleExpand(node.path)}
      >
        {hasChildren && (
          <span className="library-tree-arrow">{isExpanded ? '▼' : '▶'}</span>
        )}
        <span className="library-tree-folder">{node.name || '/'}</span>
      </div>
      {isExpanded && (
        <div className="library-tree-children">
          {node.children?.map(child => (
            <FolderNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              selectedFileId={selectedFileId}
              filterFile={filterFile}
              onToggleExpand={onToggleExpand}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
            />
          ))}
          {filteredFiles.map(f => (
            <FileRow
              key={f.id}
              file={f}
              selected={f.id === selectedFileId}
              indent={depth + 1}
              showPreview={f.file_type === 'pdf'}
              onSelect={onSelectFile}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// --- File Row ---

function FileRow({ file, selected, indent, showPreview, onSelect, onOpen }: {
  file: DatabankFile;
  selected: boolean;
  indent: number;
  showPreview?: boolean;
  onSelect?: (f: DatabankFile) => void;
  onOpen: (f: DatabankFile) => void;
}) {
  const icon = file.file_type === 'board' ? 'B' : 'P';
  const iconClass = file.file_type === 'board' ? 'library-icon-board' : 'library-icon-pdf';
  const previewEnabled = showPreview && databankStore.showPreviews;

  return (
    <div
      className={`library-file-row ${selected ? 'selected' : ''}`}
      style={{ paddingLeft: indent * 16 + 20 }}
      onClick={() => onSelect ? onSelect(file) : onOpen(file)}
      onDoubleClick={() => onOpen(file)}
      title={`${file.filename}\n${file.path}\n${formatSize(file.size)}`}
    >
      {previewEnabled && <PreviewThumbnail file={file} />}
      <span className={`library-file-icon ${iconClass}`}>{icon}</span>
      {file.file_type === 'board' && (
        MULTILAYER_FORMATS.has(file.format_id) ||
        MULTILAYER_EXTENSIONS.has(('.' + file.extension).toLowerCase())
      ) && (
        <IconStack2 size={14} className="library-multilayer-icon" />
      )}
      <span className="library-file-name">{file.filename}</span>
      {file.part_count != null && (
        <span className="library-file-meta">{file.part_count}p</span>
      )}
    </div>
  );
}

// --- Preview Thumbnail (lazy via IntersectionObserver) ---

function PreviewThumbnail({ file }: { file: DatabankFile }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const triggered = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || triggered.current) return;
        triggered.current = true;

        const url = databankStore.previewUrl(file);
        if (url) {
          setSrc(url);
        } else if (file.file_type === 'pdf' && !generating) {
          setGenerating(true);
          databankStore.generatePdfPreview(file).then((ok) => {
            setGenerating(false);
            if (ok) setSrc(databankStore.previewUrl(file));
          });
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [file, generating]);

  return (
    <div ref={ref} className="library-preview-thumb">
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : generating ? (
        <span className="library-preview-loading" />
      ) : (
        <span className="library-preview-placeholder">
          {file.file_type === 'board' ? 'B' : 'P'}
        </span>
      )}
    </div>
  );
}

// --- Metadata Edit Modal ---

function MetadataEditModal({ detail, onClose }: {
  detail: FileDetail;
  onClose: () => void;
}) {
  const [boardNumber, setBoardNumber] = useState(detail.board_number || '');
  const [manufacturer, setManufacturer] = useState(detail.manufacturer || '');
  const [model, setModel] = useState(detail.model || '');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await databankStore.updateFile(detail.id, {
      board_number: boardNumber,
      manufacturer,
      model,
    });
    // Refresh detail
    await databankStore.fetchFileDetail(detail.id);
    setSaving(false);
    onClose();
  };

  return (
    <div className="library-modal-backdrop" onClick={onClose}>
      <div className="library-modal" onClick={(e) => e.stopPropagation()}>
        <div className="library-modal-title">Edit Metadata</div>
        <div className="library-modal-filename">{detail.filename}</div>

        <label className="library-modal-field">
          <span>Board Number</span>
          <input
            type="text"
            value={boardNumber}
            onChange={(e) => setBoardNumber(e.target.value)}
            placeholder="e.g. 820-02020"
          />
        </label>

        <label className="library-modal-field">
          <span>Manufacturer</span>
          <input
            type="text"
            value={manufacturer}
            onChange={(e) => setManufacturer(e.target.value)}
            placeholder="e.g. Apple"
          />
        </label>

        <label className="library-modal-field">
          <span>Model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g. MacBook Pro 16"
          />
        </label>

        <div className="library-modal-actions">
          <button onClick={onClose} disabled={saving}>Cancel</button>
          <button className="library-modal-save" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
