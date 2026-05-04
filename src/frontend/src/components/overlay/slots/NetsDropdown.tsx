import { useRef, useState } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { DropdownPopover, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function NetsDropdown({ ctx }: { ctx: SlotCtx }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  const tab = tabs.find(t => t.id === ctx.tabId);
  const board = tab?.board;

  if (!board) {
    return <button className="board-netlines-toggle" disabled title="No board loaded">Nets ▾</button>;
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    const normalRows = (q ? idx.netsNormal.filter(n => n.nameLower.includes(q)) : idx.netsNormal)
      .map(row => ({ row }));
    const ncRows = (q ? idx.netsNc.filter(n => n.nameLower.includes(q)) : idx.netsNc)
      .map(row => ({ row, dimmed: true }));
    const groups: DropdownPopoverGroup[] = [];
    if (normalRows.length > 0) groups.push({ header: null, rows: normalRows });
    if (ncRows.length > 0)     groups.push({ header: 'No connect', rows: ncRows });
    return groups;
  };

  const onSelect = (name: string) => {
    const mode = renderSettingsStore.settings.overlayNetsOnSelect;
    if (mode === 'panZoomFit') {
      boardStore.focusNet(name);
      return;
    }
    boardStore.highlightNet(name);
    if (mode === 'panIfOffscreen') {
      ctx.rendererRef.current?.panToNetIfOffscreen(name);
    }
  };

  return (
    <div ref={wrapRef} className="overlay-dropdown-wrap">
      <button
        className={`board-netlines-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Find net by name"
        data-testid="nets-dropdown-button"
      >
        Nets ▾
      </button>
      {open && (
        <DropdownPopover
          buildGroups={buildGroups}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          placeholder="Filter nets…"
        />
      )}
    </div>
  );
}
