import { useEffect } from 'react';
import { shortcuts, matchesShortcut } from '../store/keyboard-shortcuts';
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
      // Don't intercept when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.target as HTMLElement)?.isContentEditable) return;

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
            const { showTop, showBottom, butterfly } = boardStore;
            if (butterfly) return;
            if (showTop && showBottom) return;
            e.preventDefault();
            if (showTop) {
              boardStore.selectBottom();
            } else {
              boardStore.selectTop();
            }
            return;
          }

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
    const blockBrowserZoom = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
      }
    };

    // Also block Ctrl+Plus/Minus/0 keyboard zoom
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
