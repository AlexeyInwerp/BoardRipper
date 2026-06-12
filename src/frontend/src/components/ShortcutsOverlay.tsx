import { useEffect, useState } from 'react';
import { shortcuts, formatShortcut, type Shortcut } from '../store/keyboard-shortcuts';

const CATEGORY_LABELS: Record<Shortcut['category'], string> = {
  file: 'File',
  view: 'Board',
  wsad: 'WSAD Navigation',
  navigation: 'Navigation',
  pdf: 'PDF (when panel is active)',
};
const CATEGORY_ORDER: Shortcut['category'][] = ['file', 'view', 'wsad', 'navigation', 'pdf'];

/**
 * Press `?` (Shift+/) anywhere outside a text field to toggle a keyboard-
 * shortcut cheat sheet — the registry is otherwise only visible on the empty
 * home screen, unreachable once a board is open. Esc or outside-click closes.
 */
export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) { setOpen(false); return; }
      if (e.key !== '?') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      setOpen(v => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  return (
    <div className="shortcuts-overlay-backdrop" onClick={() => setOpen(false)}>
      <div className="shortcuts-overlay" role="dialog" aria-label="Keyboard shortcuts" onClick={e => e.stopPropagation()}>
        <div className="shortcuts-overlay-header">
          <span>Keyboard shortcuts</span>
          <button className="shortcuts-overlay-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
        </div>
        <div className="home-shortcut-grid">
          {CATEGORY_ORDER.map(cat => {
            const items = shortcuts.filter(s => s.category === cat && !s.hideInList);
            if (items.length === 0) return null;
            return (
              <div key={cat} className="home-shortcut-col">
                <h3 className="home-shortcut-category">{CATEGORY_LABELS[cat]}</h3>
                <ul className="home-shortcut-list">
                  {items.map(s => (
                    <li key={s.id} className="home-shortcut-row">
                      <span className="home-shortcut-label">{s.label}</span>
                      <kbd className="home-shortcut-key">{formatShortcut(s.id)}</kbd>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
