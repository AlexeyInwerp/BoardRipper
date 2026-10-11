/**
 * PdfNightMenu — the PDF toolbar's night-mode control (issue #41).
 *
 * The ◐ button toggles night mode in the chosen style; the caret (or a
 * right-click on ◐) opens a menu to pick the style — invert, dark paper with
 * colours kept, or custom colours — and, for custom, the exact paper and ink
 * colours. State is global and persisted in `store/pdf-night-store.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown } from '@tabler/icons-react';
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

export function PdfNightMenu() {
  const s = usePdfNight();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.parentElement?.contains(t)) return;
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
    const b = btnRef.current?.parentElement?.getBoundingClientRect();
    const el = menuRef.current;
    if (!b || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(b.right - r.width, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(b.bottom + 4, window.innerHeight - r.height - 4))}px`;
  }, [open, s.style]);

  const openMenu = (e: React.MouseEvent) => { e.preventDefault(); setOpen(v => !v); };
  const customOn = s.on && s.style === 'custom';

  return (
    <div className="pdf-corrector-wrapper pdf-night-wrapper">
      <button
        type="button"
        className={`pdf-toolbar-btn pdf-night-btn${s.on ? ' active' : ''}`}
        data-testid="pdf-night-btn"
        data-night-style={s.style}
        onClick={() => pdfNightStore.setOn(!s.on)}
        onContextMenu={openMenu}
        title={`Night mode: ${STYLE_TITLE[s.style]} (▾ or right-click to change)`}
      >
        &#x25D0;
      </button>
      <button
        ref={btnRef}
        type="button"
        className={`pdf-toolbar-btn pdf-night-caret${open ? ' open' : ''}`}
        data-testid="pdf-night-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Night mode style and colours"
        onClick={openMenu}
      >
        <IconChevronDown size={10} className="pdf-filter-caret" />
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
