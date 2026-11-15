/**
 * Survey every sample board for large ball fields (CPU / GPU / PCH / memory
 * packages): ball count, pitch, grid, body size, depopulation, package name.
 *
 *   cd src/frontend && npx vite-node ../../scripts/cpu-package-survey.ts -- ../../samples [minBalls] > out.tsv
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseBoardFile } from '../src/frontend/src/parsers';
import type { Part } from '../src/frontend/src/parsers/types';

const [root, minArg] = process.argv.slice(2).filter(a => a !== '--');
const MIN = Number(minArg ?? 300);
const EXT = /\.(brd|bvr|pcb|cad|fz|tvw|bdv|kicad_pcb|pcbdoc|asc|cae)$/i;
const files: string[] = [];
(function walk(d: string) { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) { if (n !== '3d-compare') walk(p); } else if (EXT.test(n)) files.push(p); } })(root);

const mm = (v: number) => v * 0.0254;
const clusters = (vals: number[], tol: number) => { const s = [...vals].sort((a, b) => a - b); const out: number[] = []; let run: number[] = []; for (const v of s) { if (run.length && v - run[run.length - 1] > tol) { out.push(run.reduce((a, b) => a + b, 0) / run.length); run = []; } run.push(v); } if (run.length) out.push(run.reduce((a, b) => a + b, 0) / run.length); return out; };

function nnPitch(pts: { x: number; y: number }[]): number {
  // grid-bucketed nearest neighbour, median
  const cell = 60; const g = new Map<string, number[]>();
  pts.forEach((p, i) => { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (g.get(k) ?? g.set(k, []).get(k)!).push(i); });
  const ds: number[] = [];
  pts.forEach((p, i) => { let best = Infinity; const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell); for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of g.get(`${cx + dx},${cy + dy}`) ?? []) { if (j === i) continue; const d = Math.hypot(pts[j].x - p.x, pts[j].y - p.y); if (d < best) best = d; } if (Number.isFinite(best)) ds.push(best); });
  ds.sort((a, b) => a - b); return ds[ds.length >> 1] ?? 0;
}

function describe(part: Part) {
  const pts = part.pins.map(q => q.position);
  const pitch = nnPitch(pts); const tol = pitch * 0.35;
  const xs = clusters(pts.map(p => p.x), tol), ys = clusters(pts.map(p => p.y), tol);
  const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x)), y0 = Math.min(...pts.map(p => p.y)), y1 = Math.max(...pts.map(p => p.y));
  // depopulation: fraction of grid cells occupied; centre void = largest empty square around the centre
  const n = part.pins.length, cells = xs.length * ys.length;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  // centre void radius: the smallest distance from centre to any ball (in pitches)
  let dmin = Infinity; for (const p of pts) { const d = Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy)); if (d < dmin) dmin = d; }
  const voidPitches = pitch ? dmin / pitch : 0;
  // ring structure: count balls by Chebyshev ring index from outside
  const rows = ys.length, cols = xs.length;
  const padR = part.pins[0].radius;
  const pw = part.pins[0].padWidth, ph = part.pins[0].padHeight;
  return { n, pitch: mm(pitch), cols, rows, cells, fill: cells ? n / cells : 0, spanX: mm(x1 - x0), spanY: mm(y1 - y0), voidPitches, pad: pw ? `${mm(pw).toFixed(2)}x${mm(ph ?? pw).toFixed(2)}` : `r${mm(padR).toFixed(2)}`, pkg: part.meta?.package ?? '', side: part.side, bx: mm(part.bounds.maxX - part.bounds.minX), by: mm(part.bounds.maxY - part.bounds.minY) };
}

console.log(['file', 'format', 'refdes', 'balls', 'pitch_mm', 'cols', 'rows', 'fill', 'spanX_mm', 'spanY_mm', 'void_pitches', 'pad', 'side', 'package', 'boundsX', 'boundsY'].join('\t'));
for (const f of files) {
  let board;
  try { const buf = readFileSync(f); board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f); }
  catch (e) { console.error(`SKIP ${f}: ${(e as Error).message?.slice(0, 80)}`); continue; }
  for (const part of board.parts) {
    if (part.pins.length < MIN) continue;
    const d = describe(part);
    console.log([f.replace(root + '/', ''), board.format, part.name, d.n, d.pitch.toFixed(3), d.cols, d.rows, d.fill.toFixed(2), d.spanX.toFixed(1), d.spanY.toFixed(1), d.voidPitches.toFixed(1), d.pad, d.side, d.pkg, d.bx.toFixed(1), d.by.toFixed(1)].join('\t'));
  }
}
