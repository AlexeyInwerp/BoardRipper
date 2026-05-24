import React, { useEffect, useRef, useSyncExternalStore, useState } from 'react';
import { IconCopy, IconWorld, IconPin, IconPinFilled, IconShieldPlus } from '@tabler/icons-react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { databankStore } from '../store/databank-store';
import { renderSettingsStore } from '../store/render-settings';
import { ensurePdfPanel } from '../store/dockview-api';
import { openBoardSidebarTab } from '../panels/BoardViewerPanel';
import { showSidebarTab } from './Sidebar';
import { worklistStore } from '../store/worklist-store';
import { fileInputRefs } from '../store/file-inputs';
import { findInBoardTab, countInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge } from './SearchScopeBadge';
import { copyText } from '../clipboard';

/**
 * ============================================================================
 *  KEEP IN SYNC — renderBoardBody() and renderPdfBody() share a UI contract:
 *    • Groups render under muted .context-menu-group-header labels with
 *      separators. Group headers are non-interactive — purely informative.
 *    • Donor rows are one per donor. Row format:
 *          [scope-badge] <donor-short-name> | <default-query> (<default-count>)   [▸]
 *      Clicking the row triggers the default query lookup (component name
 *      in board mode, cursor text in PDF mode). A ▸ spoiler arrow appears
 *      only when extra query variants exist; clicking it expands inline
 *      indented variant rows below.
 *    • Variant rows (only in board mode with pin+net context) render
 *      <queryLabel> (<count>) — no badge; the donor row's badge covers
 *      the whole group.
 *    • Zero-count rows stay clickable — users may jump to a target and
 *      tweak the query there. Do not add `disabled` based on count.
 *    • Spoiler expansion state resets each time the menu reopens.
 *    • PDF donor counts are computed asynchronously via
 *      pdfStore.countTextMatchesAsync — the menu opens immediately
 *      with "(…)" placeholders for any uncomputed count, and React
 *      state updates each row as its promise resolves. Board counts
 *      (countInBoardTab) stay sync. The cache is keyed by
 *      (fileName, lowercased query) and cleared when the menu closes.
 *
 *  Board right-click:
 *      • Default query = componentName.
 *      • Extra variants (under spoiler, PDF donors only): chip@pin, net.
 *      • Extra variants (under spoiler, board donors): net.
 *      • When neither chip@pin nor net applies, no spoiler arrow shows.
 *
 *  PDF right-click:
 *      • Default query = cursor text item. No extra variants. Ever.
 *      • Donor rows never carry a spoiler arrow — always flat click-to-go.
 *
 *  When changing one body (row format, group structure, badge placement,
 *  spoiler rules, click behavior) update the other so the two right-click
 *  modes stay consistent.
 *    • The header (.context-menu-header) renders the part / pin / net under
 *      the cursor as inline chips — each chip carries a copy-on-click value
 *      plus optional search-on-web and worklist-pin actions. Replaces the
 *      older separate quick-action strip; everything an action could target
 *      now lives in one row next to its name.
 *    • PDF mode header renders the cursor text as a single chip (copy +
 *      search-on-web). A separate "Hide as watermark" item lives inside
 *      renderPdfBody above the donor groups.
 * ============================================================================
 */

let version = 0;
let lastVer = -1;
let cached: ContextMenuState | null = null;

contextMenuStore.subscribe(() => { version++; });

function getSnapshot() {
  if (lastVer !== version || !cached) {
    cached = contextMenuStore.state;
    lastVer = version;
  }
  return cached;
}

function subscribe(cb: () => void) {
  return contextMenuStore.subscribe(cb);
}

/** Strip extension for shorter display labels */
function shortPdfName(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '');
}

/** Strip extension for shorter board display labels */
function shortBoardName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

export function ContextMenu() {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  const menuRef = useRef<HTMLDivElement>(null);
  const [expandedSpoilers, setExpandedSpoilers] = useState<Set<string>>(new Set());
  const toggleSpoiler = (key: string) => {
    setExpandedSpoilers(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // Async PDF count cache: rowKey -> count (-1 = pending placeholder).
  // Populated on menu open by a useEffect that dispatches countTextMatchesAsync
  // for each unique (fileName, query) the rendered rows need.
  const [pdfCounts, setPdfCounts] = useState<Map<string, number>>(new Map());

  const pdfCountKey = (fileName: string, query: string) => `${fileName} ${query.toLowerCase()}`;
  const lookupPdfCount = (fileName: string, query: string): number | null => {
    const v = pdfCounts.get(pdfCountKey(fileName, query));
    return v === undefined ? null : v;
  };

  // Clamp menu position to viewport after render
  useEffect(() => {
    const el = menuRef.current;
    if (!el || !state.visible) return;
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - 8;
    const maxY = window.innerHeight - 8;
    if (rect.right > maxX) el.style.left = `${state.screenX - (rect.right - maxX)}px`;
    if (rect.bottom > maxY) el.style.top = `${state.screenY - (rect.bottom - maxY)}px`;
  }, [state.visible, state.screenX, state.screenY]);

  // Reset spoiler state each time the menu opens — default-collapsed UX.
  const [trackedVisible, setTrackedVisible] = useState(false);
  if (state.visible !== trackedVisible) {
    setTrackedVisible(state.visible);
    if (state.visible && expandedSpoilers.size > 0) setExpandedSpoilers(new Set());
  }

  useEffect(() => {
    if (!state.visible) return;
    const handleClick = () => contextMenuStore.hide();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') contextMenuStore.hide();
    };
    document.addEventListener('click', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [state.visible]);

  useEffect(() => {
    if (!state.visible) {
      // Menu closed — let inflight requests cancel via the cleanup below;
      // the cache stays warm. Cache entries are keyed by (fileName, query)
      // so they remain valid across reopens. Calling setPdfCounts here
      // would synchronously update state inside the effect — banned by
      // react-x/no-set-state-in-effect — and is unnecessary anyway.
      return;
    }
    const controller = new AbortController();
    const needs: Array<{ fileName: string; query: string }> = [];
    if (state.source === 'board') {
      const compName = state.componentName;
      const pinId = state.pinId;
      const netName = state.netName;
      const chipPinQuery = pinId ? `${pinId}@${compName}` : null;
      const allOpenPdfs = pdfStore.loadedFileNames;
      for (const fileName of allOpenPdfs) {
        if (compName) needs.push({ fileName, query: compName });
        if (chipPinQuery) needs.push({ fileName, query: chipPinQuery });
        if (netName) needs.push({ fileName, query: netName });
      }
    } else {
      // PDF mode: scan all OTHER open PDFs for the cursor query.
      const originPdf = state.originPdfFileName;
      const allOpenPdfs = pdfStore.loadedFileNames;
      for (const fileName of allOpenPdfs) {
        if (fileName !== originPdf && state.query) {
          needs.push({ fileName, query: state.query });
        }
      }
    }
    // Deduplicate
    const seen = new Set<string>();
    const unique = needs.filter(n => {
      const k = pdfCountKey(n.fileName, n.query);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Dispatch all in parallel (each yields internally so they interleave).
    for (const { fileName, query } of unique) {
      const k = pdfCountKey(fileName, query);
      pdfStore.countTextMatchesAsync(fileName, query, controller.signal).then(count => {
        if (controller.signal.aborted || count < 0) return;
        setPdfCounts(prev => {
          if (prev.has(k)) return prev; // already set
          const next = new Map(prev);
          next.set(k, count);
          return next;
        });
      });
    }
    return () => controller.abort();
  }, [state.visible, state.source, state.componentName, state.pinId, state.netName, state.query, state.originPdfFileName]);

  if (!state.visible) return null;

  // ── Board-mode derivations ───────────────────────────────────────────────
  const activeTab = boardStore.tabs.find(t => t.id === boardStore.activeTabId);
  const boundPdfNames = activeTab?.pdfFileNames ?? [];
  const allOpenPdfNames = pdfStore.loadedFileNames;
  const boundOpen = boundPdfNames.filter(n => allOpenPdfNames.includes(n));
  const otherPdfNames = allOpenPdfNames.filter(n => !boundOpen.includes(n));
  // Split other open PDFs into donor / non-donor based on pdf_donors membership.
  // fileByFilename is an O(N) scan but called only at menu-open time.
  const otherDonorPdfNames = otherPdfNames.filter(n => {
    const f = databankStore.fileByFilename(n);
    return f ? databankStore.isDonor(f.id) : false;
  });
  const otherNonDonorPdfNames = otherPdfNames.filter(n => {
    const f = databankStore.fileByFilename(n);
    return f ? !databankStore.isDonor(f.id) : true; // unknown = keep in non-donor group
  });
  const otherBoardTabs = boardStore.tabs.filter(
    t => t.id !== boardStore.activeTabId && t.board !== null,
  );

  // ── PDF-mode derivations ─────────────────────────────────────────────────
  const originPdf = state.originPdfFileName;
  const boundBoardTabs = boardStore.tabs.filter(
    t => t.board !== null && t.pdfFileNames.includes(originPdf),
  );
  const otherBoardsForPdf = boardStore.tabs.filter(
    t => t.board !== null && !t.pdfFileNames.includes(originPdf),
  );
  const otherPdfsForPdf = allOpenPdfNames.filter(n => n !== originPdf);

  // Auto-expand donor groups when there are few of them. Mirrors the
  // file-tree disclosure pattern: small lists default to open. Threshold
  // chosen so a typical chip with one or two linked PDFs and at most a
  // sibling board tab pre-expands; anything denser stays collapsed. While
  // the auto-expand flag is on, `expandedSpoilers` tracks rows the user
  // has *collapsed*; otherwise it tracks rows the user has *expanded*. The
  // chevron toggle is a plain add/remove either way.
  const totalDonorRows =
    state.source === 'board'
      ? boundOpen.length + otherPdfNames.length + otherBoardTabs.length
      : boundBoardTabs.length + otherBoardsForPdf.length + otherPdfsForPdf.length;

  /** Open the Library PDF Search tab with a donor-scoped query. */
  const doSearchAllDonors = (e: React.MouseEvent) => {
    e.stopPropagation();
    const query = state.source === 'board' ? state.componentName : state.query;
    if (!query.trim()) return;
    // requestPdfSearch sets the pending request + switches to the search view
    // reactively (notify), so LibraryPanel consumes it even when it is already
    // on the PDF tab (where setViewMode would be a no-op). showSidebarTab
    // ensures the sidebar is open + on the Library tab.
    databankStore.requestPdfSearch(query.trim(), 'donor');
    showSidebarTab('library');
    contextMenuStore.hide();
  };
  const autoExpandDonors = totalDonorRows > 0 && totalDonorRows < 5;

  // ── Shared click dispatchers ────────────────────────────────────────────
  const doPdfSearch = (e: React.MouseEvent, pdfFileName: string, query: string) => {
    e.stopPropagation();
    pdfStore.switchTo(pdfFileName);
    pdfStore.searchText(query);
    ensurePdfPanel(pdfFileName);
    contextMenuStore.hide();
    // Activate the PDF panel (ensurePdfPanel already does this) and focus
    // the search input. Wait a tick for the panel's onDidActiveChange effect
    // to register searchInputRef into fileInputRefs.pdfSearch.
    setTimeout(() => {
      const input = fileInputRefs.pdfSearch;
      if (!input) return;
      input.focus();
      input.select();
    }, 0);
  };

  const doBoardSearch = (e: React.MouseEvent, tabId: number, query: string) => {
    e.stopPropagation();
    findInBoardTab(query, tabId);
    contextMenuStore.hide();
  };

  const doPdfDonorFromPdf = (e: React.MouseEvent, fileName: string) => {
    e.stopPropagation();
    findInPdf(state.query, fileName);
    contextMenuStore.hide();
  };

  const copyValue = async (value: string) => {
    contextMenuStore.hide();
    try {
      await copyText(value);
      boardStore.addToast(`Copied '${value}'`, 'info');
    } catch (err) {
      boardStore.addToast(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const searchValue = (value: string) => {
    contextMenuStore.hide();
    const url = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  /** Add the right-clicked PDF text as a new watermark-filter term. Forces
   *  every open PDF to re-parse so the patched worker drops matching glyph
   *  runs at the source. */
  const onAddWatermarkTerm = () => {
    const term = state.query.trim();
    contextMenuStore.hide();
    if (!term) return;
    const current = renderSettingsStore.globalSnapshot();
    const existing = current.pdfWatermarkFilter ?? [];
    if (existing.some(t => t === term)) {
      boardStore.addToast(`"${term}" is already a watermark term`, 'info');
      return;
    }
    // Adding a term implies the user wants it filtered now — auto-enable
    // the filter if the wand was previously toggled off.
    renderSettingsStore.applyGlobal({
      ...current,
      pdfWatermarkFilter: [...existing, term],
      pdfWatermarkFilterEnabled: true,
    });
    boardStore.addToast(`Added "${term}" to watermark filter — reparsing`, 'info');
  };

  /** Toggle a refdes in the active worklist. Mirrors shift-click on canvas:
   *  present → remove, absent → add (auto-creates a worklist on first use
   *  via pushRefdesToActive). Hides the menu in either case. */
  const onToggleWorklist = (refdes: string) => {
    contextMenuStore.hide();
    const wl = worklistStore.activeWorklist;
    if (wl?.entries.some(e => e.refdes === refdes)) {
      worklistStore.removeEntry(wl.id, refdes);
      boardStore.addToast(`Removed '${refdes}' from ${wl.name}`, 'info');
      return;
    }
    const r = worklistStore.pushRefdesToActive(refdes);
    if (!r) {
      boardStore.addToast(`Could not add '${refdes}' to worklist (no active board?)`, 'error');
      return;
    }
    openBoardSidebarTab('worklist');
    const worklistName = worklistStore.activeWorklist?.name ?? 'worklist';
    if (r.added > 0) {
      boardStore.addToast(`Added '${refdes}' to ${worklistName}`, 'info');
    } else {
      boardStore.addToast(`'${refdes}' already in ${worklistName}`, 'info');
    }
  };

  /** Render a value chip: the value text + small action icons (copy /
   *  optional search / optional worklist). Click on the text itself is a
   *  shortcut for Copy. Compresses the previous three-row Copy/Search/
   *  Worklist strip into one inline header row. Worklist pin sits FIRST
   *  inside the chip so its lit/unlit state reads before the value name. */
  const renderValueChip = (
    value: string,
    actions: {
      search?: boolean;
      worklist?: boolean;
      /** When true, the worklist pin renders filled + lit and clicking
       *  *removes* the entry instead of adding (toggle semantics, mirrors
       *  shift-click on the canvas). */
      worklistLit?: boolean;
      testKind?: 'part' | 'net' | 'text';
    } = {},
  ): React.ReactElement => {
    const kind = actions.testKind ?? 'text';
    return (
      <span className="ctxmenu-chip" key={`chip-${kind}-${value}`}>
        {actions.worklist && (
          <button
            className={`ctxmenu-chip-action${actions.worklistLit ? ' is-lit' : ''}`}
            title={actions.worklistLit
              ? `'${value}' is in the active worklist — click to remove`
              : `Add '${value}' to the active worklist`}
            data-testid="qa-worklist-part"
            data-lit={actions.worklistLit ? '1' : '0'}
            onClick={(e) => { e.stopPropagation(); onToggleWorklist(value); }}
          >
            {actions.worklistLit
              ? <IconPinFilled size={12} stroke={2} />
              : <IconPin size={12} stroke={2} />}
          </button>
        )}
        <button
          className="ctxmenu-chip-value"
          title={`Copy '${value}'`}
          data-testid={`qa-copy-${kind}`}
          onClick={(e) => { e.stopPropagation(); void copyValue(value); }}
        >
          {value}
          <IconCopy size={11} stroke={2} className="ctxmenu-chip-icon" />
        </button>
        {actions.search && (
          <button
            className="ctxmenu-chip-action"
            title={`Search '${value}' on the web`}
            data-testid={`qa-search-${kind}`}
            onClick={(e) => { e.stopPropagation(); searchValue(value); }}
          >
            <IconWorld size={12} stroke={2} />
          </button>
        )}
      </span>
    );
  };

  const renderHeader = (): React.ReactElement | null => {
    if (state.source === 'board') {
      const compName = state.componentName.trim();
      if (!compName) return null;
      const pinId = state.pinId?.trim() ?? '';
      const netName = state.netName?.trim() ?? '';
      // Lit iff the part is already in the active worklist for this board.
      // Read synchronously at render — menu re-opens always re-evaluate so
      // the icon state reflects the current store.
      const isInActiveWorklist =
        !!worklistStore.activeWorklist?.entries.some(e => e.refdes === compName);
      return (
        <div className="context-menu-header" data-testid="context-menu-header">
          {renderValueChip(compName, { search: true, worklist: true, worklistLit: isInActiveWorklist, testKind: 'part' })}
          {pinId && (
            <>
              <span className="ctxmenu-chip-sep">·</span>
              {renderValueChip(pinId, { testKind: 'text' })}
            </>
          )}
          {netName && (
            <>
              <span className="ctxmenu-chip-sep">·</span>
              {renderValueChip(netName, { search: true, testKind: 'net' })}
            </>
          )}
        </div>
      );
    }
    const q = state.query.trim();
    if (!q) return null;
    return (
      <div className="context-menu-header" data-testid="context-menu-header">
        {renderValueChip(q, { search: true, testKind: 'text' })}
      </div>
    );
  };

  // ── Row renderers ────────────────────────────────────────────────────────
  /** Default-action donor row:
   *      [badge] <donorLabel> | <defaultQuery> (<defaultCount>)    [▸]
   *
   *  Clicking the row itself triggers the default lookup (component-name
   *  search in board mode, cursor text in PDF mode). If `extraVariants`
   *  is non-empty, a ▸/▾ spoiler arrow appears; clicking it toggles
   *  inline variant rows below. Row stays clickable regardless of
   *  spoiler state.
   *
   *  Zero-count rows are still clickable — user may want to jump and
   *  tweak. */
  const renderDonorRow = (
    key: string,
    scope: 'board' | 'pdf',
    donorLabel: string,
    defaultQuery: string,
    defaultCount: number | null,
    onDefaultClick: (e: React.MouseEvent) => void,
    extraVariants: React.ReactElement[] = [],
  ): React.ReactElement => {
    const hasVariants = extraVariants.length > 0;
    // Auto-expand mode: `expandedSpoilers` tracks rows the user has
    // explicitly *collapsed*. Otherwise it tracks rows explicitly *expanded*.
    // `toggleSpoiler` is a plain add/remove either way — the user-facing
    // chevron behaviour stays consistent.
    const explicit = expandedSpoilers.has(key);
    const expanded = autoExpandDonors ? !explicit : explicit;
    return (
      <React.Fragment key={key}>
        <div className="context-menu-item context-menu-donor-row" onClick={onDefaultClick}>
          <span
            className={hasVariants ? 'context-menu-donor-row-arrow' : 'context-menu-donor-row-arrow empty'}
            onClick={hasVariants ? (e) => { e.stopPropagation(); toggleSpoiler(key); } : undefined}
            aria-hidden={!hasVariants}
          >
            {hasVariants ? (expanded ? '▾' : '▸') : ''}
          </span>
          <span className="context-menu-donor-row-label" title={`${donorLabel} | ${defaultQuery}`}>
            <SearchScopeBadge scope={scope} />
            {' '}{donorLabel} | {defaultQuery} ({defaultCount == null ? '…' : defaultCount})
          </span>
        </div>
        {hasVariants && expanded && (
          <div className="context-menu-variant-group">{extraVariants}</div>
        )}
      </React.Fragment>
    );
  };

  /** Indented clickable variant row under a donor row's spoiler. No badge
   *  (badge is on the donor row). Zero-count rows stay clickable. */
  const renderVariantRow = (
    key: string,
    queryLabel: string,
    count: number | null,
    onClick: (e: React.MouseEvent) => void,
  ): React.ReactElement => (
    <div
      key={key}
      className="context-menu-item context-menu-variant-row"
      onClick={onClick}
    >
      {queryLabel} ({count == null ? '…' : count})
    </div>
  );

  // ── Board right-click body ──────────────────────────────────────────────
  // Query variants available from a component right-click:
  //   - componentName (always, e.g. "UF400")
  //   - chipPinQuery  (when pin selected, e.g. "F11@UF400") — PDF-only idiom
  //   - netName       (when pin on a net, e.g. "PP_VCC")
  const renderBoardBody = () => {
    const componentName = state.componentName;
    const chipPinQuery = state.pinId ? `${state.pinId}@${componentName}` : null;
    const netName = state.netName;

    const nothingToSearch =
      boundOpen.length === 0 &&
      otherPdfNames.length === 0 &&
      otherBoardTabs.length === 0;

    if (nothingToSearch) {
      // Still show the "Search all donors" escape hatch when no PDFs are open.
      return (
        <>
          <div className="context-menu-item disabled">
            Search &apos;{componentName}&apos; in PDF (none open)
          </div>
          {componentName.trim() && (
            <>
              <div className="context-menu-separator" />
              <div
                className="context-menu-item context-menu-search-donors"
                onClick={doSearchAllDonors}
                title={`Search all donor PDFs for '${componentName}'`}
              >
                Search all donors for &apos;{componentName}&apos;
              </div>
            </>
          )}
        </>
      );
    }

    const sections: React.ReactNode[] = [];

    // Helper: emit one donor row for a PDF. The row click triggers the
    // default (component-name) search; the ▸ spoiler (if variants exist)
    // reveals chip@pin and net variants below.
    const pdfRowFor = (name: string, keyPrefix: string) => {
      const short = shortPdfName(name);
      const key = `${keyPrefix}:${name}`;
      const compCount = lookupPdfCount(name, componentName);

      const extras: React.ReactElement[] = [];
      if (chipPinQuery) {
        const ccount = lookupPdfCount(name, chipPinQuery);
        extras.push(renderVariantRow(
          `${key}:chip`, chipPinQuery, ccount,
          (e) => doPdfSearch(e, name, chipPinQuery),
        ));
      }
      if (netName) {
        const ncount = lookupPdfCount(name, netName);
        extras.push(renderVariantRow(
          `${key}:net`, `net ${netName}`, ncount,
          (e) => doPdfSearch(e, name, netName),
        ));
      }

      return renderDonorRow(
        key, 'pdf', short, componentName, compCount,
        (e) => doPdfSearch(e, name, componentName),
        extras,
      );
    };

    // Helper: emit one donor row for a board. Default click = component
    // search; spoiler variants = net (chip@pin is a PDF-text idiom only).
    const boardRowFor = (tab: { id: number; fileName: string }, keyPrefix: string) => {
      const short = shortBoardName(tab.fileName);
      const key = `${keyPrefix}:${tab.id}`;
      const compCount = countInBoardTab(componentName, tab.id);

      const extras: React.ReactElement[] = [];
      if (netName) {
        const ncount = countInBoardTab(netName, tab.id);
        extras.push(renderVariantRow(
          `${key}:net`, `net ${netName}`, ncount,
          (e) => doBoardSearch(e, tab.id, netName),
        ));
      }

      return renderDonorRow(
        key, 'board', short, componentName, compCount,
        (e) => doBoardSearch(e, tab.id, componentName),
        extras,
      );
    };

    const groups: Array<[string, string, React.ReactElement[]]> = [
      ['bound-pdfs', 'Bound PDFs', boundOpen.map(name => pdfRowFor(name, 'bound-pdf'))],
      ['donor-pdfs', 'Donor PDFs', otherDonorPdfNames.map(name => pdfRowFor(name, 'donor-pdf'))],
      ['other-pdfs', 'Other PDFs', otherNonDonorPdfNames.map(name => pdfRowFor(name, 'other-pdf'))],
      ['other-boards', 'Other Boards', otherBoardTabs.map(tab => boardRowFor(tab, 'other-board'))],
    ];
    for (const [key, label, rows] of groups) {
      if (rows.length === 0) continue;
      sections.push(
        <React.Fragment key={key}>
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">{label}</div>
          {rows}
        </React.Fragment>,
      );
    }

    // "Search all donors" escape hatch — opens Library PDF Search with donor scope.
    if (state.componentName.trim()) {
      sections.push(
        <React.Fragment key="search-all-donors">
          <div className="context-menu-separator" />
          <div
            className="context-menu-item context-menu-search-donors"
            onClick={doSearchAllDonors}
            title={`Search all donor PDFs for '${state.componentName}'`}
          >
            Search all donors for &apos;{state.componentName}&apos;
          </div>
        </React.Fragment>,
      );
    }

    return <>{sections}</>;
  };

  // ── PDF right-click body ────────────────────────────────────────────────
  // Only one query available: the text item under the cursor.
  const renderPdfBody = () => {
    if (!state.query) {
      return <div className="context-menu-item disabled">No text at this point</div>;
    }

    // Watermark-filter shortcut. Always shown above the donor-search groups
    // — turns "right-click on the watermark, hide it" into one click.
    const wmFilter = renderSettingsStore.globalSettings.pdfWatermarkFilter ?? [];
    const alreadyWatermark = wmFilter.some(t => t === state.query.trim());
    const wmItem = (
      <div
        key="add-watermark"
        className={`context-menu-item${alreadyWatermark ? ' disabled' : ''}`}
        onClick={alreadyWatermark ? undefined : onAddWatermarkTerm}
        title={alreadyWatermark
          ? 'This text is already a watermark term'
          : 'Hide every occurrence of this text in every open PDF (reparses)'}
      >
        <IconShieldPlus size={14} stroke={1.8} />
        <span style={{ marginLeft: 6 }}>
          {alreadyWatermark
            ? `Watermark filter already includes "${state.query}"`
            : `Hide as watermark — "${state.query}"`}
        </span>
      </div>
    );

    const nothingToSearch =
      boundBoardTabs.length === 0 &&
      otherBoardsForPdf.length === 0 &&
      otherPdfsForPdf.length === 0;

    if (nothingToSearch) {
      return <>{wmItem}<div className="context-menu-separator" /><div className="context-menu-item disabled">Nowhere to search</div></>;
    }

    const sections: React.ReactNode[] = [wmItem];

    // PDF mode has exactly one query per right-click, so donor rows are
    // flat (no spoiler, no variants). Each row = click = jump + search.
    const groups: Array<[string, string, React.ReactElement[]]> = [
      ['bound-boards', 'Bound Boards', boundBoardTabs.map(tab => renderDonorRow(
        `pdf-bound:${tab.id}`, 'board',
        shortBoardName(tab.fileName),
        state.query,
        countInBoardTab(state.query, tab.id),
        (e) => doBoardSearch(e, tab.id, state.query),
      ))],
      ['other-boards', 'Other Boards', otherBoardsForPdf.map(tab => renderDonorRow(
        `pdf-other-board:${tab.id}`, 'board',
        shortBoardName(tab.fileName),
        state.query,
        countInBoardTab(state.query, tab.id),
        (e) => doBoardSearch(e, tab.id, state.query),
      ))],
      ['other-pdfs', 'Other PDFs', otherPdfsForPdf.map(name => renderDonorRow(
        `pdf-other-pdf:${name}`, 'pdf',
        shortPdfName(name),
        state.query,
        lookupPdfCount(name, state.query),
        (e) => doPdfDonorFromPdf(e, name),
      ))],
    ];
    for (const [key, label, rows] of groups) {
      if (rows.length === 0) continue;
      sections.push(
        <React.Fragment key={key}>
          <div className="context-menu-separator" />
          <div className="context-menu-group-header">{label}</div>
          {rows}
        </React.Fragment>,
      );
    }

    // "Search all donors" escape hatch — opens Library PDF Search with donor scope.
    if (state.query.trim()) {
      sections.push(
        <React.Fragment key="search-all-donors">
          <div className="context-menu-separator" />
          <div
            className="context-menu-item context-menu-search-donors"
            onClick={doSearchAllDonors}
            title={`Search all donor PDFs for '${state.query}'`}
          >
            Search all donors for &apos;{state.query}&apos;
          </div>
        </React.Fragment>,
      );
    }

    return <>{sections}</>;
  };

  const header = renderHeader();
  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {header}
      {header && <div className="context-menu-separator" />}
      {state.source === 'board' ? renderBoardBody() : renderPdfBody()}
    </div>
  );
}
