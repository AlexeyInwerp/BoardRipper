import { useEffect, useRef, useState, type ReactNode } from 'react';
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

export interface DropdownPopoverProps {
  /** Builds the list groups from the current filter (already lower-cased). Pure. */
  buildGroups: (queryLower: string) => DropdownPopoverGroup[];
  /** Called with the picked row's name (original case). */
  onSelect: (name: string) => void;
  /** Closes the popover. Called on Esc, outside click, or after selection. */
  onClose: () => void;
  /** Placeholder text in the filter input. */
  placeholder?: string;
}

/**
 * Filter input + grouped list with keyboard navigation. Used by Parts and
 * Nets dropdowns. Caps rendered rows at MAX_RENDERED_ROWS — anything past
 * shows a "… and N more — refine your search" footer.
 */
export function DropdownPopover({ buildGroups, onSelect, onClose, placeholder }: DropdownPopoverProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  // Clamp highlight to valid range — derived during render, no effect needed.
  const safeHighlight = cappedFlat.length === 0 ? 0 : Math.min(highlight, cappedFlat.length - 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = cappedFlat[safeHighlight];
      if (r) { onSelect(r.row.name); onClose(); }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight(h => Math.min(h + 1, cappedFlat.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    }
  };

  // Scroll highlight into view
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-row-idx="${safeHighlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [safeHighlight]);

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
      <div ref={listRef} className="overlay-dropdown-list">
        {rendered.length === 0
          ? <div className="overlay-dropdown-empty">No matches</div>
          : rendered}
        {overflow && (
          <div className="overlay-dropdown-overflow">
            … and {flatRows.length - MAX_RENDERED_ROWS} more — refine your search
          </div>
        )}
      </div>
    </div>
  );
}
