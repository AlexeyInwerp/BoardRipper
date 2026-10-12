import { describe, expect, it } from 'vitest';
import { autoScale, contrastTable, nightPipeline, tableValueAt, type PdfNightState } from './pdf-night-store';

type RGB = [number, number, number];
const rgb = (h: string): RGB => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const lum = (c: RGB) => {
  const l = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2]);
};
const ratio = (a: RGB, b: RGB) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** Contrast against the paper of a source line of lightness x after the curve
 *  and the paper/ink map — what the panel's SVG filter produces. */
function lineContrast(bgHex: string, fgHex: string, x: number): number {
  const bg = rgb(bgHex), fg = rgb(fgHex);
  const y = tableValueAt(autoScale(bgHex, fgHex), x);
  return ratio([0, 1, 2].map(i => fg[i] + (bg[i] - fg[i]) * y) as RGB, bg);
}

const AUTO_REF = 0.88;

describe('autoScale', () => {
  it.each([
    ['#000000', '#ffffff'],
    ['#1e1f22', '#d6d6d6'],
    ['#ffffff', '#000000'],
    ['#0b1a2e', '#e8d9a0'],
    ['#f4ecd8', '#3a2a1a'],
  ])('puts the reference line at 4.5:1 on %s / %s', (bg, fg) => {
    expect(lineContrast(bg, fg, AUTO_REF)).toBeGreaterThanOrEqual(4.5 - 1e-6);
    // The largest such scale: not overshooting by much either.
    expect(lineContrast(bg, fg, AUTO_REF)).toBeLessThan(4.52);
  });

  it.each([
    ['#202020', '#909090'],
    ['#303030', '#707070'],
  ])('respects a soft pair at 60 %% of its own contrast (%s / %s)', (bg, fg) => {
    const target = 1 + (ratio(rgb(fg), rgb(bg)) - 1) * 0.6;
    expect(target).toBeLessThan(4.5);
    expect(lineContrast(bg, fg, AUTO_REF)).toBeGreaterThanOrEqual(target - 1e-6);
  });

  it('stays within [0.2, 1]', () => {
    for (const [bg, fg] of [['#000000', '#ffffff'], ['#808080', '#7f7f7f'], ['#ffffff', '#ffffff']]) {
      const m = autoScale(bg, fg);
      expect(m).toBeGreaterThanOrEqual(0.2);
      expect(m).toBeLessThanOrEqual(1);
    }
  });
});

describe('contrastTable', () => {
  it('is the identity at m = 1', () => {
    contrastTable(1).forEach((v, i, t) => expect(v).toBeCloseTo(i / (t.length - 1), 12));
  });
  it('tableValueAt interpolates between knots', () => {
    const t = contrastTable(0.5);
    expect(tableValueAt(0.5, 22 / 25)).toBeCloseTo(t[22], 12);
    expect(tableValueAt(0.5, 22.5 / 25)).toBeCloseTo((t[22] + t[23]) / 2, 12);
    expect(tableValueAt(0.5, 1)).toBeCloseTo(1, 12);
  });
});

describe('nightPipeline', () => {
  const base: PdfNightState = {
    on: true, style: 'invert', bg: '#1e1f22', fg: '#d6d6d6', colour: 100, contrastAuto: false, contrast: 0,
  };
  it('is the CSS-only inversion with no curve', () => {
    expect(nightPipeline(base, 'f')).toEqual({ css: 'invert(1)', svg: null });
  });
  it('uses the SVG filter when Auto squeezes the pale range', () => {
    expect(nightPipeline({ ...base, contrastAuto: true }, 'f')?.svg).not.toBeNull();
  });
  it('is null when off', () => {
    expect(nightPipeline({ ...base, on: false }, 'f')).toBeNull();
  });
});
