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
