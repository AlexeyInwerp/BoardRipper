import { IconGhost2, IconGhost3, IconBallVolleyball } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function GhostsButton({ ctx }: { ctx: SlotCtx }) {
  const { ghostMode } = ctx.thisTab;
  const active = ghostMode !== 'off';
  const disco = ghostMode === 'disco';
  return (
    <button
      className={`board-netlines-toggle ${active ? 'active' : ''} ${disco ? 'disco-active' : ''}`}
      onClick={() => boardStore.cycleGhostMode()}
      title={
        ghostMode === 'off'
          ? 'Hidden-side ghosts: off (click for ghosts)'
          : ghostMode === 'ghosts'
          ? 'Hidden-side ghosts: ON (click for disco)'
          : 'Disco: every part on the board pulses rainbow, both sides (click to turn off)'
      }
    >
      {ghostMode === 'off' ? (
        <IconGhost3 size={16} />
      ) : ghostMode === 'ghosts' ? (
        <IconGhost2 size={16} />
      ) : (
        <IconBallVolleyball size={16} />
      )}
    </button>
  );
}
