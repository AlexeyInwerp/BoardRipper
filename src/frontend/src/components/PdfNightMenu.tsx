/**
 * PdfNightMenu — the PDF toolbar's night-mode control (issue #41).
 *
 * The ◐ button opens a menu on click, like the wand beside it: Off, the three
 * styles — invert, dark paper with colours kept, or custom colours — the exact
 * paper and ink colours for custom, and the controls for coloured lines. The
 * button is lit while night mode is on. State is global and persisted in
 * `store/pdf-night-store.ts`.
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
        className={`pdf-toolbar-btn pdf-corrector-btn pdf-filter-btn pdf-night-btn${s.on ? ' active' : ''}${open ? ' open' : ''}`}
        data-testid="pdf-night-btn"
        data-night-style={s.style}
        aria-haspopup="menu"
        aria-expanded={open}
        title={s.on ? `PDF colours: ${STYLE_TITLE[s.style]}` : 'PDF colours'}
        onClick={() => setOpen(v => !v)}
      >
        <span aria-hidden="true">&#x25D0;</span>
        <IconChevronDown size={10} className="pdf-filter-caret" />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="quick-menu pdf-filter-menu pdf-night-menu" role="menu" aria-label="PDF colours" data-testid="pdf-night-menu">
          <div className="quick-menu-header">PDF colours · all PDFs</div>
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
                      onClick={() => pdfNightStore.setStyle(style)}>
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
          </div>
          <div className="quick-menu-sep" role="separator" />
          <div className="quick-menu-header">Coloured text and lines</div>
          <div className={`pdf-night-sliders${s.on ? '' : ' off'}`}>
            <label title="0 % turns every coloured line into a shade of the text colour">
              <span>Colour</span>
              <input type="range" min={0} max={200} step={5} value={s.colour} data-testid="pdf-night-colour"
                     onChange={e => pdfNightStore.setColour(Number(e.target.value))} />
              <span className="pdf-night-val" translate="no">{s.colour === 0 ? 'Grey' : `${s.colour} %`}</span>
            </label>
            <label title="Pulls pale lines toward the text colour so they stay readable on the new background">
              <span>Contrast</span>
              <input type="range" min={0} max={100} step={5} value={s.contrast} data-testid="pdf-night-contrast"
                     className={s.contrastAuto ? 'auto' : ''}
                     onChange={e => pdfNightStore.setContrast(Number(e.target.value))} />
              <button type="button" role="checkbox" aria-checked={s.contrastAuto}
                      className={`pdf-night-auto${s.contrastAuto ? ' on' : ''}`} data-testid="pdf-night-contrast-auto"
                      title="Choose the contrast from the background and text colours"
                      onClick={() => pdfNightStore.setContrastAuto(!s.contrastAuto)}>
                Auto
              </button>
            </label>
          </div>
          <button type="button" role="menuitem" data-testid="pdf-night-reset"
                  onClick={() => pdfNightStore.resetColors()}>
            <span className="quick-menu-tick" />
            Reset colours
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
