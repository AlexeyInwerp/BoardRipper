import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { ensurePdfPanel } from './dockview-api';
import { log } from './log-store';

/**
 * Open one or more PDF files: register, auto-bind, load into pdf.js, create panels.
 * Shared by Toolbar, App (drag-drop), and LibraryPanel to avoid duplicated logic.
 *
 * @param files   - PDF File objects to open
 * @param options - Optional: activeTabId to bind last PDF to, bindAll to bind each individually
 */
export async function openPdfFiles(
  files: (File | { name: string; arrayBuffer(): Promise<ArrayBuffer> })[],
  options?: {
    activeTabId?: number | null;
    /** If true, bind each PDF to activeTabId (used for explicit user action) */
    bindLastToActive?: boolean;
  },
): Promise<void> {
  if (files.length === 0) return;

  const { activeTabId = boardStore.activeTabId, bindLastToActive = true } = options ?? {};

  // Register and auto-bind all PDFs
  for (const file of files) {
    boardStore.addPdf(file as File);
    boardStore.autoBindPdf(file.name);
  }

  // Explicitly bind the last PDF to the active tab (user intent)
  const lastFile = files[files.length - 1];
  if (bindLastToActive && activeTabId !== null && activeTabId !== undefined) {
    boardStore.addPdfBinding(activeTabId, lastFile.name);
  }

  // Load each PDF and create its panel
  for (const file of files) {
    try {
      await pdfStore.loadFile(file as File);
      ensurePdfPanel(file.name);
    } catch (err) {
      log.ui.error(`Failed to load PDF ${file.name}:`, err);
    }
  }

  // Activate the last PDF's panel
  try {
    pdfStore.switchTo(lastFile.name);
    ensurePdfPanel(lastFile.name);
  } catch (err) {
    log.ui.error(`Failed to activate PDF ${lastFile.name}:`, err);
  }
}
