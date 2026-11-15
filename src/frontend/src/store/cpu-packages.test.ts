import { describe, expect, it } from 'vitest';
import { ballSignature, matchPackage, orientToSignature, PACKAGES, type PackageSpec } from './cpu-packages';

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

describe('orientToSignature', () => {
  // an L-shaped, clearly asymmetric field
  const base: { x: number; y: number }[] = [];
  for (let i = 0; i < 20; i++) for (let j = 0; j < 12; j++) if (i < 6 || j < 4) base.push({ x: i, y: j });
  const rot = (p: { x: number; y: number }, t: number) => t === 0 ? p : t === 90 ? { x: -p.y, y: p.x } : t === 180 ? { x: -p.x, y: -p.y } : { x: p.y, y: -p.x };
  const sig = ballSignature(base);
  it('recovers every turn of a top-side field', () => {
    for (const t of [0, 90, 180, 270]) expect(orientToSignature(sig, base.map(p => rot(p, t)), false).turn).toBe(t);
  });
  it('recovers the turn of a bottom-side field, which is seen mirrored', () => {
    for (const t of [0, 90, 180, 270]) expect(orientToSignature(sig, base.map(p => rot({ x: p.x, y: -p.y }, t)), true).turn).toBe(t);
  });
  it('reports a tie on a symmetric field as turn 0', () => {
    const sq: { x: number; y: number }[] = []; for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) sq.push({ x: i, y: j });
    const o = orientToSignature(ballSignature(sq), sq.map(p => rot(p, 90)), false); expect(o.turn).toBe(0); expect(o.fit).toBeCloseTo(o.worst, 6);
  });
});
