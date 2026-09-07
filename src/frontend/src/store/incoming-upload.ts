import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { databankStore, isElectron } from './databank-store';
import { isLiteBuild } from './build-mode';
import { log } from './log-store';

/** Wire shape of a `POST /api/upload` success (see handlers/files.go
 *  writeUploadResponse). `status` is:
 *  - `ok`      — saved under its own name;
 *  - `renamed` — saved as "name (n).ext" because a *different* file already
 *                had that name (never overwritten);
 *  - `exists`  — nothing written: the library already holds these exact
 *                bytes (any name, any folder); `id`/`path` point at it. */
interface UploadResponse {
  status: 'ok' | 'renamed' | 'exists';
  name: string;
  path: string;
  id?: number;
  file_type?: string;
}

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
 * Duplicates never produce copies: the backend answers `exists` for bytes it
 * already holds, and the open tab is simply tagged with the existing id.
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

  const saved: string[] = [];
  const renamed: string[] = [];
  const existing: string[] = [];
  const newIds: number[] = [];
  let pdfSaved = false;
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
      let body: UploadResponse | null = null;
      try { body = await res.json() as UploadResponse; } catch { /* non-JSON — treat as plain save */ }

      // Tag the already-open board tab / PDF doc with its databank id —
      // for `exists` that is the ORIGINAL's id, so board↔PDF binding and
      // session restore resolve to the library copy. For a PDF, tagging
      // also arms the on-open fast path (pdfStore.setDocFileId), which
      // uploads the text pdf.js already extracted.
      if (typeof body?.id === 'number') {
        if (body.file_type === 'pdf') pdfStore.setDocFileId(file.name, body.id);
        else boardStore.setTabFileId(file.name, body.id);
      }

      if (body?.status === 'exists') {
        existing.push(body.path);
        continue;
      }
      if (typeof body?.id === 'number') newIds.push(body.id);
      if (body?.status === 'renamed') renamed.push(body.name);
      else saved.push(file.name);
      if (body?.file_type === 'pdf' || file.name.toLowerCase().endsWith('.pdf')) pdfSaved = true;
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const written = saved.length + renamed.length;
  if (written > 0) {
    log.ui.log(`Saved ${written} dropped file(s) to library incoming/`, { saved, renamed });
    // Merge just the new rows into the in-memory library (and refresh the
    // folder tree) instead of forcing a full re-stream + IDB rewrite of a
    // multi-MB list for one file. Falls back to a forced refresh only when
    // the upload response carried no id (legacy backend).
    if (newIds.length === written) {
      void databankStore.mergeFilesById(newIds);
    } else {
      void databankStore.fetchFiles({ force: true });
    }
    // The backend hands every ingested PDF to the text indexer itself;
    // just surface the progress in the UI.
    if (pdfSaved) databankStore.startPdfIndexPolling();
    const parts = [`Saved ${written} file${written > 1 ? 's' : ''} to library (incoming)`];
    if (renamed.length > 0) {
      parts.push(`${renamed.length} renamed — a different file had that name`);
    }
    boardStore.addToast(parts.join('; '), 'info');
  }
  if (existing.length > 0) {
    log.ui.log('Dropped file(s) already in library — not copied', existing);
    const first = existing[0];
    const more = existing.length > 1 ? ` (+${existing.length - 1} more)` : '';
    boardStore.addToast(`Already in library: ${first}${more}`, 'info');
  }
  if (failures.length > 0) {
    log.ui.warn('Failed to save dropped file(s) to incoming/', failures);
    boardStore.addToast(`Couldn't save to library: ${failures[0]}`, 'error');
  }
}
