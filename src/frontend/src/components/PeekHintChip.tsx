import { usePeekHintVisible } from '../store/peek-hint-store';

/**
 * Floating hint chip shown while the user is holding Space past the
 * tap-vs-hold threshold. The keyboard handler arms a timer at keydown;
 * the timer flips this chip on once the threshold expires, and keyup /
 * blur dismisses it. A casual tap-flip never sees the chip — the user
 * only meets it the first time they actually linger on the key, which
 * is precisely when the hold semantics matter.
 */
export function PeekHintChip() {
  const visible = usePeekHintVisible();
  if (!visible) return null;
  return (
    <div className="peek-hint-chip" role="status" aria-live="polite">
      Peeking other side — release Space to revert
    </div>
  );
}
