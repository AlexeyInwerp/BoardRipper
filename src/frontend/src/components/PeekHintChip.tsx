import { useEffect, useState } from 'react';
import { usePeekHintVisible } from '../store/peek-hint-store';

/**
 * Floating hint chip shown while the user is holding Space past the
 * tap-vs-hold threshold. The keyboard handler:
 *   - arms a timer at keydown that calls peekHintStore.show() once the
 *     threshold expires;
 *   - arms a second timer that calls peekHintStore.hide() after a fixed
 *     lifespan so the chip never lingers indefinitely on a long peek;
 *   - cancels both timers on keyup / blur.
 *
 * We keep a brief local "fading" state so the visible→hidden transition
 * gets the CSS opacity fade instead of an instant pop-out.
 */
const FADE_OUT_MS = 400;

export function PeekHintChip() {
  const storeVisible = usePeekHintVisible();
  const [phase, setPhase] = useState<'hidden' | 'visible' | 'fading'>('hidden');

  useEffect(() => {
    if (storeVisible) {
      setPhase('visible');
      return;
    }
    if (phase === 'visible') {
      setPhase('fading');
      const t = setTimeout(() => setPhase('hidden'), FADE_OUT_MS);
      return () => clearTimeout(t);
    }
    // already hidden / fading-to-hidden — no-op
    return;
  }, [storeVisible, phase]);

  if (phase === 'hidden') return null;
  return (
    <div
      className={`peek-hint-chip${phase === 'fading' ? ' fading' : ''}`}
      role="status"
      aria-live="polite"
    >
      Peeking other side — release Space to revert
    </div>
  );
}
