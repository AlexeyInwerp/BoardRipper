import { IconCircuitDiode } from '@tabler/icons-react';
import { renderSettingsStore } from '../../../store/render-settings';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { boardStore } from '../../../store/board-store';
import { extractBoardNumberFromFilename, useObdForBoard } from '../../../store/obd-store';
import { boardHasDiodeData } from '../../../store/diode-readings';
import type { SlotCtx } from '../slot-ctx';

/** Toggle the on-pin diode-value overlay. Only shown when the active board
 *  carries diode readings from either source (XZZ-baked or OBD). */
export function DiodeValuesButton({ ctx }: { ctx: SlotCtx }) {
  const settings = useRenderSettings();
  const bn = ctx.thisTab.fileName ? extractBoardNumberFromFilename(ctx.thisTab.fileName) : null;
  // Subscribe to OBD so the button appears once OBD readings fetch in.
  useObdForBoard(bn ?? undefined);

  if (!boardHasDiodeData(boardStore.board, bn ?? undefined)) return null;

  const on = settings.showDiodeValues;
  return (
    <button
      className={`board-netlines-toggle ${on ? 'active' : ''}`}
      onClick={() => {
        const cur = renderSettingsStore.globalSnapshot();
        renderSettingsStore.applyGlobal({ ...cur, showDiodeValues: !cur.showDiodeValues });
      }}
      title={on ? 'Diode values: ON (click to hide)' : 'Diode values: OFF (click to show on pins)'}
    >
      <IconCircuitDiode size={16} />
    </button>
  );
}
