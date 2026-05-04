import { useRef, useState, useCallback } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { SuggestionList, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function NetsDropdown({ ctx }: { ctx: SlotCtx }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { tabs } = useBoardStore();
  const settings = useRenderSettings();
  const tab = tabs.find(t => t.id === ctx.tabId);
  const board = tab?.board;

  const close = useCallback(() => {
    setOpen(false);
    setHighlight(0);
  }, []);

  if (!board) {
    return (
      <div className="overlay-dropdown-wrap">
        <input
          className="overlay-filter-input board-netlines-toggle"
          type="text"
          placeholder="nets"
          disabled
          title="No board loaded"
        />
      </div>
    );
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

  const groups = buildGroups(query.toLowerCase().trim());

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

  // Flat row count for keyboard navigation bounds
  const flatRows = groups.flatMap(g => g.rows);
  const cappedLen = Math.min(flatRows.length, 500);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = flatRows[Math.min(highlight, flatRows.length - 1)];
      if (r) { onSelect(r.row.name); close(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, cappedLen - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    }
  };

  return (
    <div className="overlay-dropdown-wrap">
      <input
        ref={inputRef}
        type="text"
        className="overlay-filter-input board-netlines-toggle"
        placeholder="nets"
        value={query}
        data-testid="nets-filter-input"
        title="Find net by name"
        onChange={e => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <SuggestionList
          anchorRef={inputRef}
          groups={groups}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={name => { onSelect(name); setQuery(''); close(); }}
          onClose={close}
        />
      )}
    </div>
  );
}
