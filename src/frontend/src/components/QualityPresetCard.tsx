/**
 * Board quality preset — four buttons that each write several render
 * settings at once (`store/quality-preset.ts`). Start page, beside the
 * Interface scale and HDR cards, and at the top of Settings ▸ Rendering.
 *
 * The highlighted button is derived from the settings, never stored: a hand
 * edit of any setting a preset covers shows "Custom". The readout says what
 * the settings come to on this machine — on a desktop, Quality and Balanced
 * are the same thing, and the readout is how a user can tell.
 */
import { useSyncExternalStore } from 'react';
import { renderSettingsStore } from '../store/render-settings';
import {
  QUALITY_PRESETS, applyQualityPreset, effectiveBoardRender, matchQualityPreset, isTouchPrimary,
} from '../store/quality-preset';

function useGlobalSettings() {
  return useSyncExternalStore(
    (cb) => renderSettingsStore.subscribe(cb),
    () => renderSettingsStore.globalSettings,
  );
}

export function QualityPresetCard() {
  const s = useGlobalSettings();
  const current = matchQualityPreset(s);
  const eff = effectiveBoardRender(s);
  const preset = QUALITY_PRESETS.find((p) => p.id === current);
  const readout = `${eff.resolution}× · ${eff.fps}${s.boardAntialiasing ? '' : ' · no MSAA'}`;

  return (
    <div className="ui-scale-full home-quality-card" data-testid="quality-preset-card">
      <div className="ui-scale-full-label">
        <span>Board quality</span>
        <span className="ui-scale-full-readout" translate="no" title="Board render resolution and frame-rate cap on this device">
          {readout}
        </span>
      </div>
      <div className="home-quality-buttons" role="radiogroup" aria-label="Board quality preset">
        {QUALITY_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={current === p.id}
            className={`home-quality-btn${current === p.id ? ' active' : ''}`}
            data-testid={`quality-preset-${p.id}`}
            onClick={() => applyQualityPreset(p.id)}
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="ui-scale-full-hint">
        <span>{preset ? preset.hint : 'Custom — settings were changed by hand in Settings ▸ Rendering.'}</span>
        {isTouchPrimary() && current !== 'fast' && current !== 'fastest' && (
          <span> If boards stutter on this tablet, try Fast.</span>
        )}
      </div>
    </div>
  );
}
