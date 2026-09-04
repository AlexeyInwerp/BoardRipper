/**
 * Main-thread façade for parse-worker.ts. Falls back to inline
 * parseBoardFile when workers are unavailable or the worker crashes.
 *
 * The input ArrayBuffer is TRANSFERRED to the worker (zero-copy) and is
 * detached afterwards — callers must not reuse it. Retry paths (FZ key
 * dialog, inline fallback) must re-read bytes from the original File.
 */
import { parseBoardFile } from './index';
import { FZKeyError } from './fz-parser';
import { getFzKey, fzKeyStore } from '../store/fz-key-store';
import { isOfflineBuild } from '../store/build-mode';
import { log } from '../store/log-store';
import type { BoardData } from './types';
import type { ParseWorkerRequest, ParseWorkerResponse, ParseWorkerLogMsg } from './parse-worker';

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<number, { resolve: (b: BoardData) => void; reject: (e: unknown) => void }>();

/** Forwarded worker log entries re-enter the main log store under their
 *  original scope so Debug-panel filtering keeps working. */
function relayLog(m: ParseWorkerLogMsg['log']): void {
  const scoped = (log as unknown as Record<string, Record<string, (s: string) => void>>)[m.scope];
  (scoped ?? log.parser)[m.level](m.message);
}

/** Offline single-file build: the worker cannot be a separate file (there is
 *  only one file), so Vite's `?worker&inline` packs it as a base64 blob the
 *  page starts itself. Until 2026-09 the offline build parsed on the main
 *  thread instead, freezing the tab for seconds on a 5 MB Allegro/Altium
 *  board — on a tablet, the exact device the single file is for. The import
 *  is behind a build-time constant so lite/NAS never carry the inlined copy
 *  (they load the worker as a normal chunk). */
async function loadInlineWorker(): Promise<(new () => Worker) | null> {
  if (import.meta.env.MODE !== 'offline') return null;
  try {
    const m = await import('./parse-worker.ts?worker&inline');
    return m.default;
  } catch (e) {
    log.parser.warn('Inline parse worker unavailable — parsing on the main thread:', String(e));
    return null;
  }
}

function wireWorker(w: Worker): Worker {
  w.onmessage = (ev: MessageEvent<ParseWorkerResponse | ParseWorkerLogMsg>) => {
    if ('log' in ev.data) { relayLog(ev.data.log); return; }
    const resp = ev.data;
    const p = pending.get(resp.id);
    if (!p) return;
    pending.delete(resp.id);
    if (resp.ok) p.resolve(resp.board as BoardData);
    else if (resp.fzReason) p.reject(new FZKeyError(resp.fzReason));
    else p.reject(Object.assign(new Error(resp.message), { name: resp.errName }));
  };
  w.onerror = (e) => {
    log.parser.error('Parse worker crashed — falling back to inline parsing:', e.message ?? String(e));
    for (const p of pending.values()) p.reject(Object.assign(new Error('parse worker crashed'), { name: 'WorkerCrash' }));
    pending.clear();
    worker?.terminate();
    worker = null;
    workerBroken = true;
  };
  return w;
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  // The offline build's worker is created asynchronously (loadInlineWorker)
  // by parseBoardFileInWorker; nothing to construct synchronously here.
  if (isOfflineBuild()) return null;
  try {
    worker = wireWorker(new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' }));
  } catch (e) {
    log.parser.warn('Parse worker unavailable — parsing inline:', String(e));
    workerBroken = true;
    return null;
  }
  return worker;
}

/** True when the error means "the worker path failed, the parse itself was
 *  never judged" — the caller should retry inline with fresh bytes. */
export function isWorkerTransportError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'DataCloneError' || e.name === 'WorkerCrash');
}

export async function parseBoardFileInWorker(buffer: ArrayBuffer, fileName: string): Promise<BoardData> {
  if (isOfflineBuild() && !worker && !workerBroken) {
    const Ctor = await loadInlineWorker();
    if (Ctor) {
      try { worker = wireWorker(new Ctor()); } catch (e) { log.parser.warn('Inline parse worker failed to start:', String(e)); workerBroken = true; }
    } else {
      workerBroken = true;
    }
  }
  const w = ensureWorker();
  if (!w) return parseBoardFile(buffer, fileName);
  const id = nextId++;
  const req: ParseWorkerRequest = { id, buffer, fileName, fzKey: getFzKey(), caeKey: fzKeyStore.caeKey };
  const board = await new Promise<BoardData>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage(req, [buffer]); // transfer — buffer is detached from here
    } catch (e) {
      pending.delete(id);
      reject(Object.assign(new Error(String(e)), { name: 'DataCloneError' }));
    }
  });
  log.parser.log(`Parsed in worker: ${fileName}`);
  return board;
}
