import React, { useEffect, useRef, useSyncExternalStore, useState } from 'react';
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
 *          [scope-badge] <donor-short-name> (<default-count>)   [▸]
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

  // ── Row renderers ────────────────────────────────────────────────────────
  /** Default-action donor row:
   *      [badge] <donorLabel> (<defaultCount>)    [▸]
   *
   *  Clicking the row itself triggers the default lookup (component-name
   *  search, or in PDF mode the query text). If `extraVariants` is
   *  non-empty, a ▸/▾ spoiler arrow appears; clicking it toggles inline
   *  variant rows below. Row stays clickable regardless of spoiler state.
   *
   *  Zero-count rows are still clickable — user may want to jump and tweak. */
  const renderDonorRow = (
    key: string,
    scope: 'board' | 'pdf',
    donorLabel: string,
    defaultCount: number,
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
            {' '}{donorLabel} ({defaultCount})
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
    count: number,
    onClick: (e: React.MouseEvent) => void,
  ): React.ReactElement => (
    <div
      key={key}
      className="context-menu-item context-menu-variant-row"
      onClick={onClick}
    >
      {queryLabel} ({count})
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
      const compCount = pdfStore.countTextMatches(name, componentName.toLowerCase());

      const extras: React.ReactElement[] = [];
      if (chipPinQuery) {
        const ccount = pdfStore.countTextMatches(name, chipPinQuery.toLowerCase());
        extras.push(renderVariantRow(
          `${key}:chip`, chipPinQuery, ccount,
          (e) => doPdfSearch(e, name, chipPinQuery),
        ));
      }
      if (netName) {
        const ncount = pdfStore.countTextMatches(name, netName.toLowerCase());
        extras.push(renderVariantRow(
          `${key}:net`, `net ${netName}`, ncount,
          (e) => doPdfSearch(e, name, netName),
        ));
      }

      return renderDonorRow(
        key, 'pdf', short, compCount,
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
        key, 'board', short, compCount,
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
        countInBoardTab(state.query, tab.id),
        (e) => doBoardSearch(e, tab.id, state.query),
      ))],
      ['other-boards', 'Other Boards', otherBoardsForPdf.map(tab => renderDonorRow(
        `pdf-other-board:${tab.id}`, 'board',
        shortBoardName(tab.fileName),
        countInBoardTab(state.query, tab.id),
        (e) => doBoardSearch(e, tab.id, state.query),
      ))],
      ['other-pdfs', 'Other PDFs', otherPdfsForPdf.map(name => renderDonorRow(
        `pdf-other-pdf:${name}`, 'pdf',
        shortPdfName(name),
        pdfStore.countTextMatches(name, state.query.toLowerCase()),
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

  return (
    <div
      className="context-menu"
      ref={menuRef}
      style={{ left: state.screenX, top: state.screenY }}
      onClick={(e) => e.stopPropagation()}
    >
      {state.source === 'board' ? renderBoardBody() : renderPdfBody()}
    </div>
  );
}
