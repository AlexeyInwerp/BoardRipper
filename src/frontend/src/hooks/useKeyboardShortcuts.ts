import { useEffect } from 'react';
import { shortcuts, matchesShortcut, getShortcut } from '../store/keyboard-shortcuts';
import { boardStore } from '../store/board-store';
import { pdfStore } from '../store/pdf-store';
import { viewCommands } from '../store/view-commands';
import { fileInputRefs } from '../store/file-inputs';

/**
 * Global keyboard shortcut handler — attach once in App.
 * Uses shared fileInputRefs set by Toolbar.
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl+F → focus PDF search if a PDF panel is active, otherwise board search
      const focusSearch = getShortcut('focusSearch');
      if (focusSearch && matchesShortcut(e, focusSearch)) {
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
            // When PDF panel is active, Space → fit-to-width instead
            if (fileInputRefs.pdfSearch) {
              e.preventDefault();
              window.dispatchEvent(new Event('pdf-fit-width'));
              return;
            }
            e.preventDefault();
            const { showTop, showBottom, butterfly } = boardStore;
            if (butterfly || (showTop && showBottom)) return;
            if (showTop) boardStore.selectBottom();
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

    document.addEventListener('keydown', handler);
    document.addEventListener('keydown', blockKeyboardZoom);
    document.addEventListener('wheel', blockBrowserZoom, { passive: false });
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('keydown', blockKeyboardZoom);
      document.removeEventListener('wheel', blockBrowserZoom);
    };
  }, []);
}
