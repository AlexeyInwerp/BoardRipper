import { describe, it, expect } from 'vitest';
import { parseXzzTailAnnotations, parseDiodeSection } from './xzz-parser';

const MARKER = 'v6v6555v6v6';

/** Build a fake XZZ tail: arbitrary leading bytes, the XOR-boundary marker,
 *  then `section` verbatim. Only the post-marker bytes are ever read. */
function withTail(section: string, marker = MARKER): Uint8Array {
  const head = new Uint8Array([0x58, 0x5a, 0x5a, 0x50, 0x43, 0x42, 0, 0, 0, 0]);
  const body = new TextEncoder().encode(marker + section);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/** The real banner between the marker and the JSON is GB2312 ("===PCB板视图"),
 *  not UTF-8 — the tail decoder must not choke on it. These are the exact four
 *  bytes iPhone16_16Plus ships. */
const BANNER = '\n===PCB¸½¼Ó\n';

describe('parseXzzTailAnnotations — legacy record encoding', () => {
  it('reads =value=PART(pin) records', () => {
    const t = parseXzzTailAnnotations(withTail('\n=359=C100(1)\n=OL=C100(2)\n=0=R5(1)\n'));
    expect(t.encoding).toBe('legacy');
    expect(t.diodes.get('C100(1)')).toMatchObject({ kind: 'value', mv: 359, source: 'xzz-pcb' });
    expect(t.diodes.get('C100(2)')).toMatchObject({ kind: 'open', mv: null });
    // A literal 0 is a real measurement (short to ground), not "no reading".
    expect(t.diodes.get('R5(1)')).toMatchObject({ kind: 'value', mv: 0 });
    expect(t.partAliases.size).toBe(0);
    expect(t.netAliases.size).toBe(0);
  });

  it('is empty when the file carries no marker', () => {
    const t = parseXzzTailAnnotations(new TextEncoder().encode('XZZPCB no tail here'));
    expect(t.encoding).toBe('none');
    expect(t.diodes.size).toBe(0);
  });
});

describe('parseXzzTailAnnotations — JSON encoding', () => {
  const doc = JSON.stringify({
    part: [
      {
        reference: 'N02615', alias: 'J10600',
        pad: [{ name: '22', diode: '538' }, { name: '10', diode: 'OL' }, { name: '4', diode: 'L' }],
      },
      { reference: 'C343', alias: 'C10602' },
      { reference: 'U7000', pad: [{ name: 'B1', diode: '584' }] },
    ],
    net: [{ name: 'Net21', alias: 'PP_VDD_MAIN' }, { name: 'Net55', alias: 'Net55' }],
    bitmap: { x: 50000, y: 50000 },
  });

  it('reads diode readings under both the reference and the alias key', () => {
    const t = parseXzzTailAnnotations(withTail(BANNER + doc));
    expect(t.encoding).toBe('json');
    expect(t.diodes.get('N02615(22)')).toMatchObject({ kind: 'value', mv: 538, source: 'xzz-pcb' });
    expect(t.diodesByAlias.get('J10600(22)')).toBe(t.diodes.get('N02615(22)'));
    expect(t.diodes.get('N02615(10)')).toMatchObject({ kind: 'open' });
    // Alphanumeric BGA pad names are keys too — the legacy regex only took \d+.
    expect(t.diodes.get('U7000(B1)')).toMatchObject({ kind: 'value', mv: 584 });
  });

  it('drops unparseable tokens rather than inventing a reading', () => {
    const t = parseXzzTailAnnotations(withTail(BANNER + doc));
    expect(t.diodes.has('N02615(4)')).toBe(false);   // "L" — a typo in the source data
  });

  it('reads the part rename table, skipping self-aliases', () => {
    const t = parseXzzTailAnnotations(withTail(BANNER + doc));
    expect(t.partAliases.get('N02615')).toBe('J10600');
    expect(t.partAliases.get('C343')).toBe('C10602');
    expect(t.partAliases.has('U7000')).toBe(false);  // no alias field
  });

  it('reads the net rename table, skipping no-op aliases', () => {
    const t = parseXzzTailAnnotations(withTail(BANNER + doc));
    expect(t.netAliases.get('Net21')).toBe('PP_VDD_MAIN');
    expect(t.netAliases.has('Net55')).toBe(false);   // alias === name
  });

  it('returns an empty diode table for a JSON tail that carries only renames', () => {
    // The "YiDianTong" delivery of a board: same JSON shape, no pad[] anywhere.
    // This file genuinely has no diode data — the absence must be reported as
    // such, not as a parse failure.
    const renamesOnly = JSON.stringify({
      part: [{ reference: 'C356_1', alias: 'C11814' }, { reference: 'R102_1', alias: 'R11818' }],
    });
    const t = parseXzzTailAnnotations(withTail(BANNER + renamesOnly));
    expect(t.encoding).toBe('json');
    expect(t.diodes.size).toBe(0);
    expect(t.partAliases.size).toBe(2);
  });

  it('falls back to the legacy scan when the tail is not valid JSON', () => {
    const t = parseXzzTailAnnotations(withTail('\n{ not json at all\n=359=C100(1)\n'));
    expect(t.encoding).toBe('legacy');
    expect(t.diodes.get('C100(1)')).toMatchObject({ mv: 359 });
  });
});

describe('parseDiodeSection', () => {
  it('still returns just the reading table, for either encoding', () => {
    expect(parseDiodeSection(withTail('\n=359=C100(1)\n')).get('C100(1)')).toMatchObject({ mv: 359 });
    const json = JSON.stringify({ part: [{ reference: 'C100', pad: [{ name: '1', diode: '359' }] }] });
    expect(parseDiodeSection(withTail(BANNER + json)).get('C100(1)')).toMatchObject({ mv: 359 });
  });
});
