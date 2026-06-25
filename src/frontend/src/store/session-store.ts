import { boardStore } from './board-store';
import { pdfStore } from './pdf-store';
import { log } from './log-store';

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
