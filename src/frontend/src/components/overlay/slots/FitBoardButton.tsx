import { IconObjectScan } from '@tabler/icons-react';
import type { SlotCtx } from '../slot-ctx';

export function FitBoardButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button
      className="board-netlines-toggle"
      onClick={() => { const r = ctx.rendererRef.current; if (!r) return; r.fitToBoard(); r.noteFitViewpoint(); }}
      title="Zoom to fit board"
    >
      <IconObjectScan size={16} />
    </button>
  );
}
