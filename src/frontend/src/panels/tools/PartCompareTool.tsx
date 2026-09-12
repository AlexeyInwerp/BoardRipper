/**
 * Part comparison — one component's pinout across two open boards.
 *
 * All the judgement lives in `store/part-compare.ts`; this file picks the two
 * subjects, renders the result, and wires a row click back to the two boards.
 *
 * Layout adapts to the sidebar width via a ResizeObserver (`data-wide` at
 * WIDE_PX): stacked two-line rows in the default 320 px sidebar, real
 * side-by-side columns once the user drags it open. Same idiom the Settings
 * tab strip uses.
 *
 * Design: docs/specs/2026-09-11-part-pin-comparison-design.md
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { boardStore } from '../../store/board-store';
import { useBoardStore } from '../../hooks/useBoardStore';
import { renderSettingsStore, isGroundNet } from '../../store/render-settings';
import { formatDiode } from '../../store/diode-readings';
import { log } from '../../store/log-store';
import {
  partCompareStore, usePartCompare, resolveSide,
} from '../../store/part-compare-store';
import {
  comparePart, compareToText, statusSymbol,
  type AlignMode, type CompareResult, type NameMatch, type PinDiffRow,
  type PinDiffStatus, type ResolvedAlignMode,
} from '../../store/part-compare';

/** Sidebar width at which the two sides get their own columns. */
const WIDE_PX = 520;
/** Rows rendered before the list is cut off with a "showing N of M" note.
 *  A 1500-pin BGA in a sidebar is not a table anyone reads; the filter and the
 *  copy button are the way through it. */
const ROW_CAP = 600;

const STATUS_TITLE: Record<PinDiffStatus, string> = {
  same: 'Same net name',
  renamed: 'Different name, identical neighbours — a rename, not a rewiring',
  similar: 'Different name, mostly the same neighbours',
  partial: 'The two names share most of their text — the same net spelled differently',
  bulk: 'Both sides are ground/power rails of comparable size',
  differs: 'Different net, and the neighbours differ too',
  'only-a': 'This pin exists only on board A',
  'only-b': 'This pin exists only on board B',
  nc: 'Unconnected on both sides',
};

const MODE_LABEL: Record<AlignMode, string> = {
  auto: 'Auto',
  name: 'Pin name',
  number: 'Pin number',
  order: 'File order',
  geometry: 'Geometry',
};

function shortName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '');
  return base.length > 28 ? `${base.slice(0, 27)}…` : base;
}

/**
 * A net name with the run it shares with the other side marked.
 *
 * Marking the *shared* text rather than the differing text is deliberate: on a
 * pair like `PPBUS_G3H` / `PPBUS_G3H_R` the eye lands on the unmarked tail,
 * which is exactly the character or two that actually differ.
 */
function NetName({ text, match, side }: { text: string; match?: NameMatch; side: 'a' | 'b' }) {
  if (!text) return <span className="pc-net-text">n/c</span>;
  const start = side === 'a' ? match?.aStart : match?.bStart;
  const len = match?.length ?? 0;
  if (start == null || len <= 0 || start + len > text.length) {
    return <span className="pc-net-text">{text}</span>;
  }
  return (
    <span className="pc-net-text">
      {text.slice(0, start)}
      <span className="pc-shared">{text.slice(start, start + len)}</span>
      {text.slice(start + len)}
    </span>
  );
}

// ── Component lookup ──────────────────────────────────────────────────────

function PartPicker({ which }: { which: 'a' | 'b' }) {
  const state = usePartCompare();
  const { tabs } = useBoardStore();
  const ref = state[which];
  const resolved = useMemo(() => resolveSide(ref, tabs), [ref, tabs]);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // `query === null` means "showing the committed value"; typing switches to a
  // draft so the list can filter without clobbering the selection behind it.
  const value = query ?? ref?.partName ?? '';

  const matches = useMemo(() => {
    if (!resolved?.board) return [];
    const q = value.trim().toUpperCase();
    if (!q) return [];
    const out: string[] = [];
    for (const p of resolved.board.parts) {
      const n = p.name.trim();
      if (!n) continue;
      const u = n.toUpperCase();
      if (u === q) continue;              // already exact — nothing to suggest
      if (u.includes(q)) out.push(n);
      if (out.length >= 40) break;
    }
    return [...new Set(out)].sort((x, y) => {
      const px = x.toUpperCase().startsWith(q) ? 0 : 1;
      const py = y.toUpperCase().startsWith(q) ? 0 : 1;
      return px - py || x.localeCompare(y);
    });
  }, [resolved, value]);

  const commit = (name: string) => {
    partCompareStore.setPart(which, name);
    setQuery(null);
    setOpen(false);
  };

  const found = resolved?.part ?? null;

  return (
    <div className="part-compare-lookup">
      <input
        ref={inputRef}
        className="part-compare-input"
        data-testid={`compare-part-${which}`}
        placeholder={resolved ? 'Component…' : 'Pick a board first'}
        disabled={!resolved}
        value={value}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => { window.setTimeout(() => setOpen(false), 120); }}
        onKeyDown={e => {
          if (e.key === 'Enter') commit(matches[0] ?? value);
          else if (e.key === 'Escape') { setQuery(null); setOpen(false); }
        }}
      />
      <span
        className={`part-compare-pincount${found ? '' : ' missing'}`}
        data-testid={`compare-pins-${which}`}
      >
        {found ? `${found.pins.length} pins` : (ref?.partName ? 'not on this board' : '')}
      </span>
      {open && matches.length > 0 && (
        <div className="part-compare-suggest" data-testid={`compare-suggest-${which}`}>
          {matches.slice(0, 12).map(name => (
            <div
              key={name}
              className="part-compare-suggest-row"
              onMouseDown={e => { e.preventDefault(); commit(name); }}
            >
              {name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BoardPicker({ which }: { which: 'a' | 'b' }) {
  const state = usePartCompare();
  const { tabs } = useBoardStore();
  const loaded = tabs.filter(t => t.board !== null);
  const ref = state[which];

  return (
    <select
      className="part-compare-board"
      data-testid={`compare-board-${which}`}
      value={ref?.tabId ?? ''}
      onChange={e => {
        const v = e.target.value;
        if (v === '') partCompareStore.setSide(which, null);
        else partCompareStore.setBoard(which, Number(v));
      }}
    >
      <option value="">— pick a board —</option>
      {loaded.map(t => (
        <option key={t.id} value={t.id}>{shortName(t.fileName)}</option>
      ))}
    </select>
  );
}

// ── The tool ──────────────────────────────────────────────────────────────

export function PartCompareTool() {
  const state = usePartCompare();
  // Subscribed so the comparison re-runs when a board finishes loading or a
  // tab closes underneath us. `tabs` doubles as the memo key for `resolveSide`,
  // which scans the parts array and must not run per render.
  const { tabs } = useBoardStore();

  const bodyRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWide(e.contentRect.width >= WIDE_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Exactly two boards open and nothing picked yet — there is only one
  // comparison on offer, so the pickers start filled in. In an effect rather
  // than at render time because it writes to a store other components read.
  const loadedIds = useMemo(
    () => tabs.filter(t => t.board !== null).map(t => t.id),
    [tabs],
  );
  useEffect(() => {
    partCompareStore.autoFillBoards(loadedIds);
  }, [loadedIds]);

  const sideA = useMemo(() => resolveSide(state.a, tabs), [state.a, tabs]);
  const sideB = useMemo(() => resolveSide(state.b, tabs), [state.b, tabs]);

  const result = useMemo(() => {
    if (!sideA?.part || !sideB?.part) return null;
    const settings = renderSettingsStore.settings;
    return comparePart(
      { board: sideA.board, part: sideA.part },
      { board: sideB.board, part: sideB.part },
      { mode: state.mode, isBulkNet: n => isGroundNet(settings, n) },
    );
  }, [sideA, sideB, state.mode]);

  const visibleRows: PinDiffRow[] = useMemo(() => {
    if (!result) return [];
    if (!state.onlyDiffs) return result.rows;
    return result.rows.filter(r => r.status !== 'same' && r.status !== 'nc');
  }, [result, state.onlyDiffs]);

  const pickRow = (row: PinDiffRow) => {
    // Set both sides, active tab last so its focus request is the one the
    // renderer consumes.
    const other = state.a && boardStore.activeTabId === state.a.tabId ? 'b' : 'a';
    const order: Array<'a' | 'b'> = other === 'b' ? ['b', 'a'] : ['a', 'b'];
    for (const which of order) {
      const ref = state[which];
      const side = which === 'a' ? row.a : row.b;
      if (!ref || !side) continue;
      boardStore.selectPinInTab(ref.tabId, ref.partName, side.pinIndex);
    }
  };

  const jump = (which: 'a' | 'b', row: PinDiffRow) => {
    const ref = state[which];
    const side = which === 'a' ? row.a : row.b;
    if (!ref || !side) return;
    boardStore.switchTab(ref.tabId);
    boardStore.selectPinInTab(ref.tabId, ref.partName, side.pinIndex);
  };

  const copy = () => {
    if (!result) return;
    const text = compareToText(
      visibleRows,
      sideA ? shortName(sideA.tab.fileName) : 'A',
      sideB ? shortName(sideB.tab.fileName) : 'B',
      result.hasDiode,
    );
    navigator.clipboard.writeText(text).catch(err => log.ui.warn('compare copy failed:', err));
  };

  const capped = visibleRows.length > ROW_CAP;
  const rows = capped ? visibleRows.slice(0, ROW_CAP) : visibleRows;

  return (
    <div
      className="part-compare"
      data-testid="part-compare"
      data-wide={wide ? 'true' : undefined}
      ref={bodyRef}
    >
      <div className="part-compare-pickers">
        <div className="part-compare-side">
          <div className="part-compare-side-label">A</div>
          <BoardPicker which="a" />
          <PartPicker which="a" />
        </div>
        <button
          className="part-compare-swap"
          data-testid="compare-swap"
          title="Swap the two sides"
          onClick={() => partCompareStore.swap()}
        >⇄</button>
        <div className="part-compare-side">
          <div className="part-compare-side-label">B</div>
          <BoardPicker which="b" />
          <PartPicker which="b" />
        </div>
      </div>

      {!result && (
        <div className="part-compare-empty" data-testid="compare-empty">
          Pick a board and a component on each side. Right-clicking a component
          on the board fills both sides in with the same refdes.
        </div>
      )}

      {result && (
        <>
          <Summary
            result={result}
            visible={visibleRows.length}
            onCopy={copy}
          />
          <div className="part-compare-rows" data-testid="compare-rows">
            {rows.map(row => (
              <Row
                key={row.key}
                row={row}
                wide={wide}
                withDiode={result.hasDiode}
                onPick={pickRow}
                onJump={jump}
              />
            ))}
            {rows.length === 0 && (
              <div className="part-compare-empty">
                No differences — every matched pin agrees.
              </div>
            )}
            {capped && (
              <div className="part-compare-note">
                Showing {ROW_CAP} of {visibleRows.length} rows. Use Copy for the full list.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────

function Summary({
  result, visible, onCopy,
}: {
  result: CompareResult;
  visible: number;
  onCopy: () => void;
}) {
  const state = usePartCompare();
  const { alignment, counts } = result;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  const bits: string[] = [];
  if (counts.differs) bits.push(`${counts.differs} differ`);
  if (counts['only-a']) bits.push(`${counts['only-a']} only in A`);
  if (counts['only-b']) bits.push(`${counts['only-b']} only in B`);
  if (counts.renamed) bits.push(`${counts.renamed} renamed`);
  if (counts.similar) bits.push(`${counts.similar} similar`);
  if (counts.partial) bits.push(`${counts.partial} partial`);

  return (
    <div className="part-compare-summary">
      <div className="part-compare-headline" data-testid="compare-headline">
        <strong data-testid="compare-difference-count">{result.differences}</strong>
        {result.differences === 1 ? ' difference' : ' differences'}
        {bits.length > 0 && <span className="part-compare-bits"> · {bits.join(' · ')}</span>}
      </div>

      <div className="part-compare-align" data-testid="compare-alignment">
        {alignment.matched} of {result.rows.length} rows matched via{' '}
        <em>{MODE_LABEL[alignment.mode as ResolvedAlignMode]}</em>
        {alignment.transform ? ` (${alignment.transform})` : ''}
        {result.candidates[0] && (
          <span className="part-compare-evidence">
            {' '}· nets agree {pct(result.candidates[0].netAgree)}
            , positions {pct(result.candidates[0].geomAgree)}
          </span>
        )}
      </div>

      {alignment.ambiguous && (
        <div className="part-compare-warn" data-testid="compare-ambiguous">
          This package is symmetric and the net names give no clue which way
          round it sits — the pairing is a guess. Check it, or pin an alignment
          mode below.
        </div>
      )}
      {result.sizeMismatch && (
        <div className="part-compare-warn" data-testid="compare-size-mismatch">
          The two footprints are very different sizes — these are probably not
          the same package.
        </div>
      )}

      <div className="part-compare-controls">
        <label className="part-compare-check">
          <input
            type="checkbox"
            data-testid="compare-only-diffs"
            checked={state.onlyDiffs}
            onChange={e => partCompareStore.setOnlyDiffs(e.target.checked)}
          />
          only differences
        </label>
        <select
          className="part-compare-mode"
          data-testid="compare-mode"
          value={state.mode}
          onChange={e => partCompareStore.setMode(e.target.value as AlignMode)}
          title="How pins are paired up. Auto ranks every strategy by how well it explains the nets and the pad positions."
        >
          {(['auto', 'name', 'number', 'order', 'geometry'] as AlignMode[]).map(m => {
            const cand = result.candidates.find(c => c.mode === m);
            const unavailable = m !== 'auto' && !cand;
            return (
              <option key={m} value={m} disabled={unavailable}>
                {MODE_LABEL[m]}{unavailable ? ' (n/a)' : ''}
              </option>
            );
          })}
        </select>
        <button className="part-compare-copy" data-testid="compare-copy" onClick={onCopy}>
          Copy {visible}
        </button>
      </div>
    </div>
  );
}

// ── One pin row ───────────────────────────────────────────────────────────

function Row({
  row, wide, withDiode, onPick, onJump,
}: {
  row: PinDiffRow;
  wide: boolean;
  withDiode: boolean;
  onPick: (r: PinDiffRow) => void;
  onJump: (which: 'a' | 'b', r: PinDiffRow) => void;
}) {
  const net = (which: 'a' | 'b') => {
    const s = which === 'a' ? row.a : row.b;
    if (s == null) return <span className="pc-net-text pc-absent">—</span>;
    return <NetName text={s.rawNet} match={row.nameMatch} side={which} />;
  };

  const badge = (
    <span
      className={`part-compare-badge s-${row.status}`}
      title={STATUS_TITLE[row.status] + (row.similarity != null
        ? ` (${Math.round(row.similarity * 100)}% shared neighbours)` : '')}
      data-status={row.status}
    >
      {statusSymbol(row.status)}
    </span>
  );

  const diode = (s: PinDiffRow['a']) => (s?.diode ? formatDiode(s.diode) : '');

  return (
    <div
      className={`part-compare-row s-${row.status}${row.diodeDiffers ? ' diode-differs' : ''}`}
      data-testid="compare-row"
      data-status={row.status}
      onClick={() => onPick(row)}
    >
      {wide ? (
        <>
          <span className="pc-pin">{row.a?.label ?? ''}</span>
          <span className="pc-net" onDoubleClick={() => onJump('a', row)}>{net('a')}</span>
          {badge}
          <span className="pc-net" onDoubleClick={() => onJump('b', row)}>{net('b')}</span>
          <span className="pc-pin">{row.b?.label ?? ''}</span>
          {withDiode && (
            <span className="pc-diode">{diode(row.a)}{diode(row.a) || diode(row.b) ? ' / ' : ''}{diode(row.b)}</span>
          )}
        </>
      ) : (
        <>
          <span className="pc-pin">{row.a?.label ?? row.b?.label ?? ''}</span>
          <span className="pc-stack">
            <span className="pc-line" onDoubleClick={() => onJump('a', row)}>
              <span className="pc-tag">A</span>{net('a')}
              {withDiode && diode(row.a) && <span className="pc-diode">{diode(row.a)}</span>}
            </span>
            <span className="pc-line" onDoubleClick={() => onJump('b', row)}>
              <span className="pc-tag">B</span>{net('b')}
              {withDiode && diode(row.b) && <span className="pc-diode">{diode(row.b)}</span>}
            </span>
          </span>
          {badge}
        </>
      )}
    </div>
  );
}
