import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { databankStore } from './databank-store';
import { ensurePdfPanel, ensureBoardPanel } from './dockview-api';
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

/** Open a library file (board or PDF) by its databank file id — the
 *  bridge-callable core of LibraryPanel.handleOpenFile, so the MCP `open_file`
 *  tool can bring a library file into the live view. Boards auto-load their
 *  bound (auto_open) schematic PDFs. Returns the opened file's name + type. */
export async function openLibraryFileById(
  fileId: number,
  page?: number,
): Promise<{ name: string; file_type: string }> {
  await databankStore.ensureLoaded();
  const file = databankStore.fileById(fileId);
  if (!file) throw new Error(`file id ${fileId} not in the library index`);
  const fileObj = await databankStore.fetchFileBuffer(file);

  if (file.file_type === 'board') {
    await boardStore.loadFiles([fileObj]);
    const tabId = boardStore.activeTabId;
    if (tabId != null) ensureBoardPanel(tabId, fileObj.name);
    // Auto-load bound (auto_open) PDFs so "open the board" also brings its schematic.
    const detail = await databankStore.fetchFileDetail(file.id);
    for (const binding of detail?.bindings ?? []) {
      if (!binding.auto_open) continue;
      try {
        const pdfFile = databankStore.fileById(binding.pdf_file_id);
        if (!pdfFile) continue;
        const pdfObj = await databankStore.fetchFileBuffer(pdfFile);
        boardStore.addPdf(pdfObj);
        if (tabId != null) boardStore.addPdfBinding(tabId, pdfObj.name);
        await pdfStore.loadFile(pdfObj, pdfFile.id);
        ensurePdfPanel(pdfObj.name);
      } catch (err) {
        log.ui.error('open_file: failed to load bound PDF:', err);
      }
    }
    // Re-activate the board panel so auto-loaded PDFs don't steal focus.
    if (tabId != null) ensureBoardPanel(tabId, fileObj.name);
  } else {
    // PDF (or other) — open via the shared PDF path, then jump to a page.
    await openPdfFiles([fileObj]);
    if (page && page > 0) pdfStore.goToPage(page);
  }
  return { name: fileObj.name, file_type: file.file_type };
}
