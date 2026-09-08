/**
 * Side — the control a repair session touches most, so it leads the ribbon
 * and keeps its words. Click to show a side; Shift-click for both. The
 * keyboard's flip shortcut (hold to peek) is unchanged and named in the tip.
 * Moved down from the app toolbar in v0.39; behaviour identical.
 */
import { IconStackFront, IconStackBack } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import { formatShortcut } from '../../../store/keyboard-shortcuts';
import type { SlotCtx } from '../slot-ctx';

export function SideSwitch({ ctx }: { ctx: SlotCtx }) {
  const t = ctx.thisTab;
  // The store tracks the file's side='top' layer; on files whose primary
  // side is the bottom the labels swap so "Top" means what the user sees.
  const uiTop    = t.primarySide === 'bottom' ? t.showBottom : t.showTop;
  const uiBottom = t.primarySide === 'bottom' ? t.showTop    : t.showBottom;
  const tip = `${formatShortcut('flipBoard')} flips · hold it to peek · Shift-click for both sides`;
  return (
    <div className="overlay-seg" role="group" aria-label="Board side" data-testid="side-switch">
      <button
        type="button"
        className={`overlay-seg-btn${uiTop ? ' active' : ''}`}
        data-testid="side-top"
        aria-pressed={uiTop}
        title={`Top side · ${tip}`}
        onClick={(e) => boardStore.selectTop(e.shiftKey)}
      >
        <IconStackFront size={15} stroke={1.9} /><span className="overlay-seg-lbl">Top</span>
      </button>
      <button
        type="button"
        className={`overlay-seg-btn${uiBottom ? ' active' : ''}`}
        data-testid="side-bottom"
        aria-pressed={uiBottom}
        title={`Bottom side · ${tip}`}
        onClick={(e) => boardStore.selectBottom(e.shiftKey)}
      >
        <IconStackBack size={15} stroke={1.9} /><span className="overlay-seg-lbl">Bottom</span>
      </button>
    </div>
  );
}
