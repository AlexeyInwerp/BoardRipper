import { useBoardStore } from '../hooks/useBoardStore';
import { boardStore } from '../store/board-store';

export function ComponentInfoPanel() {
  const { selectedPart, selection, board } = useBoardStore();

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
            </tr>
          </thead>
          <tbody>
            {selectedPart.pins.map((pin, idx) => {
              const isSelected = selection.pinIndex === idx;
              const isNetHighlighted = selection.highlightedNet === pin.net && pin.net !== '';
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
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
