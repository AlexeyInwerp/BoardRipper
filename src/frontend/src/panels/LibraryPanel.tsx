import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useDatabank } from '../hooks/useDatabank';
import { useLibraryLoad } from '../store/library-load-store';
import { databankStore, contentCollapsePlan } from '../store/databank-store';
import type { CollapsedFileInfo, DatabankBinding, DatabankFile, FileDetail, FolderNode, MetadataGroup, ModelGroup, SearchResult, ViewMode } from '../store/databank-store';
import { pdfIndexClient } from '../pdf/pdf-index-client';
import type { PdfIndexFailedEntry } from '../pdf/pdf-index-client';
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

/** Compute a "rate/min · ETA Xh Ym" string for index progress bars.
 *  started_at is an ISO-8601 string (from the backend wire format). */
export function fmtIndexEta(p: { running: boolean; total: number; done: number; started_at: number }): string {
  if (!p.running || !p.started_at || p.done <= 0) return '';
  // started_at is unix SECONDS (backend time.Now().Unix()), not an ISO string.
  const elapsed = Math.max(1, Math.floor(Date.now() / 1000) - p.started_at);
  const rate = p.done / elapsed; // files/sec
  if (rate <= 0) return '';
  const remain = Math.max(0, p.total - p.done);
  const etaSec = Math.round(remain / rate);
  const h = Math.floor(etaSec / 3600), m = Math.floor((etaSec % 3600) / 60);
  const eta = h > 0 ? `${h}h ${m}m` : `${m}m`;
  return `${(rate * 60).toFixed(1)}/min · ETA ${eta}`;
}

export function LibraryPanel() {
  const {
    files, folderTree, scanStatus, viewMode, selectedFileId,
    selectedFileDetail, loadStatus, loadError,
    autoPdf, backendAvailable,
    libraryPath, electronMode,
    browseMode, browseResult, browsing,
    stats, filesComplete,
    donorIds,
    pdfIndexProgress, pdfIndexStats,
    pendingPdfSearch,
  } = useDatabank();
  const libraryLoad = useLibraryLoad();
  void donorIds; // consumed by FileDetailPane and ContextMenu via databankStore.isDonor

  // Tree groupings are O(N) at 100k entries — only compute the one the user
  // is actually looking at. Each is internally version-cached in the store
  // (keyed on _filesVersion), so flipping back to a previously-rendered tab
  // is free. Reading `files` (even though unused in the callback body) is the
  // load-bearing signal that forces re-grab when the store data mutates —
  // useDatabank re-renders this component on file changes, but useMemo only
  // re-runs when a dep reference changes.
  const metadataTree = useMemo(
    () => viewMode === 'metadata' ? databankStore.metadataTree : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMode, files],
  );
  const modelTree = useMemo(
    () => viewMode === 'model' ? databankStore.modelTree : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewMode, files],
  );
  const [localSearch, setLocalSearch] = useState('');
  const [failedList, setFailedList] = useState<PdfIndexFailedEntry[] | null>(null);
  const [failedListLoading, setFailedListLoading] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const showFailedList = useCallback(async () => {
    setFailedListLoading(true);
    const list = await pdfIndexClient.failed();
    setFailedList(list ?? []);
    setFailedListLoading(false);
  }, []);

  const handleRetryFailed = useCallback(async () => {
    setRetrying(true);
    await pdfIndexClient.reindex('failed');
    databankStore.startPdfIndexPolling();
    setFailedList(null);
    setRetrying(false);
  }, []);

  // Register external setter
  useEffect(() => {
    _externalSearchSetter = setLocalSearch;
    return () => { if (_externalSearchSetter === setLocalSearch) _externalSearchSetter = null; };
  }, []);
  // PDF Search tab state
  const [pdfQuery, setPdfQuery] = useState('');
  const [pdfScope, setPdfScope] = useState<'all' | 'donor'>('all');
  const [pdfResults, setPdfResults] = useState<SearchResult[]>([]);
  const [pdfSearching, setPdfSearching] = useState(false);
  // Tracks the in-flight stream so a new search can abort the previous one.
  const pdfSearchAbort = useRef<AbortController | null>(null);
  // Buffer + flush plumbing: incoming results accumulate here and are flushed
  // to React state on a ~80ms interval so a query yielding hundreds of rows
  // re-renders the list a handful of times instead of once per line.
  const pdfBufferRef = useRef<SearchResult[]>([]);
  const pdfFlushTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Shared streaming runner used by both the manual Search button and the
  // context-menu "Search in donors/PDFs" pending-search path.
  const streamPdfSearch = useCallback((query: string, scope: 'all' | 'donor') => {
    if (!query.trim()) return;
    // Abort any in-flight stream; the new run takes ownership of pdfSearching.
    pdfSearchAbort.current?.abort();
    const controller = new AbortController();
    pdfSearchAbort.current = controller;

    pdfBufferRef.current = [];
    setPdfResults([]);
    setPdfSearching(true);

    const flush = () => {
      if (pdfBufferRef.current.length === 0) return;
      const batch = pdfBufferRef.current;
      pdfBufferRef.current = [];
      setPdfResults(prev => [...prev, ...batch]);
    };
    if (pdfFlushTimer.current) clearInterval(pdfFlushTimer.current);
    pdfFlushTimer.current = setInterval(flush, 80);

    const stopFlush = () => {
      if (pdfFlushTimer.current) { clearInterval(pdfFlushTimer.current); pdfFlushTimer.current = null; }
      flush();
    };

    databankStore.searchPdfsStream(
      query,
      scope,
      {
        onResult: (r) => { pdfBufferRef.current.push(r); },
        onCounts: (counts) => {
          // Patch hit_count for already-rendered + still-buffered results.
          pdfBufferRef.current = pdfBufferRef.current.map(r =>
            counts[r.file_id] != null ? { ...r, hit_count: counts[r.file_id] } : r);
          setPdfResults(prev => prev.map(r =>
            counts[r.file_id] != null ? { ...r, hit_count: counts[r.file_id] } : r));
        },
        onDone: () => {
          stopFlush();
          if (pdfSearchAbort.current === controller) {
            pdfSearchAbort.current = null;
            setPdfSearching(false);
          }
        },
      },
      controller.signal,
    ).finally(() => {
      stopFlush();
      // Only the run that still owns the controller clears searching — a
      // superseded run (whose controller was replaced) leaves it to the new run.
      if (pdfSearchAbort.current === controller) {
        pdfSearchAbort.current = null;
        setPdfSearching(false);
      }
    });
  }, []);

  const runPdfSearch = useCallback((scopeOverride?: 'all' | 'donor') => {
    streamPdfSearch(pdfQuery, scopeOverride ?? pdfScope);
  }, [pdfQuery, pdfScope, streamPdfSearch]);

  // Clean up the flush interval + abort the stream on unmount.
  useEffect(() => () => {
    pdfSearchAbort.current?.abort();
    if (pdfFlushTimer.current) clearInterval(pdfFlushTimer.current);
  }, []);
  const donorResults = useMemo(() => pdfResults.filter(r => r.is_donor), [pdfResults]);
  const otherResults = useMemo(() => pdfResults.filter(r => !r.is_donor), [pdfResults]);

  // Donor list for manage mode: shown when scope=donor and no query entered
  const [donorList, setDonorList] = useState<{ file_id: number; filename: string; path?: string }[]>([]);
  const isDonorManageMode = viewMode === 'search' && pdfScope === 'donor' && !pdfQuery.trim();
  useEffect(() => {
    if (!isDonorManageMode) return;
    databankStore.listDonors().then(setDonorList);
  }, [isDonorManageMode]);

  // Pick up a pending PDF search set by ContextMenu "Search in donors/PDFs".
  // Keyed on the reactive `pendingPdfSearch` snapshot value (not viewMode), so
  // it fires even when the Library is already on the search tab — the sidebar
  // keeps LibraryPanel mounted (display:none), so a viewMode no-op wouldn't
  // re-run an effect keyed on viewMode.
  useEffect(() => {
    if (!pendingPdfSearch) return;
    const { query, scope } = pendingPdfSearch;
    databankStore.clearPendingPdfSearch();
    // Defer the state updates off the synchronous effect pass (avoids the
    // cascading-render lint and keeps the store mutation cleanly separated).
    queueMicrotask(() => {
      setPdfQuery(query);
      setPdfScope(scope);
      streamPdfSearch(query, scope);
    });
  }, [pendingPdfSearch, streamPdfSearch]);

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

  const handleSetViewMode = useCallback((mode: ViewMode) => {
    databankStore.setViewMode(mode);
  }, []);

  // Model tab is hidden (Board# now groups by model). If a user's persisted
  // viewMode is the now-unreachable 'model', fall back to Board# once on mount
  // so they aren't stuck on a view with no tab to leave it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (viewMode === 'model') handleSetViewMode('metadata'); }, []);

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
  }, [autoPdf]);

  /** Opens a PDF Search hit at its page, then fires the in-document search so
   *  the matching text is highlighted.
   *
   *  Robust open: we don't depend on `databankStore.fileById(r.file_id)` being
   *  populated (it isn't when the session jumped straight to the PDF-search
   *  tab without loading the full file list). A SearchResult already carries
   *  the only fields the open path reads — `id`, `path`, `filename`, and the
   *  fact that PDF-search hits are always PDFs — so we synthesize a minimal
   *  DatabankFile when the cached object is missing.
   *
   *  Reliable auto-find: instead of a fixed 300 ms timeout (which raced text
   *  extraction on large PDFs and found nothing), we await
   *  pdfStore.whenTextReady(fileName, pageNum) so searchText runs only once the
   *  target page's text is actually in memory. */
  const handleOpenSearchHit = useCallback(async (r: SearchResult) => {
    const file: DatabankFile = databankStore.fileById(r.file_id) ?? ({
      id: r.file_id,
      path: r.path,
      filename: r.filename,
      file_type: 'pdf',
      // mod_time gates the File.lastModified fed to pdf.js / cache keys; 0 is
      // a safe sentinel for a synthesized entry (the real value, if any, is
      // irrelevant to opening + searching this hit).
      mod_time: 0,
    } as DatabankFile);
    await handleOpenFile(file, r.page_num);
    const query = pdfQuery;
    if (query.trim()) {
      // The doc is now the active PDF (handleOpenFile switched to it). Wait for
      // its text pages to be ready (up to ~10 s) before searching.
      await pdfStore.whenTextReady(file.filename, r.page_num ?? 1);
      pdfStore.searchText(query, 'lookup');
    }
  }, [handleOpenFile, pdfQuery]);

  /** Single-click a PDF-search result: select it + load its detail so the
   *  shared FileDetailPane info section appears (same model as the tree
   *  views' handleSelectFile). */
  const handleSelectResult = useCallback((fileId: number) => {
    databankStore.selectFile(fileId);
    databankStore.fetchFileDetail(fileId);
  }, []);

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

  const handleIndexFolder = useCallback(async (folderPath: string) => {
    const res = await pdfIndexClient.indexFolder(folderPath);
    if (res.status === 409) {
      if (confirm('An index is already running. Stop it and index this folder instead?')) {
        await pdfIndexClient.stop();
        await new Promise(r => setTimeout(r, 600));
        await pdfIndexClient.indexFolder(folderPath);
        databankStore.startPdfIndexPolling();
      }
      return;
    }
    if (res.ok) {
      databankStore.startPdfIndexPolling();
    }
  }, []);

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
  const showLoadStrip =
    libraryLoad.phase !== 'idle' && libraryLoad.phase !== 'done';
  const loadStripPct = libraryLoad.total > 0
    ? Math.min(100, Math.round((libraryLoad.done / libraryLoad.total) * 100))
    : 0;
  const loadStripLabel =
    libraryLoad.phase === 'connecting' ? 'Connecting'
    : libraryLoad.phase === 'cache' ? 'Restoring cache'
    : libraryLoad.phase === 'streaming' ? 'Streaming files'
    : libraryLoad.phase === 'finalizing' ? 'Indexing'
    : libraryLoad.phase === 'error' ? 'Load failed'
    : '';
  const loadStrip = showLoadStrip && (
    <div className={`library-loadstrip ${libraryLoad.phase}`} role="status" aria-live="polite">
      <div className="library-loadstrip-bar">
        <div
          className="library-loadstrip-fill"
          style={{ width: `${loadStripPct}%` }}
        />
      </div>
      <div className="library-loadstrip-text">
        <span className="library-loadstrip-phase">{loadStripLabel}</span>
        {libraryLoad.total > 0 ? (
          <span className="library-loadstrip-counter">
            {libraryLoad.done.toLocaleString()} / {libraryLoad.total.toLocaleString()} ({loadStripPct}%)
          </span>
        ) : libraryLoad.done > 0 ? (
          <span className="library-loadstrip-counter">{libraryLoad.done.toLocaleString()} files</span>
        ) : null}
        {libraryLoad.note && (
          <span className="library-loadstrip-note">{libraryLoad.note}</span>
        )}
        {libraryLoad.phase === 'error' && libraryLoad.error && (
          <button
            className="library-scan-btn"
            style={{ marginLeft: 8, padding: '0 6px', fontSize: 10 }}
            onClick={() => { void databankStore.fetchFiles(); }}
            title={libraryLoad.error}
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );

  // Completeness guard: after the strip is done (phase==='done'), compare the
  // in-memory file count to the backend stats. A mismatch means the stream
  // truncated mid-flight, IDB returned a torn cache, or a post-scan refetch
  // got skipped — none of which the strip alone surfaces. Show a sticky chip
  // with a one-click reload until the counts agree. Allow a tiny slack in case
  // the scanner adds a row between the stats call and the stream finishing.
  const expectedTotal = stats ? stats.boards + stats.pdfs : 0;
  const loadedTotal = files.length;
  const isIncomplete =
    libraryLoad.phase === 'done'
    && filesComplete
    && expectedTotal > 0
    && loadedTotal + 16 < expectedTotal; // 16 = small slack window
  const incompleteStrip = isIncomplete && (
    <div className="library-loadstrip error" role="alert">
      <div className="library-loadstrip-text">
        <span className="library-loadstrip-phase">Library load incomplete</span>
        <span className="library-loadstrip-counter">
          {loadedTotal.toLocaleString()} of {expectedTotal.toLocaleString()} files
        </span>
        <span className="library-loadstrip-note">
          (the stream stopped early — usually a transient network issue)
        </span>
        <button
          className="library-scan-btn"
          style={{ marginLeft: 8, padding: '0 6px', fontSize: 10 }}
          onClick={() => { void databankStore.fetchFiles(); }}
        >
          Reload
        </button>
      </div>
    </div>
  );

  const statsBar = (
    <div className="library-statsbar">
      {loadStrip}
      {incompleteStrip}
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
            {pdfIndexProgress?.running && (
              <span className="library-indexing" style={{ marginLeft: 8 }}>
                Indexing {pdfIndexProgress.done}/{pdfIndexProgress.total}
                {pdfIndexProgress.workers > 0 ? ` · ${pdfIndexProgress.active_workers}/${pdfIndexProgress.workers} threads` : ''}
                {pdfIndexProgress.errors > 0 ? ` (${pdfIndexProgress.errors} err)` : ''}
                {fmtIndexEta(pdfIndexProgress) ? ` · ${fmtIndexEta(pdfIndexProgress)}` : ''}
              </span>
            )}
            {pdfIndexProgress?.running && pdfIndexProgress.current_file && (
              <div className="library-indexing-file" title={pdfIndexProgress.current_file}>
                {tailTruncate(pdfIndexProgress.current_file)}
              </div>
            )}
            {!pdfIndexProgress?.running && pdfIndexStats && (
              <span className="library-scan-result" style={{ marginLeft: 8 }}>
                {pdfIndexStats.indexed} indexed · {pdfIndexStats.pages} pages
                {pdfIndexStats.failed > 0 && (
                  <button
                    className="library-scan-btn"
                    style={{ marginLeft: 6, padding: '0 5px', fontSize: 10 }}
                    onClick={failedListLoading ? undefined : showFailedList}
                    disabled={failedListLoading}
                    title="Show failed PDF files"
                  >
                    {failedListLoading ? '…' : `${pdfIndexStats.failed} failed`}
                  </button>
                )}
              </span>
            )}
          </>
        )}
      </div>
      <div className="library-statsbar-actions">
        {scanStatus?.running ? (
          <button className="library-scan-btn library-scan-stop" onClick={() => databankStore.stopScan()} title="Stop scan">Stop</button>
        ) : (
          <>
            {pdfIndexProgress?.running ? (
              <>
                <button className="library-scan-btn library-scan-stop" onClick={() => pdfIndexClient.stop()} title="Stop PDF indexing">Stop</button>
              </>
            ) : (
              <button
                className="library-scan-btn library-scan-icon"
                onClick={() => { void pdfIndexClient.run(); databankStore.startPdfIndexPolling(); }}
                title="Index all PDFs for text search"
              >
                <IconFileText size={14} />
              </button>
            )}
            <button className="library-scan-btn library-scan-icon" onClick={handleFileScan} title="Scan filesystem for board and PDF files">
              <IconFolderSearch size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );

  const failedModal = failedList !== null && (
    <div className="library-modal-backdrop" onClick={() => setFailedList(null)}>
      <div className="library-modal library-modal-wide" onClick={e => e.stopPropagation()}>
        <div className="library-modal-title">Failed PDF Indexing ({failedList.length})</div>
        {failedList.length === 0 ? (
          <div className="library-modal-filename">No failed files.</div>
        ) : (
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {failedList.map(f => (
              <div key={f.file_id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 5 }}>
                <div className="library-modal-filename" style={{ marginBottom: 2 }}>
                  ID {f.file_id} — {f.status}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-secondary)', wordBreak: 'break-all', opacity: 0.8 }}>
                  {f.error || '(no error message)'}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="library-modal-actions">
          {failedList.length > 0 && (
            <button className="library-scan-btn" onClick={handleRetryFailed} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry failed'}
            </button>
          )}
          <button className="library-scan-btn" onClick={() => setFailedList(null)}>Close</button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="library-panel">
      {failedModal}
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
          {/* Model tab hidden — Board# now groups by model. Code kept (ModelView/modelTree) for future re-enable.
          <button
            className={`library-tab ${viewMode === 'model' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('model')}
          >
            Model
          </button>
          */}
          <button
            className={`library-tab ${viewMode === 'search' ? 'active' : ''}`}
            onClick={() => handleSetViewMode('search')}
            title="Search PDF text content"
          >
            PDF
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
      {viewMode !== 'search' && (
        <div className="library-search">
          <input
            type="text"
            placeholder="Filter files..."
            className="library-search-input"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
            }}
          />
          {localSearch && (
            <button
              className="library-search-clear"
              onClick={() => {
                setLocalSearch('');
              }}
              title="Clear search"
            >
              x
            </button>
          )}
          {!filesComplete && libraryLoad.total > 0 && (
            <span
              className="library-search-partial"
              title="The library is still loading. The filter runs against the files received so far."
            >
              streaming database from server… {libraryLoad.done.toLocaleString()} / {libraryLoad.total.toLocaleString()}
            </span>
          )}
        </div>
      )}

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
        {viewMode === 'search' ? (
          <div className="library-pdf-search">
            <div className="library-search" style={{ borderBottom: 'none', padding: '6px 8px 4px' }}>
              <input
                className="library-search-input"
                placeholder="Search PDF text (e.g. 10UF 25V)…"
                value={pdfQuery}
                onChange={e => setPdfQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runPdfSearch(); }}
              />
              <label className="library-pdf-search-toggle" title="Restrict search to donor PDFs only">
                <input
                  type="checkbox"
                  checked={pdfScope === 'donor'}
                  onChange={e => setPdfScope(e.target.checked ? 'donor' : 'all')}
                />
                Donors only
              </label>
              <button
                className="library-search-btn"
                onClick={() => runPdfSearch()}
                disabled={pdfSearching}
              >
                {pdfSearching ? '…' : 'Search'}
              </button>
              {pdfResults.length > 0 && (
                <button
                  className="library-search-clear"
                  onClick={() => { setPdfResults([]); setPdfQuery(''); }}
                  title="Clear"
                >x</button>
              )}
            </div>
            {isDonorManageMode ? (
              <div className="library-donor-list">
                {donorList.length === 0
                  ? <div className="library-empty">No donor PDFs yet. Mark PDFs as donors to build this list.</div>
                  : donorList.map(d => (
                      <div key={d.file_id} className="library-donor-row">
                        <span className="library-donor-name" title={d.path || d.filename}>{d.filename}</span>
                        <button
                          className="library-donor-remove"
                          title="Remove from donor list"
                          onClick={async () => { await databankStore.removeDonor(d.file_id); setDonorList(await databankStore.listDonors()); }}
                        >×</button>
                      </div>
                    ))}
              </div>
            ) : (
              <>
                {donorResults.length > 0 && (
                  <details className="library-donor-spoiler" open>
                    <summary>Donors ({donorResults.length})</summary>
                    <SearchResultsView
                      results={donorResults}
                      selectedFileId={selectedFileId}
                      onSelectResult={handleSelectResult}
                      onOpenResult={handleOpenSearchHit}
                      searching={pdfSearching}
                    />
                  </details>
                )}
                {otherResults.length > 0 && (
                  <SearchResultsView
                    results={otherResults}
                    selectedFileId={selectedFileId}
                    onSelectResult={handleSelectResult}
                    onOpenResult={handleOpenSearchHit}
                    searching={pdfSearching}
                  />
                )}
                {pdfResults.length === 0 && pdfSearching && (
                  <div className="library-search-results-header">
                    Searching… <span className="library-search-spinner" aria-hidden />
                  </div>
                )}
                {pdfResults.length === 0 && !pdfSearching && pdfQuery.trim() && (
                  <div className="library-empty">No results for "{pdfQuery}"</div>
                )}
                {pdfResults.length === 0 && !pdfQuery.trim() && (
                  <div className="library-empty">Enter a query and press Search or Enter</div>
                )}
              </>
            )}
          </div>
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
          <LiveBrowser browseResult={browseResult} browsing={browsing} searchFilter={debouncedSearch} onIndexFolder={handleIndexFolder} />
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
          electronMode={electronMode}
        />
      )}

      {/* Stats + scan buttons — pinned to bottom of the panel for visual
       *  consistency with SettingsPanel (tabs at top, status at bottom). */}
      {statsBar}
    </div>
  );
}

// --- Live Browser ---

function LiveBrowser({ browseResult, browsing, searchFilter, onIndexFolder }: {
  browseResult: import('../store/databank-store').BrowseResult | null;
  browsing: boolean;
  searchFilter: string;
  onIndexFolder?: (folderPath: string) => void;
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
      {onIndexFolder && (
        <div className="library-live-index-header">
          <button
            className="library-scan-btn"
            title={currentPath ? `Index PDFs in "${currentPath}"` : 'Index all PDFs in library root'}
            onClick={() => onIndexFolder(currentPath)}
          >
            {currentPath ? `Index "${currentPath.split('/').pop()}"` : 'Index root'}
          </button>
        </div>
      )}
      {currentPath && (
        <div className="library-tree-node" onClick={navigateUp} style={{ cursor: 'pointer' }}>
          <span className="library-tree-arrow">▶</span>
          <span className="library-tree-folder">..</span>
        </div>
      )}
      {dirs.map(d => {
        const dirPath = currentPath ? currentPath + '/' + d.name : d.name;
        return (
          <div key={d.name} className="library-tree-node" onClick={() => navigateTo(d.name)} style={{ cursor: 'pointer' }}>
            <span className="library-tree-arrow">▶</span>
            <span className="library-tree-folder">{d.name}</span>
            {onIndexFolder && (
              <button
                className="library-live-index-btn"
                title={`Index PDFs in "${d.name}"`}
                onClick={(e) => { e.stopPropagation(); onIndexFolder(dirPath); }}
              >
                idx
              </button>
            )}
          </div>
        );
      })}
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

/** Toggle button for adding/removing a PDF from the pdf_donors list. */
function DonorToggle({ fileId }: { fileId: number }) {
  const { donorIds } = useDatabank();
  const isDonor = donorIds.has(fileId);
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try {
      if (isDonor) {
        await databankStore.removeDonor(fileId);
      } else {
        await databankStore.addDonor(fileId);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={`library-donor-toggle-btn${isDonor ? ' is-donor' : ''}`}
      onClick={handleToggle}
      disabled={busy}
      title={isDonor
        ? 'Remove this PDF from the donor pool (will no longer appear in donor searches)'
        : 'Mark this PDF as a donor (makes it appear in donor-scoped searches)'}
    >
      {busy ? '…' : isDonor ? 'Remove donor' : 'Mark as donor'}
    </button>
  );
}

function useRevealLabel(): string {
  const [platform, setPlatform] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.platform().then(p => { if (!cancelled) setPlatform(p); });
    return () => { cancelled = true; };
  }, []);
  if (platform === 'darwin') return 'Show in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in folder';
}

function RevealButton({ path }: { path: string }) {
  const label = useRevealLabel();
  return (
    <button
      className="library-detail-open library-detail-download"
      onClick={() => { void window.electronAPI?.showItemInFolder(path); }}
      title="Show file in the OS file browser"
    >
      {label}
    </button>
  );
}

function FileDetailPane({ detail, files, onOpen, onCreateBinding, onUpdateBinding, onDeleteBinding, electronMode }: {
  detail: FileDetail;
  files: DatabankFile[];
  onOpen: (f: DatabankFile) => void;
  onCreateBinding: (boardId: number, pdfId: number, category?: string, autoOpen?: boolean) => void;
  onUpdateBinding: (bindingId: number, patch: { category?: string; auto_open?: boolean }) => void;
  onDeleteBinding: (bindingId: number) => void;
  electronMode: boolean;
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
        {electronMode ? (
          <RevealButton path={detail.path} />
        ) : (
          <a
            className="library-detail-open library-detail-download"
            href={`/api/files/path/${detail.path.split('/').map(encodeURIComponent).join('/')}?download=1`}
            download={detail.filename}
            title="Download file"
          >
            Download
          </a>
        )}
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

      {detail.file_type === 'pdf' && (
        <div className="library-detail-donor-row">
          <DonorToggle fileId={detail.id} />
        </div>
      )}

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

function SearchResultsView({ results, selectedFileId, onSelectResult, onOpenResult, searching }: {
  results: import('../store/databank-store').SearchResult[];
  selectedFileId: number | null;
  onSelectResult: (fileId: number) => void;
  onOpenResult: (r: SearchResult) => void;
  searching: boolean;
}) {
  return (
    <div className="library-search-results">
      <div className="library-search-results-header">
        {searching
          ? <>Searching… {results.length} found <span className="library-search-spinner" aria-hidden /></>
          : `${results.length} result${results.length !== 1 ? 's' : ''}`}
      </div>
      {results.map((r, i) => (
        <div
          key={`${r.file_id}-${i}`}
          className={`library-search-result${r.file_id === selectedFileId ? ' selected' : ''}`}
          onClick={() => onSelectResult(r.file_id)}
          onDoubleClick={() => onOpenResult(r)}
        >
          <div className="library-search-result-header">
            <span className="library-file-icon library-icon-pdf">P</span>
            <span className="library-search-result-file">{r.filename}</span>
            <span className="library-search-result-hits">
              {r.hit_count ?? 1} hit{(r.hit_count ?? 1) === 1 ? '' : 's'}
            </span>
            <span className="library-search-result-page">p{r.page_num}</span>
          </div>
          {r.snippet && (
            <div className="library-search-result-snippet">
              {renderSnippet(r.snippet)}
            </div>
          )}
          {r.copies && r.copies.length > 0 && (
            <details
              className="library-copies-spoiler"
              onClick={(e) => e.stopPropagation()}
            >
              <summary>
                +{r.copies.length} cop{r.copies.length === 1 ? 'y' : 'ies'}
              </summary>
              {r.copies.map((p) => (
                <div key={p} className="library-copies-path" title={p}>
                  {tailTruncate(p)}
                </div>
              ))}
            </details>
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

// View-only cleanup for the Board# tree: within a single leaf list, files that
// share the same filename (from different source folders, NOT byte-identical —
// those are already collapsed by contentCollapsePlan) are folded into one head
// row plus a native <details> spoiler holding the rest. This is purely layout;
// it never touches the dedup pass, content hashing, or the per-file byte-copy
// ×N badge (copyCount/copyPaths still flow through to each row independently).
// Files arrive already content-collapsed: each carries the byte-copy ×N info
// merged in by MetadataView's `take()`, so we keep that shape here.
type CollapsedDatabankFile = DatabankFile & CollapsedFileInfo;

function NameGroupedFileRows({ files, indent, selectedFileId, onSelectFile, onOpenFile }: {
  files: CollapsedDatabankFile[];
  /** Base indent for the head rows (variants render at indent + 1). */
  indent: number;
  selectedFileId: number | null;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  // Group by lowercased filename, preserving first-seen order.
  const groups: CollapsedDatabankFile[][] = [];
  const byName = new Map<string, CollapsedDatabankFile[]>();
  for (const f of files) {
    const key = f.filename.toLowerCase();
    let g = byName.get(key);
    if (!g) {
      g = [];
      byName.set(key, g);
      groups.push(g);
    }
    g.push(f);
  }

  return (
    <>
      {groups.map(group => {
        const head = group[0];
        if (group.length === 1) {
          return (
            <FileRow
              key={head.id}
              file={head}
              copyCount={head.copyCount}
              copyPaths={head.copyPaths}
              selected={head.id === selectedFileId}
              indent={indent}
              showPreview={head.file_type === 'pdf'}
              onSelect={onSelectFile}
              onOpen={onOpenFile}
            />
          );
        }
        const extra = group.length - 1;
        return (
          <div key={head.id} className="library-name-group">
            <FileRow
              file={head}
              copyCount={head.copyCount}
              copyPaths={head.copyPaths}
              selected={head.id === selectedFileId}
              indent={indent}
              showPreview={head.file_type === 'pdf'}
              onSelect={onSelectFile}
              onOpen={onOpenFile}
            />
            <details
              className="library-variants-spoiler"
              style={{ paddingLeft: indent * 16 + 20 }}
              onClick={e => e.stopPropagation()}
            >
              <summary>+{extra} same-name {extra === 1 ? 'variant' : 'variants'}</summary>
              {group.slice(1).map(v => (
                <FileRow
                  key={v.id}
                  file={v}
                  copyCount={v.copyCount}
                  copyPaths={v.copyPaths}
                  selected={v.id === selectedFileId}
                  indent={indent + 1}
                  showPreview={v.file_type === 'pdf'}
                  onSelect={onSelectFile}
                  onOpen={onOpenFile}
                />
              ))}
            </details>
          </div>
        );
      })}
    </>
  );
}

function MetadataView({ groups, selectedFileId, filterFile, onSelectFile, onOpenFile }: {
  groups: MetadataGroup[];
  selectedFileId: number | null;
  filterFile: (f: DatabankFile) => boolean;
  onSelectFile: (f: DatabankFile) => void;
  onOpenFile: (f: DatabankFile) => void;
}) {
  const [expanded, toggle, collapseAll] = usePersistedExpanded('boardripper-tree-metadata');

  // Collapse byte-identical duplicates across the WHOLE view (after filtering)
  // so each content group shows once (canonical row + ×N chip), even when the
  // copies sit under different board numbers (e.g. 820-00165 vs 820-00165-A)
  // or different models. Folder views never collapse — they list every copy.
  const filteredGroups = useMemo(() => {
    const all: DatabankFile[] = [];
    for (const g of groups) {
      for (const m of g.models) {
        for (const bn of m.boardNumbers) for (const f of bn.files) if (filterFile(f)) all.push(f);
        for (const f of m.ungrouped) if (filterFile(f)) all.push(f);
      }
    }
    const plan = contentCollapsePlan(all);
    const take = (files: DatabankFile[]) =>
      files
        .filter(f => filterFile(f) && plan.keep.has(f.id))
        .map(f => ({ ...f, ...(plan.info.get(f.id) ?? { copyCount: 0, copyPaths: [] }) }));
    return groups.map(g => ({
      ...g,
      models: g.models.map(m => ({
        ...m,
        boardNumbers: m.boardNumbers.map(bn => ({ ...bn, files: take(bn.files) })).filter(bn => bn.files.length > 0),
        ungrouped: take(m.ungrouped),
      })).filter(m => m.boardNumbers.length > 0 || m.ungrouped.length > 0),
    })).filter(g => g.models.length > 0);
  }, [groups, filterFile]);

  return (
    <div className="library-tree">
      {expanded.size > 0 && (
        <button className="library-collapse-all" onClick={collapseAll} title="Collapse all">⊟</button>
      )}
      {filteredGroups.map(group => {
        const mfrKey = `mfr:${group.manufacturer}`;
        const isExpanded = expanded.has(mfrKey);
        const brandTotal = group.models.reduce(
          (n, m) => n + m.boardNumbers.reduce((bn, b) => bn + b.files.length, 0) + m.ungrouped.length,
          0,
        );

        return (
          <div key={mfrKey} className="library-tree-group">
            <div className="library-tree-node" onClick={() => toggle(mfrKey)}>
              <span className="library-tree-arrow">{isExpanded ? '▼' : '▶'}</span>
              <span className="library-tree-mfr">{group.manufacturer}</span>
              <span className="library-tree-count">{brandTotal}</span>
            </div>
            {isExpanded && (
              <div className="library-tree-children">
                {group.models.map(model => {
                  const mdlKey = `mdl:${group.manufacturer} ${model.model}`;
                  const mdlExpanded = expanded.has(mdlKey);
                  const modelTotal = model.boardNumbers.reduce((n, bn) => n + bn.files.length, 0) + model.ungrouped.length;
                  return (
                    <div key={mdlKey} className="library-tree-group">
                      <div className="library-tree-node library-tree-indent" onClick={() => toggle(mdlKey)}>
                        <span className="library-tree-arrow">{mdlExpanded ? '▼' : '▶'}</span>
                        <span className="library-tree-model">{model.model}</span>
                        <span className="library-tree-count">{modelTotal}</span>
                      </div>
                      {mdlExpanded && (
                        <div className="library-tree-children">
                          {model.boardNumbers.map(bn => {
                            const bnKey = `bn:${group.manufacturer} ${model.model} ${bn.boardNumber}`;
                            const bnExpanded = expanded.has(bnKey);
                            return (
                              <div key={bnKey} className="library-tree-group">
                                <div className="library-tree-node library-tree-indent-2" onClick={() => toggle(bnKey)}>
                                  <span className="library-tree-arrow">{bnExpanded ? '▼' : '▶'}</span>
                                  <span className="library-tree-board-num">{bn.boardNumber}</span>
                                  <span className="library-tree-count">{bn.files.length}</span>
                                </div>
                                {bnExpanded && (
                                  <div className="library-tree-children">
                                    <NameGroupedFileRows
                                      files={bn.files}
                                      indent={3}
                                      selectedFileId={selectedFileId}
                                      onSelectFile={onSelectFile}
                                      onOpenFile={onOpenFile}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <NameGroupedFileRows
                            files={model.ungrouped}
                            indent={2}
                            selectedFileId={selectedFileId}
                            onSelectFile={onSelectFile}
                            onOpenFile={onOpenFile}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
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

  // Collapse byte-identical duplicates across the WHOLE view — see MetadataView
  // note. A content group spanning model variants (board# revisions) folds to
  // one canonical row.
  const filteredGroups = useMemo(() => {
    const all: DatabankFile[] = [];
    for (const g of groups) {
      for (const v of g.variants) for (const f of v.files) if (filterFile(f)) all.push(f);
      for (const f of g.unresolved) if (filterFile(f)) all.push(f);
    }
    const plan = contentCollapsePlan(all);
    const take = (files: DatabankFile[]) =>
      files
        .filter(f => filterFile(f) && plan.keep.has(f.id))
        .map(f => ({ ...f, ...(plan.info.get(f.id) ?? { copyCount: 0, copyPaths: [] }) }));
    return groups.map(g => ({
      ...g,
      variants: g.variants.map(v => ({ ...v, files: take(v.files) })).filter(v => v.files.length > 0),
      unresolved: take(g.unresolved),
    })).filter(g => g.variants.length > 0 || g.unresolved.length > 0);
  }, [groups, filterFile]);

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
                              copyCount={f.copyCount}
                              copyPaths={f.copyPaths}
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
                    copyCount={f.copyCount}
                    copyPaths={f.copyPaths}
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

function FileRow({ file, selected, indent, showPreview, copyCount = 0, copyPaths, onSelect, onOpen }: {
  file: DatabankFile;
  selected: boolean;
  indent: number;
  showPreview?: boolean;
  /** When > 0, this row stands in for a byte-identical content group and the
   *  badge reports how many redundant copies were collapsed away. */
  copyCount?: number;
  /** Paths of the folded-away copies (shown on the badge tooltip). */
  copyPaths?: string[];
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
      {copyCount > 0 && (
        <span
          className="library-copies-chip"
          title={
            copyPaths && copyPaths.length
              ? `${copyCount} byte-identical ${copyCount === 1 ? 'copy' : 'copies'} also at:\n${copyPaths.join('\n')}`
              : `${copyCount} byte-identical ${copyCount === 1 ? 'copy' : 'copies'} collapsed`
          }
        >
          ×{copyCount + 1}
        </span>
      )}
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
