/**
 * Interface scaling slider — exposes themeStore.scale to the user.
 * Used in two places:
 *   - SettingsPanel ▸ Theme tab
 *   - HomeBackdrop  ▸ dedicated row under the welcome banner
 *
 * Behaviour: scale is committed on pointer-up / key-up only. While
 * dragging, the thumb moves and the % readout updates from a local draft,
 * but body zoom does not change — otherwise the slider track shrinks
 * under the pointer mid-drag and becomes hard to grab. Double-click the
 * slider (or release at 100%) to revert to default.
 */
import { useSyncExternalStore, useCallback, useState, useEffect } from 'react';
import {
  themeStore,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  UI_SCALE_STEP,
} from '../store/themes';

function useScale(): number {
  return useSyncExternalStore(
    (cb) => themeStore.subscribe(cb),
    () => themeStore.scale,
  );
}

function formatPct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function InterfaceScaleSlider() {
  const committed = useScale();
  // Local draft so the thumb tracks the pointer during drag without
  // applying the new body zoom yet (which would resize this very control).
  const [draft, setDraft] = useState<number | null>(null);
  const display = draft ?? committed;

  // Sync the draft when the committed value changes from elsewhere
  // (Reset button, other surface adjusting scale, etc.).
  useEffect(() => { setDraft(null); }, [committed]);

  const onInput = useCallback((e: React.FormEvent<HTMLInputElement>) => {
    const n = parseFloat(e.currentTarget.value);
    if (Number.isFinite(n)) setDraft(n);
  }, []);

  const commit = useCallback(() => {
    setDraft((d) => {
      if (d != null && d !== committed) themeStore.setScale(d);
      return null;
    });
  }, [committed]);

  // Double-click resets to default. Replaces the old conditional "Reset"
  // button, which appeared/disappeared as the value crossed 100% and shifted
  // the slider track width → visible jitter while dragging near default.
  const onReset = useCallback(() => {
    setDraft(null);
    themeStore.setScale(null);
  }, []);

  return (
    <div className="ui-scale-full">
      <div className="ui-scale-full-label">
        <span>Interface scale</span>
        <span className="ui-scale-full-readout">{formatPct(display)}</span>
      </div>
      <div className="ui-scale-full-controls">
        <input
          type="range"
          min={UI_SCALE_MIN}
          max={UI_SCALE_MAX}
          step={UI_SCALE_STEP}
          value={display}
          onInput={onInput}
          onChange={onInput}
          onPointerUp={commit}
          onPointerCancel={commit}
          onKeyUp={commit}
          onBlur={commit}
          onDoubleClick={onReset}
          aria-label="Interface scale"
        />
      </div>
      <div className="ui-scale-full-hint">
        Scales every panel, toolbar, dialog, and the start page. Board and PDF
        rendering keep their native resolution. Applied on release; double-click
        the slider to reset to 100%.
      </div>
    </div>
  );
}
