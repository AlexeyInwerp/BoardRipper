import { useEffect } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';
import { extractBoardNumberFromFilename, useObdNetLookup, obdStore, type ObdNet } from '../store/obd-store';

export function ComponentInfoPanel() {
  const { selectedPart, selection, board, fileName } = useBoardStore();
  const boardNumber = extractBoardNumberFromFilename(fileName) ?? undefined;
  const obd = useObdNetLookup(boardNumber);

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
