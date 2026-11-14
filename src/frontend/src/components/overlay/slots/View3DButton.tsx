import { useSyncExternalStore } from 'react';
import { IconCube, IconFocusCentered, IconHandStop, IconRotate360, IconStackBack, IconStackFront, IconZoomIn, IconZoomOut, IconView360 } from '@tabler/icons-react';
import { view3dStore } from '../../../store/view3d-store';
import type { SlotCtx } from '../slot-ctx';

const use3d = () => useSyncExternalStore(c => view3dStore.subscribe(c), () => view3dStore.snapshot());

/** Switches this board tab between the 2D view and the 3D one; while in 3D,
 *  zoom out / in and what a drag does (turn ↔ pan) sit beside it. */
export function View3DButton({ ctx }: { ctx: SlotCtx }) {
  const on = use3d().has(ctx.tabId);
  const ui = view3dStore.uiOf(ctx.tabId);
  const h = () => view3dStore.handle(ctx.tabId);
  return (
    <>
      <button
        className={`board-netlines-toggle ${on ? 'active' : ''}`}
        data-testid="view3d-btn"
        aria-pressed={on}
        onClick={() => view3dStore.toggle(ctx.tabId)}
        title={on ? '3D view: on — back to 2D' : '3D view: parts estimated from the file'}
      >
        <IconCube size={16} />
      </button>
      {on && (
        <>
          <button className="board-netlines-toggle" data-testid="board-3d-zoom-out" onClick={() => h()?.zoomBy(1 / 0.75)} title="Zoom out · −"><IconZoomOut size={16} /></button>
          <button className="board-netlines-toggle" data-testid="board-3d-zoom-in" onClick={() => h()?.zoomBy(0.75)} title="Zoom in · +"><IconZoomIn size={16} /></button>
          <button
            className={`board-netlines-toggle ${ui.drag === 'pan' ? 'active' : ''}`}
            data-testid="board-3d-drag-mode"
            aria-pressed={ui.drag === 'pan'}
            onClick={() => view3dStore.setDrag(ctx.tabId, ui.drag === 'orbit' ? 'pan' : 'orbit')}
            title={ui.drag === 'orbit' ? 'Drag turns the board, right-drag pans · click: drag pans' : 'Drag pans, right-drag turns the board · click: drag turns'}
          >
            {ui.drag === 'orbit' ? <IconRotate360 size={16} /> : <IconHandStop size={16} />}
          </button>
        </>
      )}
    </>
  );
}

/** The Side switch in 3D: which way the camera looks — angled, at the top, at the bottom. */
export function View3DSideSwitch({ ctx }: { ctx: SlotCtx }) {
  use3d();
  const preset = view3dStore.uiOf(ctx.tabId).preset;
  const btn = (p: 'iso' | 'top' | 'bottom', label: string, Icon: typeof IconStackFront, title: string) => (
    <button type="button" className={`overlay-seg-btn${preset === p ? ' active' : ''}`} data-testid={`board-3d-${p}`} aria-pressed={preset === p} title={title} onClick={() => view3dStore.setPreset(ctx.tabId, p)}>
      <Icon size={15} stroke={1.9} /><span className="overlay-seg-lbl">{label}</span>
    </button>
  );
  return (
    <div className="overlay-seg" role="group" aria-label="3D camera" data-testid="side-switch-3d">
      {btn('iso', 'Angled', IconView360, 'Angled view')}
      {btn('top', 'Top', IconStackFront, 'Look at the top side')}
      {btn('bottom', 'Bottom', IconStackBack, 'Look at the bottom side')}
    </div>
  );
}

/** Fit in 3D: the whole board in view, keeping the angle. */
export function View3DFitButton({ ctx }: { ctx: SlotCtx }) {
  return (
    <button className="board-netlines-toggle" data-testid="board-3d-fit" onClick={() => view3dStore.handle(ctx.tabId)?.fit()} title="Fit the board · 0">
      <IconFocusCentered size={16} />
    </button>
  );
}
