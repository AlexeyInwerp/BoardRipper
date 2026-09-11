import { describe, it, expect } from 'vitest';
import type { BoardData, DiodeReading, Net, Part, Pin } from '../parsers/types';
import { comparePart, normalizeNet, diodeDiverges, buildAlignment } from './part-compare';

// ── Fixture builders ──────────────────────────────────────────────────────
//
// Boards are built from a plain spec so a test reads as the scenario it is
// about. `nets` is derived exactly the way the parsers derive it, so a
// fingerprint in a test is the same object shape it is in production.

interface PinSpec { net: string; x: number; y: number; name?: string; number?: string; diode?: DiodeReading }

function mkPin(s: PinSpec, i: number): Pin {
  return {
    name: s.name ?? '',
    number: s.number ?? String(i + 1),
    position: { x: s.x, y: s.y },
    radius: 5,
    side: 'top',
    net: s.net,
    ...(s.diode ? { diode: s.diode } : {}),
  };
}

function mkPart(name: string, pins: PinSpec[], angleDeg?: number): Part {
  const ps = pins.map(mkPin);
  const xs = ps.map(p => p.position.x), ys = ps.map(p => p.position.y);
  return {
    name,
    side: 'top',
    type: 'unknown',
    origin: { x: 0, y: 0 },
    pins: ps,
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    ...(angleDeg != null ? { angleDeg } : {}),
  };
}

function mkBoard(parts: Part[]): BoardData {
  const nets = new Map<string, Net>();
  parts.forEach((p, pi) => p.pins.forEach((pin, ni) => {
    if (!pin.net) return;
    let n = nets.get(pin.net);
    if (!n) { n = { name: pin.net, pinIndices: [] }; nets.set(pin.net, n); }
    n.pinIndices.push({ partIndex: pi, pinIndex: ni });
  }));
  return {
    format: 'TEST',
    parts,
    nets,
    bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  } as BoardData;
}

/** A 4-pin part plus the neighbours that give each of its nets a topology. */
function simpleBoard(netNames: [string, string, string, string], neighbourSuffix = ''): {
  board: BoardData; part: Part;
} {
  const subject = mkPart('U1', [
    { net: netNames[0], x: 0, y: 0 },
    { net: netNames[1], x: 10, y: 0 },
    { net: netNames[2], x: 10, y: 10 },
    { net: netNames[3], x: 0, y: 10 },
  ]);
  // Each net also touches one distinct 2-pin neighbour, so fingerprints differ.
  const neighbours = netNames.map((n, i) =>
    mkPart(`R${i + 1}${neighbourSuffix}`, [{ net: n, x: 50 + i, y: 50 }, { net: `T${i}`, x: 51 + i, y: 50 }]),
  );
  const board = mkBoard([subject, ...neighbours]);
  return { board, part: board.parts[0] };
}

// ── normalizeNet ──────────────────────────────────────────────────────────

describe('normalizeNet', () => {
  it('folds the three spellings of unconnected to empty', () => {
    expect(normalizeNet('')).toBe('');
    expect(normalizeNet('  ')).toBe('');
    expect(normalizeNet('NC')).toBe('');
    expect(normalizeNet('unconnected')).toBe('');
  });
  it('uppercases and trims real names', () => {
    expect(normalizeNet(' ppbus_g3h ')).toBe('PPBUS_G3H');
  });
});

// ── Alignment: keys ───────────────────────────────────────────────────────

describe('key alignment', () => {
  it('uses pin names when the format carries real designators', () => {
    const a = mkPart('U1', [
      { net: 'A', x: 0, y: 0, name: 'A1' },
      { net: 'B', x: 10, y: 0, name: 'B2' },
      { net: 'C', x: 20, y: 0, name: 'M7' },
    ]);
    // Same designators, deliberately shuffled into a different file order.
    const b = mkPart('U1', [
      { net: 'C', x: 0, y: 0, name: 'M7' },
      { net: 'A', x: 10, y: 0, name: 'A1' },
      { net: 'B', x: 20, y: 0, name: 'B2' },
    ]);
    const { alignment } = buildAlignment(a, b, 'name');
    expect(alignment.mode).toBe('name');
    expect(alignment.matched).toBe(3);
    expect(alignment.pairs).toEqual([{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 0 }]);
  });

  it('is ineligible when names are sparse', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0, name: 'A1' }, { net: 'B', x: 10, y: 0 }, { net: 'C', x: 20, y: 0 }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0, name: 'A1' }, { net: 'B', x: 10, y: 0 }, { net: 'C', x: 20, y: 0 }]);
    const { candidates } = buildAlignment(a, b, 'auto');
    expect(candidates.some(c => c.mode === 'name')).toBe(false);
  });

  it('is ineligible when a name repeats — a duplicate is not a key', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0, name: 'P1' }, { net: 'B', x: 10, y: 0, name: 'P1' }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0, name: 'P1' }, { net: 'B', x: 10, y: 0, name: 'P2' }]);
    const { candidates } = buildAlignment(a, b, 'auto');
    expect(candidates.some(c => c.mode === 'name')).toBe(false);
  });

  it('falls back to the running number when there are no names', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 10, y: 0 }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 10, y: 0 }]);
    const { alignment } = buildAlignment(a, b, 'auto');
    expect(alignment.matched).toBe(2);
    expect(alignment.score).toBe(1);
  });

  it('leaves surplus pins unmatched on both sides', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 10, y: 0 }, { net: 'C', x: 20, y: 0 }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 10, y: 0 }]);
    const { alignment } = buildAlignment(a, b, 'number');
    expect(alignment.matched).toBe(2);
    expect(alignment.pairs).toContainEqual({ a: 2, b: null });
    expect(alignment.score).toBeCloseTo(2 / 3);
  });
});

// ── Alignment: geometry ───────────────────────────────────────────────────

describe('geometric alignment', () => {
  /** An 8-pin SOIC-ish package: two rows of four, 50 mil pitch. */
  const layout: Array<[number, number]> = [
    [0, 0], [50, 0], [100, 0], [150, 0],
    [150, 100], [100, 100], [50, 100], [0, 100],
  ];
  const nets = ['N0', 'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7'];

  const partA = mkPart('U1', layout.map(([x, y], i) => ({ net: nets[i], x, y })));

  function transformed(rot: number, mirror: boolean, shuffle: boolean, dx = 900, dy = -700): Part {
    const r = (rot * Math.PI) / 180;
    const cx = 75, cy = 50;
    let entries = layout.map(([x, y], i) => {
      let lx = x - cx;
      const ly = y - cy;
      if (mirror) lx = -lx;
      return { net: nets[i], x: lx * Math.cos(r) - ly * Math.sin(r) + dx, y: lx * Math.sin(r) + ly * Math.cos(r) + dy };
    });
    if (shuffle) entries = [entries[5], entries[0], entries[7], entries[2], entries[4], entries[1], entries[6], entries[3]];
    return mkPart('U1', entries);
  }

  for (const rot of [0, 90, 180, 270]) {
    for (const mirror of [false, true]) {
      it(`recovers the pairing at ${rot}°${mirror ? ' mirrored' : ''} with the pin array shuffled`, () => {
        const b = transformed(rot, mirror, true);
        const { alignment } = buildAlignment(partA, b, 'geometry');
        expect(alignment.matched).toBe(8);
        // Every pair must join pins carrying the same net — that is the proof
        // the geometry recovered the *correct* pairing, not just eight pairs.
        for (const p of alignment.pairs) {
          expect(partA.pins[p.a!].net).toBe(b.pins[p.b!].net);
        }
      });
    }
  }

  it('is what auto picks when the file order disagrees', () => {
    const b = transformed(90, false, true);
    const { alignment } = buildAlignment(partA, b, 'auto');
    expect(alignment.mode).toBe('geometry');
    expect(alignment.score).toBe(1);
  });

  it('wins on geometry alone when every net has been renamed and the order shuffled', () => {
    // The case the feature exists for: two deliveries of one board, one with
    // real net names and one with N$ numbers, pins enumerated differently.
    // No net agrees, so only the copper can decide — and `number` alignment
    // would otherwise "match" 8 of 8 and look perfect.
    const renamed = transformed(0, false, true);
    renamed.pins.forEach((pin, i) => { pin.net = `N$${100 + i}`; });
    const { alignment, candidates } = buildAlignment(partA, renamed, 'auto');
    expect(alignment.mode).toBe('geometry');
    const num = candidates.find(c => c.mode === 'number')!;
    expect(num.score).toBe(1);        // coverage says nothing
    expect(num.geomAgree).toBeLessThan(1);
    expect(candidates[0].geomAgree).toBe(1);
  });

  it('admits ambiguity on a symmetric package with nothing to orient it', () => {
    // This pad field maps onto itself under 180° and under a mirror. With the
    // nets renamed there is no evidence left, and the pairing must not be
    // presented as if there were.
    const renamed = transformed(180, false, false);
    renamed.pins.forEach((pin, i) => { pin.net = `N$${100 + i}`; });
    const { alignment } = buildAlignment(partA, renamed, 'geometry');
    expect(alignment.matched).toBe(8);
    expect(alignment.ambiguous).toBe(true);
  });

  it('is not ambiguous when the nets orient the package', () => {
    const { alignment } = buildAlignment(partA, transformed(180, false, false), 'geometry');
    expect(alignment.ambiguous).toBeFalsy();
  });

  it('does not rescale — a different package size fails to match', () => {
    const big = mkPart('U1', layout.map(([x, y], i) => ({ net: nets[i], x: x * 3, y: y * 3 })));
    const { alignment } = buildAlignment(partA, big, 'geometry');
    expect(alignment.matched).toBeLessThan(8);
  });
});

// ── Classification ────────────────────────────────────────────────────────

describe('net classification', () => {
  it('calls identical names the same', () => {
    const A = simpleBoard(['P1', 'P2', 'P3', 'P4']);
    const B = simpleBoard(['P1', 'P2', 'P3', 'P4']);
    const res = comparePart(A, B);
    expect(res.counts.same).toBe(4);
    expect(res.differences).toBe(0);
  });

  it('calls a different name with identical neighbours a rename', () => {
    // Same wiring, different naming convention — the everyday Apple case.
    const A = simpleBoard(['PPBUS_G3H', 'PP3V3_S5', 'PP1V8_S0', 'SMC_RST_L']);
    const B = simpleBoard(['N$1', 'N$2', 'N$3', 'N$4']);
    const res = comparePart(A, B);
    expect(res.counts.renamed).toBe(4);
    expect(res.differences).toBe(0);
  });

  it('calls a different name with different neighbours a real difference', () => {
    const A = simpleBoard(['P1', 'P2', 'P3', 'P4']);
    // Distinct neighbour refdes on the B side ⇒ fingerprints share nothing.
    const B = simpleBoard(['Q1', 'Q2', 'Q3', 'Q4'], '_B');
    const res = comparePart(A, B);
    expect(res.counts.differs).toBe(4);
    expect(res.differences).toBe(4);
  });

  it('treats two stubs that touch nothing as different, not as a rename', () => {
    const a = mkPart('U1', [{ net: 'STUB_A', x: 0, y: 0 }]);
    const b = mkPart('U1', [{ net: 'STUB_B', x: 0, y: 0 }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.rows[0].status).toBe('differs');
  });

  it('does not count both-sides-unconnected as a difference', () => {
    const a = mkPart('U1', [{ net: '', x: 0, y: 0 }, { net: 'NC', x: 10, y: 0 }]);
    const b = mkPart('U1', [{ net: 'UNCONNECTED', x: 0, y: 0 }, { net: '', x: 10, y: 0 }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.counts.nc).toBe(2);
    expect(res.differences).toBe(0);
  });

  it('calls one-side-connected a difference', () => {
    const a = mkPart('U1', [{ net: 'PP3V3', x: 0, y: 0 }]);
    const b = mkPart('U1', [{ net: '', x: 0, y: 0 }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.rows[0].status).toBe('differs');
  });

  it('flags a pin that exists on one side only', () => {
    const A = simpleBoard(['P1', 'P2', 'P3', 'P4']);
    const b = mkPart('U1', [{ net: 'P1', x: 0, y: 0 }, { net: 'P2', x: 10, y: 0 }]);
    const res = comparePart(A, { board: mkBoard([b]), part: b }, { mode: 'number' });
    expect(res.counts['only-a']).toBe(2);
    expect(res.differences).toBe(2);
  });
});

// ── Bulk nets ─────────────────────────────────────────────────────────────

describe('rails', () => {
  /** A net with `members` two-pin parts hanging off it — a rail by size alone. */
  function railBoard(railName: string, members: number) {
    const subject = mkPart('U1', [{ net: railName, x: 0, y: 0 }]);
    const rest = Array.from({ length: members }, (_, i) =>
      mkPart(`R${i}`, [{ net: railName, x: 100 + i, y: 0 }, { net: `T${i}`, x: 101 + i, y: 0 }]));
    const board = mkBoard([subject, ...rest]);
    return { board, part: board.parts[0] };
  }

  it('compares two similarly sized rails as equivalent without fingerprinting', () => {
    const A = railBoard('GND', 200);
    const B = railBoard('AGND', 210);
    const res = comparePart(A, B);
    expect(res.rows[0].status).toBe('bulk');
    expect(res.differences).toBe(0);
  });

  it('calls rails of very different size a difference', () => {
    const A = railBoard('GND', 200);
    const B = railBoard('AGND', 500);
    const res = comparePart(A, B);
    expect(res.rows[0].status).toBe('differs');
  });

  it('honours the injected ground classifier below the pin threshold', () => {
    const A = simpleBoard(['GND', 'P2', 'P3', 'P4']);
    const B = simpleBoard(['AGND', 'P2', 'P3', 'P4']);
    const withoutHint = comparePart(A, B);
    expect(withoutHint.rows[0].status).toBe('renamed'); // same neighbours here
    const withHint = comparePart(A, B, { isBulkNet: n => n.endsWith('GND') });
    expect(withHint.rows[0].status).toBe('bulk');
  });
});

// ── Diode ─────────────────────────────────────────────────────────────────

describe('diode divergence', () => {
  const v = (mv: number): DiodeReading => ({ raw: String(mv), kind: 'value', mv, source: 'xzz-pcb' });
  const open: DiodeReading = { raw: 'OL', kind: 'open', mv: null, source: 'xzz-pcb' };

  it('ignores a difference inside the absolute floor', () => {
    expect(diodeDiverges(v(430), v(470))).toBe(false);   // 40 mV < 50 mV
  });
  it('flags a difference past the absolute floor', () => {
    expect(diodeDiverges(v(430), v(500))).toBe(true);    // 70 mV
  });
  it('uses the relative threshold on large readings', () => {
    expect(diodeDiverges(v(1000), v(1060))).toBe(false); // 60 mV < 15% of 1060
    expect(diodeDiverges(v(1000), v(1300))).toBe(true);
  });
  it('treats open-vs-value as a divergence and open-vs-open as agreement', () => {
    expect(diodeDiverges(open, v(500))).toBe(true);
    expect(diodeDiverges(open, open)).toBe(false);
  });
  it('says nothing when a reading is missing', () => {
    expect(diodeDiverges(undefined, v(500))).toBe(false);
  });

  it('surfaces the column and the per-row flag through comparePart', () => {
    const a = mkPart('U1', [{ net: 'P1', x: 0, y: 0, diode: v(430) }, { net: 'P2', x: 10, y: 0, diode: v(600) }]);
    const b = mkPart('U1', [{ net: 'P1', x: 0, y: 0, diode: v(440) }, { net: 'P2', x: 10, y: 0, diode: v(900) }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.hasDiode).toBe(true);
    expect(res.rows[0].diodeDiffers).toBe(false);
    expect(res.rows[1].diodeDiffers).toBe(true);
    // A matching net with a diverging reading is exactly the case worth seeing.
    expect(res.rows[1].status).toBe('same');
  });
});

// ── Package size ──────────────────────────────────────────────────────────

describe('package size guard', () => {
  it('warns when the two parts are not plausibly the same package', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 100, y: 100 }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 500, y: 500 }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.sizeMismatch).toBe(true);
  });
  it('stays quiet on the same package', () => {
    const a = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 100, y: 100 }]);
    const b = mkPart('U1', [{ net: 'A', x: 0, y: 0 }, { net: 'B', x: 102, y: 101 }]);
    const res = comparePart({ board: mkBoard([a]), part: a }, { board: mkBoard([b]), part: b });
    expect(res.sizeMismatch).toBe(false);
  });
});
