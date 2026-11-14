import { describe, it, expect } from 'vitest';
import type { Part, Pin } from '../parsers/types';
import { estimatePart, chipSizeVote, parsePackageName } from './package-estimate';

const MIL = 1 / 0.0254;
/** Pin at (x, y) mm with a w×h mm pad. */
function pin(number: string, x: number, y: number, w = 0.6, h = 0.6, extra: Partial<Pin> = {}): Pin {
  const px = x * MIL, py = y * MIL, pw = w * MIL, ph = h * MIL;
  return { name: number, number, position: { x: px, y: py }, radius: Math.min(pw, ph) / 2, side: 'top', net: 'N' + number, padWidth: pw, padHeight: ph, padBounds: { minX: px - pw / 2, maxX: px + pw / 2, minY: py - ph / 2, maxY: py + ph / 2 }, ...extra };
}
function part(name: string, pins: Pin[], pkg?: string): Part {
  return { name, side: 'top', type: 'smd', origin: { x: 0, y: 0 }, pins, bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, meta: pkg ? { package: pkg } : undefined };
}
const pinsOnly = { usePackage: false };

describe('chip size', () => {
  it('votes span, pad gap and pad width', () => {
    // IPC 0603: span 53, gap 26, width 39 mil
    expect(chipSizeVote(53, 26, 39).size).toBe('0603');
    // hand-solder 0603 (Adafruit 0603-NO): span 67 says 0805, gap and width say 0603
    expect(chipSizeVote(67, 25, 39).size).toBe('0603');
    // without pad sizes only the span is left
    expect(chipSizeVote(32).size).toBe('0402');
  });
  it('sizes a hand-solder 0603 resistor from its pads, with the refdes as the kind', () => {
    const e = estimatePart(part('R7', [pin('1', 0, 0, 1.07, 0.99), pin('2', 1.70, 0, 1.07, 0.99)]), pinsOnly);
    expect(e).toMatchObject({ family: 'chip', size: '0603', kind: 'R', evidence: 'geometry' });
    expect(e.rotDeg).toBeCloseTo(0);
  });
  it('reads 0603 in a package name as imperial, metric only with "Metric"', () => {
    expect(parsePackageName('CHIPLED_0603_NOOUTLINE', 'L')).toMatchObject({ family: 'chip', size: '0603', kind: 'LED' });
    expect(parsePackageName('C_0603_1608Metric', 'C1')).toMatchObject({ size: '0603' });
  });
});

describe('patterns from pins alone', () => {
  it('squares a SOT-23 although its lone pin sits diagonally to the others', () => {
    const e = estimatePart(part('Q3', [pin('1', -0.95, -1.1), pin('2', 0.95, -1.1), pin('3', 0, 1.1)]), pinsOnly);
    expect(e.family).toBe('sot23');
    expect(Math.abs(e.rotDeg) % 180).toBeCloseTo(0);
  });
  it('finds a QFN with a centre pad', () => {
    const pins: Pin[] = []; let k = 1;
    for (let i = 0; i < 8; i++) { const t = -1.75 + i * 0.5; pins.push(pin(String(k++), -2.4, t, 0.8, 0.25), pin(String(k++), 2.4, t, 0.8, 0.25), pin(String(k++), t, -2.4, 0.25, 0.8), pin(String(k++), t, 2.4, 0.25, 0.8)); }
    pins.push(pin('EP', 0, 0, 3.2, 3.2));
    const e = estimatePart(part('U1', pins), pinsOnly);
    expect(e.family).toBe('qfn'); expect(e.p.pitch).toBeCloseTo(0.5); expect(e.p.ep).toBe(1);
  });
  it('takes a row with two other-shaped pads beyond its ends for a connector, by pitch', () => {
    // JST SH 4: 1.0 mm row + two mount tabs behind the row ends
    const sh = [0, 1, 2, 3].map(i => pin(String(i + 1), -1.5 + i, 0, 0.6, 1.55)).concat([pin('MT1', -2.8, -1.9, 1.2, 1.8), pin('MT2', 2.8, -1.9, 1.2, 1.8)]);
    expect(estimatePart(part('J1', sh), pinsOnly)).toMatchObject({ family: 'conn', size: 'JST SH' });
    // JST PH 2: the signal pads are LONGER than the tabs — grouping is by shape, not size
    const ph = [pin('1', -1, 0, 1.0, 4.6), pin('2', 1, 0, 1.0, 4.6), pin('NC1', -3.4, -5.2, 3.4, 1.6), pin('NC2', 3.4, -5.2, 3.4, 1.6)];
    expect(estimatePart(part('X1', ph), pinsOnly)).toMatchObject({ family: 'conn', size: 'JST PH' });
  });
  it('does not call a four-pad tact switch a connector', () => {
    const sw = [pin('1', -1.65, -0.8, 1.3, 1.1), pin('2', 1.65, -0.8, 1.3, 1.1), pin('3', -2.2, 0.9, 0.9, 1.2), pin('4', 2.2, 0.9, 0.9, 1.2)];
    expect(estimatePart(part('SW3', sw), pinsOnly).family).not.toBe('conn');
  });
  it('marks a footprint the package calls not fitted', () => {
    const pins = Array.from({ length: 10 }, (_, i) => pin(String(i + 1), -2.54 + (i % 5) * 1.27, i < 5 ? -1 : 1, 0.76, 2.4));
    expect(estimatePart(part('X2', pins, '2X05_1.27MM_BOX_NOCREAM'), { usePackage: true }).populated).toBe(false);
  });
  it('falls back to a body box, and says so', () => {
    const e = estimatePart(part('U9', [pin('1', 0, 0), pin('2', 3, 0.4), pin('3', 1.1, 2.7), pin('4', -2, 1.9), pin('5', 2.2, -1.6), pin('6', -0.7, -2.3), pin('7', 3.3, 2.9)]), pinsOnly);
    expect(e.evidence).toBe('fallback');
  });
});
