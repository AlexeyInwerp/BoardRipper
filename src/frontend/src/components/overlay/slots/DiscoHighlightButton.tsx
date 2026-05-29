import { IconBallVolleyball } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import type { SlotCtx } from '../slot-ctx';

export function DiscoHighlightButton({ ctx }: { ctx: SlotCtx }) {
  const { discoHighlight } = ctx.thisTab;
  return (
    <button
      className={`board-netlines-toggle disco-highlight-toggle ${discoHighlight ? 'active disco-active' : ''}`}
      onClick={() => boardStore.toggleDiscoHighlight()}
      title={discoHighlight ? 'Disco highlight: ON' : 'Disco highlight: OFF'}
    >
      <IconBallVolleyball size={16} />
    </button>
  );
}
