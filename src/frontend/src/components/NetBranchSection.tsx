/**
 * NetBranchSection — the net half of the Info tab.
 *
 * Rendered by `ComponentInfoBody` only when a *pin* is selected and that pin
 * carries a net (a part-only selection derives its net from an arbitrary pin,
 * so showing a branch there would be a guess). Lists every component that
 * touches the net as a branch hanging off the net node.
 *
 * The interaction contract — the reason this is its own component — is that a
 * row has TWO distinct click zones:
 *
 *   - the chevron button expands the row's spoiler and does nothing else:
 *     the board, the selection and the net highlight are all untouched, so
 *     you can read a neighbour's pinout without losing your place;
 *   - the row body selects that component (`focusPart`), which pans the board
 *     and retargets the whole Info tab to it.
 *
 * The chevron stops propagation so the two can never fire together.
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
  const [showAll, setShowAll] = useState(false);

  const rows = useMemo(() => buildBranchRows(board, net), [board, net]);

  const netEntry = board.nets.get(net);
  const pinCount = netEntry?.pinIndices.length ?? 0;
  const isHighlighted = selection.highlightedNet === net;
  const obdNets = obd.hasData ? obd.lookup(net) : [];

  const shown = showAll ? rows : rows.slice(0, ROW_CAP);

  const toggle = (partIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(partIndex)) next.add(partIndex);
      return next;
    });
  };

  return (
    <div className="net-branch" data-testid="net-branch">
      <button
        type="button"
        className={`net-branch-header ${isHighlighted ? 'net-branch-header--on' : ''}`}
        onClick={() => boardStore.highlightNet(isHighlighted ? null : net)}
        title={isHighlighted ? 'Clear the net highlight' : 'Highlight this net on the board'}
      >
        <span className="net-branch-kicker">NET</span>
        <span className="net-branch-name" data-testid="net-branch-name">{net}</span>
        <span className="badge">{pinCount} pin{pinCount === 1 ? '' : 's'}</span>
        <span className="badge" data-testid="net-branch-count">
          {rows.length} comp{rows.length === 1 ? '' : 's'}
        </span>
        {obdNets.length > 0 && (
          <span className="net-branch-obd"><ObdCell nets={obdNets} /></span>
        )}
      </button>

      <div className="net-branch-list">
        {shown.map((row, i) => (
          <BranchItem
            key={row.partIndex}
            row={row}
            board={board}
            net={net}
            obd={obd}
            isSelected={selection.partIndex === row.partIndex}
            isLast={i === shown.length - 1 && shown.length === rows.length}
            isExpanded={expanded.has(row.partIndex)}
            onToggle={() => toggle(row.partIndex)}
          />
        ))}
        {rows.length > shown.length && (
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
  isSelected,
  isLast,
  isExpanded,
  onToggle,
}: {
  row: BranchRow;
  board: BoardData;
  net: string;
  obd: { hasData: boolean; lookup: (netName: string) => ObdNet[] };
  isSelected: boolean;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { part, netPinIndices, netPinLabel } = row;
  return (
    <div className={`net-branch-item ${isLast ? 'net-branch-item--last' : ''}`}>
      <div
        className={`net-branch-row ${isSelected ? 'net-branch-row--selected' : ''}`}
        data-testid="net-branch-row"
        data-refdes={part.name}
        onClick={() => boardStore.focusPart(part.name)}
        title={`Select ${part.name} on the board`}
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
        {isSelected && <span className="net-branch-this" title="Currently selected component">● this</span>}
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
      <div className="net-branch-detail-meta">
        {metaBits.length > 0 ? metaBits.join(' · ') : <span className="net-branch-muted">no BOM metadata</span>}
        <span className="net-branch-muted"> · {part.pins.length} pins total</span>
      </div>
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

/** Group a net's pin references by part. One row per component, carrying the
 *  pins of that component which land on the net. Sorted by refdes with
 *  numeric collation so R2 precedes R10. */
function buildBranchRows(board: BoardData, net: string): BranchRow[] {
  const entry = board.nets.get(net);
  if (!entry) return [];
  const byPart = new Map<number, number[]>();
  for (const { partIndex, pinIndex } of entry.pinIndices) {
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
