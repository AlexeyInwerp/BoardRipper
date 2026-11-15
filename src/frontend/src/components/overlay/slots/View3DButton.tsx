import { useState, useSyncExternalStore } from 'react';
import { IconAdjustments, IconCube, IconFocusCentered, IconHandStop, IconRotate360, IconStackBack, IconStackFront, IconZoomIn, IconZoomOut, IconView360 } from '@tabler/icons-react';
import { view3dStore, QUALITY_PRESETS, type SelColour, type View3DQuality, type View3DSettings } from '../../../store/view3d-store';
import { QuickMenu, type QuickMenuItem } from '../../QuickMenu';
import type { SlotCtx } from '../slot-ctx';

const use3d = () => useSyncExternalStore(c => view3dStore.subscribe(c), () => view3dStore.snapshot());

/** Switches this board tab between the 2D view and the 3D one; while in 3D,
 *  zoom out / in, what a drag does (turn ↔ pan) and the 3D settings sit beside it. */
export function View3DButton({ ctx }: { ctx: SlotCtx }) {
  const on = use3d().has(ctx.tabId);
  const ui = view3dStore.uiOf(ctx.tabId);
  const h = () => view3dStore.handle(ctx.tabId);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
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
          <button
            className={`board-netlines-toggle ${menu ? 'active' : ''}`}
            data-testid="board-3d-settings"
            aria-expanded={!!menu}
            onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenu(menu ? null : { x: r.left, y: r.bottom + 4 }); }}
            title="3D view settings: selection colours, names, net lines, see-through, shadows"
          >
            <IconAdjustments size={16} />
          </button>
          {menu && <View3DSettingsMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
        </>
      )}
    </>
  );
}

const COLOUR_LABEL: Record<SelColour, string> = { cyan: 'Cyan', lime: 'Lime', magenta: 'Magenta', orange: 'Orange', violet: 'Violet', white: 'White' };

/** The 3D view's own settings, in the ribbon's menu style. Global and persisted:
 *  a colour that reads on one board reads on the next. */
function View3DSettingsMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  use3d();
  const s = view3dStore.settings;
  const set = (p: Partial<View3DSettings>) => view3dStore.setSettings(p);
  const colourRow = (key: 'netColour' | 'pinColour' | 'partColour', label: string, choices: SelColour[]): QuickMenuItem[] => [
    { kind: 'header', label },
    ...choices.map(c => ({ kind: 'check' as const, label: COLOUR_LABEL[c], checked: s[key] === c, testId: `view3d-${key}-${c}`, onSelect: () => set({ [key]: c }) })),
  ];
  const items: QuickMenuItem[] = [
    { kind: 'header', label: 'Performance' },
    ...(Object.keys(QUALITY_PRESETS) as View3DQuality[]).map(q => ({ kind: 'check' as const, label: QUALITY_PRESETS[q].label, hint: QUALITY_PRESETS[q].hint, checked: s.quality === q, testId: `view3d-quality-${q}`, onSelect: () => set({ quality: q }) })),
    { kind: 'sep' },
    ...colourRow('netColour', 'Lit net', ['cyan', 'magenta', 'lime', 'orange']),
    ...colourRow('pinColour', 'Picked pin', ['lime', 'cyan', 'white', 'orange']),
    ...colourRow('partColour', 'Selected part', ['violet', 'white', 'orange', 'magenta']),
    { kind: 'sep' },
    { kind: 'header', label: 'Show' },
    { kind: 'check', label: 'Part names', checked: s.partNames, testId: 'view3d-partNames', onSelect: () => set({ partNames: !s.partNames }) },
    { kind: 'check', label: 'Net names on pins (close up)', checked: s.netNames, testId: 'view3d-netNames', onSelect: () => set({ netNames: !s.netNames }) },
    { kind: 'check', label: 'Large parts see-through up close', checked: s.seeThrough, testId: 'view3d-seeThrough', onSelect: () => set({ seeThrough: !s.seeThrough }) },
    { kind: 'check', label: 'Shadows', checked: s.shadows && QUALITY_PRESETS[s.quality].shadows, disabled: !QUALITY_PRESETS[s.quality].shadows, testId: 'view3d-shadows', onSelect: () => set({ shadows: !s.shadows }) },
    { kind: 'sep' },
    { kind: 'range', label: 'Marker size', value: s.markerPx, min: 6, max: 40, step: 1, format: v => `${v} px`, testId: 'view3d-markerPx', onChange: v => set({ markerPx: v }) },
    { kind: 'range', label: 'Outline width', value: s.outlinePx, min: 1, max: 8, step: 0.5, format: v => `${v} px`, testId: 'view3d-outlinePx', onChange: v => set({ outlinePx: v }) },
    { kind: 'sep' },
    { label: 'Reset to defaults', testId: 'view3d-reset', onSelect: () => view3dStore.resetSettings() },
  ];
  return <QuickMenu x={x} y={y} onClose={onClose} ariaLabel="3D view settings" testId="view3d-settings-menu" items={items} />;
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
