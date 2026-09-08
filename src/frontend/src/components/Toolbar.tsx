import { useRef, useEffect, useState, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { IconBoxMultiple, IconLayoutBoardSplit, IconUpload, IconDownload, IconInfoCircle } from '@tabler/icons-react';
import { boardStore } from '../store/board-store';
import { useBoardStore } from '../hooks/useBoardStore';
import { useUpdateStore } from '../hooks/useUpdateStore';
import { showSidebarTab } from './Sidebar.utils';
import { SidebarCycleButton } from './SidebarCycleButton';
import { getAllExtensions, getFileExtension } from '../parsers';
import { fileInputRefs } from '../store/file-inputs';
import { openPdfFiles } from '../store/file-actions';
import { updateStore, fmtVersion } from '../store/update-store';
import { ReleaseNotes } from './ReleaseNotes';
import { pdfStore } from '../store/pdf-store';
import { databankStore, isElectron } from '../store/databank-store';
import { isLiteBuild, isOfflineBuild } from '../store/build-mode';

/** Touch-first device (tablet). Evaluated once — the primary pointer of a
 *  device does not change while the page is open. */
const COARSE_POINTER = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;
import { setLibrarySearch } from '../panels/LibraryPanel';
import { countInBoardTab, countInPdf, findInBoardTab, findInPdf } from '../store/cross-target-search';
import { SearchScopeBadge, type SearchScope } from './SearchScopeBadge';
import { isTwoWindowMode, toggleTwoWindowMode, onTwoWindowModeChange } from '../store/two-window-mode';

declare const __APP_VERSION__: string;

/** Display a version string with exactly one leading `v`. The backend's
 *  Version (release.sh tag, e.g. "v0.31.18") already carries the prefix, so
 *  the old `v${state.current_version}` rendered "vv0.31.18". Non-numeric
 *  builds like "dev" are shown verbatim (no spurious "vdev"). */

/** Hosted lite build only: download the single self-contained offline copy
 *  (boardripper-lite.html). Sits in the top-right slot where the self-update
 *  badge lives on the backend build. Relative href so it resolves under the
 *  /boardripper/web/ sub-path. Hidden in the offline file itself (you can't
 *  re-download it while running from file://). */
function DownloadOfflineButton() {
  return (
    <a
      className="toolbar-btn"
      href="./boardripper-lite.html"
      download="boardripper-lite.html"
      data-testid="download-offline"
      title="Download BoardRipper as a single offline HTML file — save it to your computer and open it in any browser, no internet needed."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}
    >
      <IconDownload size={15} stroke={2} />
      Offline copy
    </a>
  );
}

/** Small (i) next to the update badge: who wrote this, what it is, and where
 *  to support it. Renders in every build (lite/offline/Electron included) —
 *  unlike the update badge, which is backend-only — because this is the one
 *  always-visible place the project introduces itself. The long version lives
 *  in Settings ▸ About; keep the two in step, and both in step with the
 *  "Support the project" section on landing/index.html. */
function InfoBadge() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click — same pattern as UpdateBadge.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="update-badge-wrap" ref={ref}>
      <button
        data-testid="info-badge"
        className={`toolbar-btn toolbar-info-badge${open ? ' active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="About BoardRipper"
        aria-label="About BoardRipper"
      >
        <IconInfoCircle size={15} stroke={2} />
      </button>

      {open && (
        <div className="update-dropdown info-dropdown">
          <div className="update-dropdown-header">
            <div className="update-dropdown-header-main">
              <span>BoardRipper {fmtVersion(__APP_VERSION__)}</span>
            </div>
            <button className="update-dropdown-close" onClick={() => setOpen(false)}>x</button>
          </div>
          <div className="update-dropdown-body info-dropdown-body">
            <p>
              Built as a tool for my own repair shop, then shared once it turned out
              useful. Free software under AGPL-3.0 — no accounts, no paywall, no
              telemetry; your boards stay on your machine.
            </p>
            <p className="info-dropdown-author">by Alexey Lavrov — RipperDoc, Munich</p>
            <p>
              Development runs about €100 a month in AI tokens out of my own pocket.
              If BoardRipper is useful to you, support is genuinely appreciated.
            </p>
            <div className="info-dropdown-links">
              <a href="https://buymeacoffee.com/inwerp" target="_blank" rel="noopener noreferrer"
                className="info-dropdown-donate">Buy me a coffee</a>
              <a href="https://www.ripperdoc.de/boardripper/" target="_blank" rel="noopener noreferrer">Website</a>
              <a href="https://github.com/AlexeyInwerp/BoardRipper" target="_blank" rel="noopener noreferrer">Source</a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

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
  // A mirror is publishing a release this build cannot verify — almost always a
  // rotated signing key, but indistinguishable from a hostile mirror, which is
  // why nothing below is rendered from the manifest itself.
  const unverified = state.signature_mismatch === true && !state.has_update;
  // Release notes for an available update, embedded in the signed manifest.
  // Empty (→ spoiler not shown) when the manifest carries no notes.
  const pendingNotes = (state.has_update && manifest?.notes) ? manifest.notes : '';
  // Notes for the version RUNNING right now. The whole point: after the update
  // lands, has_update flips false and the pending notes go away — this is what
  // keeps "what changed" readable afterwards. Null when we have never seen a
  // manifest for this version (bundle install / dev build).
  const installed = update.installed;

  return (
    <div className="update-badge-wrap" ref={ref}>
      <button
        data-testid="update-badge"
        className={`toolbar-btn toolbar-update-badge${state.has_update ? ' has-update' : ''}${isImportant ? ' is-important' : ''}${unverified ? ' is-unverified' : ''}${updating ? ' is-updating' : ''}`}
        onClick={() => {
          // Mid-update the badge becomes a shortcut to the live progress
          // view: jump straight to the Debug tab instead of opening the
          // dropdown (which would show stale "Update & Restart" actions).
          if (updating) { showSidebarTab('debug'); return; }
          if (!open) updateStore.check();
          setOpen(v => !v);
        }}
        title={updating ? 'Updating — see Debug tab' : unverified ? 'Update available — manual install required (signature not verifiable by this build)' : state.has_update ? (isImportant ? `Important update: ${fmtVersion(state.latest_version)}` : `Update available: ${fmtVersion(state.latest_version)}`) : `${fmtVersion(state.current_version)} — click to check`}
      >
        {updating ? 'Updating…' : state.has_update ? fmtVersion(state.latest_version) : fmtVersion(state.current_version)}
      </button>

      {open && (
        <div className={`update-dropdown${isImportant && state.has_update ? ' update-dropdown-important' : ''}`}>
          <div className="update-dropdown-header">
            <div className="update-dropdown-header-main">
              <span>{state.has_update ? (isImportant ? 'Important update' : 'Update available') : fmtVersion(state.current_version)}</span>
              {state.has_update && <span className="update-dropdown-version-tag">{fmtVersion(manifest?.version || state.latest_version)}</span>}
            </div>
            {isImportant && manifest?.important_reason && (
              <span className="update-dropdown-important-reason">{manifest.important_reason}</span>
            )}
            <button className="update-dropdown-close" onClick={() => setOpen(false)}>x</button>
          </div>

          {pendingNotes && (
            <details className="update-dropdown-notes" data-testid="update-whats-new">
              <summary>What&apos;s new in {fmtVersion(manifest?.version || state.latest_version)}</summary>
              <div className="update-dropdown-body">
                <ReleaseNotes notes={pendingNotes} />
              </div>
            </details>
          )}

          {!state.has_update && !updating && (
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

          {unverified && (
            <div className="update-dropdown-unverified" data-testid="update-unverified">
              <p><b>Update available &mdash; manual install required</b></p>
              <p>
                A newer release is published, but this build cannot verify its
                signature, so it will not install it automatically.
              </p>
              <p>
                This normally means the release signing key has been rotated.
                Rotating the key is a security measure, and your install only
                trusts the key it was built with &mdash; that refusal is exactly
                what stops anyone else pushing an update to it.
              </p>
              <p>To update, pull the new image yourself:</p>
              <code>docker compose pull{'\n'}docker compose up -d</code>
              <p>
                The current signing key is published at{' '}
                <a
                  href="https://www.ripperdoc.de/boardripper/"
                  target="_blank"
                  rel="noopener noreferrer"
                >ripperdoc.de/boardripper</a>, so you can confirm the release is
                the maintainer&rsquo;s before installing it.
              </p>
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
                  {fmtVersion(state.current_version)} &#8594; {fmtVersion(state.latest_version)}
                </span>
              </div>
            </div>
          )}

          {/* What the version you are RUNNING brought. Sits below the actions
              and carries its own version in the summary, so it can never be
              mistaken for the pending release's notes above. */}
          {installed && !updating && (
            <details className="update-dropdown-notes" data-testid="update-installed-notes">
              <summary>
                What&apos;s new in {fmtVersion(installed.version)}
                {state.has_update && <span className="update-dropdown-yours"> · yours</span>}
              </summary>
              <div className="update-dropdown-body">
                <ReleaseNotes notes={installed.notes} />
                {installed.notes_url && (
                  <a
                    className="update-dropdown-notes-link"
                    href={installed.notes_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Full release notes ↗
                  </a>
                )}
              </div>
            </details>
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

  // Register search input ref for Cmd+F shortcut. Capture inputRef.current in
  // a local at effect-run time so the cleanup compares against the same
  // element we registered — React 19 may clear the ref before the cleanup
  // fires, which would otherwise leave the stale registration behind.
  useEffect(() => {
    const el = inputRef.current;
    fileInputRefs.search = el;
    return () => { if (fileInputRefs.search === el) fileInputRefs.search = null; };
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
        placeholder="Search parts, nets, PDFs, library"
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
  const { activeTabId } = useBoardStore();
  const [twoWindow, setTwoWindow] = useState(isTwoWindowMode());
  useEffect(() => onTwoWindowModeChange(() => setTwoWindow(isTwoWindowMode())), []);

  const update = useUpdateStore();

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

  // Delegated, viewport-clamped tooltip for [data-tooltip] buttons. Replaces a
  // pure-CSS ::after, which couldn't clamp and spilled off-screen for buttons
  // near the toolbar's right/left edge.
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const showTip = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-tooltip]') as HTMLElement | null;
    const text = el?.getAttribute('data-tooltip');
    if (!el || !text) return;
    const r = el.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2, y: r.bottom + 8 });
  }, []);
  const hideTip = useCallback((e: React.MouseEvent) => {
    const from = (e.target as HTMLElement).closest('[data-tooltip]');
    const to = e.relatedTarget instanceof HTMLElement ? e.relatedTarget.closest('[data-tooltip]') : null;
    if (from && from !== to) setTip(null);
  }, []);

  // After render, nudge the tooltip back inside the viewport (horizontal clamp;
  // flip above the button if it would overflow the bottom).
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!el || !tip) return;
    const pad = 8;
    el.style.left = `${tip.x}px`;
    el.style.top = `${tip.y}px`;
    el.style.transform = 'translateX(-50%)';
    const r = el.getBoundingClientRect();
    let dx = 0;
    if (r.right > window.innerWidth - pad) dx = (window.innerWidth - pad) - r.right;
    else if (r.left < pad) dx = pad - r.left;
    if (dx) el.style.transform = `translateX(calc(-50% + ${Math.round(dx)}px))`;
    if (r.bottom > window.innerHeight - pad) el.style.top = `${tip.y - r.height - 16}px`;
  }, [tip]);

  return (
    <div className="toolbar" data-testid="toolbar" onMouseOver={showTip} onMouseOut={hideTip}>
      {tip && createPortal(
        <div
          ref={tipRef}
          className="toolbar-tooltip"
          style={{ position: 'fixed', left: tip.x, top: tip.y, transform: 'translateX(-50%)' }}
        >
          {tip.text}
        </div>,
        document.body,
      )}
      <input
        ref={fileInputRef}
        type="file"
        /* NO `accept` in the browser — deliberate, and load-bearing on iPad.
         *
         * Safari resolves each `accept` extension token to a UTI. `.pdf` maps
         * to com.adobe.pdf; every board extension we support (`.pcb`, `.bvr`,
         * `.fz`, `.brd`, `.tvw`, `.kicad_pcb`, …) is unregistered on iOS, so it
         * resolves to a dynamic UTI that matches nothing. The Files picker then
         * greys out every board file and offers PDFs only — which on a tablet,
         * where there is no drag-and-drop, means the app cannot open a board at
         * all. Android pickers degrade the same way for extensions with no MIME
         * mapping.
         *
         * Filtering buys nothing here anyway: `detectFormat` sniffs header
         * bytes and only falls back to the extension, and drag-and-drop has
         * never filtered. Electron keeps the list — a native dialog resolves
         * these extensions correctly and gives the user a real "All Files"
         * escape, so there the filter is help rather than a wall. */
        {...(isElectron() ? { accept: [...getAllExtensions(), '.pdf'].join(',') } : {})}
        multiple
        onChange={handleFileChange}
        style={{ display: 'none' }}
        data-testid="file-input"
      />
      {/* ── App bar (v0.39): the bar is about the app, the board's own bar is
          about the board. Sidebar cycle and Open on the left, search in the
          centre, window mode / about / version on the right. Side, rotate,
          mirror, butterfly and traces live in the board ribbon now — same
          store actions, same shortcuts, only the button's home moved. ── */}
      <SidebarCycleButton />
      <button
        onClick={handleFileOpen}
        className="toolbar-btn toolbar-quiet"
        data-testid="open-btn"
        data-tooltip={isElectron() ? 'Open boards or PDFs' : 'Open boards or PDFs from your device'}
      >
        <IconUpload size={15} stroke={1.75} />Open
      </button>

      {/* ── Search, centred ── */}
      <div className="toolbar-spacer" />
      <GlobalSearch />
      <div className="toolbar-spacer" />

      {/* Pop-out needs a real second window. The offline single file has no
       *  popout.html to open, and a tablet's window.open is a new tab (iPadOS)
       *  or nothing — so the control is hidden where it can only fail. Read
       *  once at render: the pointer type does not change. */}
      {!isOfflineBuild() && !COARSE_POINTER && (
        <button
          onClick={() => toggleTwoWindowMode()}
          className={`toolbar-btn toolbar-quiet toolbar-btn-icon ${twoWindow ? 'active' : ''}`}
          data-testid="two-window-toggle"
          data-tooltip={twoWindow
            ? '2-window mode ON — click to re-dock PDF into main window'
            : '2-window mode — detach PDF viewer into its own window'}
        >
          {twoWindow
            ? <IconBoxMultiple size={15} stroke={1.75} />
            : <IconLayoutBoardSplit size={15} stroke={1.75} />}
        </button>
      )}

      {/* "Save as BVR3" was a permanently-disabled placeholder (export path
          still has a side-inversion bug). Dead chrome trains users to ignore
          the toolbar — removed until the feature actually ships, at which
          point it belongs in an overflow menu. exportToBVR3 stays in parsers. */}

      <InfoBadge />
      {!isElectron() && !isLiteBuild() && <UpdateBadge update={update} />}
      {isLiteBuild() && !isOfflineBuild() && <DownloadOfflineButton />}
    </div>
  );
}
