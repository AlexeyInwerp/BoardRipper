import { describe, expect, it } from 'vitest';
import { matchPackage, PACKAGES, type PackageSpec } from './cpu-packages';

const spec = (id: string, balls: number, pitch: number, span: [number, number]): PackageSpec =>
  ({ id, vendor: 'intel', name: id, balls, pitch, body: { L: span[0] + 1.3, W: span[1] + 1.3 }, span, style: 'test' });

describe('matchPackage', () => {
  const specs = [spec('u1356', 1356, 0.65, [40.7, 22.8]), spec('u1528', 1528, 0.65, [44.7, 22.7]), spec('h1440', 1440, 0.65, [40.7, 26.8]), spec('ult1168', 1168, 0.65, [38.7, 22.7])];
  it('finds the record by span and pitch', () => {
    expect(matchPackage({ balls: 1356, pitch: 0.65, spanX: 40.7, spanY: 22.77 }, specs)?.spec.id).toBe('u1356');
  });
  it('accepts the field turned 90° and says so', () => {
    const m = matchPackage({ balls: 1440, pitch: 0.65, spanX: 26.76, spanY: 40.72 }, specs);
    expect(m?.spec.id).toBe('h1440'); expect(m?.turned).toBe(true);
  });
  it('tolerates balls a boardview left out, and reports how many', () => {
    const m = matchPackage({ balls: 1344, pitch: 0.635, spanX: 44.4, spanY: 22.9 }, [...specs, spec('u1526', 1526, 0.65, [48.7, 23.7])]);
    expect(m?.spec.id).toBe('u1528'); // the Ice Lake record is 4.7 mm longer — the span rules it out before the count does
    expect(m?.missingBalls).toBe(184);
  });
  it('never returns a record with fewer balls than the field', () => {
    expect(matchPackage({ balls: 1356, pitch: 0.65, spanX: 38.7, spanY: 22.7 }, specs)).toBeNull();
  });
  it('a 2 mm shorter field is another package', () => {
    expect(matchPackage({ balls: 1168, pitch: 0.65, spanX: 38.7, spanY: 22.7 }, specs)?.spec.id).toBe('ult1168');
  });
  it('the shipped table has unique ids and every record finds itself from its own nominal field', () => {
    const ids = new Set(PACKAGES.map(p => p.id)); expect(ids.size).toBe(PACKAGES.length);
    for (const s of PACKAGES) {
      const m = matchPackage({ balls: s.balls, pitch: s.pitch, spanX: s.span[0], spanY: s.span[1] });
      expect(m?.spec.id, `${s.id} → ${m?.spec.id}`).toBe(s.id);
    }
  });
});
