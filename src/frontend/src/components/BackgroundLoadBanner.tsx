import { useSyncExternalStore } from 'react';
import { useBoardStore } from '../hooks/useBoardStore';
import { pdfStore, PDF_LOAD_PHASE_TEXT } from '../store/pdf-store';

/**
 * "Another board is loading" — shown in every visible board panel while a
 * board is being parsed or its scene built.
 *
 * Parsing runs in a worker and costs nothing here; the scene build that
 * follows runs on the main thread and freezes the page for as long as it
 * takes — about 0.7 s on a 3369-part board on this Mac, several seconds on
 * a tablet. During that time a finger on the glass gets no answer at all,
 * which read as "touch is blocked" (2026-09-28). The renderer defers the
 * build by one painted frame precisely so this banner is on screen before
 * the freeze begins; the banner itself only explains the wait, it takes no
 * input.
 */
const subscribePdf = (cb: () => void) => pdfStore.subscribe(cb);
const getPdfLoads = () => pdfStore.loads;

/** PDFs too (2026-10-09): a PDF opened from the library, or auto-loaded with
 *  its board, used to load with nothing on screen at all — the panel only
 *  appeared once the file was parsed. Its phase comes from pdfStore.loads. */
export function BackgroundLoadBanner() {
  const { backgroundLoads } = useBoardStore();
  const pdfLoads = useSyncExternalStore(subscribePdf, getPdfLoads);
  const total = backgroundLoads.count + pdfLoads.count;
  if (total === 0) return null;
  const names = [...backgroundLoads.names, ...pdfLoads.names];
  let label: string;
  if (total > 1) {
    label = backgroundLoads.count === 0 ? `Loading ${total} PDFs…`
      : pdfLoads.count === 0 ? `Loading ${total} boards…`
      : `Loading ${total} files…`;
  } else if (backgroundLoads.count === 1) {
    label = `Loading ${backgroundLoads.names[0]}…`;
  } else {
    const l = pdfLoads.byName[pdfLoads.names[0]];
    label = `${PDF_LOAD_PHASE_TEXT[l.phase]} ${l.name}…`;
  }
  return (
    <div className="background-load-banner" role="status" data-testid="background-load-banner"
         title={names.join('\n')}>
      <span className="background-load-spinner" aria-hidden="true" />
      <span className="background-load-banner-text">
        <span translate="no">{label}</span>
        {backgroundLoads.count > 0 && <> <span className="background-load-banner-hint">the view may pause until it is ready</span></>}
      </span>
    </div>
  );
}
