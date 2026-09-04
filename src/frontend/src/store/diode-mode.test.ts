import { describe, it, expect } from 'vitest';
import { diodeMode, cycleDiodeMode, diodeModeTitle } from './diode-readings';

const S = (showDiodeValues: boolean, diodeValuesOnly: boolean) => ({ showDiodeValues, diodeValuesOnly });

describe('diode display mode', () => {
  it('reads the three states from the two booleans', () => {
    expect(diodeMode(S(false, false))).toBe('off');
    expect(diodeMode(S(true, false))).toBe('on');
    expect(diodeMode(S(true, true))).toBe('only');
  });

  it('ignores a stale diodeValuesOnly while readings are hidden', () => {
    // The cycle never produces this pair, but the Settings panel exposes both
    // toggles independently, so the reader must not report "only" with the
    // reading layer switched off.
    expect(diodeMode(S(false, true))).toBe('off');
  });

  it('cycles off → on → only → off', () => {
    let s = S(false, false);
    s = { ...s, ...cycleDiodeMode(s) }; expect(diodeMode(s)).toBe('on');
    s = { ...s, ...cycleDiodeMode(s) }; expect(diodeMode(s)).toBe('only');
    s = { ...s, ...cycleDiodeMode(s) }; expect(diodeMode(s)).toBe('off');
  });

  it('leaves nothing set when it returns to off', () => {
    // A stuck diodeValuesOnly would blank pin numbers the moment the user
    // re-enabled readings from Settings rather than the button.
    expect(cycleDiodeMode(S(true, true))).toEqual({ showDiodeValues: false, diodeValuesOnly: false });
  });

  it('names the current state and the next click in every title', () => {
    for (const m of ['off', 'on', 'only'] as const) {
      expect(diodeModeTitle(m).toLowerCase()).toContain('click');
    }
  });
});
