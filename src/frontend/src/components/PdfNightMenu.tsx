/**
 * PdfNightMenu — the PDF toolbar's night-mode control (issue #41).
 *
 * The ◐ button toggles night mode in the chosen style; holding it or a
 * right-click opens a menu to pick the style — invert, dark paper with
 * colours kept, or custom colours — and, for custom, the exact paper and ink
 * colours. State is global and persisted in `store/pdf-night-store.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pdfNightStore, usePdfNight, type NightStyle } from '../store/pdf-night-store';
import './PdfFilterMenu.css';

const STYLES: { style: NightStyle; label: string; hint: string }[] = [
  { style: 'dark', label: 'Dark paper, keep colours', hint: 'Black background; red and blue lines stay red and blue, lighter' },
  { style: 'invert', label: 'Invert colours', hint: 'Every colour flipped (red turns cyan)' },
  { style: 'custom', label: 'Custom colours', hint: 'Choose the exact background and text colour' },
];

const STYLE_TITLE: Record<NightStyle, string> = {
  dark: 'dark paper, colours kept',
  invert: 'invert colours',
  custom: 'custom colours',
};

/** Long-press, as on the board ribbon's history chevrons. */
const HOLD_MS = 500;

export function PdfNightMenu() {
  const s = usePdfNight();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdFired = useRef(false);
  const cancelHold = useCallback(() => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  // Anchor under the button group, right-aligned, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    const el = menuRef.current;
    if (!b || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(b.right - r.width, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(b.bottom + 4, window.innerHeight - r.height - 4))}px`;
  }, [open, s.style]);

  const customOn = s.on && s.style === 'custom';

  return (
    <div className="pdf-corrector-wrapper">
      <button
        ref={btnRef}
        type="button"
        className={`pdf-toolbar-btn pdf-night-btn${s.on ? ' active' : ''}${open ? ' open' : ''}`}
        data-testid="pdf-night-btn"
        data-night-style={s.style}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Night mode: ${STYLE_TITLE[s.style]} · hold or right-click for styles and colours`}
        onPointerDown={e => {
          holdFired.current = false;
          if (e.button !== 0) return;
          cancelHold();
          holdTimer.current = setTimeout(() => { holdTimer.current = null; holdFired.current = true; setOpen(true); }, HOLD_MS);
        }}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={e => { e.preventDefault(); cancelHold(); setOpen(v => !v); }}
        onClick={() => {
          if (holdFired.current) { holdFired.current = false; return; }
          pdfNightStore.setOn(!s.on);
        }}
      >
        &#x25D0;
      </button>
      {open && createPortal(
        <div ref={menuRef} className="quick-menu pdf-filter-menu pdf-night-menu" role="menu" aria-label="Night mode" data-testid="pdf-night-menu">
          <div className="quick-menu-header">Night mode · all PDFs</div>
          <button type="button" role="menuitemradio" aria-checked={!s.on} data-testid="pdf-night-off"
                  onClick={() => { pdfNightStore.setOn(false); close(); }}>
            <span className="quick-menu-tick">{!s.on ? '✓' : ''}</span>
            Off
          </button>
          {STYLES.map(({ style, label, hint }) => {
            const checked = s.on && s.style === style;
            return (
              <button key={style} type="button" role="menuitemradio" aria-checked={checked}
                      data-testid={`pdf-night-${style}`} title={hint}
                      onClick={() => { pdfNightStore.setStyle(style); if (style !== 'custom') close(); }}>
                <span className="quick-menu-tick">{checked ? '✓' : ''}</span>
                {label}
              </button>
            );
          })}
          <div className={`pdf-night-colors${customOn ? '' : ' off'}`}>
            <label>
              <input type="color" data-testid="pdf-night-bg" value={s.bg}
                     onChange={e => { pdfNightStore.setColors({ bg: e.target.value }); pdfNightStore.setStyle('custom'); }} />
              Background
            </label>
            <label>
              <input type="color" data-testid="pdf-night-fg" value={s.fg}
                     onChange={e => { pdfNightStore.setColors({ fg: e.target.value }); pdfNightStore.setStyle('custom'); }} />
              Text and lines
            </label>
            <button type="button" className="pdf-night-reset" data-testid="pdf-night-reset"
                    onClick={() => pdfNightStore.resetColors()}>
              Reset
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
