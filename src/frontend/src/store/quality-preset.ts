/**
 * Quality presets: one choice that writes several render settings at once.
 *
 * A preset is not a setting of its own — it is a macro over the settings that
 * decide what a frame costs, and the current preset is *derived* by matching
 * those settings, so changing any one of them by hand shows "Custom" rather
 * than a preset that no longer describes what is drawn.
 *
 * What the knobs buy, measured 2026-10-06 on a 3369-part / 39k-trace Allegro
 * board at the fit view (Chromium, iPad-sized viewport at DPR 2):
 *  - `boardResolutionCap` 1 instead of the touch profile's 1.5 — 44 % of the
 *    fragments; the cost a tile GPU (A12Z) pays for every MSAA sample.
 *  - `traceCorners: 'simple'` — 3.7 M → 1.8 M vertices a frame at the fit
 *    view, where every trace is on screen and culling cannot help.
 *  - `cap60Fps` — an iPad Pro's 120 Hz panel otherwise asks for twice the work.
 *  - label thresholds — fewer, larger labels for the Canvas2D overlay to draw.
 *  - `boardAntialiasing` off (Fastest only) — the board outline and thin
 *    traces go jaggy at overview zoom; the last resort, not a default.
 */
import { renderSettingsStore, type RenderSettings } from './render-settings';
import { boardPixelRatio, boardMaxFps, isTouchPrimary } from '../device-profile';

export type QualityPresetId = 'quality' | 'balanced' | 'fast' | 'fastest';

type PresetKey =
  | 'touchPerformanceMode' | 'boardResolutionCap' | 'boardAntialiasing' | 'cap60Fps'
  | 'traceCorners' | 'labelMinScreenPx' | 'circleLabelMinScreenPx' | 'twoPinLabelMinScreenPx';

export interface QualityPreset {
  id: QualityPresetId;
  label: string;
  /** One line under the buttons: what this preset trades. */
  hint: string;
  values: Pick<RenderSettings, PresetKey>;
}

const LABELS_DEFAULT = { labelMinScreenPx: 3, circleLabelMinScreenPx: 8, twoPinLabelMinScreenPx: 6 };

export const QUALITY_PRESETS: readonly QualityPreset[] = [
  {
    id: 'quality',
    label: 'Quality',
    hint: 'Full resolution and the display\'s full refresh rate, on a tablet too.',
    values: {
      touchPerformanceMode: false, boardResolutionCap: 0, boardAntialiasing: true, cap60Fps: false,
      traceCorners: 'round', ...LABELS_DEFAULT,
    },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    hint: 'The default. On a tablet: 60 fps and 1.5× resolution; elsewhere the same as Quality.',
    values: {
      touchPerformanceMode: true, boardResolutionCap: 0, boardAntialiasing: true, cap60Fps: false,
      traceCorners: 'round', ...LABELS_DEFAULT,
    },
  },
  {
    id: 'fast',
    label: 'Fast',
    hint: 'For older tablets and laptops: 1× resolution, 60 fps, simpler trace corners, fewer tiny labels.',
    values: {
      touchPerformanceMode: true, boardResolutionCap: 1, boardAntialiasing: true, cap60Fps: true,
      traceCorners: 'simple', labelMinScreenPx: 5, circleLabelMinScreenPx: 9, twoPinLabelMinScreenPx: 8,
    },
  },
  {
    id: 'fastest',
    label: 'Fastest',
    hint: 'Fast, plus no edge smoothing and only larger labels. Thin lines look jagged.',
    values: {
      touchPerformanceMode: true, boardResolutionCap: 1, boardAntialiasing: false, cap60Fps: true,
      traceCorners: 'simple', labelMinScreenPx: 7, circleLabelMinScreenPx: 11, twoPinLabelMinScreenPx: 10,
    },
  },
];

/** The preset the settings currently match, or null for "Custom". */
export function matchQualityPreset(s: Pick<RenderSettings, PresetKey>): QualityPresetId | null {
  for (const p of QUALITY_PRESETS) {
    let all = true;
    for (const k of Object.keys(p.values) as PresetKey[]) {
      if (s[k] !== p.values[k]) { all = false; break; }
    }
    if (all) return p.id;
  }
  return null;
}

/** Write a preset's values into the global settings in one commit. */
export function applyQualityPreset(id: QualityPresetId): void {
  const p = QUALITY_PRESETS.find((q) => q.id === id);
  if (!p) return;
  const snap = renderSettingsStore.globalSnapshot();
  Object.assign(snap, p.values);
  renderSettingsStore.applyGlobal(snap);
}

/** What the settings come to on this machine, for the readout. */
export function effectiveBoardRender(s: Pick<RenderSettings, PresetKey>): { resolution: number; fps: string } {
  const res = boardPixelRatio(s.touchPerformanceMode, s.boardResolutionCap);
  const max = boardMaxFps(s.cap60Fps, s.touchPerformanceMode);
  return { resolution: Math.round(res * 100) / 100, fps: max > 0 ? `${max} fps` : 'display rate' };
}

export { isTouchPrimary };
