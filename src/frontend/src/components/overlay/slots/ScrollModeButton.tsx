import { IconHandMove, IconZoomIn } from '@tabler/icons-react';
import { invertScrollBindings } from '../../../store/scroll-mode';
import type { SlotCtx } from '../slot-ctx';

export function ScrollModeButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={invertScrollBindings}
      title={ctx.bareAction === 'pan'
        ? 'Scroll: Pan · Shift+Scroll: Zoom — click to swap'
        : 'Scroll: Zoom · Shift+Scroll: Pan — click to swap'}
    >
      {ctx.bareAction === 'pan' ? <IconHandMove size={16} /> : <IconZoomIn size={16} />}
    </button>
  );
}
