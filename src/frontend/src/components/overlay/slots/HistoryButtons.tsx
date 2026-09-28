/**
 * History ‹ › — Preview's Go ▸ Back / Forward for the board ribbon. A touch
 * screen has no ⌘, so this is where a tablet walks the timeline; on a desktop
 * it doubles the ⌘[ / ⌘] shortcuts named in the tips. Disabled state follows
 * `navHistoryStore.canBack/canForward`, which honours the layer toggles and
 * skips entries whose file has been closed.
 */
import { useCallback, useRef, useState } from 'react';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import { useNavHistory } from '../../../hooks/useNavHistory';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { navHistoryStore } from '../../../store/nav-history-store';
import { historyBack, historyForward, historyJumpTo, entryReachable } from '../../../store/nav-history-actions';
import { formatShortcut } from '../../../store/keyboard-shortcuts';
import { QuickMenu, type QuickMenuItem } from '../../QuickMenu';

/** Long-press (the context-menu hold) or right-click on either chevron lists
 *  the ten nearest entries in that direction, as browsers do on Back. */
const HOLD_MS = 500;
const MENU_DEPTH = 10;

function useHoldMenu(dir: -1 | 1) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancel = useCallback(() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, []);
  const open = useCallback((x: number, y: number) => { fired.current = true; setMenu({ x, y }); }, []);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    fired.current = false;
    if (e.button !== 0) return;
    cancel();
    const { clientX, clientY } = e;
    timer.current = setTimeout(() => { timer.current = null; open(clientX, clientY); }, HOLD_MS);
  }, [cancel, open]);
  const onClick = useCallback((step: () => void) => { if (fired.current) { fired.current = false; return; } step(); }, []);
  const onContextMenu = useCallback((e: React.MouseEvent) => { e.preventDefault(); cancel(); open(e.clientX, e.clientY); }, [cancel, open]);
  const items = (): QuickMenuItem[] => {
    const out: QuickMenuItem[] = [{ kind: 'header', label: dir < 0 ? 'Back to' : 'Forward to' }];
    const { entries, cursor, layers } = navHistoryStore;
    for (let i = cursor + dir, n = 0; i >= 0 && i < entries.length && n < MENU_DEPTH; i += dir) {
      const e = entries[i];
      if (!layers[e.cause]) continue;
      n++;
      out.push({ label: e.label || e.place?.fileName || '…', disabled: !entryReachable(e), testId: `history-menu-${e.id}`, onSelect: () => historyJumpTo(e.id) });
    }
    if (out.length === 1) out.push({ label: 'Nothing this way', disabled: true, onSelect: () => {} });
    return out;
  };
  return { menu, close: () => setMenu(null), onPointerDown, onPointerUp: cancel, onPointerLeave: cancel, onClick, onContextMenu, items };
}

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
  const back = useHoldMenu(-1);
  const fwd = useHoldMenu(1);
  return (
    <div className="overlay-seg overlay-history" role="group" aria-label="History" data-testid="history-nav">
      <button
        type="button"
        className="overlay-seg-btn overlay-history-btn"
        data-testid="history-back"
        disabled={!canBack}
        title={`Back${prev ? ` to ${prev.label}` : ''} · ${formatShortcut('historyBack')} · hold for the list`}
        aria-label="Back"
        onPointerDown={back.onPointerDown}
        onPointerUp={back.onPointerUp}
        onPointerLeave={back.onPointerLeave}
        onContextMenu={back.onContextMenu}
        onClick={() => back.onClick(historyBack)}
      >
        <IconChevronLeft size={16} stroke={1.9} />
      </button>
      <button
        type="button"
        className="overlay-seg-btn overlay-history-btn"
        data-testid="history-forward"
        disabled={!canForward}
        title={`Forward${next ? ` to ${next.label}` : ''} · ${formatShortcut('historyForward')} · hold for the list`}
        aria-label="Forward"
        onPointerDown={fwd.onPointerDown}
        onPointerUp={fwd.onPointerUp}
        onPointerLeave={fwd.onPointerLeave}
        onContextMenu={fwd.onContextMenu}
        onClick={() => fwd.onClick(historyForward)}
      >
        <IconChevronRight size={16} stroke={1.9} />
      </button>
      {back.menu && <QuickMenu x={back.menu.x} y={back.menu.y} items={back.items()} onClose={back.close} ariaLabel="Back to" testId="history-back-menu" />}
      {fwd.menu && <QuickMenu x={fwd.menu.x} y={fwd.menu.y} items={fwd.items()} onClose={fwd.close} ariaLabel="Forward to" testId="history-forward-menu" />}
    </div>
  );
}
