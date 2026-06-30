import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { log } from './log-store';
import { databankStore } from './databank-store';
import { ensurePdfPanel } from './dockview-api';

const SESSION_KEY = 'boardripper-session';
const DEBOUNCE_MS = 500;

export interface SessionEntry {
  kind: 'board' | 'pdf';
  fileName: string;
  fileSize: number;
  fileLastModified: number;
  fileId?: number;
  active?: boolean;
}

export interface SavedSession {
  version: 1;
  savedAt: number;
  entries: SessionEntry[];
}

/** Build the current open set from the board + PDF stores. */
function snapshot(): SessionEntry[] {
  const boards: SessionEntry[] = boardStore.openBoardEntries().map(b => ({
    kind: 'board',
    fileName: b.fileName,
    fileSize: b.fileSize,
    fileLastModified: b.fileLastModified,
    active: b.active || undefined,
  }));
  const pdfs: SessionEntry[] = pdfStore.openPdfEntries().map(p => ({
    kind: 'pdf',
    fileName: p.fileName,
    fileSize: p.fileSize,
    fileLastModified: p.fileLastModified,
    fileId: p.fileId,
  }));
  return [...boards, ...pdfs];
}

/** Write the current open set to localStorage immediately. */
export function captureNow(): void {
  try {
    const session: SavedSession = { version: 1, savedAt: Date.now(), entries: snapshot() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch (e) {
    log.cache.warn('session: capture failed', e);
  }
}

export function readSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    if (!s || s.version !== 1 || !Array.isArray(s.entries)) return null;
    return s;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

let inited = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleCapture(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { debounceTimer = null; captureNow(); }, DEBOUNCE_MS);
}

/** Wire continuous capture: subscribe to board + PDF changes (debounced) and
 *  flush on beforeunload. Idempotent. Restore is driven separately by the
 *  SessionRestorePrompt, so initSessionStore does NOT auto-restore. */
export function initSessionStore(): void {
  if (inited) return;
  inited = true;
  boardStore.subscribe(scheduleCapture);
  pdfStore.subscribe(scheduleCapture);
  window.addEventListener('beforeunload', captureNow);
}

/** Reopen every entry in a saved session, then focus the previously-active
 *  board. Resolves databank-first (dropped files live under incoming/), with
 *  the IndexedDB board cache as a board-only fallback. Collects unavailable
 *  files into one summary toast. Never called automatically — the restore
 *  prompt invokes it on the user's explicit Reopen. */
export async function restoreSession(session: SavedSession): Promise<void> {
  await databankStore.ensureLoaded();
  const unavailable: string[] = [];
  let activeBoardName: string | null = null;
  let opened = 0;   // count only items that genuinely opened (a panel/tab), not just loaded

  for (const e of session.entries) {
    try {
      const dbFile =
        (e.fileId != null ? databankStore.fileById(e.fileId) : undefined) ??
        databankStore.findFileByName(e.fileName, e.fileSize) ??
        null;

      if (e.kind === 'board') {
        if (dbFile && dbFile.file_type === 'board') {
          const file = await databankStore.fetchFileBuffer(dbFile);
          await boardStore.loadFile(file);
        } else if (!(await boardStore.loadFromCache(e.fileName, e.fileSize, e.fileLastModified))) {
          unavailable.push(e.fileName);
          continue;
        }
        opened++;
        if (e.active) activeBoardName = e.fileName;
      } else {
        // pdf — must replicate openPdfFiles' full sequence (addPdf + loadFile +
        // ensurePdfPanel), otherwise the doc loads invisibly and never opens a panel.
        if (dbFile && dbFile.file_type === 'pdf') {
          const file = await databankStore.fetchFileBuffer(dbFile);
          boardStore.addPdf(file);
          await pdfStore.loadFile(file, dbFile.id);
          ensurePdfPanel(file.name);
          opened++;
        } else {
          unavailable.push(e.fileName); // local-drop PDF with no databank entry → no binary cache
        }
      }
    } catch (err) {
      log.ui.warn(`session restore: ${e.fileName} failed`, err);
      unavailable.push(e.fileName);
    }
  }

  if (activeBoardName) {
    const tab = boardStore.tabs.find(t => t.fileName === activeBoardName);
    if (tab) boardStore.switchTab(tab.id);
  }

  if (opened > 0 && unavailable.length === 0) {
    boardStore.addToast(`Reopened ${opened} item${opened > 1 ? 's' : ''} from your last session`, 'info');
  } else if (unavailable.length > 0) {
    boardStore.addToast(
      `Reopened ${opened} · ${unavailable.length} unavailable (re-drop): ${unavailable.slice(0, 3).join(', ')}${unavailable.length > 3 ? '…' : ''}`,
      'error',
    );
  }
}
