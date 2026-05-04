import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { OverlayIndexRow } from './get-overlay-index';

const MAX_RENDERED_ROWS = 500;

export interface DropdownPopoverRow {
  /** The actual list entry; passed back on selection */
  row: OverlayIndexRow;
  /** Reduced-opacity styling (e.g. NC nets) */
  dimmed?: boolean;
}

export interface DropdownPopoverGroup {
  /** Optional header string — null hides the divider, useful when only one group is rendered. */
  header: string | null;
  rows: DropdownPopoverRow[];
}

export interface SuggestionListProps {
  /** Pre-built groups (already filtered by caller). */
  groups: DropdownPopoverGroup[];
  /** Currently highlighted flat index. */
  highlight: number;
  /** Called when highlight changes (e.g. on mouse enter). */
  onHighlight: (i: number) => void;
  /** Called with the picked row's name (original case). */
  onSelect: (name: string) => void;
  /** Closes the suggestion list. */
  onClose: () => void;
  /** Element the suggestion list anchors under (the filter input). */
  anchorRef: RefObject<HTMLInputElement | null>;
}

/**
 * Suggestion list shown below the filter input. Handles its own scroll-into-view.
 * The parent component owns the `<input>`, the query state, and keyboard events.
 */
export function SuggestionList({ groups, highlight, onHighlight, onSelect, onClose, anchorRef }: SuggestionListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const flatRows: DropdownPopoverRow[] = groups.flatMap(g => g.rows);
  const overflow = flatRows.length > MAX_RENDERED_ROWS;
  const cappedFlat = overflow ? flatRows.slice(0, MAX_RENDERED_ROWS) : flatRows;
  const safeHighlight = cappedFlat.length === 0 ? 0 : Math.min(highlight, cappedFlat.length - 1);

  // Anchor the portalled list under the input, refreshed on scroll/resize so
  // the list follows if the layout moves while it's open.
  useLayoutEffect(() => {
    const updatePos = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const minWidth = 200;
      const width = Math.max(r.width, minWidth);
      setPos({ top: r.bottom + 4, left: r.left, width });
    };
    updatePos();
    window.addEventListener('scroll', updatePos, true);
    window.addEventListener('resize', updatePos);
    return () => {
      window.removeEventListener('scroll', updatePos, true);
      window.removeEventListener('resize', updatePos);
    };
  }, [anchorRef]);

  // Scroll highlighted row into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${safeHighlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [safeHighlight]);

  // Close on outside click — accept clicks inside the anchor (input) too so
  // typing/clicking the input itself doesn't dismiss the list.
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (listRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose, anchorRef]);

  // Build the rendered list with group headers + flat indices for highlight tracking
  const rendered: ReactNode[] = [];
  let flatIdx = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.rows.length === 0) continue;
    if (group.header && g > 0) {
      rendered.push(
        <div key={`hdr-${g}`} className="overlay-dropdown-group-header">{group.header}</div>
      );
    }
    for (const r of group.rows) {
      if (flatIdx >= MAX_RENDERED_ROWS) break;
      const i = flatIdx;
      rendered.push(
        <button
          key={`${group.header ?? ''}-${r.row.name}`}
          data-row-idx={i}
          className={`overlay-dropdown-row${r.dimmed ? ' dimmed' : ''}${i === safeHighlight ? ' highlighted' : ''}`}
          onMouseEnter={() => onHighlight(i)}
          onMouseDown={e => {
            // Prevent the input from losing focus before we handle the click
            e.preventDefault();
            onSelect(r.row.name);
            onClose();
          }}
        >
          {r.row.name}
        </button>
      );
      flatIdx++;
    }
    if (flatIdx >= MAX_RENDERED_ROWS) break;
  }

  if (!pos) return null;

  return createPortal(
    <div
      ref={listRef}
      className="overlay-dropdown-popover"
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width }}
    >
      <div className="overlay-dropdown-list">
        {rendered.length === 0
          ? <div className="overlay-dropdown-empty">No matches</div>
          : rendered}
        {overflow && (
          <div className="overlay-dropdown-overflow">
            … and {flatRows.length - MAX_RENDERED_ROWS} more — refine your search
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ── Legacy full-popover (input + list in one component) ─────────────────────
// Kept for reference only — no longer rendered by PartsDropdown / NetsDropdown.

export interface DropdownPopoverProps {
  buildGroups: (queryLower: string) => DropdownPopoverGroup[];
  onSelect: (name: string) => void;
  onClose: () => void;
  placeholder?: string;
}

/** @deprecated Use the inline filter-input pattern in PartsDropdown / NetsDropdown. */
export function DropdownPopover({ buildGroups, onSelect, onClose, placeholder }: DropdownPopoverProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose]);

  const groups = buildGroups(query.toLowerCase().trim());
  const flatRows: DropdownPopoverRow[] = groups.flatMap(g => g.rows);
  const overflow = flatRows.length > MAX_RENDERED_ROWS;
  const cappedFlat = overflow ? flatRows.slice(0, MAX_RENDERED_ROWS) : flatRows;
  const safeHighlight = cappedFlat.length === 0 ? 0 : Math.min(highlight, cappedFlat.length - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = cappedFlat[safeHighlight];
      if (r) { onSelect(r.row.name); onClose(); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, cappedFlat.length - 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)); }
  };

  const rendered: ReactNode[] = [];
  let flatIdx = 0;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group.rows.length === 0) continue;
    if (group.header && g > 0) {
      rendered.push(<div key={`hdr-${g}`} className="overlay-dropdown-group-header">{group.header}</div>);
    }
    for (const r of group.rows) {
      if (flatIdx >= MAX_RENDERED_ROWS) break;
      const i = flatIdx;
      rendered.push(
        <button
          key={`${group.header ?? ''}-${r.row.name}`}
          data-row-idx={i}
          className={`overlay-dropdown-row${r.dimmed ? ' dimmed' : ''}${i === safeHighlight ? ' highlighted' : ''}`}
          onMouseEnter={() => setHighlight(i)}
          onClick={() => { onSelect(r.row.name); onClose(); }}
        >
          {r.row.name}
        </button>
      );
      flatIdx++;
    }
    if (flatIdx >= MAX_RENDERED_ROWS) break;
  }

  return (
    <div ref={popoverRef} className="overlay-dropdown-popover" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="overlay-dropdown-input"
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={placeholder ?? 'Filter…'}
      />
      <div className="overlay-dropdown-list">
        {rendered.length === 0 ? <div className="overlay-dropdown-empty">No matches</div> : rendered}
        {overflow && <div className="overlay-dropdown-overflow">… and {flatRows.length - MAX_RENDERED_ROWS} more — refine your search</div>}
      </div>
    </div>
  );
}
