/**
 * NetBranchSection — the net half of the Info tab.
 *
 * Rendered by `ComponentInfoBody` only when a *pin* is selected and that pin
 * carries a net (a part-only selection derives its net from an arbitrary pin,
 * so showing a branch there would be a guess). Lists every OTHER component
 * that touches the net as a branch hanging off the net node.
 *
 * ── Placement and size ───────────────────────────────────────────────────
 * The block is always a row INSIDE the pin table, directly under the pin it
 * belongs to, so the link between pin and net is a few pixels rather than a
 * page. The pin row above already names the net, so the header here is a
 * NAMELESS strip: counts, OBD, lit state.
 *
 * A net with fifty components must not push the rest of the pinout off the
 * screen, so only the first NET_TREE_PREVIEW_ROWS hang open and the rest sit
 * behind a "+N more" spoiler. Two further escapes: the strip's caret collapses
 * the block entirely (the pin table then reads as one uninterrupted list), and
 * past ROW_CAP even the expanded list is truncated behind "show all".
 *
 * Ground rails never get here at all — `ComponentInfoBody` skips them, because
 * "every component touching GND" is most of the board and answers nothing.
 *
 * ── The selected part is not a row ───────────────────────────────────────
 * It is the subject of the block above; listing it again as "● this" was pure
 * duplication. Its own other pins on the net are marked in the pin table
 * instead (the `pin-echo` rows in `ComponentInfoBody`).
 *
 * ── Interaction: three verbs, three hit zones ────────────────────────────
 *   - chevron      → open this component's pinout in place. Touches nothing
 *                    else: no selection, no pan, no highlight change.
 *   - single click → PREVIEW. Pans the board to the component and marks the
 *                    row; the inspector keeps its subject and this tree stays
 *                    open, so you can sweep a rail without losing your place.
 *   - double click → PROMOTE. `promotePartOnNet` re-roots the inspector on
 *                    that component *via its pin on this net*, so the tree
 *                    survives the move and the old subject becomes a row here.
 *
 * The chevron stops propagation so it can never fire with the others. Preview
 * also fires on the first click of a double click; that is harmless, because
 * both navigate to the same part.
 *
 * Expand state is deliberately local and keyed by net: the parent mounts this
 * with `key={net}`, so switching nets resets every open spoiler.
 */
import { useMemo, useState } from 'react';
import { IconChevronRight, IconChevronDown } from '@tabler/icons-react';
import type { BoardData, Part, Pin } from '../parsers';
import { pinDisplayId } from '../parsers/types';
import type { SelectionState } from '../store/board-store';
import { boardStore } from '../store/board-store';
import type { ObdNet } from '../store/obd-store';
import { formatDiode } from '../store/diode-readings';
import { ObdCell } from './ObdCell';

/** Rows rendered before the overflow line kicks in. Ground/power rails can
 *  carry thousands of parts; the list stays usable and the user opts in to
 *  the rest. */
const ROW_CAP = 100;

/** Components shown before the "+N more" spoiler. Keeps the block about four
 *  rows tall whatever the net's size, so the pinout underneath stays visible. */
export const NET_TREE_PREVIEW_ROWS = 3;

export interface NetBranchSectionProps {
  board: BoardData;
  /** The net the selected pin sits on. Never empty (parent guards). */
  net: string;
  selection: SelectionState;
  /** OBD net lookup from the parent, so we don't rebuild the index here. */
  obd: { hasData: boolean; lookup: (netName: string) => ObdNet[] };
}

interface BranchRow {
  partIndex: number;
  part: Part;
  /** Indices (into part.pins) of the pins that sit on THIS net. */
  netPinIndices: number[];
  /** Display ids of those pins, e.g. "A3, B7". */
  netPinLabel: string;
}

export function NetBranchSection({ board, net, selection, obd }: NetBranchSectionProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  /** Past the first NET_TREE_PREVIEW_ROWS. */
  const [showMore, setShowMore] = useState(false);
  /** Past ROW_CAP, once showMore is on. */
  const [showAll, setShowAll] = useState(false);
  /** Row last previewed by a single click — panel-local "where was I looking",
   *  not board state, and it resets with the net because the parent keys us. */
  const [preview, setPreview] = useState<number | null>(null);

  const rows = useMemo(
    () => buildBranchRows(board, net, selection.partIndex),
    [board, net, selection.partIndex],
  );

  // Preview → expanded (capped) → uncapped. Each step is opt-in, so a
  // 400-component rail can never take the screen without being asked twice.
  const shown = !showMore
    ? rows.slice(0, NET_TREE_PREVIEW_ROWS)
    : showAll
      ? rows
      : rows.slice(0, ROW_CAP);
  const hiddenByPreview = showMore ? 0 : rows.length - shown.length;
  const hiddenByCap = showMore && !showAll ? rows.length - shown.length : 0;

  const toggle = (partIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(partIndex)) next.add(partIndex);
      return next;
    });
  };

  return (
    <div className="net-branch net-branch--inline" data-testid="net-branch">
      <div className="net-branch-list">
          {shown.map((row, i) => (
            <BranchItem
              key={row.partIndex}
              row={row}
              board={board}
              net={net}
              obd={obd}
              isPreviewed={preview === row.partIndex}
              isLast={i === shown.length - 1 && shown.length === rows.length}
              isExpanded={expanded.has(row.partIndex)}
              onToggle={() => toggle(row.partIndex)}
              onPreview={() => { setPreview(row.partIndex); boardStore.previewPart(row.part.name); }}
              onPromote={() => boardStore.promotePartOnNet(row.partIndex, row.netPinIndices[0] ?? 0)}
            />
          ))}

          {/* Stage 1: the rest of a normal net, one click away. */}
          {hiddenByPreview > 0 && (
            <div className="net-branch-item net-branch-item--last net-branch-more">
              <button
                type="button"
                className="net-branch-more-btn"
                data-testid="net-branch-more"
                onClick={() => setShowMore(true)}
              >
                + {hiddenByPreview} more
              </button>
            </div>
          )}

          {/* Stage 2: past ROW_CAP, ask again — this is rail territory. */}
          {hiddenByCap > 0 && (
            <div className="net-branch-overflow">
              Showing {shown.length} of {rows.length} —{' '}
              <button type="button" className="net-branch-showall" onClick={() => setShowAll(true)}>
                show all
              </button>
            </div>
          )}
      </div>
    </div>
  );
}

/** One component on the net: the clickable row plus its optional spoiler. */
function BranchItem({
  row,
  board,
  net,
  obd,
  isPreviewed,
  isLast,
  isExpanded,
  onToggle,
  onPreview,
  onPromote,
}: {
  row: BranchRow;
  board: BoardData;
  net: string;
  obd: { hasData: boolean; lookup: (netName: string) => ObdNet[] };
  isPreviewed: boolean;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  onPreview: () => void;
  onPromote: () => void;
}) {
  const { part, netPinIndices, netPinLabel } = row;
  return (
    <div className={`net-branch-item ${isLast ? 'net-branch-item--last' : ''}`}>
      <div
        className={`net-branch-row ${isPreviewed ? 'net-branch-row--preview' : ''}`}
        data-testid="net-branch-row"
        data-refdes={part.name}
        onClick={onPreview}
        onDoubleClick={onPromote}
        title={`${part.name} — click to show it on the board, double-click to inspect it`}
      >
        <button
          type="button"
          className="net-branch-chevron"
          data-testid="net-branch-chevron"
          aria-expanded={isExpanded}
          onClick={(e) => {
            // The whole point of the separate hit area: expanding must not
            // touch the board selection.
            e.stopPropagation();
            onToggle();
          }}
          // Suppressed so a fast double-click on the chevron can't fall through
          // to promote — the chevron's contract is "changes nothing else".
          onDoubleClick={(e) => e.stopPropagation()}
          title={isExpanded ? `Collapse ${part.name} details` : `Show ${part.name} details (keeps the current selection)`}
        >
          {isExpanded ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />}
        </button>
        <span className="net-branch-refdes">{part.name}</span>
        <span className={`badge badge-${part.side}`}>{part.side}</span>
        <span className="net-branch-pins">
          pin{netPinIndices.length === 1 ? '' : 's'}{' '}
          <span className="net-branch-pin-ids">{netPinLabel}</span>
        </span>
      </div>
      {isExpanded && (
        <BranchDetail part={part} board={board} net={net} obd={obd} netPinIndices={netPinIndices} />
      )}
    </div>
  );
}

/** Spoiler body: the same facts the top block shows for a part, compact.
 *  Pin rows are inert on purpose — opening a spoiler must never navigate you
 *  out of it. Only the net cell acts (highlights that net). */
function BranchDetail({
  part,
  board,
  net,
  obd,
  netPinIndices,
}: {
  part: Part;
  board: BoardData;
  net: string;
  obd: { hasData: boolean; lookup: (netName: string) => ObdNet[] };
  netPinIndices: number[];
}) {
  const onNet = useMemo(() => new Set(netPinIndices), [netPinIndices]);
  const meta = part.meta;
  const metaBits: string[] = [];
  if (meta?.partType) metaBits.push(meta.partType);
  if (meta?.value) metaBits.push(meta.value);
  if (meta?.package) metaBits.push(meta.package);
  if (meta?.angleDeg != null) metaBits.push(`${meta.angleDeg}°`);

  return (
    <div className="net-branch-detail" data-testid="net-branch-detail">
      {/* Only when there is something to say. "no BOM metadata · 2 pins total"
          spent a whole row announcing nothing — the pin table directly below
          already shows how many pins there are. */}
      {metaBits.length > 0 && (
        <div className="net-branch-detail-meta">{metaBits.join(' · ')}</div>
      )}
      <table className="pin-table net-branch-pin-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Name</th>
            <th>Net</th>
            {board.diodeReference && <th title="diode-mode reference reading baked into the board file (volts)">Diode</th>}
            {obd.hasData && <th title="diode / V / Ω from OpenBoardData">OBD</th>}
          </tr>
        </thead>
        <tbody>
          {part.pins.map((pin, idx) => (
            <tr key={idx} className={onNet.has(idx) ? 'net-branch-pin-on-net' : ''}>
              <td>{pin.number}</td>
              <td>{pin.name}</td>
              <td
                className="pin-net"
                onClick={(e) => {
                  e.stopPropagation();
                  if (pin.net) boardStore.highlightNet(pin.net === net ? null : pin.net);
                }}
                title={pin.net ? `Highlight ${pin.net}` : undefined}
              >
                {pin.net}
              </td>
              {board.diodeReference && <td className="pin-diode">{diodeText(pin)}</td>}
              {obd.hasData && (
                <td className="pin-obd">
                  <ObdCell nets={obd.lookup(pin.net)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function diodeText(pin: Pin) {
  if (!pin.diode || pin.diode.kind === 'none') return <span className="net-branch-muted">—</span>;
  const color = pin.diode.kind === 'open' ? '#f87171' : '#4ade80';
  return <span style={{ color, fontFamily: 'monospace', fontSize: 11 }}>{formatDiode(pin.diode)}</span>;
}

/** Group a net's pin references by part, skipping `excludePartIndex` (the
 *  inspector's own subject — it is the block above, not a branch of itself).
 *  One row per component, carrying the pins of that component which land on
 *  the net. Sorted by refdes with numeric collation so R2 precedes R10. */
function buildBranchRows(board: BoardData, net: string, excludePartIndex: number | null): BranchRow[] {
  const entry = board.nets.get(net);
  if (!entry) return [];
  const byPart = new Map<number, number[]>();
  for (const { partIndex, pinIndex } of entry.pinIndices) {
    if (partIndex === excludePartIndex) continue;
    if (!board.parts[partIndex]) continue;
    const list = byPart.get(partIndex);
    if (list) list.push(pinIndex);
    else byPart.set(partIndex, [pinIndex]);
  }
  const rows: BranchRow[] = [];
  for (const [partIndex, pinIndices] of byPart) {
    const part = board.parts[partIndex];
    pinIndices.sort((a, b) => a - b);
    rows.push({
      partIndex,
      part,
      netPinIndices: pinIndices,
      netPinLabel: pinIndices
        .slice(0, 4)
        .map(i => (part.pins[i] ? pinDisplayId(part.pins[i], i) : String(i + 1)))
        .join(', ') + (pinIndices.length > 4 ? '…' : ''),
    });
  }
  return rows.sort((a, b) => a.part.name.localeCompare(b.part.name, undefined, { numeric: true }));
}
