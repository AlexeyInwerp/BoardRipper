import { useRef, useState, useCallback } from 'react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { SuggestionList, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

export function PartsDropdown({ ctx }: { ctx: SlotCtx }) {
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
          placeholder="parts"
          disabled
          title="No board loaded"
        />
      </div>
    );
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    const rows = q
      ? idx.parts.filter(p => p.nameLower.includes(q))
      : idx.parts;
    return [{ header: null, rows: rows.map(row => ({ row })) }];
  };

  const groups = buildGroups(query.toLowerCase().trim());

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
        placeholder="parts"
        value={query}
        data-testid="parts-filter-input"
        title="Find part by name"
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
