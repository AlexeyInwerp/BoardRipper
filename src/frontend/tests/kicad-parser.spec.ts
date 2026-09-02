import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { BoardData } from '../src/parsers/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Public MIT-licensed KiCad samples (theacodes/kicanvas). They live under the
// gitignored top-level samples/ tree, so every test here skips — not fails —
// when its fixture is absent, the same idiom as cross-format.spec.ts.
const KICAD_DIR = path.resolve(__dirname, '../../../samples/kicad');
const STARFISH = path.resolve(KICAD_DIR, 'starfish.kicad_pcb');
const TOMU = path.resolve(KICAD_DIR, 'tomu-fpga.kicad_pcb');
const DIMENSIONS = path.resolve(KICAD_DIR, 'dimensions.kicad_pcb');
const TEXT_ONLY = path.resolve(KICAD_DIR, 'text.kicad_pcb');

function readFixture(file: string): ArrayBuffer {
  test.skip(!fs.existsSync(file), `${path.basename(file)} not present (local-only fixture)`);
  const buf = fs.readFileSync(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function parseFixture(file: string): Promise<BoardData> {
  const { parseKiCadPCB } = await import('../src/parsers/kicad-parser');
  return parseKiCadPCB(readFixture(file));
}

function pinCount(board: BoardData): number {
  return board.parts.reduce((n, p) => n + p.pins.length, 0);
}

/** Every number in a bbox must be finite and the box must have real extent. */
function expectNonDegenerateBounds(b: BoardData['bounds']) {
  for (const v of [b.minX, b.minY, b.maxX, b.maxY]) expect(Number.isFinite(v)).toBe(true);
  expect(b.maxX - b.minX).toBeGreaterThan(0);
  expect(b.maxY - b.minY).toBeGreaterThan(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// S-expression tokenizer — pure unit tests, no fixture needed
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad S-expression tokenizer', () => {
  test('nests lists and keeps atoms verbatim', async () => {
    const { parseSExpr } = await import('../src/parsers/kicad-parser');
    expect(parseSExpr('(a b (c 1 2) d)')).toEqual([['a', 'b', ['c', '1', '2'], 'd']]);
  });

  test('quoted and bare atoms are indistinguishable in the output', async () => {
    const { parseSExpr } = await import('../src/parsers/kicad-parser');
    // This is what lets one code path read both the modern quoted spelling
    // and the legacy KiCad 4/5 bare one.
    expect(parseSExpr('(layer "F.Cu")')).toEqual(parseSExpr('(layer F.Cu)'));
  });

  test('unescapes quoted strings and tolerates embedded parens', async () => {
    const { parseSExpr } = await import('../src/parsers/kicad-parser');
    expect(parseSExpr('(x "a\\"b" "c(d)e" "f\\\\g")')).toEqual([['x', 'a"b', 'c(d)e', 'f\\g']]);
  });

  test('bare atoms may carry the wildcard layer syntax', async () => {
    const { parseSExpr } = await import('../src/parsers/kicad-parser');
    expect(parseSExpr('(layers *.Cu *.Mask)')).toEqual([['layers', '*.Cu', '*.Mask']]);
  });

  test('tolerates unbalanced parens rather than throwing', async () => {
    const { parseSExpr } = await import('../src/parsers/kicad-parser');
    expect(parseSExpr('(a (b c')).toEqual([['a', ['b', 'c']]]);
    expect(parseSExpr('(a) ) )')).toEqual([['a']]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Arc sampling — the issue #33 invariant
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad three-point arc sampling', () => {
  test('samples a quarter arc through its midpoint', async () => {
    const { kicadArcPoints } = await import('../src/parsers/kicad-parser');
    const r = Math.SQRT1_2;
    const pts = kicadArcPoints({ x: 1, y: 0 }, { x: r, y: r }, { x: 0, y: 1 });
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(pts[0]).toEqual({ x: 1, y: 0 });
    expect(pts[pts.length - 1].x).toBeCloseTo(0, 6);
    expect(pts[pts.length - 1].y).toBeCloseTo(1, 6);
    // Every sample sits on the unit circle centred at the origin.
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 6);
  });

  test('a major arc is NOT folded into its minor complement (issue #33)', async () => {
    const { kicadArcPoints } = await import('../src/parsers/kicad-parser');
    // Same endpoints as above, but the stored midpoint is on the far side —
    // this is a 270° sweep and must stay one. A shortest-arc normalisation
    // would silently return the 90° complement.
    const r = Math.SQRT1_2;
    const pts = kicadArcPoints({ x: 1, y: 0 }, { x: -r, y: -r }, { x: 0, y: 1 });
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 6);
    // The sampled path must actually visit the far side of the circle.
    expect(pts.some(p => p.x < -0.9)).toBe(true);
    expect(pts.some(p => p.y < -0.9)).toBe(true);
    // Arc length ≈ 270° of a unit circle, three times the minor complement.
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    expect(len).toBeGreaterThan(4.5); // 3π/2 ≈ 4.712, minus chord error
    expect(len).toBeLessThan(4.72);
  });

  test('collinear input degenerates to a straight chord', async () => {
    const { kicadArcPoints } = await import('../src/parsers/kicad-parser');
    const pts = kicadArcPoints({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 });
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 2, y: 2 }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Format descriptor + registration
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad format registration', () => {
  test('descriptor claims .kicad_pcb and detects the root keyword', async () => {
    const { KiCadPcbFormat } = await import('../src/parsers/kicad-format');
    expect(KiCadPcbFormat.id).toBe('KICAD');
    expect(KiCadPcbFormat.extensions).toEqual(['.kicad_pcb']);
    expect(KiCadPcbFormat.hasTraces).toBe(true);
    expect(KiCadPcbFormat.hasPads).toBe(true);
    // KiCad stores Y-down already — flipping would render the board mirrored.
    expect(KiCadPcbFormat.flipY ?? false).toBe(false);

    const enc = new TextEncoder();
    expect(KiCadPcbFormat.detect(enc.encode('(kicad_pcb (version 20221018) (generator pcbnew)'))).toBe(true);
    expect(KiCadPcbFormat.detect(enc.encode('  \n(kicad_pcb (version 4)'))).toBe(true);
    expect(KiCadPcbFormat.detect(enc.encode('(kicad_sch (version 20221018)'))).toBe(false);
    expect(KiCadPcbFormat.detect(enc.encode('$HEADER\nGENCAD 1.4'))).toBe(false);
  });

  test('.kicad_pcb resolves through the shared registry', async () => {
    await import('../src/parsers/index');
    const { getAllExtensions, getFormat } = await import('../src/parsers/registry');
    expect(getAllExtensions()).toContain('.kicad_pcb');
    expect(getFormat('KICAD')?.name).toBe('KiCad Board');
  });

  test('no other registered format claims a KiCad header', async () => {
    await import('../src/parsers/index');
    const { detectFormat } = await import('../src/parsers/registry');
    const header = new TextEncoder().encode('(kicad_pcb (version 20221018) (generator pcbnew)\n  (general\n');
    expect(detectFormat(header)?.id).toBe('KICAD');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// starfish.kicad_pcb — 262 footprints, arcs on Edge.Cuts, curved tracks
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad parser — starfish.kicad_pcb', () => {
  test('parses the expected part / pin / net / pad counts', async () => {
    const board = await parseFixture(STARFISH);
    expect(board.format).toBe('KICAD');
    expect(board.formatVersion).toBe('KiCad 20211014');

    // 262 (footprint) records; 33 carry no copper pad (fiducials, mask
    // helpers, annotation-only) and are dropped.
    expect(board.parts.length).toBe(229);
    // 767 (pad) records = 711 with copper + 56 mask/paste-only apertures;
    // 6 of the 711 are np_thru_hole and so are pads but not pins.
    expect(board.pads?.length).toBe(711);
    expect(pinCount(board)).toBe(705);
    expect(board.nets.size).toBe(165);
  });

  test('reference designators come from fp_text, not the library id', async () => {
    const board = await parseFixture(STARFISH);
    const c1508 = board.parts.find(p => p.name === 'C1508');
    expect(c1508).toBeTruthy();
    expect(c1508!.pins.length).toBe(2);
    expect(c1508!.side).toBe('top');
    expect(c1508!.type).toBe('smd');
    // Library id survives as package metadata; value comes from fp_text value.
    expect(c1508!.meta?.package).toBe('C_0603_HandSolder');
    expect(c1508!.meta?.value).toBe('470p');
    // As-authored rotation is preserved for display…
    expect(c1508!.meta?.angleDeg).toBe(90);
    // …while part.angleDeg carries the raw-board-frame angle the renderer
    // consumes as a (cos θ, sin θ) axis.
    expect(c1508!.angleDeg).toBe(270);
    // No part name may leak a "lib:" prefix.
    expect(board.parts.some(p => p.name.includes(':'))).toBe(false);
  });

  test('pads of a 90°-rotated footprint land on their tracks', async () => {
    const board = await parseFixture(STARFISH);
    const c1508 = board.parts.find(p => p.name === 'C1508')!;
    // Footprint (at 83.7 141.998 90); pads (at ∓0.8625 0 90). Under the
    // Y-down CCW convention the pads separate along Y, not X.
    const [p1, p2] = c1508.pins;
    expect(Math.abs(p1.position.x - p2.position.x)).toBeLessThan(0.01);
    expect(Math.abs(p1.position.y - p2.position.y)).toBeCloseTo(2 * 0.8625 * (1000 / 25.4), 3);
    expect(p1.position.x).toBeCloseTo(83.7 * (1000 / 25.4), 3);
    expect(p1.position.y).toBeCloseTo((141.998 + 0.8625) * (1000 / 25.4), 3);
    expect(p1.net).toBe('Net-(C1508-Pad1)');
  });

  test('through-hole pads carry a drill and both-side copper', async () => {
    const board = await parseFixture(STARFISH);
    const thru = board.parts.filter(p => p.type === 'throughhole');
    expect(thru.length).toBeGreaterThan(0);
    const drilled = board.pads!.filter(p => p.drill !== undefined && p.drill > 0);
    expect(drilled.length).toBeGreaterThan(0);
    for (const pad of drilled) expect(pad.side).toBe('both');
    // Unplated mounting holes are pads but never pins.
    const unattached = board.pads!.filter(p => p.attached === false);
    expect(unattached.length).toBe(6);
    for (const pad of unattached) expect(pad.net).toBeUndefined();
  });

  test('pad shapes map onto the renderer vocabulary', async () => {
    const board = await parseFixture(STARFISH);
    const shapes = new Set(board.pads!.map(p => p.shape));
    expect(shapes).toEqual(new Set(['round', 'rect', 'roundrect']));
    for (const pad of board.pads!) {
      expect(pad.width).toBeGreaterThan(0);
      expect(pad.height).toBeGreaterThan(0);
      if (pad.shape === 'roundrect') expect(pad.cornerRadius).toBeGreaterThan(0);
    }
  });

  test('Edge.Cuts outline is closed-ish, non-empty and frames the parts', async () => {
    const board = await parseFixture(STARFISH);
    // 4 gr_line + 4 gr_arc rounded rectangle, arcs tessellated at 15°.
    expect(board.outline.length).toBeGreaterThanOrEqual(20);
    for (const p of board.outline) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // The chain must return close to where it started — a rounded rectangle
    // is one closed loop, so a greedy chain that wandered would not.
    const first = board.outline[0];
    const last = board.outline[board.outline.length - 1];
    expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeLessThan(50);

    // 100 mm × 100 mm board.
    const ob = { minX: Math.min(...board.outline.map(p => p.x)), maxX: Math.max(...board.outline.map(p => p.x)) };
    expect(ob.maxX - ob.minX).toBeCloseTo(100 * (1000 / 25.4), 0);

    expectNonDegenerateBounds(board.bounds);
    // Every pin must sit inside the board bounds.
    for (const part of board.parts) {
      for (const pin of part.pins) {
        expect(pin.position.x).toBeGreaterThanOrEqual(board.bounds.minX);
        expect(pin.position.x).toBeLessThanOrEqual(board.bounds.maxX);
        expect(pin.position.y).toBeGreaterThanOrEqual(board.bounds.minY);
        expect(pin.position.y).toBeLessThanOrEqual(board.bounds.maxY);
      }
    }
  });

  test('tracks, curved tracks and vias are surfaced with layers', async () => {
    const board = await parseFixture(STARFISH);
    expect(board.layerNames).toEqual(['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
    // 2054 (segment) plus 143 (arc) sampled into straight pieces.
    expect(board.traces!.length).toBeGreaterThan(2054);
    for (const t of board.traces!.slice(0, 200)) {
      expect(t.width).toBeGreaterThan(0);
      expect(t.layer).toBeGreaterThanOrEqual(0);
      expect(t.layer).toBeLessThan(board.layerNames!.length);
    }
    expect(board.vias!.length).toBe(413);
    for (const v of board.vias!) {
      expect(v.diameter).toBeGreaterThan(0);
      for (const l of v.layers) expect(l).toBeLessThan(board.layerNames!.length);
    }
  });

  test('net names are de-slashed and every pin net resolves', async () => {
    const board = await parseFixture(STARFISH);
    expect(board.nets.has('GND')).toBe(true);
    expect(board.nets.has('+3V3')).toBe(true);
    // Sheet-local nets lose the leading slash (the file has no collision).
    for (const name of board.nets.keys()) expect(name.startsWith('/')).toBe(false);
    // buildNets must account for every non-empty pin net.
    for (const part of board.parts) {
      for (const pin of part.pins) {
        if (pin.net) expect(board.nets.has(pin.net)).toBe(true);
      }
    }
  });

  test('re-parsing the same bytes is deterministic', async () => {
    const a = await parseFixture(STARFISH);
    const b = await parseFixture(STARFISH);
    expect(b.parts.length).toBe(a.parts.length);
    expect(pinCount(b)).toBe(pinCount(a));
    expect(b.nets.size).toBe(a.nets.size);
    expect(b.outline).toEqual(a.outline);
    expect(b.bounds).toEqual(a.bounds);
    expect(b.traces!.length).toBe(a.traces!.length);
    expect(b.vias!.length).toBe(a.vias!.length);
    expect(b.parts.map(p => p.name)).toEqual(a.parts.map(p => p.name));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// tomu-fpga.kicad_pcb — back-side heavy, many-segment Edge.Cuts, micro vias
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad parser — tomu-fpga.kicad_pcb', () => {
  test('parses the expected counts', async () => {
    const board = await parseFixture(TOMU);
    expect(board.formatVersion).toBe('KiCad 20221018');
    // 55 (footprint) − 3 pad-less.
    expect(board.parts.length).toBe(52);
    // 222 (pad) = 148 copper + 74 mask-only apertures; no np_thru_hole.
    expect(board.pads?.length).toBe(148);
    expect(pinCount(board)).toBe(148);
    expect(board.nets.size).toBe(31);
    expect(board.traces!.length).toBe(579); // 579 (segment), no curved tracks
    expect(board.vias!.length).toBe(249);
  });

  test('back-side footprints are placed without an extra mirror', async () => {
    const board = await parseFixture(TOMU);
    const bottom = board.parts.filter(p => p.side === 'bottom');
    expect(bottom.length).toBeGreaterThan(30);

    // A back-side pin's net must be reachable at a track endpoint on the same
    // spot. KiCad stores flipped footprints with pad geometry already
    // mirrored in footprint-local space, so no extra mirror may be applied.
    const key = (x: number, y: number) => `${Math.round(x * 10)}:${Math.round(y * 10)}`;
    const ends = new Map<string, Set<string>>();
    for (const t of board.traces!) {
      for (const p of [t.start, t.end]) {
        const k = key(p.x, p.y);
        let s = ends.get(k);
        if (!s) { s = new Set(); ends.set(k, s); }
        s.add(t.net);
      }
    }
    let tested = 0, matched = 0;
    for (const part of bottom) {
      for (const pin of part.pins) {
        if (!pin.net) continue;
        const s = ends.get(key(pin.position.x, pin.position.y));
        if (!s) continue;
        tested++;
        if (s.has(pin.net)) matched++;
      }
    }
    expect(tested).toBeGreaterThan(20);
    // Every track that lands exactly on a pad centre must belong to that pad.
    expect(matched).toBe(tested);
  });

  test('a many-segment Edge.Cuts outline chains into one polyline', async () => {
    const board = await parseFixture(TOMU);
    // 95 Edge.Cuts graphics (93 lines + 2 arcs), arcs tessellated.
    expect(board.outline.length).toBeGreaterThan(90);
    expectNonDegenerateBounds(board.bounds);
    // Tomu is a ~13 mm × 9.4 mm USB stub — sanity-check the scale in mils.
    const w = board.bounds.maxX - board.bounds.minX;
    const h = board.bounds.maxY - board.bounds.minY;
    expect(w).toBeGreaterThan(400);
    expect(w).toBeLessThan(600);
    expect(h).toBeGreaterThan(300);
    expect(h).toBeLessThan(500);
  });

  test('mask-only apertures produce neither pins nor pads', async () => {
    const board = await parseFixture(TOMU);
    // The "soldermask-removal" footprint is four F.Mask/B.Mask rect pads and
    // nothing else, so it must be dropped entirely.
    expect(board.parts.find(p => p.name === 'XX1')).toBeUndefined();
    // Every emitted pad must have a real copper side.
    for (const pad of board.pads!) expect(['top', 'bottom', 'both']).toContain(pad.side);
  });

  test('micro vias keep their explicit layer span', async () => {
    const board = await parseFixture(TOMU);
    // (via micro … (layers "F.Cu" "In1.Cu")) — a blind via, so layers stays
    // populated rather than being normalised to the through-hole empty array.
    const blind = board.vias!.filter(v => v.layers.length === 2);
    expect(blind.length).toBeGreaterThan(0);
    for (const v of blind) {
      expect(v.layers[0]).toBeLessThan(v.layers[1]);
      expect(v.diameter).toBeGreaterThan(0);
    }
  });

  test('re-parsing the same bytes is deterministic', async () => {
    const a = await parseFixture(TOMU);
    const b = await parseFixture(TOMU);
    expect(b.parts.map(p => `${p.name}/${p.side}/${p.pins.length}`))
      .toEqual(a.parts.map(p => `${p.name}/${p.side}/${p.pins.length}`));
    expect(b.outline).toEqual(a.outline);
    expect(b.bounds).toEqual(a.bounds);
    expect([...b.nets.keys()].sort()).toEqual([...a.nets.keys()].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Non-board KiCad documents
// ═══════════════════════════════════════════════════════════════════════════

test.describe('KiCad parser — pad-less documents', () => {
  for (const [label, file] of [['dimensions', DIMENSIONS], ['text', TEXT_ONLY]] as const) {
    test(`${label}.kicad_pcb is rejected with an explanatory error`, async () => {
      const { parseKiCadPCB } = await import('../src/parsers/kicad-parser');
      const buf = readFixture(file);
      // Valid KiCad documents, but kicanvas *rendering* fixtures: zero pads,
      // so there is nothing to hit-test, highlight or select.
      expect(() => parseKiCadPCB(buf)).toThrow(/no placed footprints with copper pads/);
    });
  }

  test('a non-KiCad buffer is rejected before any geometry work', async () => {
    const { parseKiCadPCB } = await import('../src/parsers/kicad-parser');
    const buf = new TextEncoder().encode('$HEADER\nGENCAD 1.4\n$ENDHEADER\n');
    expect(() => parseKiCadPCB(buf.buffer as ArrayBuffer))
      .toThrow(/does not contain a \(kicad_pcb/);
  });
});
