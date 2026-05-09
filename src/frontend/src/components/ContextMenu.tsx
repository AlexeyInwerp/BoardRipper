import React, { useEffect, useRef, useSyncExternalStore, useState } from 'react';
import { IconCopy, IconWorld } from '@tabler/icons-react';
import { contextMenuStore } from '../store/context-menu-store';
import type { ContextMenuState } from '../store/context-menu-store';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { ensurePdfPanel } from '../store/dockview-api';
import { fileInputRefs } from '../store/file-inputs';
import { findInBoardTab, countInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge } from './SearchScopeBadge';

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
 *    • A muted top-of-menu header (.context-menu-header) shows what
 *      Copy/Search will act on: "<component> · pin <pinId> · net <netName>"
 *      in board mode, or the cursor text in PDF mode. Hidden when the
 *      relevant fields are empty.
 *    • A top-of-menu icon strip (.context-menu-actions) renders quick
 *      actions built from buildQuickActions(state). Board mode = up to
 *      4 buttons (Copy net, Copy part, Search net, Search part). PDF
 *      mode = up to 2 buttons (Copy, Search Web). The strip is hidden
 *      when buildQuickActions returns []. Donor groups render below.
 * ============================================================================
 */

type QuickActionKind = 'copy' | 'search';
type QuickActionTarget = 'net' | 'part' | 'text';
interface QuickAction {
  kind: QuickActionKind;
  target: QuickActionTarget;
  value: string;
  /** Short label shown next to the icon. Empty string = icon-only (PDF mode). */
  label: string;
}

/** Build the icon-strip action list from the current ContextMenu state.
 *  Order: copy-net, copy-part, search-net, search-part (board);
 *         copy, search (pdf). Skips entries with empty values. */
function buildQuickActions(state: ContextMenuState): QuickAction[] {
  const out: QuickAction[] = [];
  if (state.source === 'board') {
    const compName = state.componentName.trim();
    const netName = state.netName?.trim() ?? '';
    if (netName)  out.push({ kind: 'copy',   target: 'net',  value: netName,  label: 'Net'  });
    if (compName) out.push({ kind: 'copy',   target: 'part', value: compName, label: 'Part' });
    if (netName)  out.push({ kind: 'search', target: 'net',  value: netName,  label: 'Net'  });
    if (compName) out.push({ kind: 'search', target: 'part', value: compName, label: 'Part' });
  } else {
    const q = state.query.trim();
    if (q) {
      // PDF mode has only one target — render icon-only (no label) for compactness.
      out.push({ kind: 'copy',   target: 'text', value: q, label: '' });
      out.push({ kind: 'search', target: 'text', value: q, label: '' });
    }
  }
  return out;
}

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
      // Menu closed — clear the cache so a re-open recomputes.
      setPdfCounts(new Map());
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

  const onCopy = async (action: QuickAction) => {
    contextMenuStore.hide();
    try {
      await navigator.clipboard.writeText(action.value);
      boardStore.addToast(`Copied '${action.value}'`, 'info');
    } catch (err) {
      boardStore.addToast(`Copy failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  };

  const onSearch = (action: QuickAction) => {
    contextMenuStore.hide();
    const url = `https://www.google.com/search?q=${encodeURIComponent(action.value)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  const renderHeader = (): React.ReactElement | null => {
    if (state.source === 'board') {
      const compName = state.componentName.trim();
      if (!compName) return null;
      const pinId = state.pinId?.trim() ?? '';
      const netName = state.netName?.trim() ?? '';
      const parts: string[] = [compName];
      if (pinId) parts.push(`pin ${pinId}`);
      if (netName) parts.push(`net ${netName}`);
      return (
        <div className="context-menu-header" data-testid="context-menu-header">
          {parts.join(' · ')}
        </div>
      );
    }
    const q = state.query.trim();
    if (!q) return null;
    return (
      <div className="context-menu-header" data-testid="context-menu-header">
        {q}
      </div>
    );
  };

  const renderQuickActions = (): React.ReactElement | null => {
    const actions = buildQuickActions(state);
    if (actions.length === 0) return null;
    return (
      <div className="context-menu-actions" data-testid="context-menu-actions">
        {actions.map((a, i) => {
          const Icon = a.kind === 'copy' ? IconCopy : IconWorld;
          const verb = a.kind === 'copy' ? 'Copy' : 'Search';
          const tail = a.kind === 'search' ? ' on the web' : '';
          const title = `${verb} '${a.value}'${tail}`;
          const onClick = (e: React.MouseEvent) => {
            e.stopPropagation();
            if (a.kind === 'copy') onCopy(a); else onSearch(a);
          };
          return (
            <button
              key={`${a.kind}:${a.target}:${i}`}
              className="context-menu-action-btn"
              title={title}
              data-testid={`qa-${a.kind}-${a.target}`}
              onClick={onClick}
            >
              <Icon size={14} />
              {a.label && <span>{a.label}</span>}
            </button>
          );
        })}
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
    const expanded = expandedSpoilers.has(key);
    return (
      <React.Fragment key={key}>
        <div className="context-menu-item context-menu-donor-row" onClick={onDefaultClick}>
          <span>
            <SearchScopeBadge scope={scope} />
            {' '}{donorLabel} | {defaultQuery} ({defaultCount == null ? '…' : defaultCount})
          </span>
          {hasVariants && (
            <span
              className="context-menu-donor-row-arrow"
              onClick={(e) => { e.stopPropagation(); toggleSpoiler(key); }}
            >
              {expanded ? '▾' : '▸'}
            </span>
          )}
        </div>
        {hasVariants && expanded && extraVariants}
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
      return (
        <div className="context-menu-item disabled">
          Search &apos;{componentName}&apos; in PDF (none linked)
        </div>
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
      ['other-pdfs', 'Other PDFs', otherPdfNames.map(name => pdfRowFor(name, 'other-pdf'))],
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

    return <>{sections}</>;
  };

  // ── PDF right-click body ────────────────────────────────────────────────
  // Only one query available: the text item under the cursor.
  const renderPdfBody = () => {
    if (!state.query) {
      return <div className="context-menu-item disabled">No text at this point</div>;
    }

    const nothingToSearch =
      boundBoardTabs.length === 0 &&
      otherBoardsForPdf.length === 0 &&
      otherPdfsForPdf.length === 0;

    if (nothingToSearch) {
      return <div className="context-menu-item disabled">Nowhere to search</div>;
    }

    const sections: React.ReactNode[] = [];

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

    return <>{sections}</>;
  };

  const header = renderHeader();
  const quickActions = renderQuickActions();
  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {header}
      {header && <div className="context-menu-separator" />}
      {quickActions}
      {quickActions && <div className="context-menu-separator" />}
      {state.source === 'board' ? renderBoardBody() : renderPdfBody()}
    </div>
  );
}
