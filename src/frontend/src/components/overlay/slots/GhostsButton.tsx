import { IconGhost2 } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function GhostsButton({ ctx }: { ctx: SlotCtx }) {
  const { showGhosts } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${showGhosts ? 'active' : ''}`}
      onClick={() => boardStore.toggleGhosts()}
      title={showGhosts ? 'Hidden-side ghosts: ON' : 'Hidden-side ghosts: OFF'}
    >
      <IconGhost2 size={16} />
    </button>
  );
}
