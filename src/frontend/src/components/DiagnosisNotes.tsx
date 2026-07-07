import { useMemo } from 'react';
import type { ObdSection, ObdNote } from '../store/obd-store';
import { boardStore } from '../store/board-store';
import type { BoardData } from '../parsers';

/**
 * Renders the structured DIAGNOSIS_DATA from openboarddata.org as
 * collapsible sections (HTML <details>) with clickable inline references.
 *
 * OBD note bodies contain tokens like:
 *   [n:PP3V3_S5]              — net reference; click → highlight on board
 *   [p:U7701]                 — part reference; click → select part
 *   [p:U7701:3]               — part + pin; click → select part, pin, highlight net
 *
 * The component is small and self-contained so the same UI can be
 * embedded by the BoardSidebar InfoTab (via ComponentInfoBody) without
 * coupling.
 */
export function DiagnosisNotes({
  sections,
  board,
}: {
  sections: ObdSection[];
  /** Active board, for resolving part-name references → indices. Optional;
   *  net-only references work without it. */
  board: BoardData | null;
}) {
  if (!sections || sections.length === 0) return null;
  return (
    <div className="obd-diagnosis-notes" data-testid="obd-diagnosis-notes" style={{ marginTop: 8 }}>
      <div style={{ fontSize: 11, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
        Repair notes
      </div>
      {sections.map((sec, i) => (
        <DiagnosisSectionView key={`${i}-${sec.title}`} section={sec} board={board} />
      ))}
    </div>
  );
}

function DiagnosisSectionView({ section, board }: { section: ObdSection; board: BoardData | null }) {
  return (
    <details
      data-testid="obd-section-spoiler"
      style={{
        border: '1px solid #333',
        borderRadius: 4,
        marginBottom: 4,
        background: '#1a1a1a',
      }}
    >
      <summary
        style={{
          padding: '4px 8px',
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          background: '#222',
          borderRadius: 4,
        }}
      >
        {section.title || '(untitled section)'}
        <span style={{ marginLeft: 6, fontSize: 10, color: '#888', fontWeight: 400 }}>
          {section.notes.length} note{section.notes.length === 1 ? '' : 's'}
        </span>
      </summary>
      <div style={{ padding: '4px 8px 6px' }}>
        {section.notes.map((note, j) => (
          <DiagnosisNoteView key={`${j}-${note.title}`} note={note} board={board} />
        ))}
      </div>
    </details>
  );
}

function DiagnosisNoteView({ note, board }: { note: ObdNote; board: BoardData | null }) {
  return (
    <details data-testid="obd-note-spoiler" style={{ marginTop: 4 }}>
      <summary style={{ fontSize: 11, color: '#cde', cursor: 'pointer', padding: '2px 0' }}>
        {note.title || '(untitled)'}
      </summary>
      <div
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          padding: '4px 8px',
          background: '#101010',
          borderRadius: 3,
          marginTop: 2,
          fontFamily: 'monospace',
          whiteSpace: 'pre-wrap',
        }}
      >
        <NoteBody body={note.body} board={board} />
      </div>
    </details>
  );
}

/** Tokenises the note body, replacing [n:NET] / [p:PART] / [p:PART:PIN]
 *  with clickable chips. Plain text is preserved with whitespace as-is.
 *  Exported so the worklist AI-mode transcript reuses the same chips. */
export function NoteBody({ body, board }: { body: string; board: BoardData | null }) {
  // Build a part-name → index lookup once per body.
  const partIndex = useMemo(() => {
    const map = new Map<string, number>();
    if (board) {
      for (let i = 0; i < board.parts.length; i++) {
        map.set(board.parts[i].name, i);
      }
    }
    return map;
  }, [board]);

  const parts: React.ReactNode[] = [];
  // Match [n:NAME], [p:NAME], or [p:NAME:PIN]. NAME can include letters,
  // digits, underscore, slash, dot, hyphen, angle brackets (for indexed nets
  // like MEM_A<7>); deliberately permissive.
  const re = /\[(n|p):([^\]:]+?)(?::([^\]]+))?\]/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(body)) !== null) {
    if (match.index > cursor) {
      parts.push(<span key={`t${key++}`}>{body.slice(cursor, match.index)}</span>);
    }
    const [, kind, name, pin] = match;
    if (kind === 'n') {
      parts.push(<NetChip key={`n${key++}`} netName={name} />);
    } else {
      parts.push(<PartChip key={`p${key++}`} partName={name} pinId={pin} partIdx={partIndex.get(name)} />);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) {
    parts.push(<span key={`t${key++}`}>{body.slice(cursor)}</span>);
  }
  return <>{parts}</>;
}

function NetChip({ netName }: { netName: string }) {
  return (
    <button
      data-testid="obd-ref-net"
      data-net={netName}
      onClick={() => {
        const cur = boardStore.selection.highlightedNet;
        boardStore.highlightNet(cur === netName ? null : netName);
      }}
      title={`Highlight net ${netName}`}
      style={{
        display: 'inline-block',
        padding: '0 6px',
        margin: '0 1px',
        border: '1px solid #4a8',
        borderRadius: 8,
        background: '#1a3329',
        color: '#9f9',
        fontSize: 10,
        fontFamily: 'monospace',
        cursor: 'pointer',
        verticalAlign: 'baseline',
      }}
    >
      {netName}
    </button>
  );
}

function PartChip({
  partName,
  pinId,
  partIdx,
}: {
  partName: string;
  pinId?: string;
  partIdx: number | undefined;
}) {
  const known = partIdx !== undefined;
  return (
    <button
      data-testid="obd-ref-part"
      data-part={partName}
      data-pin={pinId ?? ''}
      onClick={() => {
        if (partIdx === undefined) return;
        if (pinId) {
          // Find the pin by its `number` field; fall back to part-only selection.
          const part = boardStore.activeTab?.board?.parts[partIdx];
          if (part) {
            const pIdx = part.pins.findIndex(p => p.number === pinId);
            if (pIdx >= 0) {
              boardStore.selectPin(partIdx, pIdx);
              return;
            }
          }
        }
        boardStore.selectPart(partIdx);
      }}
      disabled={!known}
      title={
        known
          ? `Select ${partName}${pinId ? ` pin ${pinId}` : ''}`
          : `${partName} not found in this board`
      }
      style={{
        display: 'inline-block',
        padding: '0 6px',
        margin: '0 1px',
        border: '1px solid ' + (known ? '#a84' : '#444'),
        borderRadius: 8,
        background: known ? '#332a14' : '#222',
        color: known ? '#fc9' : '#666',
        fontSize: 10,
        fontFamily: 'monospace',
        cursor: known ? 'pointer' : 'not-allowed',
        verticalAlign: 'baseline',
      }}
    >
      {partName}{pinId ? `:${pinId}` : ''}
    </button>
  );
}
