/**
 * QuickMenu — the small right-click menu used by the activity rail and the
 * board ribbon. Portaled to document.body (Dockview transforms would offset
 * it otherwise), clamped to the viewport once it has a size, closed by an
 * outside pointerdown, Escape, or a window resize.
 *
 * Items are data: plain actions, checkable toggles, headers and separators.
 * One component, one clamp, one dismissal rule — instead of a copy per menu.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

export type QuickMenuItem =
  | { kind: 'header'; label: string }
  | { kind: 'sep' }
  | { kind?: 'item'; label: string; onSelect: () => void; disabled?: boolean; testId?: string; hint?: string }
  | { kind: 'check'; label: string; checked: boolean; onSelect: () => void; disabled?: boolean; testId?: string; hint?: string };

interface Props {
  x: number;
  y: number;
  items: QuickMenuItem[];
  onClose: () => void;
  ariaLabel: string;
  testId?: string;
}

export function QuickMenu({ x, y, items, onClose, ariaLabel, testId }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  }, [x, y, items.length]);

  return createPortal(
    <div ref={ref} className="quick-menu" role="menu" aria-label={ariaLabel} data-testid={testId} style={{ left: x, top: y }}>
      {items.map((it, i) => {
        if (it.kind === 'sep') return <div key={i} className="quick-menu-sep" role="separator" />;
        if (it.kind === 'header') return <div key={i} className="quick-menu-header">{it.label}</div>;
        const check = it.kind === 'check';
        return (
          <button
            key={i}
            type="button"
            role={check ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={check ? it.checked : undefined}
            disabled={it.disabled}
            data-testid={it.testId}
            title={it.hint}
            onClick={() => { it.onSelect(); onClose(); }}
          >
            <span className="quick-menu-tick">{check && it.checked ? '✓' : ''}</span>
            {it.label}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
