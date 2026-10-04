import { useMemo, useState, type ReactNode } from 'react';
import type { AnnotationTable, BoardData } from '../parsers/types';
import { hasNonLatin } from '../parsers/annotation-tables';
import { boardKnowledge, netKnowledge, type KnowledgeSource } from '../store/board-knowledge';
import { NetChip, PartChip } from './DiagnosisNotes';

/**
 * Board sidebar ▸ Notes: what is known about this board beyond its geometry,
 * one block per source (`store/board-knowledge.ts`). Shown only when a source
 * has something; today that is an XZZ file's repair tables, loose notes and
 * net glossary.
 *
 * This is DOM, not canvas text, on purpose: the notes are mostly Chinese and
 * the browser's "Translate page" can only translate text nodes. Two rules keep
 * that safe:
 *  - prose carries `lang` so the translator knows the source language, and
 *    identifiers (part and net names) carry translate="no", because a
 *    translated "U3900" no longer matches the board;
 *  - every piece of text is the only child of its own element. The translator
 *    swaps text nodes for <font> wrappers, and React then throws when it
 *    inserts next to a node it no longer finds (issue #36).
 */
export function BoardNotesTab({ board, highlightedNet }: { board: BoardData; highlightedNet: string | null }) {
  const k = boardKnowledge(board);
  const partIndex = useMemo(() => new Map(board.parts.map((p, i) => [p.name, i])), [board]);
  if (k.count === 0) {
    return <div className="panel-empty"><span>No notes for this board</span></div>;
  }
  const forNet = highlightedNet ? netKnowledge(k, highlightedNet) : [];
  return (
    <div className="bn" data-testid="board-notes">
      {highlightedNet && forNet.length > 0 && (
        <div className="bn-net-card" data-testid="board-notes-net">
          <div className="bn-net-card-name" translate="no"><NetChip netName={highlightedNet} /></div>
          {forNet.map((e, i) => (
            <div key={i} className="bn-net-card-text" lang={langOf(e.text)}>{e.text}</div>
          ))}
        </div>
      )}
      {k.sources.map((s, i) => (
        <SourceView key={`${s.kind}-${i}`} source={s} board={board} partIndex={partIndex} />
      ))}
    </div>
  );
}

type PartIndex = ReadonlyMap<string, number>;

function SourceView({ source, board, partIndex }: { source: KnowledgeSource; board: BoardData; partIndex: PartIndex }) {
  return (
    <section className="bn-source" data-source={source.kind}>
      <div className="bn-source-label"><span>{source.label}</span></div>
      {source.tables.map((t, i) => <TableView key={i} table={t} board={board} partIndex={partIndex} />)}
      {source.notes.length > 0 && (
        <details className="bn-block" data-testid="board-notes-notes">
          <summary><span>{`Notes (${source.notes.length})`}</span></summary>
          <ul className="bn-notes">
            {source.notes.map((n, i) => (
              <li key={i}><Line text={n} board={board} partIndex={partIndex} /></li>
            ))}
          </ul>
        </details>
      )}
      {source.netNotes.size > 0 && <NetNotes notes={source.netNotes} board={board} />}
    </section>
  );
}

function TableView({ table, board, partIndex }: { table: AnnotationTable; board: BoardData; partIndex: PartIndex }) {
  const total = table.columnWeights.reduce((s, w) => s + w, 0) || 1;
  return (
    <table className="bn-table" data-testid="board-notes-table">
      {table.caption && (
        <caption lang={langOf(table.caption)}>{table.caption}</caption>
      )}
      <colgroup>
        {table.columnWeights.map((w, i) => <col key={i} style={{ width: `${(w / total * 100).toFixed(1)}%` }} />)}
      </colgroup>
      <thead>
        <tr>
          {table.header.map((h, i) => <th key={i} lang={langOf(h)}>{h}</th>)}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, r) => (
          <tr key={r}>
            {row.map((lines, c) => (
              <td key={c}>
                {lines.map((l, j) => <div key={j}><Line text={l} board={board} partIndex={partIndex} /></div>)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The net glossary. Collapsed by default (an iPhone glossary runs to ~500
 *  entries) and filterable by net name or description. A net this board has
 *  is a chip that highlights it; the glossary covers the whole device, so the
 *  rest stay plain names. */
function NetNotes({ notes, board }: { notes: ReadonlyMap<string, string>; board: BoardData }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const rows = useMemo(() => {
    const all = [...notes];
    // Nets on this board first: those are the ones a click can show.
    all.sort((a, b) => Number(board.nets.has(b[0])) - Number(board.nets.has(a[0])) || a[0].localeCompare(b[0]));
    return q ? all.filter(([n, t]) => n.toLowerCase().includes(q) || t.toLowerCase().includes(q)) : all;
  }, [notes, board, q]);
  return (
    <details className="bn-block" data-testid="board-notes-glossary">
      <summary><span>{`What each net does (${notes.size})`}</span></summary>
      <input
        className="bn-filter"
        data-testid="board-notes-filter"
        type="search"
        placeholder="Filter nets"
        value={filter}
        onChange={e => setFilter(e.target.value)}
      />
      <div className="bn-glossary">
        {rows.length === 0 && <div className="bn-empty"><span>No net matches</span></div>}
        {rows.map(([net, text]) => (
          <div key={net} className="bn-glossary-row" data-testid="board-notes-glossary-row">
            <div className="bn-glossary-net" translate="no">
              {board.nets.has(net)
                ? <NetChip netName={net} />
                : <span className="bn-offboard" title="Not on this board">{net}</span>}
            </div>
            <div className="bn-glossary-text" lang={langOf(text)}>{text}</div>
          </div>
        ))}
      </div>
    </details>
  );
}

// Designators (U6300, C1402_K) and net names (PP3V0_TRISTAR), plus the
// slash-joined rail pairs the tables write.
const TOKEN = /[A-Za-z0-9_./+-]+/g;

/** One line of note text. Every token that names a part or net on THIS board
 *  becomes the chip the OBD notes use; the rest stays prose. A designator from
 *  another revision stays text rather than offering a jump to nowhere. */
function Line({ text, board, partIndex }: { text: string; board: BoardData; partIndex: PartIndex }) {
  const out: ReactNode[] = [];
  let last = 0, key = 0;
  for (const m of text.matchAll(TOKEN)) {
    const tok = m[0];
    if (tok.length < 2 || !/[A-Za-z]/.test(tok)) continue;
    const part = partIndex.get(tok);
    const isNet = part === undefined && board.nets.has(tok);
    if (part === undefined && !isNet) continue;
    if (m.index > last) out.push(<Prose key={key++} text={text.slice(last, m.index)} />);
    out.push(
      <span key={key++} translate="no">
        {isNet ? <NetChip netName={tok} /> : <PartChip partName={tok} partIdx={part} />}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Prose key={key++} text={text.slice(last)} />);
  return <>{out}</>;
}

function Prose({ text }: { text: string }) {
  return hasNonLatin(text)
    ? <span lang={langOf(text)}>{text}</span>
    : <span translate="no">{text}</span>;
}

/** Coarse script → BCP-47, so a translator knows the source. Han reads as
 *  zh-CN: every file seen so far comes from Chinese repair tooling. */
function langOf(s: string): string | undefined {
  if (!hasNonLatin(s)) return undefined;
  if (/[぀-ヿ]/.test(s)) return 'ja';
  if (/[가-힯]/.test(s)) return 'ko';
  if (/[Ѐ-ӿ]/.test(s)) return 'ru';
  return 'zh-CN';
}
