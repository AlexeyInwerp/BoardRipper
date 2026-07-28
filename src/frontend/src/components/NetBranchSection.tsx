/**
 * NetBranchSection — the net half of the Info tab.
 *
 * Rendered by `ComponentInfoBody` only when a *pin* is selected and that pin
 * carries a net (a part-only selection derives its net from an arbitrary pin,
 * so showing a branch there would be a guess). Lists every OTHER component
 * that touches the net as a branch hanging off the net node.
 *
 * ── Placement ────────────────────────────────────────────────────────────
 * Two placements, chosen by `ComponentInfoBody` on component count:
 *
 *   inline (≤ NET_TREE_INLINE_MAX others) — the block is a row INSIDE the pin
 *     table, directly under the pin it belongs to. The pin row above already
 *     names the net, so the header here is a NAMELESS strip: counts, OBD, lit
 *     state. Collapsible, so the pin table can always be read as one
 *     uninterrupted list again.
 *
 *   below (more than that) — the block sits after the pin table, where it
 *     can't bury the pinout. It is far from the row that spawned it, so here
 *     the header DOES name the net: that repetition is orientation, not
 *     duplication.
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

/** At most this many other components may hang inline inside the pin table.
 *  Above it the block moves below the table so the pinout stays scannable —
 *  a 40-component rail must never push pins 4..42 off the screen. */
export const NET_TREE_INLINE_MAX = 3;

export interface NetBranchSectionProps {
  board: BoardData;
  /** The net the selected pin sits on. Never empty (parent guards). */
  net: string;
  selection: SelectionState;
  /** OBD net lookup from the parent, so we don't rebuild the index here. */
  obd: { hasData: boolean; lookup: (netName: string) => ObdNet[] };
  /** Where the parent mounted us — decides strip-vs-header and collapsibility. */
  placement: 'inline' | 'below';
}

interface BranchRow {
  partIndex: number;
  part: Part;
  /** Indices (into part.pins) of the pins that sit on THIS net. */
  netPinIndices: number[];
  /** Display ids of those pins, e.g. "A3, B7". */
  netPinLabel: string;
}

/** How many components other than `excludePartIndex` sit on `net`. The parent
 *  needs this before rendering to choose a placement, and it is much cheaper
 *  than building the rows. */
export function countNetComponents(board: BoardData, net: string, excludePartIndex: number | null): number {
  const entry = board.nets.get(net);
  if (!entry) return 0;
  const seen = new Set<number>();
  for (const { partIndex } of entry.pinIndices) {
    if (partIndex === excludePartIndex) continue;
    if (board.parts[partIndex]) seen.add(partIndex);
  }
  return seen.size;
}

export function NetBranchSection({ board, net, selection, obd, placement }: NetBranchSectionProps) {
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  // Inline blocks open by default (they are ≤ NET_TREE_INLINE_MAX rows tall, so
  // they cost the pin list almost nothing) but can be collapsed back to the
  // single strip row, which restores an uninterrupted pin table.
  const [open, setOpen] = useState(true);
  /** Row last previewed by a single click — panel-local "where was I looking",
   *  not board state, and it resets with the net because the parent keys us. */
  const [preview, setPreview] = useState<number | null>(null);

  const rows = useMemo(
    () => buildBranchRows(board, net, selection.partIndex),
    [board, net, selection.partIndex],
  );

  const netEntry = board.nets.get(net);
  const pinCount = netEntry?.pinIndices.length ?? 0;
  const isHighlighted = selection.highlightedNet === net;
  const obdNets = obd.hasData ? obd.lookup(net) : [];
  const inline = placement === 'inline';

  const shown = showAll ? rows : rows.slice(0, ROW_CAP);

  const toggle = (partIndex: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(partIndex)) next.add(partIndex);
      return next;
    });
  };

  const toggleHighlight = () => boardStore.highlightNet(isHighlighted ? null : net);

  return (
    <div className={`net-branch net-branch--${placement}`} data-testid="net-branch" data-placement={placement}>
      {inline ? (
        /* Nameless: the pin row directly above already says which net this is. */
        <button
          type="button"
          className="net-strip"
          data-testid="net-strip"
          onClick={toggleHighlight}
          title={isHighlighted ? 'Clear the net highlight' : 'Highlight this net on the board'}
        >
          <span
            className="net-strip-caret"
            data-testid="net-strip-caret"
            aria-expanded={open}
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setOpen(o => !o); }
            }}
            title={open ? 'Collapse — show the pin list uninterrupted' : 'Expand the net'}
          >
            {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </span>
          <span className="net-strip-counts" data-testid="net-strip-counts">
            <b>{pinCount}</b> pin{pinCount === 1 ? '' : 's'} · <b>{rows.length}</b> comp{rows.length === 1 ? '' : 's'}
          </span>
          {obdNets.length > 0 && <span className="net-strip-obd"><ObdCell nets={obdNets} /></span>}
          <span className="net-strip-lit">
            <span className={isHighlighted ? 'net-lit-dot' : 'net-lit-dot net-lit-dot--off'} />
            {isHighlighted ? 'lit' : 'dim'}
          </span>
        </button>
      ) : (
        /* Below the table: far from the row that spawned it, so name the net. */
        <button
          type="button"
          className={`net-branch-header ${isHighlighted ? 'net-branch-header--on' : ''}`}
          onClick={toggleHighlight}
          title={isHighlighted ? 'Clear the net highlight' : 'Highlight this net on the board'}
        >
          <span className="net-branch-kicker">NET</span>
          <span className="net-branch-name" data-testid="net-branch-name">{net}</span>
          <span className="badge">{pinCount} pin{pinCount === 1 ? '' : 's'}</span>
          <span className="badge" data-testid="net-branch-count">
            {rows.length} other{rows.length === 1 ? '' : 's'}
          </span>
          {obdNets.length > 0 && (
            <span className="net-branch-obd"><ObdCell nets={obdNets} /></span>
          )}
        </button>
      )}

      {(!inline || open) && (
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
          {rows.length > shown.length && (
            <div className="net-branch-overflow">
              Showing {shown.length} of {rows.length} —{' '}
              <button type="button" className="net-branch-showall" onClick={() => setShowAll(true)}>
                show all
              </button>
            </div>
          )}
        </div>
      )}
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
