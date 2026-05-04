import { useEffect } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore, bomClusterSig } from '../store/board-store';
import { extractBoardNumberFromFilename, useObdNetLookup, obdStore, type ObdNet } from '../store/obd-store';
import { DiagnosisNotes } from '../components/DiagnosisNotes';
import type { BomAlternateCluster } from '../parsers';

export function ComponentInfoPanel() {
  const { selectedPart, selection, board, fileName, showBomAlternates, bomClusterSelections } = useBoardStore();
  const boardNumber = extractBoardNumberFromFilename(fileName) ?? undefined;
  const obd = useObdNetLookup(boardNumber);

  // Look up the BOM-alternate cluster the selected part belongs to (if any).
  // Matched by refdes so it survives the parts-array filtering done by
  // `buildRenderedBoard` when alternates are hidden.
  const cluster: BomAlternateCluster | null = (() => {
    if (!board?.bomClusters || !selectedPart) return null;
    return board.bomClusters.find(c => c.memberRefdes.includes(selectedPart.name)) ?? null;
  })();

  // Auto-load matches + cached data when the active board changes. Cheap:
  // hits the backend's match endpoint once per board, and the per-bpath
  // cache loaders are short-circuited if already in memory.
  useEffect(() => {
    if (boardNumber) obdStore.loadMatches(boardNumber);
  }, [boardNumber]);

  if (!board) {
    return <div className="panel-empty">No board loaded</div>;
  }

  if (!selectedPart) {
    return <div className="panel-empty">Click a component to inspect</div>;
  }

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
                        selection.highlightedNet === pin.net ? null : pin.net
                      );
                    }}
                  >
                    {pin.net}
                  </td>
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
      {obd.loadedVariants
        .filter(v => v.sections && v.sections.length > 0)
        .map(v => (
          <DiagnosisNotes
            key={v.bpath}
            sections={v.sections!}
            board={board}
          />
        ))}
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
  const reasonLabel = cluster.reason === 'shape-named-device'
    ? 'named device'
    : cluster.reason === 'lowest-refdes'
      ? 'lowest refdes'
      : 'largest footprint';

  return (
    <div className="bom-cluster-section" data-testid="bom-cluster-section">
      <div className="bom-cluster-header" style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 8, padding: '4px 6px', background: 'rgba(120,80,200,0.12)', borderRadius: 4 }}>
        <strong style={{ fontSize: 12 }}>BOM alternates ({cluster.memberRefdes.length})</strong>
        <span style={{ fontSize: 11, color: '#888' }} title={`Auto-pick reason: ${reasonLabel}`}>auto: {reasonLabel}</span>
      </div>
      <div style={{ fontSize: 11, color: '#888', padding: '2px 6px' }}>
        Only one is fitted per BOM. {showAll ? 'All shown (X-ray).' : 'Click a row to switch which member is rendered.'}
      </div>
      <table className="bom-cluster-table" data-testid="bom-cluster-table" style={{ width: '100%', fontSize: 11, marginTop: 4 }}>
        <tbody>
          {cluster.memberRefdes.map((refdes, i) => {
            const isChosen = refdes === chosenRefdes;
            const isSelected = refdes === selectedRefdes;
            const memberIdx = cluster.memberIndices[i];
            return (
              <tr
                key={refdes}
                style={{
                  cursor: showAll ? 'default' : 'pointer',
                  background: isSelected ? 'rgba(120,80,200,0.22)' : isChosen ? 'rgba(120,80,200,0.10)' : undefined,
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
                <td style={{ padding: '2px 6px', color: '#888' }}>
                  {isChosen && !isSelected ? '(primary)' : isSelected && isChosen ? '(primary, selected)' : isSelected ? '(selected)' : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ObdCell({ nets }: { nets: ObdNet[] }) {
  if (nets.length === 0) return <span style={{ color: '#666' }}>—</span>;
  // Defensive against null arrays (older cached payloads, future API drift).
  const diodes = unique(nets.map(n => n.diode).filter((v): v is string => !!v));
  const volts = unique(nets.map(n => n.voltage).filter((v): v is string => !!v));
  const ohms = unique(nets.map(n => n.resistance).filter((v): v is string => !!v));
  const allComments = unique(
    nets.flatMap(n => n.comments ?? []).filter((c): c is string => typeof c === 'string' && c.trim().length > 0),
  );
  const parts: string[] = [];
  if (diodes.length) parts.push(`d ${diodes.join('/')}`);
  if (volts.length) parts.push(`${volts.join('/')} V`);
  if (ohms.length) parts.push(`${ohms.join('/')} Ω`);
  return (
    <span style={{ fontSize: 11, fontFamily: 'monospace' }}>
      {parts.length > 0 ? parts.join(' · ') : <span style={{ color: '#666' }}>—</span>}
      {allComments.length > 0 && (
        <span title={allComments.join('\n')} style={{ marginLeft: 4, cursor: 'help' }}>📝</span>
      )}
    </span>
  );
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
