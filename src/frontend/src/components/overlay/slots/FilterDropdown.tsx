/**
 * Find part / Find net — the two search slots of the board ribbon, one
 * component parameterised by `kind`.
 *
 * Collapsed, each is a single ribbon button: a magnifier with the thing it
 * searches drawn inside the lens (a chip for parts, the net glyph for nets).
 * Click it and the text field opens next to it with the suggestion list;
 * Escape, an outside click, or choosing a row closes it again. The typed
 * text survives a close so refocusing restores the last search with the
 * chosen row highlighted (the original behaviour, kept). In the vertical
 * ribbon the field pops out beside the column so the column never widens.
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import { IconSearch, IconCpu, IconHierarchy } from '@tabler/icons-react';
import { boardStore } from '../../../store/board-store';
import { renderSettingsStore } from '../../../store/render-settings';
import { useBoardStore } from '../../../hooks/useBoardStore';
import { useRenderSettings } from '../../../hooks/useRenderSettings';
import { SuggestionList, type DropdownPopoverGroup } from '../dropdown-popover';
import { getOverlayIndex } from '../get-overlay-index';
import type { SlotCtx } from '../slot-ctx';

type Kind = 'parts' | 'nets';

const META: Record<Kind, { placeholder: string; title: string; buttonId: string; inputId: string; Inner: typeof IconCpu }> = {
  parts: { placeholder: 'Part name', title: 'Find part by name', buttonId: 'parts-search-btn', inputId: 'parts-filter-input', Inner: IconCpu },
  nets:  { placeholder: 'Net name',  title: 'Find net by name',  buttonId: 'nets-search-btn',  inputId: 'nets-filter-input',  Inner: IconHierarchy },
};

/** Magnifier with the searched thing inside the lens. */
function SearchGlyph({ Inner }: { Inner: typeof IconCpu }) {
  return (
    <span className="overlay-search-ico" aria-hidden>
      <IconSearch size={16} stroke={1.75} />
      <Inner size={8} stroke={2.2} className="overlay-search-ico-inner" />
    </span>
  );
}

export function FilterDropdown({ ctx, kind }: { ctx: SlotCtx; kind: Kind }) {
  const m = META[kind];
  const [expanded, setExpanded] = useState(false);
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
    setExpanded(false);
  }, []);

  // Focus the field the moment it appears.
  useEffect(() => { if (expanded) inputRef.current?.focus(); }, [expanded]);

  if (!board) {
    return (
      <button type="button" className="board-netlines-toggle" disabled title="No board loaded" data-testid={m.buttonId}>
        <SearchGlyph Inner={m.Inner} />
      </button>
    );
  }

  const idx = getOverlayIndex(board, settings.ncNetPatterns);

  const buildGroups = (q: string): DropdownPopoverGroup[] => {
    if (kind === 'parts') {
      const rows = q ? idx.parts.filter(p => p.nameLower.includes(q)) : idx.parts;
      return [{ header: null, rows: rows.map(row => ({ row })) }];
    }
    const normalRows = (q ? idx.netsNormal.filter(n => n.nameLower.includes(q)) : idx.netsNormal).map(row => ({ row }));
    const ncRows = (q ? idx.netsNc.filter(n => n.nameLower.includes(q)) : idx.netsNc).map(row => ({ row, dimmed: true }));
    const groups: DropdownPopoverGroup[] = [];
    if (normalRows.length > 0) groups.push({ header: null, rows: normalRows });
    if (ncRows.length > 0)     groups.push({ header: 'No connect', rows: ncRows });
    return groups;
  };

  const groups = buildGroups(query.toLowerCase().trim());

  const onSelect = (name: string) => {
    if (kind === 'parts') {
      const mode = renderSettingsStore.settings.overlayPartsOnSelect;
      if (mode === 'panZoomFit') { boardStore.focusPart(name); return; }
      const partIdx = board.parts.findIndex(p => p.name === name);
      if (partIdx < 0) return;
      boardStore.selectPart(partIdx);
      if (mode === 'panIfOffscreen') ctx.rendererRef.current?.panToPartIfOffscreen(partIdx);
      return;
    }
    const mode = renderSettingsStore.settings.overlayNetsOnSelect;
    if (mode === 'panZoomFit') { boardStore.focusNet(name); return; }
    boardStore.highlightNet(name);
    if (mode === 'panIfOffscreen') ctx.rendererRef.current?.panToNetIfOffscreen(name);
  };

  const flatRows = groups.flatMap(g => g.rows);
  const cappedLen = Math.min(flatRows.length, 500);

  // Commit a selection: act, remember the name (so a refocus restores the
  // highlight), close the field, and blur so a following Space reaches the
  // board-flip shortcut instead of being typed.
  const commit = (name: string) => {
    onSelect(name);
    setSelectedName(name);
    close();
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); inputRef.current?.blur(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = flatRows[Math.min(highlight, flatRows.length - 1)];
      if (r) commit(r.row.name);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, cappedLen - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
  };

  return (
    <div className={`overlay-dropdown-wrap${expanded ? ' expanded' : ''}`}>
      <button
        type="button"
        className={`board-netlines-toggle${expanded ? ' active' : ''}`}
        data-testid={m.buttonId}
        aria-expanded={expanded}
        aria-label={m.title}
        title={m.title}
        onClick={() => { if (expanded) { close(); } else { setExpanded(true); setOpen(true); } }}
      >
        <SearchGlyph Inner={m.Inner} />
      </button>
      {expanded && (
        <input
          ref={inputRef}
          type="text"
          className="overlay-filter-input board-netlines-toggle"
          placeholder={m.placeholder}
          value={query}
          data-testid={m.inputId}
          title={m.title}
          onChange={e => { setQuery(e.target.value); setHighlight(0); setOpen(true); }}
          onFocus={() => {
            setOpen(true);
            if (selectedName) {
              const i = flatRows.findIndex(r => r.row.name === selectedName);
              if (i >= 0) setHighlight(i);
            }
          }}
          onKeyDown={onKeyDown}
        />
      )}
      {expanded && open && (
        <SuggestionList
          anchorRef={inputRef}
          groups={groups}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={commit}
          onClose={close}
          selectedName={selectedName}
        />
      )}
    </div>
  );
}
