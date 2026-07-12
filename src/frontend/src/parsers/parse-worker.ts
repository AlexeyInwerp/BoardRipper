/// <reference lib="webworker" />
/**
 * Module worker that runs the full parse pipeline off the main thread.
 *
 * The worker gets its own instances of every store module the parsers
 * import; the two that matter are handled explicitly:
 * - fz-key-store: no localStorage in a worker, so the key is injected per
 *   request (`fzKeyStore.key = …`) from the message payload.
 * - log-store: the worker's logStore is a separate module instance whose
 *   entries would be invisible to the main thread's Debug panel — they are
 *   forwarded via postMessage and re-injected on the main side.
 */
import { parseBoardFile } from './index';
import { FZKeyError } from './fz-parser';
import { fzKeyStore } from '../store/fz-key-store';
import { logStore } from '../store/log-store';
import type { LogLevel, LogScope } from '../store/log-store';

export interface ParseWorkerRequest {
  id: number;
  buffer: ArrayBuffer;
  fileName: string;
  /** FZ decryption key — injected because workers have no localStorage. */
  fzKey: Uint32Array | null;
}

export type ParseWorkerResponse =
  | { id: number; ok: true; board: unknown }
  | { id: number; ok: false; errName: string; message: string; fzReason?: 'missing' | 'invalid' };

export interface ParseWorkerLogMsg {
  log: { level: LogLevel; scope: LogScope; message: string };
}

const post = (msg: ParseWorkerResponse | ParseWorkerLogMsg) =>
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);

let lastForwardedLogId = 0;
logStore.subscribe(() => {
  for (const e of logStore.getSnapshot()) {
    if (e.id <= lastForwardedLogId) continue;
    lastForwardedLogId = e.id;
    post({ log: { level: e.level, scope: e.scope, message: e.message } });
  }
});

self.onmessage = async (ev: MessageEvent<ParseWorkerRequest>) => {
  const { id, buffer, fileName, fzKey } = ev.data;
  fzKeyStore.key = fzKey;
  try {
    const board = await parseBoardFile(buffer, fileName);
    try {
      post({ id, ok: true, board });
    } catch (cloneErr) {
      // Non-cloneable BoardData (should not happen — it survives the IDB
      // cache) — report so the main side falls back to inline parsing.
      post({ id, ok: false, errName: 'DataCloneError', message: String(cloneErr) });
    }
  } catch (e) {
    post({
      id, ok: false,
      errName: e instanceof Error ? e.name : 'Error',
      message: e instanceof Error ? e.message : String(e),
      ...(e instanceof FZKeyError ? { fzReason: e.reason } : {}),
    });
  }
};
