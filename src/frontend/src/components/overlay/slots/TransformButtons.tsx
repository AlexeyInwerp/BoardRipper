/**
 * The board transforms that moved down from the app toolbar in v0.39:
 * Butterfly (both sides side by side), rotate left / right, PCB traces, and
 * the ⋯ menu for the rarer one-shot transforms (180°, mirror) and the
 * flip-axis preference. Every action is the same boardStore call the toolbar
 * made; only the button's home changed.
 */
import { useCallback, useState } from 'react';
import { IconFlipHorizontal, IconRotate, IconRotateClockwise, IconRoute, IconDots } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import { formatShortcut } from '../../../store/keyboard-shortcuts';
import { QuickMenu } from '../../QuickMenu';
import type { SlotCtx } from '../slot-ctx';

export function ButterflyButton({ ctx }: { ctx: SlotCtx }) {
  // Layered formats have no top/bottom pair to lay side by side.
  if (ctx.thisTab.hasLayers) return null;
  const on = ctx.thisTab.butterfly;
  return (
    <button
      type="button"
      className={`board-netlines-toggle${on ? ' active' : ''}`}
      data-testid="butterfly-btn"
      aria-pressed={on}
      title="Butterfly · both sides side by side"
      onClick={() => boardStore.toggleButterfly()}
    >
      <IconFlipHorizontal size={16} />
    </button>
  );
}

export function RotateCcwButton() {
  return (
    <button type="button" className="board-netlines-toggle" data-testid="rotate-ccw"
      title={`Rotate left 90° (${formatShortcut('rotateCCW')})`} onClick={() => boardStore.rotateCCW()}>
      <IconRotate size={16} />
    </button>
  );
}

export function RotateCwButton() {
  return (
    <button type="button" className="board-netlines-toggle" data-testid="rotate-cw"
      title={`Rotate right 90° (${formatShortcut('rotateCW')})`} onClick={() => boardStore.rotateCW()}>
      <IconRotateClockwise size={16} />
    </button>
  );
}

export function TracesButton({ ctx }: { ctx: SlotCtx }) {
  const t = ctx.thisTab;
  // Only formats that carry copper, and not layered ones (the Layers panel owns those).
  if (!t.hasTraces || t.hasLayers) return null;
  return (
    <button
      type="button"
      className={`board-netlines-toggle${t.showTraces ? ' active' : ''}`}
      data-testid="traces-btn"
      aria-pressed={t.showTraces}
      title={t.showTraces ? 'PCB traces: shown' : 'PCB traces: hidden'}
      onClick={() => boardStore.toggleTraces()}
    >
      <IconRoute size={16} />
    </button>
  );
}

export function TransformMenuButton({ ctx }: { ctx: SlotCtx }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const t = ctx.thisTab;
  // The flip-axis label describes the SCREEN direction. Under 90°/270°
  // rotation board X↔screen Y, so invert to match what the user sees.
  const axesSwapped = Math.round(t.rotation / 90) % 2 === 1;
  const screenVertical = (t.flipAxis === 'x') !== axesSwapped;
  return (
    <>
      <button
        type="button"
        className={`board-netlines-toggle${menu ? ' active' : ''}`}
        data-testid="transform-menu"
        aria-haspopup="menu"
        aria-expanded={!!menu}
        title="More transforms: 180°, mirror, flip axis"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
      >
        <IconDots size={16} />
      </button>
      {menu && (
        <QuickMenu
          x={menu.x}
          y={menu.y}
          onClose={close}
          ariaLabel="More transforms"
          testId="transform-menu-popup"
          items={[
            { kind: 'header', label: 'Transform' },
            { label: 'Rotate 180°', testId: 'transform-rotate-180', onSelect: () => boardStore.rotate180() },
            { label: 'Mirror horizontally', testId: 'transform-mirror-h', hint: formatShortcut('mirrorBoard'), onSelect: () => boardStore.flipHorizontal() },
            { label: 'Mirror vertically', testId: 'transform-mirror-v', onSelect: () => boardStore.flipVertical() },
            { kind: 'sep' },
            { kind: 'header', label: 'Flip axis' },
            { kind: 'check', label: 'Vertical', checked: screenVertical, testId: 'transform-flip-vertical',
              onSelect: () => { if (!screenVertical) boardStore.toggleFlipAxis(); } },
            { kind: 'check', label: 'Horizontal', checked: !screenVertical, testId: 'transform-flip-horizontal',
              onSelect: () => { if (screenVertical) boardStore.toggleFlipAxis(); } },
          ]}
        />
      )}
    </>
  );
}
