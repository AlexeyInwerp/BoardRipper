import { useBoardStore } from '../hooks/useBoardStore';

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
export function BackgroundLoadBanner() {
  const { backgroundLoads } = useBoardStore();
  if (backgroundLoads.count === 0) return null;
  const label = backgroundLoads.count === 1
    ? `Loading ${backgroundLoads.names[0]}…`
    : `Loading ${backgroundLoads.count} boards…`;
  return (
    <div className="background-load-banner" role="status" data-testid="background-load-banner"
         title={backgroundLoads.names.join('\n')}>
      <span className="background-load-spinner" aria-hidden="true" />
      <span className="background-load-banner-text">
        {label} <span className="background-load-banner-hint">the view may pause until it is ready</span>
      </span>
    </div>
  );
}
