import { useEffect } from 'react';
import { shortcuts, matchesShortcut, getShortcut } from '../store/keyboard-shortcuts';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { viewCommands } from '../store/view-commands';
import { fileInputRefs } from '../store/file-inputs';
import { ensurePdfPanel, getDockviewApi } from '../store/dockview-api';
import { openBoardSearch } from '../panels/board-viewer-bridge';
import { focusBoardSearchInput } from '../components/BoardSidebar.utils';
import { toggleLibrarySidebar } from '../components/Sidebar.utils';
import { copyText } from '../clipboard';

/**
 * Global keyboard shortcut handler — attach once in App.
 * Uses shared fileInputRefs set by Toolbar.
 */
function activePanelKind(): 'board' | 'pdf' | null {
  const id = getDockviewApi()?.activePanel?.id ?? '';
  if (id.startsWith('board-')) return 'board';
  if (id.startsWith('pdf-')) return 'pdf';
  return null;
}

// Track last known cursor position for context-sensitive shortcuts
let _lastMouseX = 0;
let _lastMouseY = 0;

/**
 * Hold-to-peek state for Space-flip:
 *   - keydown records the original side + a timestamp and flips immediately.
 *   - keyup checks the duration: under SPACE_HOLD_PEEK_MS = tap (keep flipped);
 *     at or over = hold (revert to the original side).
 *
 * 180 ms balances: a deliberate tap is well under it (~60 ms typical), and a
 * "peek" gesture naturally lingers above it. Browsers fire `e.repeat=true` at
 * roughly the autorepeat rate (~30 ms intervals after a ~500 ms initial
 * delay), so any autorepeat we see is well past the threshold and gated out
 * by the `_spaceFlipPress` presence check.
 */
const SPACE_HOLD_PEEK_MS = 180;
let _spaceFlipPress: { wasUiTopVisible: boolean; pressedAt: number } | null = null;

/** Text to copy for the active board tab's current selection, mirroring the
 *  Cmd/Ctrl+F prefill priority: a selected pin yields its net (or, when the
 *  pin carries no net, a `part-pin` reference); a part-only selection yields
 *  the component name; a net-only selection yields the net name. Returns null
 *  when nothing is selected. */
function copySelectionText(): string | null {
  const sel = boardStore.selection;
  const part = boardStore.selectedPart;
  const pin = boardStore.selectedPin;
  if (sel.pinIndex != null && sel.pinIndex >= 0 && pin) {
    if (pin.net) return pin.net;
    const label = pin.number || pin.name;
    if (part && label) return `${part.name}-${label}`;
    return label || part?.name || null;
  }
  if (part) return part.name;
  if (sel.highlightedNet) return sel.highlightedNet;
  return null;
}

export function useKeyboardShortcuts() {
  useEffect(() => {
    const trackMouse = (e: MouseEvent) => { _lastMouseX = e.clientX; _lastMouseY = e.clientY; };
    document.addEventListener('mousemove', trackMouse, { passive: true });

    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F — routing:
      //   1. Active board tab has a linked PDF → activate the PDF panel, prefill
      //      its search with the selected component/net name (if any), focus it.
      //   2. A PDF panel is already active (ref set) → focus its search.
      //   3. Otherwise → fall back to top-bar board search.
      const focusSearch = getShortcut('focusSearch');
      // Match focusSearch with OR without shift — the block below routes
      // shift to prevMatch and unshifted to nextMatch. The matcher's
      // symmetric shift-guard otherwise rejects Shift+Cmd+F outright.
      const focusSearchMatch = focusSearch && (
        matchesShortcut(e, focusSearch) ||
        matchesShortcut(e, { ...focusSearch, shift: true })
      );
      if (focusSearch && focusSearchMatch) {
        // Standard behavior: if the PDF search field is already focused with a
        // query, repeat Cmd+F steps to the next match (Shift reverses direction).
        if (fileInputRefs.pdfSearch
            && document.activeElement === fileInputRefs.pdfSearch
            && fileInputRefs.pdfSearch.value.trim()) {
          e.preventDefault();
          if (e.shiftKey) pdfStore.prevMatch();
          else pdfStore.nextMatch();
          return;
        }

        const tab = boardStore.activeTab;
        const linkedPdf = tab?.pdfFileNames?.[0];
        const sel = tab?.selection;
        const partIdx = sel?.partIndex;
        const selectedPart = (partIdx != null && tab?.board)
          ? tab.board.parts[partIdx]
          : null;
        // Priority: pin-selected (→ net name) > part-only (→ component name) > net-only
        // From board panel context. For PDF panel context, override below.
        let prefillText: string | null = null;
        if (sel?.pinIndex != null && sel.pinIndex >= 0 && sel.highlightedNet) {
          prefillText = sel.highlightedNet;
        } else if (selectedPart) {
          prefillText = selectedPart.name;
        } else if (sel?.highlightedNet) {
          prefillText = sel.highlightedNet;
        }

        // If the currently active dockview panel is a PDF panel, prefer its
        // last-clicked word over the board selection.
        const api = getDockviewApi();
        const activePanelId = api?.activePanel?.id ?? '';
        const activePdfFile: string | null = activePanelId.startsWith('pdf-')
          ? (api?.activePanel?.params as { pdfFileName?: string } | undefined)?.pdfFileName ?? null
          : null;
        if (activePdfFile) {
          const pdfClicked = pdfStore.lastClickedWord;
          if (pdfClicked) prefillText = pdfClicked;
        }

        // Board panel active with NO selection → open BoardSidebar search tab.
        // Board panel active WITH selection → fall through to PDF lookup.
        if (activePanelId.startsWith('board-') && !prefillText) {
          e.preventDefault();
          const tabIdStr = activePanelId.slice('board-'.length);
          const boardTabId = parseInt(tabIdStr, 10);
          openBoardSearch('', isNaN(boardTabId) ? undefined : boardTabId);
          focusBoardSearchInput();
          return;
        }

        // Route target PDF: if a PDF panel is the active dockview panel, use
        // THAT panel's PDF — even if the board tab has a different linked PDF.
        // Cmd+F must always focus the search field of the tab the user is in.
        const targetPdf = activePdfFile ?? linkedPdf ?? null;

        if (targetPdf) {
          e.preventDefault();
          ensurePdfPanel(targetPdf);
          pdfStore.switchTo(targetPdf);
          if (prefillText) {
            pdfStore.searchText(prefillText, 'lookup');
          }
          // Wait a tick for the PDF panel's onDidActiveChange effect to register
          // searchInputRef.current into fileInputRefs.pdfSearch.
          setTimeout(() => {
            const input = fileInputRefs.pdfSearch;
            if (!input) return;
            if (prefillText) input.value = prefillText;
            input.focus();
            input.select();
          }, 0);
          return;
        }

        if (fileInputRefs.pdfSearch) {
          e.preventDefault();
          fileInputRefs.pdfSearch.focus();
          fileInputRefs.pdfSearch.select();
          return;
        }
        if (fileInputRefs.search) {
          e.preventDefault();
          fileInputRefs.search.focus();
          fileInputRefs.search.select();
          return;
        }
      }

      // Don't intercept when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

      // Tab — jump between active board panel and its linked PDF (both directions).
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const api = getDockviewApi();
        const activeId = api?.activePanel?.id ?? '';
        if (activeId.startsWith('board-')) {
          const linked = boardStore.activeTab?.pdfFileNames?.[0];
          if (linked) {
            e.preventDefault();
            ensurePdfPanel(linked);
            pdfStore.switchTo(linked);
          }
          return;
        }
        if (activeId.startsWith('pdf-')) {
          const activeTabId = boardStore.activeTabId;
          if (activeTabId != null) {
            const boardPanel = api?.getPanel('board-' + activeTabId);
            if (boardPanel) {
              e.preventDefault();
              boardPanel.api.setActive();
            }
          }
          return;
        }
      }

      // Arrow keys in PDF context: navigate matches if they exist, otherwise scroll pages
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        if (pdfStore.matches.length > 0) {
          if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
            e.preventDefault();
            pdfStore.nextMatch();
            return;
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
            e.preventDefault();
            pdfStore.prevMatch();
            return;
          }
        } else if (fileInputRefs.pdfSearch) {
          // No search matches — arrow up/down scroll PDF pages
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            pdfStore.goToPage(pdfStore.currentPage + 1);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            pdfStore.goToPage(pdfStore.currentPage - 1);
            return;
          }
        }
      }

      for (const shortcut of shortcuts) {
        if (!matchesShortcut(e, shortcut)) continue;

        switch (shortcut.id) {
          case 'openBoard':
            e.preventDefault();
            fileInputRefs.board?.click();
            return;

          case 'openPdf':
            e.preventDefault();
            fileInputRefs.pdf?.click();
            return;

          case 'flipBoard': {
            // Cursor over a PDF panel → fit-to-width; otherwise → flip board.
            // The PDF path is tap-only — no peek/hold semantics for fit-width.
            const hovered = document.elementFromPoint(_lastMouseX, _lastMouseY);
            if (hovered?.closest('.pdf-viewer')) {
              e.preventDefault();
              window.dispatchEvent(new Event('pdf-fit-width'));
              return;
            }
            e.preventDefault();
            // Autorepeat or second-keydown-without-keyup → already flipped on
            // the first keydown, ignore subsequent firings until keyup. Without
            // this gate, holding Space would re-flip every autorepeat tick.
            if (e.repeat || _spaceFlipPress) return;
            const { showTop, showBottom, butterfly, board } = boardStore;
            if (butterfly || (showTop && showBottom)) return;
            // selectTop/selectBottom already swap raw flags for primarySide='bottom'
            // files. Read state in UI perspective (what the user sees as "Top") so
            // the toggle flips both kinds of files identically.
            const swap = board?.primarySide === 'bottom';
            const uiTopVisible = swap ? showBottom : showTop;
            _spaceFlipPress = { wasUiTopVisible: uiTopVisible, pressedAt: performance.now() };
            if (uiTopVisible) boardStore.selectBottom();
            else boardStore.selectTop();
            return;
          }

          case 'pdfFitWidth':
            // Handled via flipBoard case above (same key, context-dependent)
            break;

          case 'rotateCW':
            e.preventDefault();
            boardStore.rotateCW();
            return;
          case 'rotateCCW':
            e.preventDefault();
            boardStore.rotateCCW();
            return;
          case 'mirrorBoard':
            e.preventDefault();
            boardStore.flipHorizontal();
            return;

          case 'panLeft':
            e.preventDefault();
            viewCommands.pan('left');
            return;
          case 'panRight':
            e.preventDefault();
            viewCommands.pan('right');
            return;
          case 'panUp':
            e.preventDefault();
            viewCommands.pan('up');
            return;
          case 'panDown':
            e.preventDefault();
            viewCommands.pan('down');
            return;

          case 'pageDown':
            e.preventDefault();
            pdfStore.goToPage(pdfStore.currentPage + 1);
            return;
          case 'pageUp':
            e.preventDefault();
            pdfStore.goToPage(pdfStore.currentPage - 1);
            return;

          case 'panBoardLeft':
          case 'panBoardRight':
          case 'panBoardUp':
          case 'panBoardDown': {
            const kind = activePanelKind();
            if (kind === null) return;
            e.preventDefault();
            const dir = shortcut.id === 'panBoardLeft'  ? 'left'
                      : shortcut.id === 'panBoardRight' ? 'right'
                      : shortcut.id === 'panBoardUp'    ? 'up'
                      : 'down';
            if (kind === 'board') {
              viewCommands.pan(dir);
            } else {
              window.dispatchEvent(new CustomEvent('pdf-pan', { detail: { direction: dir } }));
            }
            return;
          }

          case 'rotateBoardCCW':
          case 'rotateBoardCW': {
            const kind = activePanelKind();
            if (kind === null) return;
            // PDFs do not rotate — silently no-op when active panel is PDF.
            if (kind === 'pdf') { e.preventDefault(); return; }
            e.preventDefault();
            if (shortcut.id === 'rotateBoardCCW') boardStore.rotateCCW();
            else boardStore.rotateCW();
            return;
          }

          case 'zoomBoardIn':
          case 'zoomBoardOut': {
            const kind = activePanelKind();
            if (kind === null) return;
            e.preventDefault();
            const dir = shortcut.id === 'zoomBoardIn' ? 'in' : 'out';
            if (kind === 'board') {
              viewCommands.zoom(dir);
            } else {
              window.dispatchEvent(new CustomEvent('pdf-zoom', { detail: { direction: dir } }));
            }
            return;
          }

          case 'toggleLibrary': {
            const kind = activePanelKind();
            if (kind === null) return;
            e.preventDefault();
            toggleLibrarySidebar();
            return;
          }

          case 'copySelection': {
            // Only act when a board panel is active. Anywhere else, let the
            // browser's native copy proceed (we never preventDefault).
            if (activePanelKind() !== 'board') return;
            // If the user has highlighted text (e.g. in the NetList or Info
            // panel), don't hijack — let the native copy take it verbatim.
            if ((window.getSelection?.()?.toString() ?? '').trim()) return;
            const text = copySelectionText();
            if (!text) return;
            e.preventDefault();
            copyText(text).then(
              () => boardStore.addToast(`Copied '${text}'`, 'info'),
              (err) => boardStore.addToast(
                `Copy failed: ${err instanceof Error ? err.message : String(err)}`, 'error'),
            );
            return;
          }
        }
      }
    };

    // Block browser page zoom (Ctrl+wheel on Win/Linux, Cmd+wheel / pinch on Mac).
    // The board viewport (pixi-viewport) and PDF panel handle their own zoom already;
    // we just need to stop the browser from scaling the entire page.
    // Only block browser zoom when pointer is over a canvas (board or PDF viewer).
    // This preserves Ctrl+wheel page zoom in settings, debug, and other non-canvas panels.
    const blockBrowserZoom = (e: WheelEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.target instanceof HTMLCanvasElement)) {
        e.preventDefault();
      }
    };

    // Block Ctrl+Plus/Minus/0 keyboard zoom only when a canvas-based panel is focused
    const blockKeyboardZoom = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0')) {
        e.preventDefault();
      }
    };

    // Space-flip release: tap → keep flipped, hold → revert to original side.
    // Mirrors the keydown side of the flipBoard case above; lives outside it
    // so it can fire on the same document(s) regardless of which one received
    // the keydown (popout windows share the same module-level press state).
    const spaceKeyupHandler = (e: KeyboardEvent) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      const press = _spaceFlipPress;
      if (!press) return;
      _spaceFlipPress = null;
      const heldMs = performance.now() - press.pressedAt;
      if (heldMs < SPACE_HOLD_PEEK_MS) return; // tap: keep flipped state
      // Hold: restore the side that was visible before the press.
      if (press.wasUiTopVisible) boardStore.selectTop();
      else boardStore.selectBottom();
    };
    // Window blur safety net: if focus leaves the page mid-hold (e.g. the
    // user alt-tabs), we'll never get keyup. Discard the press state so the
    // next tap isn't ignored as "autorepeat". Don't revert — the user may
    // come back and release Space normally; reverting now would surprise
    // them.
    const spaceBlurHandler = () => { _spaceFlipPress = null; };

    document.addEventListener('keydown', handler);
    document.addEventListener('keyup', spaceKeyupHandler);
    document.addEventListener('keydown', blockKeyboardZoom);
    document.addEventListener('wheel', blockBrowserZoom, { passive: false });
    window.addEventListener('blur', spaceBlurHandler);

    // Also attach to every Dockview popout window's document so shortcuts
    // fire when focus is inside the detached PDF window. (2-window mode.)
    // Popouts share the parent's JS context, so the same `handler` closure
    // works — we just need it bound to the popout's document.
    const popoutDocs = new Set<Document>();
    const attachToPopout = (doc: Document) => {
      if (popoutDocs.has(doc)) return;
      doc.addEventListener('keydown', handler);
      doc.addEventListener('keyup', spaceKeyupHandler);
      doc.addEventListener('mousemove', trackMouse, { passive: true });
      popoutDocs.add(doc);
    };
    const detachFromPopout = (doc: Document) => {
      doc.removeEventListener('keydown', handler);
      doc.removeEventListener('keyup', spaceKeyupHandler);
      doc.removeEventListener('mousemove', trackMouse);
      popoutDocs.delete(doc);
    };
    const scanPopouts = () => {
      const api = getDockviewApi();
      if (!api) return;
      for (const group of api.groups) {
        if (group.api.location.type === 'popout') {
          attachToPopout(group.api.location.getWindow().document);
        }
      }
    };
    scanPopouts();
    const scanInterval = setInterval(scanPopouts, 500);

    return () => {
      document.removeEventListener('mousemove', trackMouse);
      document.removeEventListener('keydown', handler);
      document.removeEventListener('keyup', spaceKeyupHandler);
      document.removeEventListener('keydown', blockKeyboardZoom);
      document.removeEventListener('wheel', blockBrowserZoom);
      window.removeEventListener('blur', spaceBlurHandler);
      clearInterval(scanInterval);
      for (const doc of Array.from(popoutDocs)) detachFromPopout(doc);
    };
  }, []);
}
