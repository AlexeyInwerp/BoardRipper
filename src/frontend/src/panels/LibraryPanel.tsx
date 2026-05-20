import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useDatabank } from '../hooks/useDatabank';
import { databankStore } from '../store/databank-store';
import type { DatabankBinding, DatabankFile, FileDetail, FolderNode, MetadataGroup, ModelGroup, ViewMode } from '../store/databank-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel, ensureBoardPanel } from '../store/dockview-api';
import { lookupBoard } from '../store/apple-boards';
import { IconStack2, IconHistory, IconFolder, IconFolderSearch, IconFileText, IconPin, IconPinFilled } from '@tabler/icons-react';
import { log } from '../store/log-store';
import { fetchWithCloudRetry, readCloudError, formatCloudErrorToast } from '../store/fetch-with-cloud-retry';
import { ObdSection } from '../components/ObdSection';

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

/** Returns `value` after `delayMs` ms of stillness — empty values short-circuit
 *  the delay so clearing the search feels instant. Used to keep the filter
 *  input responsive on large libraries where per-keystroke re-filtering blocks
 *  the input event loop. */
function useDebouncedValue<T extends string>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (value === debounced) return;
    // Empty values short-circuit the debounce so clearing the search feels
    // instant. Both paths schedule via setTimeout (rather than a synchronous
    // setState in this effect) — same async update shape, avoids the
    // react-hooks "cascading renders" error.
    const delay = value === '' ? 0 : delayMs;
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, debounced, delayMs]);
  return debounced;
}

const MULTILAYER_FORMATS = new Set(['TVW', 'ALLEGRO_BRD']);
/** Extensions that always indicate multi-layer formats (format_id may not be set by backend) */
const MULTILAYER_EXTENSIONS = new Set(['.tvw']);

function tailTruncate(s: string, max = 60) {
  return s.length > max ? '...' + s.slice(-(max - 3)) : s;
}

/** Render an FTS5 snippet safely. SQLite's snippet() wraps each match in
 *  literal `<b>` / `</b>` delimiters; the rest is the user's PDF text which
 *  may contain arbitrary HTML (`<script>`, `<img onerror=…>`, etc.). Split
 *  on the delimiters and render the segments as plain React text — React
 *  auto-escapes — wrapping the marked segments in <b> elements. The only
 *  HTML that ever ends up in the DOM is the literal <b>; nothing the
 *  attacker controls. */
function renderSnippet(snippet: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let rest = snippet;
  let key = 0;
  while (rest.length > 0) {
    const open = rest.indexOf('<b>');
    if (open < 0) { out.push(rest); break; }
    if (open > 0) out.push(<span key={key++}>{rest.slice(0, open)}</span>);
    rest = rest.slice(open + 3);
    const close = rest.indexOf('</b>');
    if (close < 0) { out.push(<b key={key++}>{rest}</b>); break; }
    out.push(<b key={key++}>{rest.slice(0, close)}</b>);
    rest = rest.slice(close + 4);
  }
  return out;
}

// Global setter for toolbar search integration
let _externalSearchSetter: ((q: string) => void) | null = null;
export function setLibrarySearch(query: string): void {
  _externalSearchSetter?.(query);
}

export function LibraryPanel() {
  const {
    files, folderTree, scanStatus, viewMode, selectedFileId,
    selectedFileDetail, loadStatus, loadError,
    autoPdf, searchResults, searchQuery, backendAvailable,
    libraryPath, electronMode,
    browseMode, browseResult, browsing,
    stats, filesComplete,
  } = useDatabank();

  // Tree groupings are O(N) at 100k entries — only compute the one the user
  // is actually looking at. Each is internally version-cached in the store,
  // so flipping back to a previously-rendered tab is free.
  const metadataTree = useMemo(
    () => viewMode === 'metadata' ? databankStore.metadataTree : null,
    [viewMode, files],
  );
  const modelTree = useMemo(
    () => viewMode === 'model' ? databankStore.modelTree : null,
    [viewMode, files],
  );
  const [localSearch, setLocalSearch] = useState('');

  // Register external setter
  useEffect(() => {
    _externalSearchSetter = setLocalSearch;
    return () => { if (_externalSearchSetter === setLocalSearch) _externalSearchSetter = null; };
  }, []);
  const [pdfSearchMode, setPdfSearchMode] = useState(false);

  // Debounced mirror of `localSearch` driving the actual filter pipeline. The
  // input itself uses `localSearch` so typing stays responsive; everything
  // downstream (filterFile, view re-renders) keys off `debouncedSearch` so
  // large libraries don't re-filter on every keystroke. Cleared values
  // short-circuit the delay since "x" is meant to feel instant.
  const debouncedSearch = useDebouncedValue(localSearch, 200);

  // Client-side filter: match filename, board_number, manufacturer, model (case-insensitive)
  const searchFilter = debouncedSearch.trim().toLowerCase();
  const filterFile = useCallback((f: DatabankFile) => {
    if (!searchFilter) return true;
    return (
      f.filename.toLowerCase().includes(searchFilter) ||
      f.board_number?.toLowerCase().includes(searchFilter) ||
      f.manufacturer?.toLowerCase().includes(searchFilter) ||
      f.model?.toLowerCase().includes(searchFilter)
    );
  }, [searchFilter]);

  // Load data on mount.
  //
  // The actual data fetch is kicked off at app boot via App.tsx →
  // databankStore.ensureLoaded(). Here we just refresh the scan-progress
  // status so an in-flight scan started in a previous session shows its
  // current progress on the first render of this panel. checkScanStatus
  // is cheap and idempotent.
  useEffect(() => {
    databankStore.checkScanStatus();
  }, []);

  // When the user switches to a tab that needs the full file list, hydrate
  // it now (no-op if already complete). Idempotent and coalesced upstream.
  useEffect(() => {
    if (electronMode || filesComplete) return;
    if (viewMode === 'history') return;
    databankStore.fetchFiles();
  }, [viewMode, filesComplete, electronMode]);

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
  // pdfSearchMode=true without any UI control to turn it off. Handle at the
  // tab click site instead of in an effect — avoids cascading renders.
  const handleSetViewMode = useCallback((mode: ViewMode) => {
    if (mode === 'history' && pdfSearchMode) {
      setPdfSearchMode(false);
      if (searchQuery) databankStore.search('');
    }
    databankStore.setViewMode(mode);
  }, [pdfSearchMode, searchQuery]);

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
              if (!binding.auto_open) continue;
              try {
                const pdfFile = databankStore.fileById(binding.pdf_file_id);
                if (!pdfFile) continue;
                const pdfObj = await databankStore.fetchFileBuffer(pdfFile);
                boardStore.addPdf(pdfObj);
                boardStore.addPdfBinding(boardStore.activeTabId!, pdfObj.name);
                await pdfStore.loadFile(pdfObj, pdfFile.id);
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
        const matchedBoardName = boardStore.autoBindPdf(fileObj.name);
        // Promote a strong match (filename or metadata) to a persistent DB
        // binding when both files are in the databank and no binding yet
        // exists. This is what makes "open board, open matching PDF →
        // they're permanently linked" actually work without the user
        // touching the + button.
        let promoteBoardDbFile: DatabankFile | null = null;
        if (matchedBoardName) {
          // Filename-based match (Apple 820-XXXXX heuristic via boardStore).
          promoteBoardDbFile = databankStore.fileByFilename(matchedBoardName) ?? null;
        }
        if (!promoteBoardDbFile) {
          // Metadata-based match: any open board tab whose file shares
          // board_number or manufacturer+model with this PDF. Pick the best
          // metadata match across open tabs.
          let bestScore = 0;
          for (const tab of boardStore.tabs) {
            const tabDb = databankStore.fileByFilename(tab.fileName);
            if (!tabDb) continue;
            const s = metadataMatchScore(tabDb, file);
            if (s > bestScore) {
              bestScore = s;
              promoteBoardDbFile = tabDb;
            }
          }
          if (bestScore < 60) promoteBoardDbFile = null;
        }
        if (promoteBoardDbFile) {
          try {
            const detail = await databankStore.fetchFileDetail(promoteBoardDbFile.id);
            const alreadyBound = detail?.bindings.some(b => b.pdf_file_id === file.id) ?? false;
            if (!alreadyBound) {
              await databankStore.createBinding(promoteBoardDbFile.id, file.id, 'schematic', true);
              // Read selectedFileId off the store rather than the closure
              // — the FileRow memoization comment below explains why we
              // keep `selectedFileId` out of this useCallback's deps.
              const sel = databankStore.selectedFileId;
              if (sel) databankStore.fetchFileDetail(sel);
            }
          } catch (err) {
            log.ui.error('Failed to promote match to DB binding:', err);
          }
        }
        await pdfStore.loadFile(fileObj, file.id);
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
    // `files` is intentionally absent: the binding lookup goes through
    // `databankStore.fileById` (always current). Re-creating this callback
    // on every store notify would invalidate FileRow memoization and cost
    // more than the current binding-resolution Map lookup saves.
  }, [autoPdf, pdfSearchMode, searchQuery]);

  const handleSelectFile = useCallback((file: DatabankFile) => {
    databankStore.selectFile(file.id);
    databankStore.fetchFileDetail(file.id);
  }, []);

  const handleCreateBinding = useCallback(async (
    boardFileId: number,
    pdfFileId: number,
    category?: string,
    autoOpen?: boolean,
  ) => {
    await databankStore.createBinding(boardFileId, pdfFileId, category, autoOpen);
    if (selectedFileId) databankStore.fetchFileDetail(selectedFileId);
  }, [selectedFileId]);

  const handleUpdateBinding = useCallback(async (
    bindingId: number,
    patch: { category?: string; auto_open?: boolean },
  ) => {
    await databankStore.updateBinding(bindingId, patch);
    if (selectedFileId) databankStore.fetchFileDetail(selectedFileId);
  }, [selectedFileId]);

  const handleDeleteBinding = useCallback(async (bindingId: number) => {
    await databankStore.deleteBinding(bindingId);
    if (selectedFileId) databankStore.fetchFileDetail(selectedFileId);
  }, [selectedFileId]);

  const scanning = scanStatus?.running ?? false;
  const { boardCount, pdfCount } = useMemo(() => {
    // Stats are authoritative — they reflect the full database even when we
    // only loaded a partial subset of files (History fast path). Fall back
    // to counting `files` when stats haven't arrived yet (cold load).
    if (stats) return { boardCount: stats.boards, pdfCount: stats.pdfs };
    let b = 0, p = 0;
    for (const f of files) { if (f.file_type === 'board') b++; else if (f.file_type === 'pdf') p++; }
    return { boardCount: b, pdfCount: p };
  }, [files, stats]);

  // Stats bar — moved to the panel bottom for visual consistency with
  // SettingsPanel and to keep the tabs row at the natural top of the view.
  const statsBar = (
    <div className="library-statsbar">
      <div className="library-statsbar-text">
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
      <div className="library-statsbar-actions">
        {scanStatus?.running ? (
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
        )}
      </div>
    </div>
  );

  return (
    <div className="library-panel">
      {/* Tabs + inline DB/Live pill (row 1) */}
      <div className="library-tabs-row">
        <div className="library-tabs">
          <button
            className={`library-tab ${viewMode === 'history' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('history')}
            title="Recently opened"
          >
            <IconHistory size={14} />
          </button>
          <button
            className={`library-tab ${viewMode === 'metadata' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('metadata')}
          >
            Board #
          </button>
          <button
            className={`library-tab ${viewMode === 'model' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('model')}
          >
            Model
          </button>
          <button
            className={`library-tab ${viewMode === 'folders' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('folders')}
            title="Browse folders"
          >
            <IconFolder size={14} />
          </button>
        </div>
        {viewMode === 'folders' && (
          <div className="library-browse-pill" role="tablist" aria-label="Folder source">
            <button
              className={`library-browse-pill-btn ${browseMode === 'database' ? 'active' : ''}`}
              onClick={() => databankStore.setBrowseMode('database')}
              role="tab"
              aria-selected={browseMode === 'database'}
              title="Show folders from the indexed database"
            >
              DB
            </button>
            <button
              className={`library-browse-pill-btn ${browseMode === 'live' ? 'active' : ''}`}
              onClick={() => databankStore.setBrowseMode('live')}
              role="tab"
              aria-selected={browseMode === 'live'}
              title="Browse the live filesystem"
            >
              Live
            </button>
          </div>
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
          <SearchResultsView results={searchResults} onOpenFile={handleOpenFile} />
        ) : loadStatus === 'loading' && files.length === 0 ? (
          <div className="library-empty">Loading library…</div>
        ) : loadStatus === 'error' ? (
          <div className="library-empty">
            Failed to load library{loadError ? `: ${loadError.message}` : '.'} Open the Debug panel for details.
          </div>
        ) : !backendAvailable && files.length === 0 ? (
          <div className="library-empty">
            Library will appear once the backend is reachable.
          </div>
        ) : files.length === 0 ? (
          <div className="library-empty">
            No files found. Click Scan to index your data directory.
          </div>
        ) : pdfSearchMode && searchQuery && searchResults.length === 0 ? (
          <div className="library-empty">No results for "{searchQuery}"</div>
        ) : viewMode === 'history' ? (
          <HistoryView
            onOpenFile={handleOpenFile}
            onSelectFile={handleSelectFile}
            selectedFileId={selectedFileId}
            searchFilter={debouncedSearch}
          />
        ) : viewMode === 'model' ? (
          <ModelView
            groups={modelTree ?? []}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
          />
        ) : viewMode === 'metadata' ? (
          <MetadataView
            groups={metadataTree ?? []}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            onSelectFile={handleSelectFile}
            onOpenFile={handleOpenFile}
          />
        ) : viewMode === 'folders' && browseMode === 'live' ? (
          <LiveBrowser browseResult={browseResult} browsing={browsing} searchFilter={debouncedSearch} />
        ) : (
          <FolderView
            tree={folderTree}
            selectedFileId={selectedFileId}
            filterFile={filterFile}
            searchFilter={debouncedSearch}
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
          onUpdateBinding={handleUpdateBinding}
          onDeleteBinding={handleDeleteBinding}
        />
      )}

      {/* Stats + scan buttons — pinned to bottom of the panel for visual
       *  consistency with SettingsPanel (tabs at top, status at bottom). */}
      {statsBar}
    </div>
  );
}

// --- Live Browser ---

function LiveBrowser({ browseResult, browsing, searchFilter }: {
  browseResult: import('../store/databank-store').BrowseResult | null;
  browsing: boolean;
  searchFilter: string;
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
      const res = await fetchWithCloudRetry(
        `/api/files/path/${encodeURIComponent(fullPath)}`,
        undefined,
        {
          label: entry.name,
          onRetry: (attempt) => {
            if (attempt === 2) {
              boardStore.addToast(`Downloading "${entry.name}" from cloud storage…`, 'info');
            }
          },
        },
      );
      if (!res.ok) {
        if (res.status === 503) {
          const { code, message } = await readCloudError(res);
          boardStore.addToast(formatCloudErrorToast(entry.name, code, message), 'error');
          throw new Error(`HTTP 503${code ? ` (${code})` : ''}`);
        }
        throw new Error(`HTTP ${res.status}`);
      }
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
  // Client-side filter on the current directory's listing. Cheap — the
  // backend already returns the full directory; we just hide non-matching
  // entries pre-render. Both directories and files are filtered: a directory
  // whose name matches stays visible so the user can navigate toward
  // something they remember the parent name of.
  const f = searchFilter.trim().toLowerCase();
  const matches = (e: import('../store/databank-store').BrowseEntry) => !f || e.name.toLowerCase().includes(f);
  const dirs = entries.filter(e => e.is_dir && matches(e)).sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter(e => !e.is_dir && matches(e)).sort((a, b) => a.name.localeCompare(b.name));

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

const BINDING_CATEGORIES = ['schematic', 'datasheet', 'other'] as const;
type BindingCategory = (typeof BINDING_CATEGORIES)[number];
const CATEGORY_LABEL: Record<string, string> = {
  schematic: 'Schematic',
  datasheet: 'Datasheet',
  other: 'Other',
};
/** Auto-open default per category. Schematics open with their board;
 *  everything else is listed-only. The user can override per-binding via
 *  the pin button. */
function autoOpenDefault(category: string): boolean {
  return category === 'schematic';
}
function normalizeCategory(c: string): BindingCategory {
  return (BINDING_CATEGORIES as readonly string[]).includes(c) ? (c as BindingCategory) : 'other';
}

const APPLE_BOARD_RE = /820-\d{5}(?:-\d+)?/i;

function stripExt(filename: string): string {
  const i = filename.lastIndexOf('.');
  return (i > 0 ? filename.slice(0, i) : filename).toLowerCase();
}

/** Shared metadata suggests the two files belong to the same board even when
 *  filenames don't match cleanly (e.g. a TVW with an obfuscated revision-coded
 *  name vs. a PDF labelled by manufacturer/model). The library's own grouping
 *  logic uses the same fields, so anything that shows up in the same Model
 *  group should also rank highly here. */
function metadataMatchScore(a: DatabankFile, b: DatabankFile): number {
  if (a.board_number && b.board_number && a.board_number === b.board_number) return 70;
  if (a.manufacturer && b.manufacturer
      && a.manufacturer.toLowerCase() === b.manufacturer.toLowerCase()
      && a.model && b.model
      && a.model.toLowerCase() === b.model.toLowerCase()) return 60;
  return 0;
}

/** Mirror of backend `MatchScore` (src/backend/databank/metadata.go).
 *  Returns 0–100; ≥50 implies a strong likelihood the PDF is the schematic
 *  for the board. Used to sort the bind-picker so the obvious match floats
 *  to the top instead of alphabetically far away. */
function nameMatchScore(boardFilename: string, pdfFilename: string): number {
  const boardBase = stripExt(boardFilename);
  const pdfBase = stripExt(pdfFilename);
  if (boardBase === pdfBase) return 100;

  const appleMatch = boardFilename.match(APPLE_BOARD_RE);
  if (appleMatch && pdfBase.includes(appleMatch[0].toLowerCase())) return 80;

  if (pdfBase.includes(boardBase) || boardBase.includes(pdfBase)) return 50;

  const tokenize = (s: string) => s.replace(/[-_]/g, ' ').split(/\s+/).filter(t => t.length >= 3);
  const boardTokens = new Set(tokenize(boardBase));
  let overlap = 0;
  for (const pt of tokenize(pdfBase)) if (boardTokens.has(pt)) overlap++;
  return overlap > 0 ? overlap * 20 : 0;
}

/** A binding row as rendered. v1 only emits 'binding' rows from the
 *  `bindings` table. The 'derived' arm is a forward hook for a future
 *  board↔datasheet many-to-many lookup populated from external data —
 *  see docs/superpowers/specs/2026-04-27-binding-categorization-design.md. */
type RenderedBinding =
  | (DatabankBinding & { source: 'binding' })
  | { source: 'derived'; pdf_file_id: number; pdf_filename: string; category: string };

function FileDetailPane({ detail, files, onOpen, onCreateBinding, onUpdateBinding, onDeleteBinding }: {
  detail: FileDetail;
  files: DatabankFile[];
  onOpen: (f: DatabankFile) => void;
  onCreateBinding: (boardId: number, pdfId: number, category?: string, autoOpen?: boolean) => void;
  onUpdateBinding: (bindingId: number, patch: { category?: string; auto_open?: boolean }) => void;
  onDeleteBinding: (bindingId: number) => void;
}) {
  const [showBindPicker, setShowBindPicker] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  const isBoard = detail.file_type === 'board';

  // Available files to bind (opposite type, not already bound).
  // Both Set construction and the .filter are O(N) — without memoization
  // they'd re-run on every keystroke / store notify, scanning 100k rows
  // every time the user types in the metadata-edit modal.
  const boundIds = useMemo(
    () => new Set(detail.bindings.map(b => isBoard ? b.pdf_file_id : b.board_file_id)),
    [detail.bindings, isBoard],
  );
  const bindCandidates = useMemo(
    () => files.filter(f =>
      f.file_type === (isBoard ? 'pdf' : 'board') && !boundIds.has(f.id)
    ),
    [files, isBoard, boundIds],
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
        {detail.board_color && <span>Color: {detail.board_color}</span>}
        {detail.model && <span>Model: {detail.model}</span>}
        {detail.part_count != null && <span>{detail.part_count} parts</span>}
        {detail.net_count != null && <span>{detail.net_count} nets</span>}
        <span>{formatSize(detail.size)}</span>
      </div>

      {showEditModal && (
        <MetadataEditModal detail={detail} onClose={() => setShowEditModal(false)} />
      )}

      {/* Bindings section. Board side = full editor (group by category,
       *  per-row category dropdown, + bind picker). PDF side = simple
       *  back-reference list of boards this PDF appears on (no category UI,
       *  no manual binding — that's done from the board's side where the
       *  semantics line up). */}
      <div className="library-detail-bindings">
        <div className="library-detail-bindings-header">
          <span>{isBoard ? `Bindings (${detail.bindings.length})` : `Linked boards (${detail.bindings.length})`}</span>
          {isBoard && (
            <button
              className="library-detail-bind-btn"
              onClick={() => setShowBindPicker(!showBindPicker)}
              title="Bind a PDF"
            >
              +
            </button>
          )}
        </div>

        <BindingsGrouped
          bindings={detail.bindings}
          isBoard={isBoard}
          onOpen={onOpen}
          onUpdateBinding={onUpdateBinding}
          onDeleteBinding={onDeleteBinding}
        />

        {detail.bindings.length === 0 && !showBindPicker && (
          <div className="library-binding-empty">{isBoard ? 'No bindings' : 'Not linked to any board'}</div>
        )}

        {isBoard && showBindPicker && (
          <BindPicker
            isBoard={isBoard}
            focal={detail}
            candidates={bindCandidates}
            onPick={(f) => {
              // New bindings default to 'schematic' — the common case.
              // The user re-categorizes via the row's dropdown after if
              // it's actually a datasheet or other reference doc.
              onCreateBinding(detail.id, f.id, 'schematic', true);
              setShowBindPicker(false);
            }}
          />
        )}
      </div>

      {isBoard && detail.board_number && (
        <ObdSection boardNumber={detail.board_number} />
      )}
    </div>
  );
}

// --- Bindings list ---
//
// Board's detail pane: bindings group by category (Schematic / Datasheet /
// Other) and each row gets a category dropdown — the category describes
// the bound PDF, which is what's shown.
// PDF's detail pane: flat back-reference list of boards. No category UI and
// no grouping; the same PDF can have different categories per-board, but
// labelling a row of "boards" with "Schematic" reads as if the BOARD itself
// were a schematic, which is wrong (a board isn't a schematic, the PDF is).

function BindingsGrouped({ bindings, isBoard, onOpen, onUpdateBinding, onDeleteBinding }: {
  bindings: DatabankBinding[];
  isBoard: boolean;
  onOpen: (f: DatabankFile) => void;
  onUpdateBinding: (bindingId: number, patch: { category?: string; auto_open?: boolean }) => void;
  onDeleteBinding: (bindingId: number) => void;
}) {
  // Tag with `source` so future derived rows (board↔datasheet M2M) slot in
  // without restructuring this file. Today only 'binding' is emitted.
  const rendered: RenderedBinding[] = useMemo(
    () => bindings.map(b => ({ ...b, source: 'binding' as const })),
    [bindings],
  );

  const groups = useMemo(() => {
    const buckets: Record<BindingCategory, RenderedBinding[]> = {
      schematic: [], datasheet: [], other: [],
    };
    for (const r of rendered) buckets[normalizeCategory(r.category)].push(r);
    for (const k of BINDING_CATEGORIES) {
      buckets[k].sort((a, b) => {
        const am = a.source === 'binding' ? Number(a.auto_matched) : 0;
        const bm = b.source === 'binding' ? Number(b.auto_matched) : 0;
        if (am !== bm) return am - bm;  // manual (0) before auto-matched (1)
        return a.pdf_filename.localeCompare(b.pdf_filename);
      });
    }
    return buckets;
  }, [rendered]);

  const flatSorted = useMemo(() => {
    const out = [...rendered];
    out.sort((a, b) => {
      const am = a.source === 'binding' ? Number(a.auto_matched) : 0;
      const bm = b.source === 'binding' ? Number(b.auto_matched) : 0;
      if (am !== bm) return am - bm;
      const an = a.source === 'binding' ? a.board_filename : a.pdf_filename;
      const bn = b.source === 'binding' ? b.board_filename : b.pdf_filename;
      return an.localeCompare(bn);
    });
    return out;
  }, [rendered]);

  if (!isBoard) {
    return (
      <>
        {flatSorted.map(r => (
          <BindingRow
            key={r.source === 'binding' ? `b-${r.id}` : `d-${r.pdf_file_id}`}
            row={r}
            isBoard={isBoard}
            onOpen={onOpen}
            onUpdateBinding={onUpdateBinding}
            onDeleteBinding={onDeleteBinding}
          />
        ))}
      </>
    );
  }

  const visibleGroups = BINDING_CATEGORIES.filter(c => groups[c].length > 0);

  return (
    <>
      {visibleGroups.map((cat, i) => (
        <div key={cat}>
          {i > 0 && <div className="library-history-divider" aria-hidden="true" />}
          <div className="library-binding-group-header">{CATEGORY_LABEL[cat]}</div>
          {groups[cat].map(r => (
            <BindingRow
              key={r.source === 'binding' ? `b-${r.id}` : `d-${r.pdf_file_id}`}
              row={r}
              isBoard={isBoard}
              onOpen={onOpen}
              onUpdateBinding={onUpdateBinding}
              onDeleteBinding={onDeleteBinding}
            />
          ))}
        </div>
      ))}
    </>
  );
}

function BindingRow({ row, isBoard, onOpen, onUpdateBinding, onDeleteBinding }: {
  row: RenderedBinding;
  isBoard: boolean;
  onOpen: (f: DatabankFile) => void;
  onUpdateBinding: (bindingId: number, patch: { category?: string; auto_open?: boolean }) => void;
  onDeleteBinding: (bindingId: number) => void;
}) {
  const boundFileId = row.source === 'binding'
    ? (isBoard ? row.pdf_file_id : row.board_file_id)
    : row.pdf_file_id;
  const boundFile = databankStore.fileById(boundFileId);
  const filename = row.source === 'binding'
    ? (isBoard ? row.pdf_filename : row.board_filename)
    : row.pdf_filename;

  const handleCategoryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (row.source !== 'binding') return;
    const newCategory = e.target.value;
    if (newCategory === row.category) return;
    // Auto-open follows the category default. The schema keeps the columns
    // independent for future flexibility, but the UI ties them together —
    // a separate pin override per row was confusing in practice.
    onUpdateBinding(row.id, {
      category: newCategory,
      auto_open: autoOpenDefault(newCategory),
    });
  };

  // Derived rows (future): no controls, no x.
  if (row.source === 'derived') {
    return (
      <div
        className="library-binding-row"
        onDoubleClick={() => { if (boundFile) onOpen(boundFile); }}
        title={boundFile ? `Double-click to open ${filename}` : undefined}
        style={boundFile ? { cursor: 'pointer' } : undefined}
      >
        <span className="library-file-icon library-icon-pdf">P</span>
        <span className="library-binding-name">{filename}</span>
        <span className="library-binding-auto" title="Auto-detected from board metadata">D</span>
      </div>
    );
  }

  return (
    <div
      className="library-binding-row"
      onDoubleClick={() => { if (boundFile) onOpen(boundFile); }}
      title={boundFile ? `Double-click to open ${filename}` : undefined}
      style={boundFile ? { cursor: 'pointer' } : undefined}
    >
      <span className={`library-file-icon ${isBoard ? 'library-icon-pdf' : 'library-icon-board'}`}>
        {isBoard ? 'P' : 'B'}
      </span>
      <span className="library-binding-name">{filename}</span>
      {/* Category control lives on the board's detail pane only — that's
       *  where "this PDF is a schematic" reads correctly. On the PDF's
       *  pane the bound rows are boards, and putting a category dropdown
       *  next to a board name reads as "this board is a schematic", which
       *  is wrong (a board isn't a schematic, the PDF is). Edits go through
       *  the board side. */}
      {isBoard && (
        <select
          className="library-binding-category"
          value={normalizeCategory(row.category)}
          onChange={handleCategoryChange}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          title={row.auto_open ? 'Auto-opens with board' : 'Listed only'}
        >
          {BINDING_CATEGORIES.map(c => (
            <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
          ))}
        </select>
      )}
      {row.auto_matched && <span className="library-binding-auto" title="Auto-matched">A</span>}
      <button
        className="library-binding-remove"
        onClick={(e) => { e.stopPropagation(); onDeleteBinding(row.id); }}
        onDoubleClick={(e) => e.stopPropagation()}
        title="Remove binding"
      >
        x
      </button>
    </div>
  );
}

function BindPicker({ isBoard, focal, candidates, onPick }: {
  isBoard: boolean;
  focal: DatabankFile;
  candidates: DatabankFile[];
  onPick: (file: DatabankFile) => void;
}) {
  const [filter, setFilter] = useState('');

  // Score each candidate against the focal file. Filename match handles the
  // 820-XXXXX-style cases; metadata match handles cases where the file
  // names diverge but the board_number / manufacturer+model align (e.g. a
  // Lenovo TVW with a revision-coded filename vs. a PDF labelled by model
  // — the library's Model-tab already groups them, so the picker should too).
  // Take the max of the two signals.
  const scored = useMemo(() => {
    return candidates
      .map(f => {
        const board = isBoard ? focal : f;
        const pdf = isBoard ? f : focal;
        const nm = nameMatchScore(board.filename, pdf.filename);
        const mm = metadataMatchScore(board, pdf);
        return { f, score: Math.max(nm, mm) };
      })
      .sort((a, b) => b.score - a.score || a.f.filename.localeCompare(b.f.filename));
  }, [candidates, focal, isBoard]);

  // Substring filter — case-insensitive — so the user can narrow a long
  // candidate list. Matches filename and the metadata fields the library's
  // own search uses (board_number, manufacturer, model).
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return scored;
    return scored.filter(({ f }) =>
      f.filename.toLowerCase().includes(q) ||
      f.board_number?.toLowerCase().includes(q) ||
      f.manufacturer?.toLowerCase().includes(q) ||
      f.model?.toLowerCase().includes(q)
    );
  }, [scored, filter]);

  return (
    <div className="library-bind-picker">
      <div className="library-bind-picker-toolbar">
        <input
          type="text"
          className="library-bind-picker-filter"
          placeholder={`Filter ${isBoard ? 'PDFs' : 'boards'}…`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
      </div>
      {filtered.length === 0 ? (
        <div className="library-binding-empty">
          {scored.length === 0
            ? `No ${isBoard ? 'PDFs' : 'boards'} available to bind`
            : `No matches for "${filter}"`}
        </div>
      ) : (
        filtered.map(({ f, score }) => (
          <div
            key={f.id}
            className="library-bind-candidate"
            onClick={() => onPick(f)}
            title={score >= 50 ? `Likely match (score ${score})` : undefined}
          >
            <span className={`library-file-icon ${f.file_type === 'board' ? 'library-icon-board' : 'library-icon-pdf'}`}>
              {f.file_type === 'board' ? 'B' : 'P'}
            </span>
            <span>{f.filename}</span>
            {score >= 50 && (
              <span className="library-bind-match-badge" title={`Likely match (score ${score})`}>match</span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// --- History View ---

function HistoryView({ onOpenFile, onSelectFile, selectedFileId, searchFilter }: {
  onOpenFile: (f: DatabankFile) => void;
  onSelectFile: (f: DatabankFile) => void;
  selectedFileId: number | null;
  searchFilter: string;
}) {
  // Subscribe to `files` so the row resolution re-runs after a hydrate, but
  // do path lookups via the store's Map<path,file> instead of rebuilding
  // a per-component Map. With 100k entries the rebuild was ~10–30ms.
  const { recentItems, files, favoritePaths } = useDatabank();
  void files;

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

  const filteredItems = useMemo(() => {
    const q = searchFilter.trim().toLowerCase();
    if (!q) return recentItems;
    return recentItems.filter(item => {
      if (item.fileName.toLowerCase().includes(q)) return true;
      if (item.path.toLowerCase().includes(q)) return true;
      const dbFile = databankStore.fileByPath(item.path);
      if (!dbFile) return false;
      return (
        dbFile.board_number?.toLowerCase().includes(q) ||
        dbFile.manufacturer?.toLowerCase().includes(q) ||
        dbFile.model?.toLowerCase().includes(q)
      ) ?? false;
    });
  }, [recentItems, searchFilter]);

  const { pinned, recent } = useMemo(() => {
    const pinned: typeof filteredItems = [];
    const recent: typeof filteredItems = [];
    for (const item of filteredItems) {
      (favoritePaths.has(item.path) ? pinned : recent).push(item);
    }
    return { pinned, recent };
  }, [filteredItems, favoritePaths]);

  const renderRow = (item: (typeof filteredItems)[number], idx: number) => {
    const dbFile = databankStore.fileByPath(item.path);
    const isPinned = favoritePaths.has(item.path);
    const selected = dbFile != null && dbFile.id === selectedFileId;
    return (
      <div
        key={`${item.path}-${idx}`}
        className={`library-file-row${dbFile ? '' : ' library-file-missing'}${selected ? ' selected' : ''}`}
        onClick={() => { if (dbFile) onSelectFile(dbFile); }}
        onDoubleClick={() => { if (dbFile) onOpenFile(dbFile); }}
        title={dbFile ? item.path : `${item.path} (not in library)`}
      >
        <span className={`library-file-icon ${item.fileType === 'pdf' ? 'library-icon-pdf' : 'library-icon-board'}`}>
          {item.fileType === 'pdf' ? 'P' : 'B'}
        </span>
        <span className="library-file-name">{item.fileName}</span>
        <span className="library-history-time">{formatTime(item.openedAt)}</span>
        <button
          className={`library-history-pin${isPinned ? ' is-pinned' : ''}`}
          onClick={(e) => { e.stopPropagation(); databankStore.toggleFavorite(item.path); }}
          title={isPinned ? 'Unpin from top' : 'Pin to top'}
          aria-label={isPinned ? 'Unpin from top' : 'Pin to top'}
        >
          {isPinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
        </button>
      </div>
    );
  };

  return (
    <div className="library-history">
      {recentItems.length === 0 ? (
        <div className="library-empty">No recently opened files.</div>
      ) : filteredItems.length === 0 ? (
        <div className="library-empty">No recent files match "{searchFilter}".</div>
      ) : (
        <div className="library-tree-children">
          {pinned.map((item, i) => renderRow(item, i))}
          {pinned.length > 0 && recent.length > 0 && (
            <div className="library-history-divider" aria-hidden="true" />
          )}
          {recent.map((item, i) => renderRow(item, pinned.length + i))}
        </div>
      )}
    </div>
  );
}

// --- Search Results View ---

function SearchResultsView({ results, onOpenFile }: {
  results: import('../store/databank-store').SearchResult[];
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
            const file = databankStore.fileById(r.file_id);
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
            <div className="library-search-result-snippet">
              {renderSnippet(r.snippet)}
            </div>
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

/** Resolve a folder node's files into DatabankFile records. Database mode
 *  ships only IDs (cheap wire payload); Electron mode keeps embedding full
 *  records so we read either shape. */
function resolveNodeFiles(node: FolderNode): DatabankFile[] {
  if (node.files && node.files.length > 0) return node.files;
  if (!node.file_ids || node.file_ids.length === 0) return [];
  const out: DatabankFile[] = [];
  for (const id of node.file_ids) {
    const f = databankStore.fileById(id);
    if (f) out.push(f);
  }
  return out;
}

/** Recursively remove folders whose filtered file lists and all descendant
 *  folder file lists are empty. Used when a filter is active so empty
 *  directories disappear from the tree. */
function pruneEmptyFolders(node: FolderNode, filter: (f: DatabankFile) => boolean): FolderNode | null {
  const files = resolveNodeFiles(node).filter(filter);
  const children = (node.children ?? [])
    .map(c => pruneEmptyFolders(c, filter))
    .filter((c): c is FolderNode => c !== null);
  if (files.length === 0 && children.length === 0) return null;
  // Strip file_ids — pruning has materialized files into the `files` field.
  return { ...node, files, file_ids: undefined, children };
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
  const nodeFiles = resolveNodeFiles(node);
  const hasChildren = (node.children && node.children.length > 0) || nodeFiles.length > 0;

  const filteredFiles = nodeFiles.filter(filterFile);

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

/** Read-only indicator shown above the editable fields in the metadata modal.
 *  Surfaces whether the boards.db resolver match has a populated colors.hex —
 *  so the user knows whether "Use board metadata color" will affect this file. */
function PcbColorRow({ detail }: { detail: FileDetail }) {
  const colorName = detail.board_color || '';
  const colorHex = detail.board_color_hex || '';

  let dotColor: string;
  let labelText: string;
  if (!colorName) {
    dotColor = '#666';
    labelText = '— (no resolver match)';
  } else if (!colorHex) {
    dotColor = '#666';
    labelText = `${colorName} (no hex yet)`;
  } else {
    dotColor = colorHex;
    labelText = `${colorName} (hex set)`;
  }

  return (
    <div className="library-modal-pcb-color">
      <span>PCB Color:</span>
      <span className="library-modal-pcb-color-dot" style={{ background: dotColor }} aria-hidden="true" />
      <span className="library-modal-pcb-color-text">{labelText}</span>
    </div>
  );
}

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

        <PcbColorRow detail={detail} />

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
