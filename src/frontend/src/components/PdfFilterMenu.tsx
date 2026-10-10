/**
 * PdfFilterMenu — the PDF toolbar's one filtering control.
 *
 * A single button opens a menu holding every PDF filter: the watermark text
 * filter with its term list (applies live), and the two parse-time options —
 * stripping small watermark images and skipping invisible content — which
 * only take effect when a document is opened. When an open PDF was parsed
 * under different values, "Reload & re-parse" lights up and the button
 * carries a dot until it is pressed. Every setting is global (one value for
 * all PDFs); writes go through `store/pdf-filter-actions.ts`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown, IconRefresh, IconWand, IconX } from '@tabler/icons-react';
import { renderSettingsStore } from '../store/render-settings';
import { pdfStore } from '../store/pdf-store';
import {
  addWatermarkTerm, removeWatermarkTerm, setPruneInvisible, setStripWatermarkImages, setWatermarkTextEnabled,
} from '../store/pdf-filter-actions';
import './PdfFilterMenu.css';

const subscribeSettings = (cb: () => void) => renderSettingsStore.subscribe(cb);
const subscribePdf = (cb: () => void) => pdfStore.subscribe(cb);
const getGlobal = () => renderSettingsStore.globalSettings;

/** Stable string so useSyncExternalStore sees an unchanged snapshot. */
function staleKey(): string {
  return pdfStore.staleDocuments().join('\n');
}

export function PdfFilterMenu({ fileName }: { fileName: string }) {
  const g = useSyncExternalStore(subscribeSettings, getGlobal);
  // Staleness depends on both stores: the settings say what a document should
  // be parsed with, the pdf store says what it was parsed with.
  useSyncExternalStore(subscribeSettings, staleKey);
  const staleJoined = useSyncExternalStore(subscribePdf, staleKey);
  const stale = staleJoined ? staleJoined.split('\n') : [];

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const draftRef = useRef('');
  draftRef.current = draft;
  /** A typed term the list already has: said in place, not silently kept. */
  const [dupe, setDupe] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const terms = g.pdfWatermarkFilter ?? [];
  const textOn = g.pdfWatermarkFilterEnabled !== false;
  const stripOn = g.pdfStripWatermarkImages === true;
  const pruneOn = g.pdfPruneInvisible !== false;
  const active = (textOn && terms.length > 0) || stripOn;

  // Closing commits whatever was typed: an outside press unmounts the input
  // before any blur, so without this a term typed and then clicked away from
  // was lost.
  const close = useCallback(() => {
    if (draftRef.current.trim()) {
      if (addWatermarkTerm(draftRef.current)) setDraft('');
    }
    setDupe(null);
    setOpen(false);
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

  // Anchor under the button, right-aligned, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const b = btnRef.current?.getBoundingClientRect();
    const el = menuRef.current;
    if (!b || !el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(b.right - r.width, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(b.bottom + 4, window.innerHeight - r.height - 4))}px`;
  }, [open, terms.length]);

  const commitDraft = () => {
    const term = draft.trim();
    if (!term) return;
    if (addWatermarkTerm(term)) { setDraft(''); setDupe(null); }
    else setDupe(term);
  };

  const reload = async () => {
    setReloading(true);
    try {
      // The current document first, so the one being looked at comes back soonest.
      const order = [...stale].sort((a, b) => (a === fileName ? -1 : b === fileName ? 1 : 0));
      for (const name of order) await pdfStore.reparse(name);
    } finally {
      setReloading(false);
    }
  };

  const reloadLabel = reloading
    ? 'Reloading…'
    : stale.length > 1 ? `Reload & re-parse ${stale.length} open PDFs` : 'Reload & re-parse PDF';

  return (
    <div className="pdf-corrector-wrapper">
      <button
        ref={btnRef}
        type="button"
        className={`pdf-toolbar-btn pdf-corrector-btn pdf-filter-btn${active ? ' has-active' : ''}${open ? ' open' : ''}`}
        data-testid="pdf-filter-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={stale.length > 0 ? 'PDF filters — reload needed to apply a change' : 'PDF filters'}
        onClick={() => setOpen(v => !v)}
      >
        <IconWand size={14} />
        <IconChevronDown size={10} className="pdf-filter-caret" />
        {stale.length > 0 && <span className="pdf-filter-dot" data-testid="pdf-filter-dot" />}
      </button>
      {open && createPortal(
        <div ref={menuRef} className="quick-menu pdf-filter-menu" role="menu" aria-label="PDF filters" data-testid="pdf-filter-menu">
          <div className="quick-menu-header">Watermarks · all PDFs</div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={textOn}
            data-testid="pdf-filter-wm-text"
            onClick={() => setWatermarkTextEnabled(!textOn)}
          >
            <span className="quick-menu-tick">{textOn ? '✓' : ''}</span>
            Hide watermark text
          </button>
          <div className={`pdf-filter-terms${textOn ? '' : ' off'}`}>
            {terms.map(t => (
              <span key={t} className="pdf-filter-term" data-testid="pdf-filter-term">
                {t}
                <button type="button" aria-label={`Remove ${t}`} onClick={() => removeWatermarkTerm(t)}>
                  <IconX size={10} />
                </button>
              </span>
            ))}
            <input
              className="pdf-filter-term-input"
              data-testid="pdf-filter-term-input"
              placeholder="Add term…"
              value={draft}
              onChange={e => { setDraft(e.target.value); if (dupe) setDupe(null); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitDraft(); } }}
              onBlur={() => { if (draft.trim()) commitDraft(); }}
            />
            {dupe && <span className="pdf-filter-dupe" data-testid="pdf-filter-dupe">“{dupe}” is already listed</span>}
          </div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={stripOn}
            data-testid="pdf-filter-strip-images"
            title="Remove images up to 50 px (logos, stamps) before the PDF is parsed. Applies on reload."
            onClick={() => setStripWatermarkImages(!stripOn)}
          >
            <span className="quick-menu-tick">{stripOn ? '✓' : ''}</span>
            Strip small watermark images
            <span className="pdf-filter-note">on reload</span>
          </button>
          <div className="quick-menu-sep" role="separator" />
          <div className="quick-menu-header">Performance</div>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={pruneOn}
            data-testid="pdf-filter-prune"
            title="Skip content that cannot be seen — transparent images, invisible fills, empty transparency groups. The page looks the same; some PDFs scroll and zoom much faster. Applies on reload."
            onClick={() => setPruneInvisible(!pruneOn)}
          >
            <span className="quick-menu-tick">{pruneOn ? '✓' : ''}</span>
            Skip invisible content
            <span className="pdf-filter-note">on reload</span>
          </button>
          <div className="quick-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="pdf-filter-reload"
            data-testid="pdf-filter-reload"
            disabled={stale.length === 0 || reloading}
            title={stale.length === 0 ? 'Every open PDF is parsed with the current settings' : stale.join('\n')}
            onClick={() => { void reload(); }}
          >
            <span className="quick-menu-tick"><IconRefresh size={12} /></span>
            {reloadLabel}
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}
