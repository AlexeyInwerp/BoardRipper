import { IconObjectScan } from '@tabler/icons-react';
import type { SlotCtx } from '../slot-ctx';

export function FitBoardButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={() => ctx.rendererRef.current?.fitToBoard()}
      title="Zoom to fit board"
    >
      <IconObjectScan size={16} />
    </button>
  );
}
