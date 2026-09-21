import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { databankStore, type DatabankFile } from './databank-store';
import { ensurePdfPanel, ensureBoardPanel } from './dockview-api';
import { loadBoardWithAscSiblings } from './asc-open';
import { log } from './log-store';
import { boardCache } from './board-cache';
import { folderLibrary } from './folder-library';

/**
 * Open a local-folder file from what is already in the browser, without
 * touching the folder.
 *
 * This is what keeps a backend-free library from asking for the folder on
 * every run. The parsed-board cache and the PDF byte cache are keyed on
 * `name:size:lastModified`, and the folder index carries all three — so a
 * board opened once reopens for good, even when the folder itself is out of
 * reach (Safari and the iPad cannot persist a directory handle at all, and
 * Chromium drops the grant when the last tab closes).
 *
 * Only used while the folder is NOT readable: with access in hand, reading
 * the file is cheap and cannot serve a stale copy.
 */
export async function openFolderFileFromCache(file: DatabankFile): Promise<boolean> {
  if (!databankStore.folderMode || folderLibrary.readable) return false;
  const ms = file.mod_time_ms ?? file.mod_time * 1000;

  if (file.file_type === 'board') {
    const opened = await boardStore.loadFromCache(file.filename, file.size, ms);
    if (!opened) return false;
    const tabId = boardStore.activeTabId;
    if (tabId != null) ensureBoardPanel(tabId, boardStore.activeTab?.fileName ?? file.filename);
    log.ui.log(`opened "${file.filename}" from the board cache — the folder was not needed`);
    return true;
  }

  const bytes = await boardCache.getPdfBytes(file.filename, file.size, ms);
  if (!bytes) return false;
  await openPdfFiles([new File([bytes], file.filename, { lastModified: ms })]);
  log.ui.log(`opened "${file.filename}" from the PDF cache — the folder was not needed`);
  return true;
}

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

/**
 * Load a library board, pulling in the rest of its `.asc` sections when it is
 * one file of a split Tebo-ICT delivery. Shared by the Library panel and the
 * MCP `open_file` tool so a click and a tool call open the same board.
 *
 * Announces a merge — quietly opening five files when one was clicked would
 * otherwise look like the app guessed at something.
 */
export async function loadLibraryBoard(file: DatabankFile, fileObj: File): Promise<void> {
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  await loadBoardWithAscSiblings(fileObj, {
    siblingNames: () => databankStore.listFolderNames(dir),
    read: async (name) => {
      const path = dir ? `${dir}/${name}` : name;
      // A sibling need not be indexed — the folder listing sees files the
      // scanner skipped — so synthesise a row when the index has none.
      const row =
        databankStore.fileByPath(path) ??
        ({ ...file, id: -1, path, filename: name, size: 0 } as DatabankFile);
      return databankStore.fetchFileBuffer(row, { quiet: true });
    },
  });
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
  // ensureLoaded() no longer blocks on the full file stream, so a miss here
  // isn't authoritative — the row may just not have streamed in yet. Fetch it
  // directly (non-mutating, safe mid-stream) before giving up.
  const file =
    databankStore.fileById(fileId) ?? (await databankStore.fetchFileRows([fileId]))[0];
  if (!file) throw new Error(`file id ${fileId} not in the library index`);
  // A cached copy opens with no folder access at all — try that first.
  if (await openFolderFileFromCache(file)) {
    return { name: boardStore.activeTab?.fileName ?? file.filename, file_type: file.file_type };
  }
  const fileObj = await databankStore.fetchFileBuffer(file);

  if (file.file_type === 'board') {
    await loadLibraryBoard(file, fileObj);
    const tabId = boardStore.activeTabId;
    // The tab's own name, not the clicked file's — a merged .asc board is
    // named after the board, and the panel title has to agree with it.
    if (tabId != null) ensureBoardPanel(tabId, boardStore.activeTab?.fileName ?? fileObj.name);
    // Auto-load bound (auto_open) PDFs so "open the board" also brings its schematic.
    const detail = await databankStore.fetchFileDetail(file.id);
    for (const binding of detail?.bindings ?? []) {
      if (!binding.auto_open) continue;
      try {
        const pdfFile =
          databankStore.fileById(binding.pdf_file_id) ??
          (await databankStore.fetchFileRows([binding.pdf_file_id]))[0];
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
    // The tab's own name, not the clicked file's — a merged .asc board is
    // named after the board, and the panel title has to agree with it.
    if (tabId != null) ensureBoardPanel(tabId, boardStore.activeTab?.fileName ?? fileObj.name);
  } else {
    // PDF (or other) — open via the shared PDF path, then jump to a page.
    await openPdfFiles([fileObj]);
    if (page && page > 0) pdfStore.goToPage(page);
  }
  // Report the board that ended up open — merging a split .asc delivery names
  // the tab after the board, not after the section that was asked for.
  const opened = file.file_type === 'board' ? boardStore.activeTab?.fileName : undefined;
  return { name: opened ?? fileObj.name, file_type: file.file_type };
}
