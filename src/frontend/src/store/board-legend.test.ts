import { describe, it, expect } from 'vitest';
import type { BoardData, Part } from '../parsers';
import { DEFAULT_PIN_GROUPS } from './render-settings';
import { pinLegend, pinRuleFor, readingBand, readingCounts } from './board-legend';

const part = (side: 'top' | 'bottom', nets: string[], diode?: unknown[]): Part =>
  ({ name: 'U1', side, pins: nets.map((net, i) => ({ net, diode: diode?.[i] })) } as unknown as Part);
const board = (parts: Part[]) => ({ parts } as unknown as BoardData);

describe('pinRuleFor', () => {
  it('walks groups and rules in order, first match wins', () => {
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'PP3V3_S5')).toBe('power-pp');
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'AGND')).toBe('gnd-sep');     // before GND
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'GND')).toBe('gnd');
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'I2C0_SDA')).toBe('serial');
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'NC')).toBe('nc');
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, 'SYNC_X')).toBeNull();        // outline-only matches exactly
    expect(pinRuleFor(DEFAULT_PIN_GROUPS, '')).toBeNull();
  });
});

describe('pinLegend', () => {
  it('counts every pin once: by rule, or as unmatched on its side', () => {
    const b = board([
      part('top', ['GND', 'PP1V8', 'FOO', 'BAR']),
      part('bottom', ['GND', 'BAZ', '']),
    ]);
    const l = pinLegend(b, DEFAULT_PIN_GROUPS);
    expect(l.byRule.get('gnd')).toBe(2);
    expect(l.byRule.get('power-pp')).toBe(1);
    expect(l.byRule.get('ddr')).toBe(0);                                // listed, colours nothing
    expect(l.unmatchedTop).toBe(2);
    expect(l.unmatchedBottom).toBe(2);
    const total = [...l.byRule.values()].reduce((a, n) => a + n, 0) + l.unmatchedTop + l.unmatchedBottom;
    expect(total).toBe(7);
  });

  it('recounts when the rules change', () => {
    const b = board([part('top', ['FOO_X'])]);
    expect(pinLegend(b, DEFAULT_PIN_GROUPS).unmatchedTop).toBe(1);
    const groups = [{ id: 'g', label: 'G', outlineOnly: false, rules: [{ id: 'foo', keywords: 'FOO', color: '#fff' }] }];
    expect(pinLegend(b, groups).byRule.get('foo')).toBe(1);
  });
});

describe('readings', () => {
  it('bands match the on-pin colours', () => {
    expect(readingBand({ kind: 'value', mv: 12 } as never)).toBe('short');
    expect(readingBand({ kind: 'value', mv: 200 } as never)).toBe('junction');
    expect(readingBand({ kind: 'value', mv: 400 } as never)).toBe('junction');
    expect(readingBand({ kind: 'value', mv: 401 } as never)).toBe('high');
    expect(readingBand({ kind: 'open' } as never)).toBe('open');
    expect(readingBand({ kind: 'none' } as never)).toBeNull();
    expect(readingBand(undefined)).toBeNull();
  });
  it('counts the readings the file carries', () => {
    const b = board([part('top', ['A', 'B', 'C'], [{ kind: 'value', mv: 335 }, { kind: 'open' }, undefined])]);
    const c = readingCounts(b);
    expect(c.get('junction')).toBe(1);
    expect(c.get('open')).toBe(1);
    expect(c.get('short')).toBeUndefined();
  });
});
