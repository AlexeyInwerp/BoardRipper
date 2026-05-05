import { IconHierarchy, IconHierarchyOff, IconChartDots3, IconHierarchy3 } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function NetLinesButton({ ctx }: { ctx: SlotCtx }) {
  const { netLineMode } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle ${netLineMode !== 'off' ? 'active' : ''}`}
      onClick={() => boardStore.cycleNetLineMode()}
      title={
        netLineMode === 'off'
          ? 'Net lines: off (click for star)'
          : netLineMode === 'star'
          ? 'Net lines: star — radiate from selected part (click for chain)'
          : netLineMode === 'chain'
          ? 'Net lines: chain — nearest-neighbor MST (click for chain + adjacent)'
          : 'Net lines: chain + adjacent — propagate one hop through 2-pin parts (click to turn off)'
      }
    >
      {netLineMode === 'off' ? (
        <IconHierarchyOff size={16} />
      ) : netLineMode === 'star' ? (
        <IconHierarchy size={16} />
      ) : netLineMode === 'chain' ? (
        <IconChartDots3 size={16} />
      ) : (
        <IconHierarchy3 size={16} />
      )}
    </button>
  );
}
