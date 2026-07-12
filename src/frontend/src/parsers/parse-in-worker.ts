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
import { getFzKey } from '../store/fz-key-store';
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

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./parse-worker.ts', import.meta.url), { type: 'module' });
  } catch (e) {
    log.parser.warn('Parse worker unavailable — parsing inline:', String(e));
    workerBroken = true;
    return null;
  }
  worker.onmessage = (ev: MessageEvent<ParseWorkerResponse | ParseWorkerLogMsg>) => {
    if ('log' in ev.data) { relayLog(ev.data.log); return; }
    const resp = ev.data;
    const p = pending.get(resp.id);
    if (!p) return;
    pending.delete(resp.id);
    if (resp.ok) p.resolve(resp.board as BoardData);
    else if (resp.fzReason) p.reject(new FZKeyError(resp.fzReason));
    else p.reject(Object.assign(new Error(resp.message), { name: resp.errName }));
  };
  worker.onerror = (e) => {
    log.parser.error('Parse worker crashed — falling back to inline parsing:', e.message ?? String(e));
    for (const p of pending.values()) p.reject(Object.assign(new Error('parse worker crashed'), { name: 'WorkerCrash' }));
    pending.clear();
    worker?.terminate();
    worker = null;
    workerBroken = true;
  };
  return worker;
}

/** True when the error means "the worker path failed, the parse itself was
 *  never judged" — the caller should retry inline with fresh bytes. */
export function isWorkerTransportError(e: unknown): boolean {
  return e instanceof Error && (e.name === 'DataCloneError' || e.name === 'WorkerCrash');
}

export async function parseBoardFileInWorker(buffer: ArrayBuffer, fileName: string): Promise<BoardData> {
  const w = ensureWorker();
  if (!w) return parseBoardFile(buffer, fileName);
  const id = nextId++;
  const req: ParseWorkerRequest = { id, buffer, fileName, fzKey: getFzKey() };
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
