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
  const [selectedName, setSelectedName] = useState<string | null>(null);
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
          placeholder="Parts"
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

  // Commit a dropdown selection. (A) blur the input so a subsequent Space
  // reaches the board-flip shortcut instead of being typed into the field;
  // (B) keep the typed text and just close the dropdown (do NOT clear it).
  // The selected name is remembered so (C) refocus can restore the highlight.
  const commit = (name: string) => {
    onSelect(name);
    setSelectedName(name);
    close();
    inputRef.current?.blur();
  };

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
      if (r) commit(r.row.name);
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
        placeholder="Parts"
        value={query}
        data-testid="parts-filter-input"
        title="Find part by name"
        onChange={e => {
          setQuery(e.target.value);
          setHighlight(0);
          setOpen(true);
        }}
        onFocus={() => {
          setOpen(true);
          // (C) Refocusing after a selection restores the dropdown with the
          // previously-selected row highlighted (the text is still present).
          if (selectedName) {
            const i = flatRows.findIndex(r => r.row.name === selectedName);
            if (i >= 0) setHighlight(i);
          }
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <SuggestionList
          anchorRef={inputRef}
          groups={groups}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={commit}
          onClose={close}
        />
      )}
    </div>
  );
}
