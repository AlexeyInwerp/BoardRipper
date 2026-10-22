/**
 * QuickMenu — the small right-click menu used by the activity rail and the
 * board ribbon. Portaled to the body of the document it is rendered in
 * (Dockview transforms would offset it otherwise; a panel popped out into its
 * own window has its own document), clamped to that window's viewport once it
 * has a size, closed by an outside pointerdown, Escape, or a window resize.
 *
 * Items are data: plain actions, checkable toggles, headers and separators.
 * One component, one clamp, one dismissal rule — instead of a copy per menu.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uiZoom } from '../store/ui-zoom';

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
  // A hidden anchor rendered in place tells which document the caller lives
  // in; the menu is portaled there once it is known (before the first paint).
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [doc, setDoc] = useState<Document | null>(null);
  useLayoutEffect(() => { setDoc(anchorRef.current?.ownerDocument ?? document); }, []);

  useEffect(() => {
    if (!doc) return;
    const win = doc.defaultView ?? window;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('keydown', onKey);
    win.addEventListener('resize', onClose);
    return () => {
      doc.removeEventListener('pointerdown', onDown, true);
      doc.removeEventListener('keydown', onKey);
      win.removeEventListener('resize', onClose);
    };
  }, [onClose, doc]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !doc) return;
    const win = doc.defaultView ?? window;
    const r = el.getBoundingClientRect();
    // Fixed inside the zoomed body: pointer and rect are unzoomed, offsets are not.
    const z = uiZoom(doc);
    el.style.left = `${Math.max(4, Math.min(x / z, (win.innerWidth - r.width) / z - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(y / z, (win.innerHeight - r.height) / z - 4))}px`;
  }, [x, y, items.length, doc]);

  if (!doc) return <span ref={anchorRef} hidden />;

  return createPortal(
    <div ref={ref} className="quick-menu" role="menu" aria-label={ariaLabel} data-testid={testId} style={{ left: x / uiZoom(doc ?? document), top: y / uiZoom(doc ?? document) }}>
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
    doc.body,
  );
}
