import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { databankStore, isElectron } from './databank-store';
import { isLiteBuild } from './build-mode';
import { log } from './log-store';
import { pdfIndexClient } from '../pdf/pdf-index-client';

/**
 * Save dropped board/PDF files into the server library's `incoming/` folder
 * and index them so they appear in the Library panel. This runs *in addition*
 * to the in-memory open (which gives instant rendering) — its job is to
 * persist the dropped file on the server so it survives reload and is shared
 * across devices.
 *
 * Best-effort and non-blocking from the user's point of view: rendering has
 * already happened by the time this is called.
 *
 * Gated on isElectron() — NOT hasBackend() — deliberately: even when the
 * desktop MCP sidecar is running (so /api/upload exists), the desktop
 * library is the user's own curated local folder, and silently copying a
 * dropped-to-view file into its incoming/ subdir is an unwanted mutation of
 * their collection. On web/NAS the library is a managed shared store where
 * persisting is the desired behaviour.
 */
export async function saveDroppedToIncoming(files: File[]): Promise<void> {
  if (isElectron() || isLiteBuild()) return;
  if (files.length === 0) return;

  let saved = 0;
  const failures: string[] = [];

  for (const file of files) {
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch('/api/upload', { method: 'POST', body: form });
      if (!res.ok) {
        failures.push(`${file.name}: ${(await res.text()).trim() || res.status}`);
        continue;
      }
      saved++;
      // Tag the already-open board tab / PDF doc with its fresh databank id so
      // board↔PDF binding and session restore resolve by id (no name+size race).
      try {
        const body = await res.json() as { id?: number; file_type?: string };
        if (typeof body.id === 'number') {
          if (body.file_type === 'pdf') pdfStore.setDocFileId(file.name, body.id);
          else boardStore.setTabFileId(file.name, body.id);
        }
      } catch { /* response not JSON — non-critical */ }
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (saved > 0) {
    log.ui.log(`Saved ${saved} dropped file(s) to library incoming/`);
    // Force-refresh the library so the dropped row(s) show up + sort into
    // the right brand bucket — fetchFiles({force}) clears the IDB chunk
    // cache + in-memory signature so neither the in-memory shortcut nor
    // a stale cached snapshot can hide the newly-inserted row. The cache
    // clear also drops the cached folder tree, so the auto-pre-fetch at
    // the end of fetchFiles refills it from the live backend — the
    // dropped file lands in its real folder in the Folders tab too.
    void databankStore.fetchFiles({ force: true });
    // Auto-index any dropped PDFs so they're searchable in Ctrl-F /
    // PDF-search without a full library re-index. We don't get per-file IDs
    // back from the upload response, so we kick the pdfindex pipeline on the
    // whole `incoming` folder — cheap (only files that landed since the last
    // pass run), idempotent, and matches the existing per-folder index UX.
    const hasPdf = files.some(f => f.name.toLowerCase().endsWith('.pdf'));
    if (hasPdf) {
      void pdfIndexClient.indexFolder('incoming').then(res => {
        if (res.ok) databankStore.startPdfIndexPolling();
      }).catch(() => { /* non-critical */ });
    }
    boardStore.addToast(
      `Saved ${saved} file${saved > 1 ? 's' : ''} to library (incoming)`,
      'info',
    );
  }
  if (failures.length > 0) {
    log.ui.warn('Failed to save dropped file(s) to incoming/', failures);
    boardStore.addToast(`Couldn't save to library: ${failures[0]}`, 'error');
  }
}
