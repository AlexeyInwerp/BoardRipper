import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// XZZ board packs: one `.pcb` holding several physical boards, each drawn as
// two side-by-side halves. The parser has to split the file into boards, pair
// each board's halves, decide which half is the top, fold the bottom half
// onto the top — pins, pads, silk, everything — and slide the boards next to
// each other. These specs pin the behaviour the corpus review of 2026-09-05
// settled (docs/specs/2026-09-05-xzz-multi-board-unfold-review.md) on the
// files that used to break.
//
// Fixtures live under the gitignored "XZZ PCB SAMPLES/" tree; every test
// skips when its file is absent.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const XZZ = path.resolve(__dirname, '../../../samples/XZZ PCB SAMPLES');
const IPHONE = path.resolve(XZZ, 'nas-iphone/XZZ/Phones/iPhone');

const FILES = {
  pack16: path.resolve(XZZ, 'iPhone16_16Plus/iPhone16_16Plus AP+BB Boardview.pcb'),
  ap16: path.resolve(IPHONE, 'iPhone16_16Plus/Schematic and boardview/PCB layer/iPhone16_16Plus-820-03296-13_AP PCB layer.pcb'),
  bb16: path.resolve(IPHONE, 'iPhone16_16Plus/Schematic and boardview/PCB layer/iPhone16_16Plus-820-03297-10_BB PCB layer.pcb'),
  xr: path.resolve(IPHONE, 'iPhoneXR/Schematic and boardview/XR.pcb'),
  xsmax: path.resolve(IPHONE, 'iPhoneXSMAX/Schematic and boardview/iPhoneXSMAX boardview(Diode value).pcb'),
  se: path.resolve(IPHONE, 'iPhoneSE/Schematic and boardview/iPhoneSE boardview.pcb'),
  xQualcomm: path.resolve(IPHONE, 'iPhoneX/Schematic and boardview/iPhoneX Qualcomm PCB layer.pcb'),
  k90i: path.resolve(XZZ, 'A12xx/A1278_820-2936 K90I/Schematic and boardview/K90I-820-2936_07.pcb'),
  k22: path.resolve(XZZ, '820-2494 K22.pcb'),
};

function load(filePath: string): ArrayBuffer {
  const buf = fs.readFileSync(filePath);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Find a fixture by basename anywhere under the samples tree, so a
 *  re-organised corpus doesn't silently skip the test. */
function find(base: string): string | null {
  const stack = [XZZ];
  while (stack.length) {
    const d = stack.pop()!;
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === base) return p;
    }
  }
  return null;
}

const resolve = (p: string): string | null => (fs.existsSync(p) ? p : find(path.basename(p)));

const inBounds = (b: { minX: number; minY: number; maxX: number; maxY: number }, x: number, y: number, pad = 1) =>
  x >= b.minX - pad && x <= b.maxX + pad && y >= b.minY - pad && y <= b.maxY + pad;

test.describe('XZZ board packs', () => {
  test('iPhone 16 AP+BB: two boards, sides by layout, every geometry kind folded inside its board', async () => {
    const f = resolve(FILES.pack16);
    test.skip(!f, 'iPhone16_16Plus AP+BB Boardview.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));

    expect(board.boards).toHaveLength(2);
    const boards = board.boards!;
    for (const b of boards) {
      expect(b.fold?.dim).toBe('x');
      expect(b.bottom).toBeDefined();
      expect(b.sideSource).toBe('layout');
    }
    // Compaction: the boards sit next to each other with a small gap, not
    // with the empty bottom-half areas between them.
    const [l, r] = [...boards].sort((a, b) => a.bounds.minX - b.bounds.minX);
    expect(r.bounds.minX - l.bounds.maxX).toBeGreaterThan(20);
    expect(r.bounds.minX - l.bounds.maxX).toBeLessThan(300);

    // Every part is assigned, and every pin of a part lies inside its board.
    for (const p of board.parts) {
      expect(p.boardIndex).toBeDefined();
      const b = boards[p.boardIndex!];
      for (const pin of p.pins) expect(inBounds(b.bounds, pin.position.x, pin.position.y)).toBe(true);
    }
    // Both sides populated on both boards.
    for (let i = 0; i < boards.length; i++) {
      const mine = board.parts.filter(p => p.boardIndex === i);
      expect(mine.filter(p => p.side === 'top').length).toBeGreaterThan(100);
      expect(mine.filter(p => p.side === 'bottom').length).toBeGreaterThan(100);
    }
    // Pads and silkscreen followed their parts: nothing is left in the
    // discarded bottom-half areas, i.e. everything sits inside some board.
    const inAny = (x: number, y: number) => boards.some(b => inBounds(b.bounds, x, y));
    for (const pad of board.pads ?? []) {
      expect(inAny((pad.bounds.minX + pad.bounds.maxX) / 2, (pad.bounds.minY + pad.bounds.maxY) / 2)).toBe(true);
    }
    let silkOutside = 0;
    for (const s of board.silkscreen ?? []) if (!inAny(s.points[0].x, s.points[0].y)) silkOutside++;
    expect(silkOutside).toBe(0);
    // The AP board is the one with the SoC; its top half holds it.
    const soc = board.parts.reduce((m, p) => (p.pins.length > m.pins.length ? p : m));
    expect(soc.pins.length).toBeGreaterThan(1500);
    expect(soc.side).toBe('top');
  });

  test('the pack and its single-board PCB-layer siblings agree on which half is top', async () => {
    const pack = resolve(FILES.pack16), ap = resolve(FILES.ap16), bb = resolve(FILES.bb16);
    test.skip(!pack || !ap || !bb, 'iPhone 16 pack + AP/BB PCB-layer files not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const p = parseXZZ(load(pack!)), a = parseXZZ(load(ap!)), b = parseXZZ(load(bb!));
    // PCB-layer files decide from copper; the pack from layout. Same answer.
    expect(a.boards?.[0].sideSource).toBe('copper');
    expect(b.boards?.[0].sideSource).toBe('copper');
    // Compare per board: designators repeat across the AP and BB boards, so
    // match each single-board file against the pack board holding its
    // most-pinned part.
    const sideByName = (parts: typeof p.parts) => new Map(parts.map(x => [x.name, x.side] as const));
    const agree = (single: typeof p): number => {
      const big = single.parts.reduce((m, x) => (x.pins.length > m.pins.length ? x : m));
      const bi = p.parts.find(x => x.name === big.name)?.boardIndex;
      expect(bi).toBeDefined();
      const packSides = sideByName(p.parts.filter(x => x.boardIndex === bi));
      let same = 0, total = 0;
      for (const part of single.parts) {
        const ps = packSides.get(part.name);
        if (ps === undefined) continue;
        total++;
        if (ps === part.side) same++;
      }
      expect(total).toBeGreaterThan(500);
      return same / total;
    };
    expect(agree(a)).toBeGreaterThan(0.97);
    expect(agree(b)).toBeGreaterThan(0.97);
  });

  test('XR.pcb: one board with cutouts, never gap-folded across boards', async () => {
    const f = resolve(FILES.xr);
    test.skip(!f, 'XR.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));
    expect(board.boards).toHaveLength(1);
    expect(board.foldInfo?.source).toBe('outline-components');
    const unassigned = board.parts.filter(p => p.boardIndex === undefined).length;
    expect(unassigned).toBeLessThan(20);
  });

  test('iPhone SE boardview: 15 loops are one board plus cutouts', async () => {
    const f = resolve(FILES.se);
    test.skip(!f, 'iPhoneSE boardview.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));
    expect(board.foldComponents!.length).toBeGreaterThan(10);
    expect(board.boards).toHaveLength(1);
    expect(board.boards![0].components.length).toBeGreaterThan(10);
  });

  test('XS Max boardview: a bottom half with an extra notch still pairs', async () => {
    const f = resolve(FILES.xsmax);
    test.skip(!f, 'iPhoneXSMAX boardview(Diode value).pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));
    const twoSided = board.boards!.filter(b => b.bottom !== undefined);
    expect(twoSided.length).toBeGreaterThanOrEqual(2);
    expect(board.parts.filter(p => p.side === 'bottom').length).toBeGreaterThan(500);
  });

  test('K90I (A1278): touching halves drawn as one loop are split at the seam and folded', async () => {
    const f = resolve(FILES.k90i);
    test.skip(!f, 'K90I-820-2936_07.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));
    expect(board.boards).toHaveLength(1);
    const b = board.boards![0];
    expect(b.fold?.dim).toBe('y');
    expect(b.bottom).toBeDefined();
    const top = board.parts.filter(p => p.side === 'top').length;
    const bottom = board.parts.filter(p => p.side === 'bottom').length;
    expect(top).toBeGreaterThan(500);
    expect(bottom).toBeGreaterThan(500);
    // The folded board is one half tall: 6634 × ~5012 mil, not 10024.
    const h = board.bounds.maxY - board.bounds.minY;
    expect(h).toBeLessThan(5200);
    expect(h).toBeGreaterThan(4800);
    // The kept half is one closed loop: the seam edge became its top edge
    // and nothing is left hanging.
    const subPaths: Array<{ x: number; y: number }[]> = [[]];
    for (const p of board.outline) { if (Number.isFinite(p.x)) subPaths[subPaths.length - 1].push(p); else subPaths.push([]); }
    const loops = subPaths.filter(s => s.length >= 3);
    expect(loops).toHaveLength(1);
    const a = loops[0][0], z = loops[0][loops[0].length - 1];
    expect(Math.hypot(a.x - z.x, a.y - z.y)).toBeLessThan(1);
    // The CPU (U1000) is on the top side of this board.
    expect(board.parts.find(p => p.name === 'U1000')?.side).toBe('top');
  });

  test('K22 (820-2494): a rectangle loop whose halves wind opposite ways folds by translation', async () => {
    const f = resolve(FILES.k22);
    test.skip(!f, '820-2494 K22.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(load(f!));
    expect(board.boards).toHaveLength(1);
    const b = board.boards![0];
    expect(b.fold?.mode).toBe('translate');
    expect(b.sideSource).toBe('cpu');
    expect(board.parts.filter(p => p.side === 'bottom').length).toBeGreaterThan(300);
    expect(board.parts.find(p => p.name === 'U1400')?.side).toBe('top');
    const h = board.bounds.maxY - board.bounds.minY;
    expect(h).toBeLessThan(7200);
  });

  test('iPhone X Qualcomm PCB layer: copper decides both boards and agrees with the layout rule', async () => {
    const f = resolve(FILES.xQualcomm);
    test.skip(!f, 'iPhoneX Qualcomm PCB layer.pcb not present');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const { logStore } = await import('../src/store/log-store');
    logStore.clear();
    const board = parseXZZ(load(f!));
    expect(board.boards).toHaveLength(2);
    for (const b of board.boards!) expect(b.sideSource).toBe('copper');
    // The tripwire: copper has never placed the design's top half opposite
    // to where the exporter's layout rule expects it.
    const contradiction = logStore.getSnapshot().some(e => /design top OPPOSITE/.test(e.message));
    expect(contradiction).toBe(false);
  });
});
