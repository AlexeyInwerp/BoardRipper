import { useSyncExternalStore } from 'react';
import { IconCube } from '@tabler/icons-react';
import { view3dStore } from '../../../store/view3d-store';
import type { SlotCtx } from '../slot-ctx';

/** Switches this board tab between the 2D view and the 3D one. */
export function View3DButton({ ctx }: { ctx: SlotCtx }) {
  const on = useSyncExternalStore(c => view3dStore.subscribe(c), () => view3dStore.snapshot()).has(ctx.tabId);
  return (
    <button
      className={`board-netlines-toggle ${on ? 'active' : ''}`}
      data-testid="view3d-btn"
      aria-pressed={on}
      onClick={() => view3dStore.toggle(ctx.tabId)}
      title={on ? '3D view: on — back to 2D' : '3D view: parts estimated from the file'}
    >
      <IconCube size={16} />
    </button>
  );
}
