/**
 * "?" — opens the board legend card (components/BoardLegend.tsx). Shown by
 * default; switched off from the ribbon's right-click menu or Settings ▸
 * Board overlay (slot `legendHelp`).
 */
import { IconQuestionMark } from '@tabler/icons-react';
import { boardLegendStore, useBoardLegend } from '../../../store/board-legend-store';

export function LegendButton() {
  const { open } = useBoardLegend();
  return (
    <button
      type="button"
      className={`board-netlines-toggle${open ? ' active' : ''}`}
      data-testid="legend-btn"
      aria-pressed={open}
      title={open ? 'Hide the legend' : 'Legend: pin colours, readings, lines and keys'}
      onClick={() => boardLegendStore.toggle()}
    >
      <IconQuestionMark size={16} />
    </button>
  );
}
