/**
 * ComponentInfoBody — the single source of truth for the component-inspection
 * UI rendered in BOTH the floating Component Info panel
 * (`panels/ComponentInfoPanel.tsx`) and the board sidebar's Info tab
 * (`components/BoardSidebar.tsx` → InfoTab).
 *
 * These two surfaces were near-duplicate copies that had functionally
 * diverged (the sidebar lacked the BOM-alternates switcher, they disagreed on
 * whether to show board-level OBD diagnosis when nothing is selected, and they
 * carried two slightly-different copies of the OBD cell). They now both render
 * this component so they can't drift again — keep all inspection logic HERE,
 * not in either call site.
 *
 * Behavior unified here:
 *   - The BOM-alternates switcher (BomClusterSection) is available in both.
 *   - Board-level OBD DIAGNOSIS notes render regardless of whether a part is
 *     selected (they are board-scoped, not pin-scoped).
 *   - A single ObdCell renders the per-pin diode/V/Ω readings in both.
 */
import { useEffect } from 'react';
import { bomReasonLabel, type BoardData, type BomAlternateCluster } from '../parsers';
import type { SelectionState } from '../store/board-store';
import { boardStore, bomClusterSig } from '../store/board-store';
import { obdStore, useObdNetLookup, type ObdNet } from '../store/obd-store';
import { formatDiode } from '../store/diode-readings';
import { DiagnosisNotes } from './DiagnosisNotes';

export interface ComponentInfoBodyProps {
  board: BoardData;
  selection: SelectionState;
  /** Board number extracted from the file name, for OpenBoardData lookup. */
  boardNumber?: string;
  /** When true, every BOM-cluster member is rendered (X-ray); when false only
   *  the chosen primary is. Drives the BomClusterSection copy + click behavior. */
  showBomAlternates: boolean;
  bomClusterSelections: ReadonlyMap<string, string>;
}

export function ComponentInfoBody({
  board,
  selection,
  boardNumber,
  showBomAlternates,
  bomClusterSelections,
}: ComponentInfoBodyProps) {
  const obd = useObdNetLookup(boardNumber);

  // Auto-load matches + cached data when the active board changes. Cheap:
  // hits the backend's match endpoint once per board, and the per-bpath
  // cache loaders are short-circuited if already in memory.
  useEffect(() => {
    if (boardNumber) obdStore.loadMatches(boardNumber);
  }, [boardNumber]);

  const selectedPart =
    selection.partIndex !== null ? board.parts[selection.partIndex] ?? null : null;

  // DIAGNOSIS_DATA notes from openboarddata.org are board-level (not pin-
  // specific), so render them regardless of whether a component is selected.
  const obdNotes = obd.loadedVariants
    .filter(v => v.sections && v.sections.length > 0)
    .map(v => <DiagnosisNotes key={v.bpath} sections={v.sections!} board={board} />);

  if (!selectedPart) {
    return (
      <div className="panel-content component-info" data-testid="component-info">
        <div className="panel-empty">Click a component to inspect</div>
        {obdNotes}
      </div>
    );
  }

  // Look up the BOM-alternate cluster the selected part belongs to (if any).
  // Matched by refdes so it survives the parts-array filtering done by
  // `buildRenderedBoard` when alternates are hidden.
  const cluster: BomAlternateCluster | null =
    board.bomClusters?.find(c => c.memberRefdes.includes(selectedPart.name)) ?? null;

  const meta = selectedPart.meta;
  const metaRows: Array<[string, string]> = [];
  if (meta?.partType) metaRows.push(['Type', meta.partType]);
  if (meta?.value) metaRows.push(['Value', meta.value]);
  if (meta?.package) metaRows.push(['Package', meta.package]);
  if (meta?.serial) metaRows.push(['Serial', meta.serial]);
  if (meta?.heightMils != null) metaRows.push(['Height', `${meta.heightMils.toFixed(2)} mils`]);
  if (meta?.angleDeg != null) metaRows.push(['Rotation', `${meta.angleDeg}°`]);

  return (
    <div className="panel-content component-info" data-testid="component-info">
      <div className="info-header">
        <h3>{selectedPart.name}</h3>
        <div className="info-meta">
          <span className={`badge badge-${selectedPart.side}`}>{selectedPart.side}</span>
          <span className="badge">{selectedPart.type}</span>
          <span className="badge">{selectedPart.pins.length} pins</span>
          {obd.hasData && (
            <span
              className="badge"
              data-testid="obd-badge"
              title={`OpenBoardData loaded: ${obd.variantCount} variant(s)`}
              style={{ background: '#3a5', color: '#fff' }}
            >
              OBD ×{obd.variantCount}
            </span>
          )}
        </div>
      </div>

      {metaRows.length > 0 && (
        <table className="part-meta-table" data-testid="part-meta">
          <tbody>
            {metaRows.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {cluster && (
        <BomClusterSection
          cluster={cluster}
          selectedRefdes={selectedPart.name}
          showAll={showBomAlternates}
          selections={bomClusterSelections}
        />
      )}

      <div className="pin-table-container">
        <table className="pin-table">
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
            {selectedPart.pins.map((pin, idx) => {
              const isSelected = selection.pinIndex === idx;
              const isNetHighlighted = selection.highlightedNet === pin.net && pin.net !== '';
              const obdNets = obd.hasData ? obd.lookup(pin.net) : [];
              return (
                <tr
                  key={idx}
                  className={[
                    isSelected ? 'pin-selected' : '',
                    isNetHighlighted ? 'pin-net-highlight' : '',
                  ].join(' ')}
                  onClick={() => {
                    if (selection.partIndex !== null) {
                      boardStore.selectPin(selection.partIndex, idx);
                    }
                  }}
                >
                  <td>{pin.number}</td>
                  <td>{pin.name}</td>
                  <td
                    className="pin-net"
                    onClick={(e) => {
                      e.stopPropagation();
                      boardStore.highlightNet(
                        selection.highlightedNet === pin.net ? null : pin.net,
                      );
                    }}
                  >
                    {pin.net}
                  </td>
                  {board.diodeReference && (
                    <td className="pin-diode" data-testid="pin-diode-cell"
                        style={{ fontSize: 11, fontFamily: 'monospace',
                                 color: pin.diode?.kind === 'open' ? '#f87171'
                                      : pin.diode?.kind === 'value' ? '#4ade80' : '#666' }}>
                      {pin.diode && pin.diode.kind !== 'none'
                        ? formatDiode(pin.diode)
                        : <span style={{ color: '#666' }}>—</span>}
                    </td>
                  )}
                  {obd.hasData && (
                    <td className="pin-obd" data-testid="pin-obd-cell">
                      <ObdCell nets={obdNets} />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Structured DIAGNOSIS_DATA from openboarddata.org — power sequencing,
          repair notes, etc. Each fetched variant rendered sequentially. */}
      {obdNotes}
    </div>
  );
}

function BomClusterSection({
  cluster,
  selectedRefdes,
  showAll,
  selections,
}: {
  cluster: BomAlternateCluster;
  selectedRefdes: string;
  showAll: boolean;
  selections: ReadonlyMap<string, string>;
}) {
  const sig = bomClusterSig(cluster.memberRefdes);
  const chosenRefdes = selections.get(sig) ?? cluster.defaultPrimaryRefdes;
  const reasonLabel = bomReasonLabel(cluster.reason);

  return (
    <div className="bom-cluster-section" data-testid="bom-cluster-section">
      <div
        className="bom-cluster-header"
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginTop: 8,
          padding: '4px 6px',
          background: 'rgba(120,80,200,0.12)',
          borderRadius: 4,
        }}
      >
        <strong style={{ fontSize: 12 }}>BOM alternates ({cluster.memberRefdes.length})</strong>
        <span style={{ fontSize: 11, color: '#888' }} title={`Auto-pick reason: ${reasonLabel}`}>
          auto: {reasonLabel}
        </span>
      </div>
      <div style={{ fontSize: 11, color: '#888', padding: '2px 6px' }}>
        Only one is fitted per BOM.{' '}
        {showAll ? 'All shown (X-ray).' : 'Click a row to switch which member is rendered.'}
      </div>
      <table
        className="bom-cluster-table"
        data-testid="bom-cluster-table"
        style={{ width: '100%', fontSize: 11, marginTop: 4 }}
      >
        <tbody>
          {cluster.memberRefdes.map((refdes, i) => {
            const isChosen = refdes === chosenRefdes;
            const isSelected = refdes === selectedRefdes;
            const memberIdx = cluster.memberIndices[i];
            const statusLabel = memberStatusLabel(isChosen, isSelected);
            let rowBackground: string | undefined;
            if (isSelected) rowBackground = 'rgba(120,80,200,0.22)';
            else if (isChosen) rowBackground = 'rgba(120,80,200,0.10)';
            return (
              <tr
                key={refdes}
                style={{
                  cursor: showAll ? 'default' : 'pointer',
                  background: rowBackground,
                }}
                onClick={() => {
                  if (showAll) {
                    // Show-all mode: clicking a row jumps the selection to that member.
                    boardStore.selectPart(memberIdx);
                  } else {
                    // Hidden mode: clicking sets the active primary.
                    boardStore.selectBomClusterPrimary(sig, refdes);
                  }
                }}
                title={showAll ? `Select ${refdes}` : `Render ${refdes} as the primary`}
              >
                <td style={{ padding: '2px 6px', width: 18 }}>
                  {isChosen ? '●' : <span style={{ color: '#666' }}>○</span>}
                </td>
                <td style={{ padding: '2px 6px', fontWeight: isSelected ? 700 : 400 }}>{refdes}</td>
                <td style={{ padding: '2px 6px', color: '#888' }}>{statusLabel}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Suffix shown next to a BOM-cluster member: marks the rendered primary, the
 *  currently-selected member, or both. */
function memberStatusLabel(isChosen: boolean, isSelected: boolean): string {
  if (isChosen && isSelected) return '(primary, selected)';
  if (isChosen) return '(primary)';
  if (isSelected) return '(selected)';
  return '';
}

/** Single shared OBD pin-cell renderer (replaces the former ObdCell /
 *  ObdSidebarCell duplicate pair). Renders deduped diode / voltage / resistance
 *  readings plus an optional comments tooltip. */
export function ObdCell({ nets }: { nets: ObdNet[] }) {
  if (nets.length === 0) return <span style={{ color: '#666' }}>—</span>;
  // Defensive against null arrays (older cached payloads, future API drift).
  const dedupe = (xs: (string | null | undefined)[]) =>
    Array.from(new Set(xs.filter((v): v is string => typeof v === 'string' && v.length > 0)));
  const diodes = dedupe(nets.map(n => n.diode));
  const volts = dedupe(nets.map(n => n.voltage));
  const ohms = dedupe(nets.map(n => n.resistance));
  const allComments = Array.from(
    new Set(
      nets
        .flatMap(n => (Array.isArray(n.comments) ? n.comments : []))
        .filter((c): c is string => typeof c === 'string' && c.trim().length > 0),
    ),
  );
  const parts: string[] = [];
  if (diodes.length) parts.push(`d ${diodes.join('/')}`);
  if (volts.length) parts.push(`${volts.join('/')} V`);
  if (ohms.length) parts.push(`${ohms.join('/')} Ω`);
  return (
    <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
      {parts.length > 0 ? parts.join(' · ') : <span style={{ color: '#666' }}>—</span>}
      {allComments.length > 0 && (
        <span title={allComments.join('\n')} style={{ marginLeft: 4, cursor: 'help' }}>
          📝
        </span>
      )}
    </span>
  );
}
