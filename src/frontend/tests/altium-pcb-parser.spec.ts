import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/altium');
const SAMPLE_PCB = path.join(SAMPLES_DIR, 'PCB.PcbDoc');
const SAMPLE_ESD = path.join(SAMPLES_DIR, 'ESD_GW1N_4L.PcbDoc');

test.describe('Altium PCB Parser — Phase 1', () => {
  test('cfb dependency is loadable', async () => {
    const cfb = await import('cfb');
    expect(typeof cfb.read).toBe('function');
    expect(typeof cfb.find).toBe('function');
  });

  test('samples are present (informational)', () => {
    test.skip(!fs.existsSync(SAMPLE_PCB), 'samples/altium/PCB.PcbDoc missing — local-only file');
    expect(fs.statSync(SAMPLE_PCB).size).toBeGreaterThan(100_000);
    if (fs.existsSync(SAMPLE_ESD)) {
      expect(fs.statSync(SAMPLE_ESD).size).toBeGreaterThan(1_000_000);
    }
  });
});

test.describe('altium-units', () => {
  test('altiumToMils divides by 10000', async () => {
    const { altiumToMils } = await import('../src/parsers/altium/altium-units');
    expect(altiumToMils(254000)).toBe(25.4);
    expect(altiumToMils(0)).toBe(0);
    expect(altiumToMils(-100000)).toBe(-10);
  });

  test('altiumYToMils negates after scaling', async () => {
    const { altiumYToMils } = await import('../src/parsers/altium/altium-units');
    expect(altiumYToMils(254000)).toBe(-25.4);
    expect(altiumYToMils(-100000)).toBe(10);
    expect(altiumYToMils(0)).toBe(0);
  });

  test('altiumAngleToDegrees handles wraps', async () => {
    const { altiumAngleToDegrees } = await import('../src/parsers/altium/altium-units');
    expect(altiumAngleToDegrees(0)).toBe(0);
    expect(altiumAngleToDegrees(90)).toBe(90);
    expect(altiumAngleToDegrees(370)).toBe(10);
    expect(altiumAngleToDegrees(-10)).toBe(350);
  });
});

test.describe('altium-props', () => {
  test('parsePropBagText splits KEY=VALUE pairs', async () => {
    const { parsePropBagText } = await import('../src/parsers/altium/altium-props');
    const m = parsePropBagText('|RECORD=Component|NAME=R1|LAYER=TOP|');
    expect(m.get('RECORD')).toBe('Component');
    expect(m.get('NAME')).toBe('R1');
    expect(m.get('LAYER')).toBe('TOP');
    expect(m.size).toBe(3);
  });

  test('parsePropBagText handles empty values and leading/trailing pipes', async () => {
    const { parsePropBagText } = await import('../src/parsers/altium/altium-props');
    const m = parsePropBagText('|A=|B=2|');
    expect(m.get('A')).toBe('');
    expect(m.get('B')).toBe('2');
  });

  test('readPropBool returns booleans', async () => {
    const { readPropBool } = await import('../src/parsers/altium/altium-props');
    const m = new Map([['X', 'TRUE'], ['Y', 'FALSE'], ['Z', 'true']]);
    expect(readPropBool(m, 'X', false)).toBe(true);
    expect(readPropBool(m, 'Y', true)).toBe(false);
    expect(readPropBool(m, 'Z', false)).toBe(true);
    expect(readPropBool(m, 'MISSING', true)).toBe(true);
  });

  test('readPropInt / readPropFloat parse numerics with fallback', async () => {
    const { readPropInt, readPropFloat } = await import('../src/parsers/altium/altium-props');
    const m = new Map([['I', '42'], ['F', '3.14'], ['BAD', 'oops']]);
    expect(readPropInt(m, 'I', 0)).toBe(42);
    expect(readPropFloat(m, 'F', 0)).toBeCloseTo(3.14);
    expect(readPropInt(m, 'BAD', 7)).toBe(7);
    expect(readPropInt(m, 'MISSING', -1)).toBe(-1);
  });

  test('iterateRecords splits a length-prefixed text-stream blob', async () => {
    const { iterateRecords } = await import('../src/parsers/altium/altium-props');
    const r1 = '|RECORD=A|NAME=X|';
    const r2 = '|RECORD=A|NAME=Y|';
    const enc = new TextEncoder();
    const b1 = enc.encode(r1);
    const b2 = enc.encode(r2);
    const buf = new Uint8Array(4 + b1.length + 4 + b2.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, b1.length, true);
    buf.set(b1, 4);
    dv.setUint32(4 + b1.length, b2.length, true);
    buf.set(b2, 4 + b1.length + 4);
    const rows = [...iterateRecords(buf)].map(r => r.get('NAME'));
    expect(rows).toEqual(['X', 'Y']);
  });
});

test.describe('altium-stream', () => {
  test('reads typed scalars little-endian', async () => {
    const { AltiumStream } = await import('../src/parsers/altium/altium-stream');
    // 17 bytes of payload (u8 + u32 + i32 + f64) + 1 trailing byte so eof()===false after reads
    const buf = new Uint8Array(18);
    const dv = new DataView(buf.buffer);
    dv.setUint8(0, 0xAB);
    dv.setUint32(1, 0x12345678, true);
    dv.setInt32(5, -42, true);
    dv.setFloat64(9, 3.14, true);
    const s = new AltiumStream(buf);
    expect(s.readUint8()).toBe(0xAB);
    expect(s.readUint32()).toBe(0x12345678);
    expect(s.readInt32()).toBe(-42);
    expect(s.readFloat64()).toBeCloseTo(3.14);
    expect(s.eof()).toBe(false);
    expect(s.pos).toBe(17);
  });

  test('readShortPascalString reads uint8-prefixed string', async () => {
    const { AltiumStream } = await import('../src/parsers/altium/altium-stream');
    const buf = new Uint8Array([3, 0x41, 0x42, 0x43]);
    expect(new AltiumStream(buf).readShortPascalString()).toBe('ABC');
  });

  test('readFullPascalString reads uint32-prefixed string', async () => {
    const { AltiumStream } = await import('../src/parsers/altium/altium-stream');
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setUint32(0, 3, true);
    buf.set([0x58, 0x59, 0x5A], 4);
    expect(new AltiumStream(buf).readFullPascalString()).toBe('XYZ');
  });

  test('peek + skip + slice work', async () => {
    const { AltiumStream } = await import('../src/parsers/altium/altium-stream');
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    const s = new AltiumStream(buf);
    expect(s.peekUint8()).toBe(1);
    expect(s.pos).toBe(0);
    s.skip(2);
    expect(s.pos).toBe(2);
    const sub = s.slice(2);
    expect(Array.from(sub)).toEqual([3, 4]);
    expect(s.pos).toBe(4);
  });
});

test.describe('altium-cfb', () => {
  test('opens PCB.PcbDoc and enumerates streams', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const ab = fs.readFileSync(SAMPLE_PCB).buffer;
    const cfb = openAltiumCfb(ab as ArrayBuffer);
    const names = cfb.listStreams();
    expect(names).toContain('FileHeader');
    expect(names).toContain('Board6/Data');
    expect(names).toContain('Components6/Data');
    expect(names).toContain('Pads6/Data');
    expect(names).toContain('Nets6/Data');
    const fh = cfb.getStream('FileHeader');
    expect(fh).not.toBeNull();
    expect(fh!.byteLength).toBe(24);
    // FileHeader = u32 length prefix + UTF-16LE wide-char body ("PCB 5.0 Bi…").
    const wide = new TextDecoder('utf-16le').decode(fh!.subarray(4));
    expect(wide).toContain('PCB 5.0');
  });

  test('returns null for unknown streams', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const ab = fs.readFileSync(SAMPLE_PCB).buffer;
    const cfb = openAltiumCfb(ab as ArrayBuffer);
    expect(cfb.getStream('NoSuchStream/Data')).toBeNull();
  });
});

test.describe('altium-pcb-format', () => {
  test('detects CFB magic + Altium signature', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const buf = fs.readFileSync(SAMPLE_PCB);
    const header = new Uint8Array(buf.buffer, buf.byteOffset, 512);
    expect(AltiumPcbFormat.detect(header)).toBe(true);
  });

  test('rejects non-CFB headers', async () => {
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const random = new Uint8Array(64);
    expect(AltiumPcbFormat.detect(random)).toBe(false);
    const bvr = new TextEncoder().encode('BVRAW_FORMAT_3\n');
    expect(AltiumPcbFormat.detect(bvr)).toBe(false);
  });

  test('detects PCB ASCII Version 5.0 header', async () => {
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const ascii = new TextEncoder().encode('PCB ASCII Version 5.0\nrest\n');
    expect(AltiumPcbFormat.detect(ascii)).toBe(true);
  });

  test('extensions include sister formats', async () => {
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    expect(AltiumPcbFormat.extensions).toEqual(
      expect.arrayContaining(['.pcbdoc', '.cmpcbdoc', '.cspcbdoc']),
    );
    expect(AltiumPcbFormat.id).toBe('ALTIUM_PCB');
  });
});

test.describe('altium-layers', () => {
  test('TOP/BOTTOM map to top/bottom', async () => {
    const { altiumLayerSide, ALTIUM_LAYER } = await import('../src/parsers/altium/altium-layers');
    expect(altiumLayerSide(ALTIUM_LAYER.TOP)).toBe('top');
    expect(altiumLayerSide(ALTIUM_LAYER.BOTTOM)).toBe('bottom');
  });

  test('property-bag LAYER strings parse', async () => {
    const { parseAltiumLayerName, ALTIUM_LAYER } = await import('../src/parsers/altium/altium-layers');
    expect(parseAltiumLayerName('TOP')).toBe(ALTIUM_LAYER.TOP);
    expect(parseAltiumLayerName('BOTTOM')).toBe(ALTIUM_LAYER.BOTTOM);
    expect(parseAltiumLayerName('MULTILAYER')).toBe(ALTIUM_LAYER.MULTI_LAYER);
    expect(parseAltiumLayerName('TOPOVERLAY')).toBe(ALTIUM_LAYER.TOP_OVERLAY);
    expect(parseAltiumLayerName('UNKNOWN_BOGUS')).toBe(ALTIUM_LAYER.UNKNOWN);
  });

  test('inner copper layers cycle through MID_LAYER_1..30', async () => {
    const { ALTIUM_LAYER, parseAltiumLayerName } = await import('../src/parsers/altium/altium-layers');
    expect(parseAltiumLayerName('MID1')).toBe(ALTIUM_LAYER.MID_LAYER_1);
    expect(parseAltiumLayerName('MID4')).toBe(ALTIUM_LAYER.MID_LAYER_4);
  });
});

test.describe('altium-records (lookup tables)', () => {
  test('parseNets6 produces a net list with expected count', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseNets6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Nets6/Data')!;
    const nets = parseNets6(buf);
    expect(nets.length).toBeGreaterThan(0);
    expect(nets.every(n => typeof n.name === 'string')).toBe(true);
    expect(nets.length).toBeGreaterThan(5);
  });

  test('parseClasses6 yields named classes', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseClasses6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Classes6/Data')!;
    const classes = parseClasses6(buf);
    expect(Array.isArray(classes)).toBe(true);
    expect(classes.every(c => typeof c.name === 'string')).toBe(true);
  });

  test('parseWideStrings6 returns a working index lookup', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseWideStrings6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('WideStrings6/Data')!;
    const table = parseWideStrings6(buf);
    expect(typeof table.byIndex(0)).toBe('string');
  });
});

test.describe('altium-records (Board6)', () => {
  test('parseBoard6 reads origin + layer names', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseBoard6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Board6/Data')!;
    const board = parseBoard6(buf);
    expect(typeof board.originX).toBe('number');
    expect(typeof board.originY).toBe('number');
    expect(Number.isFinite(board.originX)).toBe(true);
    expect(Array.isArray(board.layerNames)).toBe(true);
    expect(board.layerNames.length).toBeGreaterThanOrEqual(2);
  });

  test('parseBoard6 on 4-layer sample yields 4 named copper layers', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseBoard6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_ESD).buffer as ArrayBuffer);
    const buf = cfb.getStream('Board6/Data')!;
    const board = parseBoard6(buf);
    const populated = board.layerNames.filter(n => n.length > 0);
    expect(populated.length).toBeGreaterThanOrEqual(4);
  });
});

test.describe('altium-records (Components6)', () => {
  test('parseComponents6 yields a non-empty list with refdes', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseComponents6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Components6/Data')!;
    const comps = parseComponents6(buf);
    expect(comps.length).toBeGreaterThan(0);
    const validRefdes = comps.filter(c => /^[A-Z]+\d+/i.test(c.designator));
    expect(validRefdes.length).toBeGreaterThan(0);
  });

  test('ESD_GW1N_4L yields multiple components', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseComponents6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_ESD).buffer as ArrayBuffer);
    const buf = cfb.getStream('Components6/Data')!;
    const comps = parseComponents6(buf);
    // ESD_GW1N_4L is a small 4-layer dev board: 13 components in the actual file.
    expect(comps.length).toBeGreaterThan(10);
    const validRefdes = comps.filter(c => /^[A-Z]+\d+/i.test(c.designator));
    expect(validRefdes.length).toBeGreaterThan(0);
  });

  test('layer + side mapping puts top/bottom parts on correct sides', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseComponents6 } = await import('../src/parsers/altium/altium-records');
    const { altiumLayerSide } = await import('../src/parsers/altium/altium-layers');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Components6/Data')!;
    const comps = parseComponents6(buf);
    const sides = new Set(comps.map(c => altiumLayerSide(c.layer)));
    expect(['top', 'bottom', 'both'].some(s => sides.has(s as 'top' | 'bottom' | 'both'))).toBe(true);
  });
});

test.describe('altium-records (Pads6)', () => {
  test('parsePads6 yields a non-empty list with sane fields', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parsePads6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const buf = cfb.getStream('Pads6/Data')!;
    const pads = parsePads6(buf);
    expect(pads.length).toBeGreaterThan(0);
    for (const p of pads) {
      expect(typeof p.name).toBe('string');
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.xsize).toBeGreaterThanOrEqual(0);
      expect(p.ysize).toBeGreaterThanOrEqual(0);
    }
  });

  test('ESD_GW1N_4L has dozens of pads', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parsePads6 } = await import('../src/parsers/altium/altium-records');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_ESD).buffer as ArrayBuffer);
    const buf = cfb.getStream('Pads6/Data')!;
    const pads = parsePads6(buf);
    expect(pads.length).toBeGreaterThan(30);  // 58KB / ~250 bytes/record ≈ 230 expected; ≥30 catches catastrophic mis-walk
    const tht = pads.filter(p => p.isThroughHole);
    expect(tht.length).toBeGreaterThan(0);
  });
});

test.describe('altium-assembler', () => {
  test('assembleBoardData produces a valid BoardData', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const { parseBoard6, parseComponents6, parsePads6, parseNets6, parseClasses6, parseWideStrings6 }
      = await import('../src/parsers/altium/altium-records');
    const { assembleBoardData } = await import('../src/parsers/altium/altium-assembler');

    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_PCB).buffer as ArrayBuffer);
    const r = await import('../src/parsers/altium/altium-records');
    const db = {
      board: parseBoard6(cfb.getStream('Board6/Data')!),
      components: parseComponents6(cfb.getStream('Components6/Data')!),
      pads: parsePads6(cfb.getStream('Pads6/Data')!),
      tracks: r.parseTracks6(cfb.getStream('Tracks6/Data') ?? new Uint8Array()),
      vias: r.parseVias6(cfb.getStream('Vias6/Data') ?? new Uint8Array()),
      arcs: r.parseArcs6(cfb.getStream('Arcs6/Data') ?? new Uint8Array()),
      fills: r.parseFills6(cfb.getStream('Fills6/Data') ?? new Uint8Array()),
      regions: [
        ...r.parseRegions6(cfb.getStream('Regions6/Data') ?? new Uint8Array()),
        ...r.parseRegions6(cfb.getStream('ShapeBasedRegions6/Data') ?? new Uint8Array()),
      ],
      nets: parseNets6(cfb.getStream('Nets6/Data')!),
      classes: parseClasses6(cfb.getStream('Classes6/Data')!),
      wideStrings: parseWideStrings6(cfb.getStream('WideStrings6/Data') ?? new Uint8Array()),
    };

    const board = assembleBoardData(db);
    expect(board.format).toBe('ALTIUM_PCB');
    expect(board.parts.length).toBeGreaterThan(0);
    expect(board.parts.some(p => p.pins.length > 0)).toBe(true);
    expect(Number.isFinite(board.bounds.minX)).toBe(true);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
    expect(board.bounds.maxY).toBeGreaterThan(board.bounds.minY);
    expect(board.nets.size).toBeGreaterThanOrEqual(0);
  });

  test('top/bottom side assignment matches component layers', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { openAltiumCfb } = await import('../src/parsers/altium/altium-cfb');
    const r = await import('../src/parsers/altium/altium-records');
    const { assembleBoardData } = await import('../src/parsers/altium/altium-assembler');
    const cfb = openAltiumCfb(fs.readFileSync(SAMPLE_ESD).buffer as ArrayBuffer);
    const board = assembleBoardData({
      board: r.parseBoard6(cfb.getStream('Board6/Data')!),
      components: r.parseComponents6(cfb.getStream('Components6/Data')!),
      pads: r.parsePads6(cfb.getStream('Pads6/Data')!),
      tracks: r.parseTracks6(cfb.getStream('Tracks6/Data') ?? new Uint8Array()),
      vias: r.parseVias6(cfb.getStream('Vias6/Data') ?? new Uint8Array()),
      arcs: r.parseArcs6(cfb.getStream('Arcs6/Data') ?? new Uint8Array()),
      fills: r.parseFills6(cfb.getStream('Fills6/Data') ?? new Uint8Array()),
      regions: [
        ...r.parseRegions6(cfb.getStream('Regions6/Data') ?? new Uint8Array()),
        ...r.parseRegions6(cfb.getStream('ShapeBasedRegions6/Data') ?? new Uint8Array()),
      ],
      nets: r.parseNets6(cfb.getStream('Nets6/Data')!),
      classes: r.parseClasses6(cfb.getStream('Classes6/Data')!),
      wideStrings: r.parseWideStrings6(cfb.getStream('WideStrings6/Data') ?? new Uint8Array()),
    });
    const sides = new Set(board.parts.map(p => p.side));
    expect(sides.has('top') || sides.has('bottom')).toBe(true);
  });
});

test.describe('parseAltiumPcb (end-to-end)', () => {
  test('parses PCB.PcbDoc end-to-end via the FormatDescriptor', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const ab = fs.readFileSync(SAMPLE_PCB).buffer;
    const board = await AltiumPcbFormat.parse(ab as ArrayBuffer);
    expect(board.format).toBe('ALTIUM_PCB');
    expect(board.parts.length).toBeGreaterThan(0);
    console.log(`[PCB] parts=${board.parts.length} nets=${board.nets.size} bounds=${JSON.stringify(board.bounds)}`);
  });

  test('parses ESD_GW1N_4L.PcbDoc end-to-end', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const ab = fs.readFileSync(SAMPLE_ESD).buffer;
    const board = await AltiumPcbFormat.parse(ab as ArrayBuffer);
    expect(board.format).toBe('ALTIUM_PCB');
    expect(board.parts.length).toBeGreaterThan(10);
    console.log(`[ESD] parts=${board.parts.length} nets=${board.nets.size} pads=${board.pads?.length ?? 0} traces=${board.traces?.length ?? 0} vias=${board.vias?.length ?? 0}`);
  });

  test('ESD_GW1N_4L surfaces traces, vias, and copper pads', async () => {
    test.skip(!fs.existsSync(SAMPLE_ESD));
    const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
    const ab = fs.readFileSync(SAMPLE_ESD).buffer;
    const board = await AltiumPcbFormat.parse(ab as ArrayBuffer);
    expect(board.traces?.length ?? 0).toBeGreaterThan(20);
    expect(board.vias?.length ?? 0).toBeGreaterThan(5);
    expect(board.pads?.length ?? 0).toBeGreaterThan(20);
    expect(board.layerNames?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('parseBoardFile dispatches .PcbDoc by content detection', async () => {
    test.skip(!fs.existsSync(SAMPLE_PCB));
    const { parseBoardFile } = await import('../src/parsers');
    const ab = fs.readFileSync(SAMPLE_PCB).buffer;
    const board = await parseBoardFile(ab as ArrayBuffer, 'PCB.PcbDoc');
    expect(board.format).toBe('ALTIUM_PCB');
  });

  test('AltiumPcbFormat is registered globally', async () => {
    await import('../src/parsers'); // triggers registration side-effects
    const { getFormat, getAllExtensions } = await import('../src/parsers');
    expect(getFormat('ALTIUM_PCB')).toBeTruthy();
    const exts = getAllExtensions();
    expect(exts).toEqual(expect.arrayContaining(['.pcbdoc', '.cmpcbdoc', '.cspcbdoc']));
  });
});

test.describe('altium-ascii', () => {
  test('parses a minimal hand-crafted PCB ASCII buffer', async () => {
    const { parseAltiumAscii } = await import('../src/parsers/altium/altium-ascii');
    const ascii = [
      'PCB ASCII Version 5.0',
      '|RECORD=Board|ORIGINX=0|ORIGINY=0|LAYER1NAME=TOP|LAYER32NAME=BOTTOM|',
      '|RECORD=Net|NAME=GND|',
      '|RECORD=Net|NAME=VCC|',
      '|RECORD=Component|SOURCEDESIGNATOR=R1|PATTERN=0603|LAYER=TOP|X=100000|Y=200000|ROTATION=0|',
      '|RECORD=Pad|NAME=1|COMPONENTINDEX=0|NETINDEX=0|LAYER=TOP|X=100000|Y=200000|XSIZE=10000|YSIZE=10000|TOPSHAPE=1|HOLESIZE=0|ROTATION=0|',
      '|RECORD=Pad|NAME=2|COMPONENTINDEX=0|NETINDEX=1|LAYER=TOP|X=110000|Y=200000|XSIZE=10000|YSIZE=10000|TOPSHAPE=1|HOLESIZE=0|ROTATION=0|',
    ].join('\n');
    const buf = new TextEncoder().encode(ascii).buffer;
    const board = parseAltiumAscii(buf as ArrayBuffer);
    expect(board.format).toBe('ALTIUM_PCB');
    expect(board.parts.length).toBe(1);
    expect(board.parts[0].name).toBe('R1');
    expect(board.parts[0].pins.length).toBe(2);
    expect(board.nets.has('GND')).toBe(true);
    expect(board.nets.has('VCC')).toBe(true);
  });
});

test('AltiumPcbFormat appears in the format list with sister extensions', async () => {
  const parsers = await import('../src/parsers');
  const all = parsers.getAllFormats();
  const altium = all.find(f => f.id === 'ALTIUM_PCB');
  expect(altium).toBeDefined();
  expect(altium!.name).toBe('Altium PCB');
  expect(altium!.extensions).toEqual(
    expect.arrayContaining(['.pcbdoc', '.cmpcbdoc', '.cspcbdoc']),
  );
});
