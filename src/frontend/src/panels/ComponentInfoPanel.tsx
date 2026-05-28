import { useBoardStore } from '../hooks/useBoardStore';
import { extractBoardNumberFromFilename } from '../store/obd-store';
import { ComponentInfoBody } from '../components/ComponentInfoBody';

/**
 * Floating Component Info panel. Renders the shared ComponentInfoBody — the
 * SAME body the board sidebar's Info tab renders — so the two surfaces can't
 * drift. All inspection logic (pin table, BOM-alternates switcher, OBD cells +
 * diagnosis) lives in ComponentInfoBody, not here.
 */
export function ComponentInfoPanel() {
  const { selection, board, fileName, showBomAlternates, bomClusterSelections } = useBoardStore();
  const boardNumber = extractBoardNumberFromFilename(fileName) ?? undefined;

  if (!board) {
    return <div className="panel-empty">No board loaded</div>;
  }

  return (
    <ComponentInfoBody
      board={board}
      selection={selection}
      boardNumber={boardNumber}
      showBomAlternates={showBomAlternates}
      bomClusterSelections={bomClusterSelections}
    />
  );
}
