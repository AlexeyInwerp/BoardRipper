import { IconGhost, IconGhostOff, IconGhostFilled } from '@tabler/icons-react';
import { boardStore, type GhostMode } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

// Same ghost shape across all three states so the OFF variant doesn't read
// as "different icon entirely". Disco gets the filled variant; the existing
// .disco-active hue-rotate animation makes it the visibly pulsing one.
const MODE_INFO: Record<GhostMode, {
  icon: typeof IconGhost;
  title: string;
}> = {
  off:    { icon: IconGhostOff,    title: 'Hidden-side ghosts: off (click for ghosts)' },
  ghosts: { icon: IconGhost,       title: 'Hidden-side ghosts: ON (click for disco)' },
  disco:  { icon: IconGhostFilled, title: 'Disco: same-net parts pulse red on both sides (click to turn off)' },
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
