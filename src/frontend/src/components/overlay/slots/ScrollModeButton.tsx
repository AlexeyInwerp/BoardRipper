import { IconHandMove, IconZoomIn } from '@tabler/icons-react';
import { invertScrollBindings, scrollSwapTooltip } from '../../../store/scroll-mode';
import type { SlotCtx } from '../slot-ctx';

export function ScrollModeButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={invertScrollBindings}
      title={scrollSwapTooltip()}
    >
      {ctx.bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
    </button>
  );
}
