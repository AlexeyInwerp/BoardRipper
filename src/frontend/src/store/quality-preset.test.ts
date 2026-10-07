import { describe, it, expect } from 'vitest';
import { QUALITY_PRESETS, matchQualityPreset } from './quality-preset';
import { DEFAULTS } from './render-settings';

describe('quality presets', () => {
  it('the shipped defaults are Balanced', () => {
    expect(matchQualityPreset(DEFAULTS)).toBe('balanced');
  });

  it('every preset matches itself and no other', () => {
    for (const p of QUALITY_PRESETS) {
      expect(matchQualityPreset({ ...DEFAULTS, ...p.values })).toBe(p.id);
    }
  });

  it('a hand edit of a covered setting is Custom', () => {
    const fast = QUALITY_PRESETS.find((p) => p.id === 'fast')!;
    expect(matchQualityPreset({ ...DEFAULTS, ...fast.values, labelMinScreenPx: 4 })).toBeNull();
  });
});
