import { boardStore } from './board-store';
import { databankStore, isElectron } from './databank-store';
import { log } from './log-store';

/**
 * Save dropped board/PDF files into the server library's `incoming/` folder
 * and index them so they appear in the Library panel. This runs *in addition*
 * to the in-memory open (which gives instant rendering) — its job is to
 * persist the dropped file on the server so it survives reload and is shared
 * across devices.
 *
 * Best-effort and non-blocking from the user's point of view: rendering has
 * already happened by the time this is called. Electron uses a local library
 * folder (scanned via electronAPI), not server upload, so it's skipped there.
 */
export async function saveDroppedToIncoming(files: File[]): Promise<void> {
  if (isElectron()) return;
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
    } catch (err) {
      failures.push(`${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (saved > 0) {
    log.ui.log(`Saved ${saved} dropped file(s) to library incoming/`);
    // Refresh the library list + totals so the new file shows up immediately.
    void databankStore.fetchFiles();
    void databankStore.fetchStats();
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
