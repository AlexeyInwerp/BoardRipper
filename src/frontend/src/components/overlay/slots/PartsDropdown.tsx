import { useRef, useState } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { DropdownPopover, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function PartsDropdown({ ctx }: { ctx: SlotCtx }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  const tab = tabs.find(t => t.id === ctx.tabId);
  const board = tab?.board;

  if (!board) {
    return <button className="board-netlines-toggle" disabled title="No board loaded">Parts ▾</button>;
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    const rows = q
      ? idx.parts.filter(p => p.nameLower.includes(q))
      : idx.parts;
    return [{ header: null, rows: rows.map(row => ({ row })) }];
  };

  const onSelect = (name: string) => {
    const mode = renderSettingsStore.settings.overlayPartsOnSelect;
    if (mode === 'panZoomFit') {
      boardStore.focusPart(name);
      return;
    }
    const partIdx = board.parts.findIndex(p => p.name === name);
    if (partIdx < 0) return;
    boardStore.selectPart(partIdx);
    if (mode === 'panIfOffscreen') {
      ctx.rendererRef.current?.panToPartIfOffscreen(partIdx);
    }
  };

  return (
    <div ref={wrapRef} className="overlay-dropdown-wrap">
      <button
        className={`board-netlines-toggle ${open ? 'active' : ''}`}
        onClick={() => setOpen(v => !v)}
        title="Find part by name"
        data-testid="parts-dropdown-button"
      >
        Parts ▾
      </button>
      {open && (
        <DropdownPopover
          buildGroups={buildGroups}
          onSelect={onSelect}
          onClose={() => setOpen(false)}
          placeholder="Filter parts…"
        />
      )}
    </div>
  );
}
