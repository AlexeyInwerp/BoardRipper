import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function NetDimButton({ ctx }: { ctx: SlotCtx }) {
  const { showNetDim } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${showNetDim ? 'active' : ''}`}
      onClick={() => boardStore.toggleNetDim()}
      title={showNetDim ? 'Selection dimming: ON' : 'Selection dimming: OFF'}
    >
      ◐
    </button>
  );
}
