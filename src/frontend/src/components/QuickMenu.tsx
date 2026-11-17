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
  | { kind: 'check'; label: string; checked: boolean; onSelect: () => void; disabled?: boolean; testId?: string; hint?: string }
  /** One line of choices — swatches (when `swatch` is set) or short labels; picking one applies at once and keeps the
   *  menu open, so a colour can be tried and changed without reopening. Each option's test id is `${testId}-${value}`. */
  | { kind: 'choice'; label: string; value: string; options: { value: string; label: string; swatch?: string; hint?: string }[]; onChange: (v: string) => void; testId?: string; disabled?: boolean }
  /** A slider that stays open while it is dragged and applies live. */
  | { kind: 'range'; label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string; testId?: string };

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
        if (it.kind === 'choice') {
          return (
            <div key={i} className="quick-menu-choice" role="radiogroup" aria-label={it.label}>
              <span className="quick-menu-range-label">{it.label}</span>
              <span className="quick-menu-choice-opts">
                {it.options.map(o => (
                  <button key={o.value} type="button" role="radio" aria-checked={it.value === o.value} disabled={it.disabled}
                    className={`quick-menu-choice-opt${o.swatch ? ' swatch' : ''}${it.value === o.value ? ' on' : ''}`}
                    data-testid={it.testId ? `${it.testId}-${o.value}` : undefined} title={o.hint ?? o.label} aria-label={o.label}
                    style={o.swatch ? { ['--sw' as string]: o.swatch } : undefined}
                    onClick={() => it.onChange(o.value)}>
                    {o.swatch ? null : o.label}
                  </button>
                ))}
              </span>
            </div>
          );
        }
        if (it.kind === 'range') {
          return (
            <label key={i} className="quick-menu-range">
              <span className="quick-menu-range-label">{it.label}</span>
              <input
                type="range" min={it.min} max={it.max} step={it.step} value={it.value}
                aria-label={it.label} data-testid={it.testId}
                onChange={e => it.onChange(Number(e.target.value))}
              />
              <span className="quick-menu-range-value">{it.format ? it.format(it.value) : String(it.value)}</span>
            </label>
          );
        }
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
