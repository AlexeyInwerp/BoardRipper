// Pure, WS-independent helpers for the MCP live-board bridge, split out so they
// are unit-testable without a socket or a live board.

/** Heuristic: does this net name carry semantic meaning, or is it an
 *  auto-generated placeholder the model must not read function into? Tunable —
 *  extend the synthetic patterns as new formats surface (see spec §12.9). */
const SYNTHETIC_PATTERNS: RegExp[] = [
  /^\s*$/,          // empty / whitespace
  /^n\$\d+$/i,      // Altium-style N$123
  /^net\d+$/i,      // NET0042
  /^\$?\d+$/,       // bare number, optional leading $
  /^unnamed/i,      // UNNAMED_*
  /^node\d+$/i,     // NODE12
];

export function classifyNetName(name: string): 'named' | 'synthetic' {
  const n = name ?? '';
  return SYNTHETIC_PATTERNS.some((re) => re.test(n)) ? 'synthetic' : 'named';
}

/** Shape of `worklistStore.aiSnapshot()`, narrowed to the fields `buildOverview`
 *  needs (the full snapshot carries more — mark/note/measurement detail — that
 *  board_overview intentionally omits; use worklist_get for that). */
type Snap = {
  note?: string;
  parts?: unknown[];
  netEntries?: Array<{ measurements?: Array<{ status?: string }> }>;
} | null;

export interface WorklistSummary {
  parts: number;
  nets: number;
  pendingMeasurements: number;
  unreadUserMessages: number;
  hasListNote: boolean;
}

/** Compress a worklist snapshot into the counts `board_overview` reports —
 *  orientation at a glance, not the full detail (that's worklist_get). */
export function buildOverview(snap: Snap, unread: number): WorklistSummary {
  const netEntries = snap?.netEntries ?? [];
  const pending = netEntries.reduce(
    (acc, n) => acc + (n.measurements ?? []).filter((m) => m.status === 'requested').length,
    0,
  );
  return {
    parts: snap?.parts?.length ?? 0,
    nets: netEntries.length,
    pendingMeasurements: pending,
    unreadUserMessages: unread,
    hasListNote: !!(snap?.note && snap.note.trim()),
  };
}

/** Narrowed shape of `PdfDocument.textPages[pageIndex][itemIndex]` — only the
 *  `.str` field `pageText`/`searchTextPages` need. */
type TextItem = { str: string };

/** Join a 1-based page's text items into a single whitespace-normalized
 *  string. Reads the already-cached text layer (no re-extraction). Returns ''
 *  for an out-of-range page rather than throwing — the open PDF's page count
 *  is dynamic (extraction is progressive), so callers should treat '' as
 *  "not available yet / out of range", not an error. */
export function pageText(pages: TextItem[][], page: number): string {
  const idx = page - 1;
  if (idx < 0 || idx >= pages.length) return '';
  return pages[idx].map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
}

/** Case-insensitive substring search across the open PDF's cached text pages,
 *  distinct from the library-wide `pdf_search` tool. Returns one hit per
 *  matching page (page + full page-text snippet), capped at `limit`
 *  (default 200, max 1000). */
export function searchTextPages(pages: TextItem[][], query: string, limit: number): Array<{ page: number; snippet: string }> {
  const q = (query ?? '').toLowerCase().trim();
  const out: Array<{ page: number; snippet: string }> = [];
  if (!q) return out;
  const cap = limit > 0 && limit <= 1000 ? limit : 200;
  for (let i = 0; i < pages.length && out.length < cap; i++) {
    const text = pages[i].map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    if (text.toLowerCase().includes(q)) out.push({ page: i + 1, snippet: text });
  }
  return out;
}
