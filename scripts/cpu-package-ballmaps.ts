/**
 * Export ball maps of named CPU / GPU / PCH packages from sample boards for the
 * package mockup (docs/specs/2026-11-15-cpu-package-mockup.html).
 *
 *   cd src/frontend && npx vite-node ../../scripts/cpu-package-ballmaps.ts -- ../../samples ../../docs/specs/2026-11-15-cpu-package-ballmaps.js
 *
 * Each entry: id, label, source, refdes, side, pitch (mm), pad (mm), span (mm),
 * and ball centres in 0.05 mm units about the field centre — package top view
 * (a bottom-side part's y is mirrored), landscape (x along the longer side).
 * Also writes src/frontend/src/store/cpu-package-signatures.ts.
 */
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseBoardFile } from '../src/frontend/src/parsers';
import { ballSignature } from '../src/frontend/src/store/cpu-packages';

const [root, out] = process.argv.slice(2).filter(a => a !== '--');
const X = 'XZZ PCB SAMPLES';
const WANT: [string, string, string, string][] = [
  // id, label, file (under samples), refdes
  ['bga1356', 'Intel Skylake-U / Kaby Lake-U · BGA1356', 'allegroBRD/PC Laptop/Compal LA-C881P boardview/LA-C881P R10-0803B.brd', 'UCPU1'],
  ['bga1356-apple', 'Intel Kaby Lake-U · BGA1356 (MacBook Pro A1708, XZZ)', `${X}/A17xx/A1708_820-00840/Schematic and boardview/J130A 820-00840-01.pcb`, 'U0500'],
  ['bga1440', 'Intel Skylake-H · BGA1440 (Dell XPS 15 9550)', 'allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd', 'UH1'],
  ['bga1440-cfl', 'Intel Coffee Lake-H · BGA1440 (LA-H281P)', 'allegroBRD/PC Laptop/LA-H281P/LAH281PR10-0410_Gerber.brd', 'UC1'],
  ['bga1744', 'Intel Alder Lake-P · BGA1744 (LA-P161P)', 'LA-P161PR1B.brd', 'UC1'],
  ['bga1515', 'Intel Amber Lake-Y · BGA1515 (MacBook Air A1932)', `${X}/A19xx/A1932_820-01521 J140/Schematic and boardview/X1032 820-01521-A.pcb`, 'U0500'],
  ['bga1528', 'Intel Coffee Lake-U (8th gen, 28 W) · BGA1528 (MacBook Pro A2159)', `${X}/A21xx/A2159_820-01598/Schematic and boardview/X1536 820-01598-06.pcb`, 'U0500'],
  ['bga1526', 'Intel Ice Lake-U · BGA1526 (MacBook Pro A2251, 1344 listed)', `${X}/A22xx/A2251_820-01949/Schematic and boardview/820-01949.pcb`, 'U0500'],
  ['bga1364', 'Intel Haswell-H · BGA1364 (LA-9941P)', 'allegroBRD/PC Laptop/LA-9941P/LA-9941PR10-0905b.brd', 'U6'],
  ['bga1168', 'Intel Haswell-ULT · BGA1168 (LA-B441P)', 'allegroBRD/PC Laptop/Compal LA-B441P r1.0 boardview/LAB441PR10-1017A/LAB441PR10-1017A.brd', 'UCPU1'],
  ['bga1380', 'Intel Bay Trail · BGA1380 (DA0EE6)', 'allegroBRD/PC Laptop/DA0ZS8MB8E0 BOARD VIEW/da0ee6mbad0-d-susan-165XL-0828.brd', 'U29'],
  ['pch-cnp-h', 'Intel Cannon Point-H PCH · BGA874 (LA-H281P)', 'allegroBRD/PC Laptop/LA-H281P/LAH281PR10-0410_Gerber.brd', 'UH1'],
  ['pch-skl-h', 'Intel Sunrise Point-H PCH · BGA837 (LA-C361P)', 'allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd', 'UH2'],
  ['ad102', 'NVIDIA AD102 · BGA3328 (RTX 4090)', 'cad/NVIDIA4090.cad', 'G1'],
  ['ga102', 'NVIDIA GA102 · BGA3328 (RTX 3080)', 'cad/ASUS TUF-RTX3080-10G-GAMING-2I3S CG132P3.101X.cad', 'G1'],
  ['ga106', 'NVIDIA GA106 · BGA2228 (MSI MS-V385)', 'cad/MSI MS-V385 Rev 1.0 BoardView.cad', 'G1'],
  ['gn22', 'NVIDIA GN22-X4 · FCBGA2088 (LA-P161P)', 'LA-P161PR1B.brd', 'UV1'],
  ['n17p', 'NVIDIA N17P-G0 (GP107 laptop) · FCBGA908 (LA-F661P)', 'allegroBRD/PC Laptop/Compal LA-F661P r1.0 (1)/LA-F661PR10.brd', 'UV1'],
  ['n15p', 'NVIDIA N15P-GT (GM107, GTX 960M) · BGA908 (LA-C361P)', 'allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd', 'UV18'],
  ['polaris', 'AMD Polaris 20 (RX 580) · BGA1401', 'cad/MSI_RX_580_V341-1.3.cad', 'U1'],
  ['vega10', 'AMD Vega 10 (iMac Pro A1862) · ~2013 balls', `${X}/A18xx/A1862 820-00967 IMac Pro 27 late 2017/A1862 820-00967.pcb`, 'UA000'],
  ['gk104', 'NVIDIA GK104 (iMac A1418 D8) · 1745 balls', `${X}/A14xx/A1418_820-3302 D7/Schematic and boardview/D8(GK104)820-3299_08.pcb`, 'UA000'],
  ['imac2019-gpu', 'AMD GPU, iMac A2115 · 1928 balls @ 0.787', `${X}/A21xx/A2115_051-04826/A2115 820-01823_04.pcb`, 'UC000'],
  ['m1', 'Apple M1 (A2337) · 2502 balls', `${X}/A23xx/A2337_820-02016 MacBook Air M1/Schematic and boardview/820-02016-07_MacBook Air (M1, A2337).pcb`, 'U0600'],
  ['m1max', 'Apple M1 Max (A2442) · 4183 balls', `${X}/A24xx/A2442_820-02098 MacBook Pro/Schematic and boardview/A2442 820-02098-H M1 MAX.pcb`, 'U0600'],
  ['t2', 'Apple T2 (A1989) · 1406 balls', `${X}/A19xx/A1989_820-00850/Schematic and boardview/J132_MLB_820-00850-A.pcb`, 'U3900'],
  ['lga1151', 'Intel LGA1151 socket pads (iMac A2115)', `${X}/A21xx/A2115_051-04826/A2115 820-01823_04.pcb`, 'U0500'],
  // memory, NAND, AMD mobile GPUs (2026-11-15)
  ['ddr4-78', 'DDR4 x8 FBGA-78 (MacBook Pro A1990, 0.8 mm)', `${X}/A19xx/A1990_820-01041/Schematic and boardview/820-01041-A.pcb`, 'U2300'],
  ['ddr3-96', 'DDR3L x16 FBGA-96 (MacBook Air A1465)', `${X}/A14xx/A1465_820-00164 J110/Schematic and boardview/Apple MacBook Air 11 A1465 820-00164.pcb`, 'U4000'],
  ['gddr5-170', 'GDDR5 FBGA-170 (LA-C361P, H5GQ1H24AFR)', 'allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd', 'UV23'],
  ['gddr6-180', 'GDDR6X FBGA-180 (ASUS RTX 3080)', 'cad/ASUS TUF-RTX3080-10G-GAMING-2I3S CG132P3.101X.cad', 'M1'],
  ['gddr7-266', 'GDDR7 FBGA-266 (LA-P161P, MT68A512M32DF)', 'LA-P161PR1B.brd', 'UV4'],
  ['lpddr3-178', 'LPDDR3 178-ball (MacBook Pro A1708)', `${X}/A17xx/A1708_820-00840/Schematic and boardview/J130A 820-00840-01.pcb`, 'U2500'],
  ['lpddr3-253', 'LPDDR3 253-ball (MacBook Air A1932)', `${X}/A19xx/A1932_820-01521 J140/Schematic and boardview/820-01521-02 J140.pcb`, 'U2500'],
  ['lpddr4-200', 'LPDDR4X 200-ball (Switch Lite)', `${X}/nas-issues/Switch lite-HDH-CPU-02 PCB Layer.pcb`, 'N487'],
  ['nand-bga315', 'Apple NAND BGA315 (820-02652)', 'cad/820-02652 boardview.cad', 'UN200'],
  ['nand-bga110', 'Apple SSD NAND BGA110 (MacBook Pro A1989)', `${X}/A19xx/A1989_820-00850/Schematic and boardview/J132_MLB_820-00850-A.pcb`, 'U8600'],
  ['amd-polaris21', 'AMD Polaris 21 / Baffin (MacBook Pro A1707 Radeon Pro 450–460)', `${X}/A17xx/A1707_820-00281 J80/Schematic and boardview/J80_MLB 820-00281 820-00928-04.pcb`, 'UA000'],
  ['amd-navi14', 'AMD Navi 14 (MacBook Pro A2141 Radeon Pro 5300M/5500M)', `${X}/A21xx/A2141_820-01700/Schematic and boardview/A2141_820-01700.pcb`, 'UA000'],
  ['amd-capeverde', 'AMD Cape Verde (MacBook Pro A1398 2015 R9 M370X)', `${X}/A13xx/A1398_820-00426/Schematic and boardview/820-00426 MLB, VENUS2, PROTO1A.pcb`, 'U8400'],
  ['bga1964', 'Intel Raptor Lake-HX · BGA1964 (Lenovo Legion Pro 5 16IRX9)', 'incoming/lenovo/Lenovo_Legion_Pro_5_16IRX9_NM_F701.cad', 'UC1'],
  ['ad107', 'NVIDIA GN21-X4/X6 (AD107/AD106 laptop, RTX 4060/4070) · 1358 balls (Legion Pro 5)', 'incoming/lenovo/Lenovo_Legion_Pro_5_16IRX9_NM_F701.cad', 'UG1'],
  ['pch-hx-1045', 'Intel 700-series PCH for HX (Legion Pro 5) · 1045 balls', 'incoming/lenovo/Lenovo_Legion_Pro_5_16IRX9_NM_F701.cad', 'UH1'],
  ['amd-pitcairn', 'AMD Pitcairn (iMac A1419 2014 R9 M290X) · 1737 balls', `${X}/A14xx/A1419_820-4652/Schematic and boardview/J78_MLB_820-4652-A.pcb`, 'U8700'],
  ['lga2066', 'Intel LGA2066 socket pads (iMac Pro A1862)', `${X}/A18xx/A1862 820-00967 IMac Pro 27 late 2017/A1862 820-00967.pcb`, 'U1000'],
];

const mm = (v: number) => v * 0.0254;
function nn(pts: { x: number; y: number }[]) {
  const cell = 60; const g = new Map<string, number[]>();
  pts.forEach((p, i) => { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(i); });
  const res: { d: number; ang: number }[] = [];
  pts.forEach((p, i) => { let best = Infinity, ang = 0; const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of g.get(`${cx + dx},${cy + dy}`) ?? []) { if (j === i) continue; const d = Math.hypot(pts[j].x - p.x, pts[j].y - p.y); if (d < best) { best = d; ang = Math.atan2(pts[j].y - p.y, pts[j].x - p.x); } } if (Number.isFinite(best)) res.push({ d: best, ang }); });
  return res;
}
const cache = new Map<string, Awaited<ReturnType<typeof parseBoardFile>>>();
const entries: unknown[] = []; const signatures: Record<string, number[]> = {};
for (const [id, label, rel, refdes] of WANT) {
  const file = join(root, rel);
  let board = cache.get(file);
  if (!board) { try { const buf = readFileSync(file); board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, file); cache.set(file, board); } catch (e) { console.error(`SKIP ${id}: ${(e as Error).message}`); continue; } }
  const part = board.parts.find(p => p.name === refdes); if (!part) { console.error(`SKIP ${id}: no ${refdes}`); continue; }
  const pts = part.pins.map(q => ({ x: q.position.x, y: q.position.y }));
  const e = nn(pts); const ds = e.map(v => v.d).sort((a, b) => a - b); const pitch = ds[ds.length >> 1];
  // dominant grid angle mod 90°
  const a4 = e.map(v => ((v.ang * 4) % (2 * Math.PI))); const sx = a4.reduce((a, v) => a + Math.cos(v), 0), sy = a4.reduce((a, v) => a + Math.sin(v), 0); let ang = Math.atan2(sy, sx) / 4;
  // a staggered (checkerboard) field has diagonal nearest neighbours: take the angle whose box is tighter
  const turn = (a: number) => { const c = Math.cos(-a), s = Math.sin(-a); return pts.map(p => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c })); };
  const area = (r: { x: number; y: number }[]) => (Math.max(...r.map(p => p.x)) - Math.min(...r.map(p => p.x))) * (Math.max(...r.map(p => p.y)) - Math.min(...r.map(p => p.y)));
  let rot = turn(ang); const alt = turn(ang + Math.PI / 4); if (area(alt) < area(rot) * 0.98) { rot = alt; ang += Math.PI / 4; }
  // package top view: a bottom-side part is seen through the board, so mirror its y (what the 3D renderer undoes);
  // landscape: every record has L ≥ W, so turn a portrait field by 90°
  if (part.side === 'bottom') rot = rot.map(p => ({ x: p.x, y: -p.y }));
  { const bx = Math.max(...rot.map(p => p.x)) - Math.min(...rot.map(p => p.x)), by = Math.max(...rot.map(p => p.y)) - Math.min(...rot.map(p => p.y)); if (by > bx * 1.02) { rot = rot.map(p => ({ x: -p.y, y: p.x })); ang += Math.PI / 2; } }
  const x0 = Math.min(...rot.map(p => p.x)), x1 = Math.max(...rot.map(p => p.x)), y0 = Math.min(...rot.map(p => p.y)), y1 = Math.max(...rot.map(p => p.y));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const balls = rot.flatMap(p => [Math.round(mm(p.x - cx) * 20), Math.round(mm(p.y - cy) * 20)]);
  const q = part.pins[0];
  signatures[id] = ballSignature(rot).map(v => +v.toFixed(3));
  entries.push({ id, label, source: rel.split('/').pop(), format: board.format, refdes, side: part.side, package: part.meta?.package ?? null, balls: part.pins.length, pitch: +mm(pitch).toFixed(3), pad: +mm(q.padWidth ?? q.radius * 2).toFixed(2), spanX: +mm(x1 - x0).toFixed(2), spanY: +mm(y1 - y0).toFixed(2), angleDeg: +(ang * 180 / Math.PI).toFixed(1), xy: balls });
  console.error(`${id}: ${part.pins.length} balls @ ${mm(pitch).toFixed(3)} span ${mm(x1 - x0).toFixed(1)}×${mm(y1 - y0).toFixed(1)} angle ${(ang * 180 / Math.PI).toFixed(1)}°`);
}
writeFileSync('src/store/cpu-package-signatures.ts', `// generated by scripts/cpu-package-ballmaps.ts — 12 × 12 ball-occupancy signatures per sample ball map (package top view, x along L).\n// Do not edit: re-run the script.\nexport const SIGNATURES: Record<string, number[]> = ${JSON.stringify(signatures)};\n`);
writeFileSync(out, `// generated by scripts/cpu-package-ballmaps.ts — ball centres in 0.05 mm units about the field centre\nwindow.BALLMAPS = ${JSON.stringify(entries)};\n`);
console.error(`wrote ${out} (${entries.length} entries)`);
