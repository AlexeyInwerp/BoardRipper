import { IconCircuitDiode, IconCircuitDiodeZener } from '@tabler/icons-react';
import { renderSettingsStore } from '../../../store/render-settings';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { boardStore } from '../../../store/board-store';
import { extractBoardNumberFromFilename, useObdForBoard } from '../../../store/obd-store';
import { boardHasDiodeData, diodeMode, cycleDiodeMode, diodeModeTitle } from '../../../store/diode-readings';
import type { SlotCtx } from '../slot-ctx';

/** Cycle the on-pin diode-value overlay: off → on → only → off. "Only" hides
 *  pin numbers and net names board-wide so a pin carries nothing but its
 *  reading — the state you want while working through a diode map. Shown only
 *  when the active board carries readings from either source (XZZ-baked or
 *  OBD). */
export function DiodeValuesButton({ ctx }: { ctx: SlotCtx }) {
  const settings = useRenderSettings();
  const bn = ctx.thisTab.fileName ? extractBoardNumberFromFilename(ctx.thisTab.fileName) : null;
  // Subscribe to OBD so the button appears once OBD readings fetch in.
  useObdForBoard(bn ?? undefined);

  if (!boardHasDiodeData(boardStore.board, bn ?? undefined)) return null;

  const mode = diodeMode(settings);
  // A distinct glyph for "only" — the two lit states are otherwise
  // indistinguishable at 16px, and this is the one that hides other labels.
  const Icon = mode === 'only' ? IconCircuitDiodeZener : IconCircuitDiode;
  return (
    <button
      className={`board-netlines-toggle ${mode !== 'off' ? 'active' : ''}`}
      onClick={() => {
        const cur = renderSettingsStore.globalSnapshot();
        renderSettingsStore.applyGlobal({ ...cur, ...cycleDiodeMode(cur) });
      }}
      title={diodeModeTitle(mode)}
    >
      <Icon size={16} />
    </button>
  );
}
