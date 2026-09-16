/**
 * Floating "Interactive mode is on" pill over the board, with the way out.
 * Interactive mode repurposes a plain click, so the switch that turns it off
 * must be where the clicks happen — not four levels down in Settings ▸ Board.
 * One per board panel, hidden when the mode is off.
 */
import { useSyncExternalStore } from 'react';
import { IconClick } from '@tabler/icons-react';
import { resizeModeStore } from '../store/resize-mode-store';

export function ResizeModeBanner() {
  const enabled = useSyncExternalStore(
    (cb) => resizeModeStore.subscribe(cb),
    () => resizeModeStore.enabled,
  );
  if (!enabled) return null;
  return (
    <div className="resize-mode-banner" role="status" data-testid="resize-mode-banner">
      <IconClick size={15} className="resize-mode-banner-icon" />
      <span className="resize-mode-banner-text">Interactive mode — click a pin, component or the board to size it</span>
      <button
        type="button"
        className="resize-mode-banner-done"
        onClick={() => resizeModeStore.setEnabled(false)}
        title="Back to normal clicks"
        data-testid="resize-mode-done"
      >
        Done
      </button>
    </div>
  );
}
