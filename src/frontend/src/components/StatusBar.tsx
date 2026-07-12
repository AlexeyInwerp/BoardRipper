import { useBoardStore } from '../hooks/useBoardStore';
import { useMemoryStat } from '../hooks/useMemoryStat';
import { getAllExtensions } from '../parsers/registry';

declare const __APP_VERSION__: string;

export function StatusBar() {
  const { board, selection, selectedPart, selectedPin } = useBoardStore();
  const mem = useMemoryStat();

  return (
    <div className="statusbar" data-testid="statusbar">
      {board ? (
        <>
          <span title="Board file format">
            {board.format}{board.formatVersion ? ` (${board.formatVersion})` : ''}
          </span>
          <span className="statusbar-sep">|</span>
          <span title="BoardRipper version">v{__APP_VERSION__}</span>
          <span className="statusbar-sep">|</span>
          <span>Components: {board.parts.length}</span>
          <span className="statusbar-sep">|</span>
          <span>Nets: {board.nets.size}</span>
          {board.nails.length > 0 && (
            <>
              <span className="statusbar-sep">|</span>
              <span>Nails: {board.nails.length}</span>
            </>
          )}
          {board.traces && board.traces.length > 0 && (
            <>
              <span className="statusbar-sep">|</span>
              <span>Traces: {board.traces.length}</span>
            </>
          )}
          {selectedPart && (
            <>
              <span className="statusbar-sep">|</span>
              <span>Selected: {selectedPart.name}</span>
            </>
          )}
          {selectedPin && (
            <>
              <span className="statusbar-sep">|</span>
              <span>Pin: {selectedPin.name} → {selectedPin.net}</span>
            </>
          )}
          {selection.highlightedNet && (
            <>
              <span className="statusbar-sep">|</span>
              <span>Net: {selection.highlightedNet}</span>
            </>
          )}
        </>
      ) : (
        <span>BoardRipper v{__APP_VERSION__} — Supports {getAllExtensions().join(', ')} formats. Vibecoded by RipperDoc</span>
      )}
      {mem && (
        <>
          <span className="statusbar-sep">|</span>
          <span title={mem.title} data-testid="statusbar-mem">{mem.label}</span>
        </>
      )}
    </div>
  );
}
