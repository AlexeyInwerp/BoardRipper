import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SAMPLES = path.resolve(__dirname, '../../../samples');
const EAGLE_DIR = path.resolve(SAMPLES, 'eagle');

// Fixture-dependent tests skip (not fail) when the gitignored samples/ tree is
// absent — same idiom as cross-format.spec.ts / allegro-brd-parser.spec.ts.
// The pure-unit tests at the bottom build their input in memory and always run.
const EPIC   = path.resolve(EAGLE_DIR, '10004_epic_cape.brd');
const LEDS   = path.resolve(EAGLE_DIR, '10leds.brd');
const GANTRY = path.resolve(EAGLE_DIR, '1-Axis_Board_-_Camera_Gantry.brd');
const POWER  = path.resolve(EAGLE_DIR, '180V_power.brd');
// A genuine Apple/Mac obfuscated BRD — must never be claimed by EAGLE.
const APPLE_BRD = path.resolve(SAMPLES, '820-02935-05.brd');

const MILS_PER_MM = 1000 / 25.4;

function readBuf(file: string): ArrayBuffer {
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function parse(file: string) {
  const { parseEagleBRD } = await import('../src/parsers/eagle-parser');
  return parseEagleBRD(readBuf(file));
}

function header(file: string): Uint8Array {
  const buf = fs.readFileSync(file);
  return new Uint8Array(buf.buffer, buf.byteOffset, Math.min(512, buf.byteLength));
}

// ───────────────────────────────────────────────────────────────────────────
// Format detection — `.brd` is shared with Apple BRD and Cadence Allegro
// ───────────────────────────────────────────────────────────────────────────

test.describe('EAGLE .brd format detection', () => {
  test('EAGLE claims its own files; Apple BRD and Allegro do not', async () => {
    test.skip(!fs.existsSync(EPIC), 'samples/eagle not present');
    const { EagleBRDFormat }   = await import('../src/parsers/eagle-format');
    const { BRDFormat }        = await import('../src/parsers/brd-format');
    const { AllegroBRDFormat } = await import('../src/parsers/allegro-brd-format');

    for (const f of [EPIC, LEDS, GANTRY, POWER]) {
      if (!fs.existsSync(f)) continue;
      const h = header(f);
      expect(EagleBRDFormat.detect(h), `${path.basename(f)} → EAGLE`).toBe(true);
      expect(BRDFormat.detect(h), `${path.basename(f)} → not Apple BRD`).toBe(false);
      expect(AllegroBRDFormat.detect(h), `${path.basename(f)} → not Allegro`).toBe(false);
    }
  });

  test('the Apple/Mac BRD fixture is NOT claimed by EAGLE', async () => {
    test.skip(!fs.existsSync(APPLE_BRD), '820-02935-05.brd not present (proprietary fixture)');
    const { EagleBRDFormat } = await import('../src/parsers/eagle-format');
    const { BRDFormat }      = await import('../src/parsers/brd-format');
    const h = header(APPLE_BRD);
    expect(EagleBRDFormat.detect(h)).toBe(false);
    expect(BRDFormat.detect(h)).toBe(true);
  });

  test('the Apple BRD magic and an Allegro-shaped header stay unclaimed', async () => {
    const { EagleBRDFormat } = await import('../src/parsers/eagle-format');
    const appleMagic = new Uint8Array([0x23, 0xE2, 0x63, 0x28, 0, 0, 0, 0, 1, 0, 0, 0]);
    expect(EagleBRDFormat.detect(appleMagic)).toBe(false);
    const allegro = new Uint8Array(16);
    allegro[0] = 0x00; allegro[1] = 0x00; allegro[2] = 0x13; allegro[3] = 0x00;
    allegro[8] = 1;
    expect(EagleBRDFormat.detect(allegro)).toBe(false);
  });

  test('registration order leaves the other two .brd claimants untouched', async () => {
    // Regression guard for adding a third `.brd` format. `detectFormat` walks
    // registration order, and `detectByExtension` resolves a `.brd` whose
    // content matched nothing — that has always been Allegro and must stay so.
    const { detectFormat, detectByExtension, getAllFormats } = await import('../src/parsers/registry');
    await import('../src/parsers/index');   // performs the registrations

    const apple = new Uint8Array(16);
    apple.set([0x23, 0xE2, 0x63, 0x28]);
    expect(detectFormat(apple)?.id).toBe('BRD');

    const allegro = new Uint8Array(16);
    allegro.set([0x00, 0x00, 0x13, 0x00], 0);   // 0x0013xxxx family
    allegro[8] = 1;                              // guard word == 1
    expect(detectFormat(allegro)?.id).toBe('ALLEGRO_BRD');

    // BDV also lists `.brd` and is registered first, so a content-unmatched
    // `.brd` has always fallen back to the BDV parser. Adding EAGLE after
    // Allegro leaves that unchanged.
    expect(detectByExtension('mystery.brd')?.id).toBe('BDV');

    const ids = getAllFormats().map(f => f.id);
    expect(ids).toContain('EAGLE_BRD');
    expect(ids.indexOf('ALLEGRO_BRD')).toBeLessThan(ids.indexOf('EAGLE_BRD'));
    expect(ids.indexOf('EAGLE_BRD')).toBeLessThan(ids.indexOf('BRD'));
  });

  test('registry routes an EAGLE .brd to the EAGLE parser end to end', async () => {
    test.skip(!fs.existsSync(LEDS), 'samples/eagle/10leds.brd not present');
    const { parseBoardFile } = await import('../src/parsers/index');
    const board = await parseBoardFile(readBuf(LEDS), '10leds.brd');
    expect(board.format).toBe('EAGLE_BRD');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Parsed content
// ───────────────────────────────────────────────────────────────────────────

test.describe('EAGLE parser — 10leds.brd (hand-verifiable placements)', () => {
  test('parses parts, pins, nets and a closed outline', async () => {
    test.skip(!fs.existsSync(LEDS), 'samples/eagle/10leds.brd not present');
    const b = await parse(LEDS);
    expect(b.format).toBe('EAGLE_BRD');
    expect(b.formatVersion).toBe('6.4');
    expect(b.parts.length).toBe(21);
    expect(b.parts.reduce((n, p) => n + p.pins.length, 0)).toBe(42);
    expect(b.nets.size).toBe(12);
    expect(b.outline.length).toBeGreaterThanOrEqual(4);
  });

  test('R4 (R180) and R6 (MR0) resolve pad 1 to the same board point, opposite sides', async () => {
    test.skip(!fs.existsSync(LEDS), 'samples/eagle/10leds.brd not present');
    const b = await parse(LEDS);
    // package M1206: <smd name="1" x="-1.4" y="0" .../>, both elements at
    // (15.24, 7.62) mm. R180 sends (-1.4,0) → (1.4,0); mirroring does the
    // same, so both land at 16.64 mm — but R6 is on the bottom.
    const expX = 16.64 * MILS_PER_MM;
    const expY = 7.62 * MILS_PER_MM;

    const r4 = b.parts.find(p => p.name === 'R4')!;
    expect(r4).toBeTruthy();
    expect(r4.side).toBe('top');
    expect(r4.type).toBe('smd');
    const r4p1 = r4.pins.find(p => p.name === '1')!;
    expect(r4p1.position.x).toBeCloseTo(expX, 4);
    expect(r4p1.position.y).toBeCloseTo(expY, 4);
    expect(r4p1.side).toBe('top');

    const r6 = b.parts.find(p => p.name === 'R6')!;
    expect(r6.side).toBe('bottom');
    const r6p1 = r6.pins.find(p => p.name === '1')!;
    expect(r6p1.position.x).toBeCloseTo(expX, 4);
    expect(r6p1.position.y).toBeCloseTo(expY, 4);
    // The mirror moves the *pad's copper* to the bottom layer too.
    expect(r6p1.side).toBe('bottom');
  });

  test('R5 (no rot) keeps package-local sign; LED6 (R90) rotates CCW', async () => {
    test.skip(!fs.existsSync(LEDS), 'samples/eagle/10leds.brd not present');
    const b = await parse(LEDS);
    // R5 at (8.89, 7.62), pad 1 local (-1.4, 0) → 7.49 mm.
    const r5p1 = b.parts.find(p => p.name === 'R5')!.pins.find(p => p.name === '1')!;
    expect(r5p1.position.x).toBeCloseTo(7.49 * MILS_PER_MM, 4);
    expect(r5p1.position.y).toBeCloseTo(7.62 * MILS_PER_MM, 4);

    // LED6 at (13.97, 12.7) rot=R90; pad A local (-1.27, 0) rotates CCW to
    // (0, -1.27) → (13.97, 11.43) mm. A clockwise reading would give 13.97.
    const led6 = b.parts.find(p => p.name === 'LED6')!;
    expect(led6.type).toBe('throughhole');
    const a = led6.pins.find(p => p.name === 'A')!;
    expect(a.position.x).toBeCloseTo(13.97 * MILS_PER_MM, 4);
    expect(a.position.y).toBeCloseTo(11.43 * MILS_PER_MM, 4);
    // shape="octagon" → poly pad with 8 pre-translated vertices.
    expect(a.padShape).toBe('poly');
    expect(a.padPolygon?.length).toBe(8);
    // drill="0.8128" mm = 32 mils.
    expect(a.drill).toBeCloseTo(32, 3);
  });

  test('through-hole "long" pads pick up the pad-local rotation', async () => {
    test.skip(!fs.existsSync(LEDS), 'samples/eagle/10leds.brd not present');
    const b = await parse(LEDS);
    // X1 at (2.54, 7.62) rot=R90; <pad name="1" x="-1.27" y="0" shape="long"
    // rot="R90"/> → position (2.54, 6.35) mm, pad angle 90+90 = 180.
    const p1 = b.parts.find(p => p.name === 'X1')!.pins.find(p => p.name === '1')!;
    expect(p1.position.x).toBeCloseTo(2.54 * MILS_PER_MM, 4);
    expect(p1.position.y).toBeCloseTo(6.35 * MILS_PER_MM, 4);
    expect(p1.padShape).toBe('roundrect');
    expect(p1.padAngleDeg).toBeCloseTo(180, 6);
    // "long" is twice as long as it is wide.
    expect(p1.padWidth! / p1.padHeight!).toBeCloseTo(2, 6);
  });
});

test.describe('EAGLE parser — routing oracle', () => {
  // EAGLE routes copper to pad centres, so on a fully-routed board every pin
  // that has any trace on its own net must sit exactly on one of that net's
  // trace endpoints. This pins down the whole placement transform (rotation
  // direction, mirror composition, mm→mil scale) far more sharply than any
  // hand-picked coordinate.
  for (const [label, file] of [['10leds', LEDS], ['180V_power', POWER]] as const) {
    test(`${label}: every routed pin lands on a trace endpoint`, async () => {
      test.skip(!fs.existsSync(file), `samples/eagle/${label}.brd not present`);
      const b = await parse(file);
      const byNet = new Map<string, { x: number; y: number }[]>();
      for (const t of b.traces ?? []) {
        let a = byNet.get(t.net);
        if (!a) { a = []; byNet.set(t.net, a); }
        a.push(t.start, t.end);
      }
      let checked = 0;
      for (const part of b.parts) {
        for (const pin of part.pins) {
          const ends = pin.net ? byNet.get(pin.net) : undefined;
          if (!ends) continue;
          checked++;
          const best = Math.min(...ends.map(e => Math.hypot(e.x - pin.position.x, e.y - pin.position.y)));
          expect(best, `${part.name}.${pin.name} (net ${pin.net})`).toBeLessThan(0.01);
        }
      }
      expect(checked).toBeGreaterThan(30);
    });
  }
});

test.describe('EAGLE parser — 10004_epic_cape.brd', () => {
  test('counts match the file', async () => {
    test.skip(!fs.existsSync(EPIC), 'samples/eagle/10004_epic_cape.brd not present');
    const b = await parse(EPIC);
    expect(b.formatVersion).toBe('6.3');
    expect(b.parts.length).toBe(99);                                  // 99 <element>
    expect(b.parts.reduce((n, p) => n + p.pins.length, 0)).toBe(405);
    expect(b.nets.size).toBe(88);                                     // 91 signals, 3 with no contactref
    expect(b.vias?.length).toBe(179);
    expect(b.traces!.length).toBeGreaterThan(600);
    expect(b.pads?.length).toBe(405);
    expect(b.parts.filter(p => p.side === 'bottom').length).toBe(10);  // 10 M-rotated elements
  });

  test('board outline comes from the shield footprint and closes', async () => {
    test.skip(!fs.existsSync(EPIC), 'samples/eagle/10004_epic_cape.brd not present');
    const b = await parse(EPIC);
    // <plain> carries no layer-20 geometry here — the 13 dimension wires live
    // in the placed BEAGLEBONE_SHIELD package.
    expect(b.parserNotes?.some(n => /placed footprint/.test(n))).toBe(true);
    const pts = b.outline.filter(p => !Number.isNaN(p.x));
    expect(pts.length).toBe(b.outline.length);        // a single sub-path, no NaN breaks
    expect(pts.length).toBeGreaterThan(40);           // arcs are flattened, not chorded
    const gap = Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
    expect(gap).toBeLessThan(0.01);                   // closed loop
    // 93.98 mm × 54.61 mm BeagleBone cape.
    expect(b.bounds.maxX - b.bounds.minX).toBeCloseTo(93.98 * MILS_PER_MM, 2);
    expect(b.bounds.maxY - b.bounds.minY).toBeCloseTo(54.61 * MILS_PER_MM, 2);
  });

  test('MR180 element R56 composes mirror-then-rotate correctly', async () => {
    test.skip(!fs.existsSync(EPIC), 'samples/eagle/10004_epic_cape.brd not present');
    const b = await parse(EPIC);
    // R56: package RESC1005, element (71.755, 16.51) rot="MR180".
    // R(180)·M = diag(1,−1), so smd "1" at local (−0.48, 0) → (71.275, 16.51).
    const r56 = b.parts.find(p => p.name === 'R56')!;
    expect(r56.side).toBe('bottom');
    const p1 = r56.pins.find(p => p.name === '1')!;
    expect(p1.position.x).toBeCloseTo(71.275 * MILS_PER_MM, 4);
    expect(p1.position.y).toBeCloseTo(16.51 * MILS_PER_MM, 4);
    expect(p1.side).toBe('bottom');
    // The pad's own rot="R90" mirrors to −90, so 180 − 90 = 90.
    expect(((p1.padAngleDeg! % 180) + 180) % 180).toBeCloseTo(90, 6);
  });

  test('nets are built from <contactref>, not from coordinates', async () => {
    test.skip(!fs.existsSync(EPIC), 'samples/eagle/10004_epic_cape.brd not present');
    const b = await parse(EPIC);
    const gnd = b.nets.get('GND');
    expect(gnd).toBeTruthy();
    expect(gnd!.pinIndices.length).toBeGreaterThan(50);
    // <contactref element="U1" pad="85"/> under signal AIN0
    const u1 = b.parts.find(p => p.name === 'U1')!;
    expect(u1.pins.find(p => p.name === '85')!.net).toBe('AIN0');
    expect(u1.pins.find(p => p.name === '1')!.net).toBe('GND');
  });
});

test.describe('EAGLE parser — remaining fixtures load cleanly', () => {
  for (const [label, file, parts, pins] of [
    ['1-Axis_Board_-_Camera_Gantry', GANTRY, 61, 297],
    ['180V_power', POWER, 22, 46],
  ] as const) {
    test(`${label} parses`, async () => {
      test.skip(!fs.existsSync(file), `samples/eagle/${label}.brd not present`);
      const b = await parse(file);
      expect(b.parts.length).toBe(parts);
      expect(b.parts.reduce((n, p) => n + p.pins.length, 0)).toBe(pins);
      expect(Number.isFinite(b.bounds.minX)).toBe(true);
      expect(b.bounds.maxX).toBeGreaterThan(b.bounds.minX);
      // Every pin must be finite — a broken transform shows up here first.
      for (const p of b.parts) {
        for (const pin of p.pins) {
          expect(Number.isFinite(pin.position.x) && Number.isFinite(pin.position.y)).toBe(true);
        }
      }
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Pure units — no fixture required
// ───────────────────────────────────────────────────────────────────────────

test.describe('EAGLE arc `curve` is a signed sweep, never normalised', () => {
  test('a 270° curve really sweeps 270°, not the 90° short way (issue #33)', async () => {
    const { eagleArcPoints } = await import('../src/parsers/eagle-parser');
    const pts = eagleArcPoints(0, 0, 1, 0, 270);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[pts.length - 1]).toEqual({ x: 1, y: 0 });
    // Accumulated turning must equal the declared sweep.
    let total = 0;
    // Centre: with θ = 270°, R = 1/(2·sin135°) = 0.7071, centre is (0.5, −0.5).
    const cx = 0.5, cy = -0.5;
    for (let i = 1; i < pts.length; i++) {
      const a0 = Math.atan2(pts[i - 1].y - cy, pts[i - 1].x - cx);
      const a1 = Math.atan2(pts[i].y - cy, pts[i].x - cx);
      let d = a1 - a0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
    }
    expect((total * 180) / Math.PI).toBeCloseTo(270, 3);
    // Every sample is equidistant from the centre.
    for (const p of pts) expect(Math.hypot(p.x - cx, p.y - cy)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  test('the sign of `curve` picks the side of the chord', async () => {
    const { eagleArcPoints } = await import('../src/parsers/eagle-parser');
    const ccw = eagleArcPoints(0, 0, 1, 0, 90);
    const cw  = eagleArcPoints(0, 0, 1, 0, -90);
    const midCcw = ccw[Math.floor(ccw.length / 2)];
    const midCw  = cw[Math.floor(cw.length / 2)];
    // +90 bulges below the chord (centre above), −90 bulges above. Whatever the
    // convention, the two must land on OPPOSITE sides — a shortest-arc
    // normalisation would collapse them onto the same one.
    expect(Math.sign(midCcw.y)).toBe(-Math.sign(midCw.y));
    expect(Math.abs(midCcw.y)).toBeGreaterThan(0.2);
  });

  test('a zero / degenerate curve degrades to the straight chord', async () => {
    const { eagleArcPoints } = await import('../src/parsers/eagle-parser');
    expect(eagleArcPoints(0, 0, 3, 4, 0)).toEqual([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(eagleArcPoints(1, 1, 1, 1, 90)).toEqual([{ x: 1, y: 1 }, { x: 1, y: 1 }]);
  });
});

test.describe('EAGLE `rot` attribute', () => {
  test('parses the [S][M]R<deg> grammar', async () => {
    const { parseEagleRot } = await import('../src/parsers/eagle-parser');
    expect(parseEagleRot('R90')).toEqual({ angleDeg: 90, mirror: false, spin: false });
    expect(parseEagleRot('MR0')).toEqual({ angleDeg: 0, mirror: true, spin: false });
    expect(parseEagleRot('MR180')).toEqual({ angleDeg: 180, mirror: true, spin: false });
    expect(parseEagleRot('SR45.5')).toEqual({ angleDeg: 45.5, mirror: false, spin: true });
    expect(parseEagleRot('SMR270')).toEqual({ angleDeg: 270, mirror: true, spin: true });
    expect(parseEagleRot(undefined)).toEqual({ angleDeg: 0, mirror: false, spin: false });
    expect(parseEagleRot('garbage')).toEqual({ angleDeg: 0, mirror: false, spin: false });
  });
});

test.describe('EAGLE XML reader (no DOMParser — must work under Node)', () => {
  test('handles entities, self-closing tags and a "> " inside an attribute', async () => {
    const { parseEagleXml } = await import('../src/parsers/eagle-parser');
    const doc = parseEagleXml(
      `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<!DOCTYPE eagle SYSTEM "eagle.dtd">\n` +
      `<!-- a > comment -->\n` +
      `<eagle version="6.4"><drawing><board>` +
      `<text x='1' y='2'>&gt;NAME</text>` +
      `<element name="U&amp;1" value="a > b" x="1.5"/>` +
      `<description><![CDATA[ <b>not markup</b> ]]></description>` +
      `</board></drawing></eagle>`,
    );
    const eagle = doc.children.find(c => c.name === 'eagle')!;
    expect(eagle.attrs.version).toBe('6.4');
    const board = eagle.children[0].children[0];
    const el = board.children.find(c => c.name === 'element')!;
    expect(el.attrs.name).toBe('U&1');
    expect(el.attrs.value).toBe('a > b');
    expect(el.attrs.x).toBe('1.5');
    // The CDATA body must not have produced phantom <b> elements.
    expect(board.children.filter(c => c.name === 'b').length).toBe(0);
  });

  test('skips a DOCTYPE carrying an internal subset', async () => {
    const { parseEagleXml } = await import('../src/parsers/eagle-parser');
    const doc = parseEagleXml(
      `<!DOCTYPE eagle [\n<!ELEMENT eagle (drawing)>\n<!ATTLIST eagle version CDATA #REQUIRED>\n]>\n` +
      `<eagle version="5.0"/>`,
    );
    expect(doc.children.map(c => c.name)).toEqual(['eagle']);
    expect(doc.children[0].attrs.version).toBe('5.0');
  });
});

test.describe('EAGLE parser rejects what it cannot read', () => {
  test('a binary (pre-6.0) .brd gets an actionable message', async () => {
    const { parseEagleBRD } = await import('../src/parsers/eagle-parser');
    const bin = new Uint8Array(64);
    bin[0] = 0x10;
    bin[1] = 0x80;
    expect(() => parseEagleBRD(bin.buffer)).toThrow(/EAGLE 6 or newer/);
  });

  test('an EAGLE schematic (no <board>) is named as such', async () => {
    const { parseEagleBRD } = await import('../src/parsers/eagle-parser');
    const xml = `<?xml version="1.0"?><eagle version="6.4"><drawing><schematic/></drawing></eagle>`;
    expect(() => parseEagleBRD(new TextEncoder().encode(xml).buffer as ArrayBuffer))
      .toThrow(/no <board> section/);
  });
});
