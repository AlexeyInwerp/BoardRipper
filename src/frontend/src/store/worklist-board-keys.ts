/**
 * A board tab's keys for worklist suggestions (store/worklist-match.ts): the
 * file name, the library's board number / model / brand, and — when a server
 * runs — what the board database knows (aliases, model number, family…),
 * fetched once per board number from GET /api/boards/resolve and cached.
 */
import { hasHttpBackend } from './build-mode';
import { databankStore } from './databank-store';
import { obdBoardNumberFor } from './obd-store';
import { boardKeys, type BoardFacts, type BoardKey } from './worklist-match';

const facts = new Map<string, BoardFacts | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();

export function subscribeBoardFacts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function query(tab: { fileName: string; fileId?: number }): string {
  return obdBoardNumberFor(tab) ?? tab.fileName;
}

/** Fetch the board-database facts for a tab once (no-op without a server). */
export function ensureBoardFacts(tab: { fileName: string; fileId?: number }): void {
  if (!hasHttpBackend()) return;
  const q = query(tab);
  if (facts.has(q) || pending.has(q)) return;
  pending.add(q);
  fetch(`/api/boards/resolve?q=${encodeURIComponent(q)}`)
    .then(r => (r.ok ? r.json() : null))
    .then((j: { match?: BoardFacts | null } | null) => { facts.set(q, j?.match ?? null); })
    .catch(() => { facts.set(q, null); })
    .finally(() => { pending.delete(q); listeners.forEach(fn => fn()); });
}

/** The tab's keys with whatever is known right now. */
export function boardKeysForTab(tab: { fileName: string; fileId?: number }): BoardKey[] {
  const row = tab.fileId != null ? databankStore.fileById(tab.fileId) : undefined;
  return boardKeys({
    fileName: tab.fileName,
    boardNumber: obdBoardNumberFor(tab),
    libraryModel: row?.model || null,
    libraryBrand: row?.manufacturer || null,
    facts: facts.get(query(tab)) ?? null,
  });
}
