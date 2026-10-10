// src/frontend/src/store/board-knowledge.ts
//
// What is known about a board beyond its geometry: repair tables, loose
// notes, what a net does. One shape for every source, tagged with where it
// came from, so the board sidebar's Notes tab renders a source without
// knowing its format.
//
// Today there is one source, the board file itself (XZZ "Common problems"
// boards and the `===信号` net glossary). OpenBoardData, the user's own notes
// and a wiki page are the next sources; each becomes another adapter here.
// Design: docs/specs/2026-09-29-board-knowledge-layer-review.md.

import type { AnnotationTable, BoardData } from '../parsers/types';

export type KnowledgeSourceKind = 'file';

export interface KnowledgeSource {
  kind: KnowledgeSourceKind;
  /** Shown above the source's content: where these notes came from. */
  label: string;
  /** Tables the source carries (symptom / fault point / fix and the like). */
  tables: AnnotationTable[];
  /** Free text that belongs to no table: legends, callouts, flowchart boxes. */
  notes: string[];
  /** Net name → what the net does. May name nets this board does not carry. */
  netNotes: ReadonlyMap<string, string>;
}

export interface BoardKnowledge {
  sources: KnowledgeSource[];
  /** Total entries across sources; 0 means the Notes tab stays hidden. */
  count: number;
}

const EMPTY: BoardKnowledge = { sources: [], count: 0 };
const cache = new WeakMap<BoardData, BoardKnowledge>();

function fromFile(board: BoardData): KnowledgeSource | null {
  const tables = board.annotations?.tables ?? [];
  const notes = (board.annotations?.notes ?? []).map(n => n.text).filter(t => t.trim() !== '');
  const netNotes = board.netDescriptions ?? new Map<string, string>();
  if (tables.length === 0 && notes.length === 0 && netNotes.size === 0) return null;
  return {
    kind: 'file',
    label: board.format === 'XZZ' ? 'From the XZZ board file' : 'From the board file',
    tables,
    notes,
    netNotes,
  };
}

/** Everything known about `board`, memoised per BoardData object (a reload
 *  or a derived view is a new object and is recomputed). */
export function boardKnowledge(board: BoardData | null | undefined): BoardKnowledge {
  if (!board) return EMPTY;
  const hit = cache.get(board);
  if (hit) return hit;
  const sources = [fromFile(board)].filter((s): s is KnowledgeSource => s !== null);
  const count = sources.reduce((n, s) => n + s.tables.length + s.notes.length + s.netNotes.size, 0);
  const out = count === 0 ? EMPTY : { sources, count };
  cache.set(board, out);
  return out;
}

/** What the sources say about one net, in source order. */
export function netKnowledge(k: BoardKnowledge, net: string): Array<{ source: KnowledgeSource; text: string }> {
  const out: Array<{ source: KnowledgeSource; text: string }> = [];
  for (const s of k.sources) {
    const text = s.netNotes.get(net);
    if (text) out.push({ source: s, text });
  }
  return out;
}
