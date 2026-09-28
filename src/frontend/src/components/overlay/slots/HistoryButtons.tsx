/**
 * History ‹ › — Preview's Go ▸ Back / Forward for the board ribbon. A touch
 * screen has no ⌘, so this is where a tablet walks the timeline; on a desktop
 * it doubles the ⌘[ / ⌘] shortcuts named in the tips. Disabled state follows
 * `navHistoryStore.canBack/canForward`, which honours the layer toggles and
 * skips entries whose file has been closed.
 */
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useNavHistory } from '../../../hooks/useNavHistory';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { navHistoryStore } from '../../../store/nav-history-store';
import { historyBack, historyForward } from '../../../store/nav-history-actions';
import { formatShortcut } from '../../../store/keyboard-shortcuts';

export function HistoryButtons() {
  // Subscribe to both: reachability (is the entry's tab still open?) changes
  // with the board store, not the history store, so the live getters are
  // read at render time rather than from the cached snapshot.
  useNavHistory();
  useBoardStore();
  const canBack = navHistoryStore.canBack;
  const canForward = navHistoryStore.canForward;
  const prev = canBack ? navHistoryStore.entries[navHistoryStore.stepIndex(-1)] : null;
  const next = canForward ? navHistoryStore.entries[navHistoryStore.stepIndex(1)] : null;
  return (
    <div className="overlay-seg overlay-history" role="group" aria-label="History" data-testid="history-nav">
      <button
        type="button"
        className="overlay-seg-btn overlay-history-btn"
        data-testid="history-back"
        disabled={!canBack}
        title={`Back${prev ? ` to ${prev.label}` : ''} · ${formatShortcut('historyBack')}`}
        aria-label="Back"
        onClick={() => historyBack()}
      >
        <IconChevronLeft size={16} stroke={1.9} />
      </button>
      <button
        type="button"
        className="overlay-seg-btn overlay-history-btn"
        data-testid="history-forward"
        disabled={!canForward}
        title={`Forward${next ? ` to ${next.label}` : ''} · ${formatShortcut('historyForward')}`}
        aria-label="Forward"
        onClick={() => historyForward()}
      >
        <IconChevronRight size={16} stroke={1.9} />
      </button>
    </div>
  );
}
