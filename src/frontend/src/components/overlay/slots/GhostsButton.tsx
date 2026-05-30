import { IconGhost2, IconGhost2Filled } from '@tabler/icons-react';
import { boardStore, type GhostMode } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

// Same ghost shape in all three states. Off-state reads as "disabled"
// purely through the `.active` class being absent — gray text vs accent,
// no strikethrough / slash variant. Disco uses the filled variant; the
// `.disco-active` hue-rotate animation makes it the visibly pulsing one.
const MODE_INFO: Record<GhostMode, {
  icon: typeof IconGhost2;
  title: string;
}> = {
  off:    { icon: IconGhost2,       title: 'Hidden-side ghosts: off (click for ghosts)' },
  ghosts: { icon: IconGhost2,       title: 'Hidden-side ghosts: ON (click for disco)' },
  disco:  { icon: IconGhost2Filled, title: 'Disco: same-net parts pulse red on both sides (click to turn off)' },
};

export function GhostsButton({ ctx }: { ctx: SlotCtx }) {
  const { ghostMode } = ctx.thisTab;
  const { icon: Icon, title } = MODE_INFO[ghostMode];
  return (
    <button
      className={`board-netlines-toggle ${ghostMode !== 'off' ? 'active' : ''} ${ghostMode === 'disco' ? 'disco-active' : ''}`}
      onClick={() => boardStore.cycleGhostMode()}
      title={title}
    >
      <Icon size={16} />
    </button>
  );
}
