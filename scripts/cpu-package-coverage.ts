/**
 * Which BGA bodies leave pads outside: for every part with ≥ 60 pins estimated as a BGA, the share of pins whose pad
 * (radius) is not fully inside the estimated body rectangle, in the estimate's own frame. Sorted worst first.
 *   cd src/frontend && npx vite-node ../../scripts/cpu-package-coverage.ts -- <board> [...]
 */
import { readFileSync } from 'fs';
import { parseBoardFile } from '../src/frontend/src/parsers';
import { estimatePart } from '../src/frontend/src/store/package-estimate';
const MM = 0.0254;
import { readdirSync, statSync } from 'fs'; import { join } from 'path';
const EXT = /\.(brd|bvr|pcb|cad|fz|tvw|bdv|kicad_pcb|pcbdoc|asc)$/i;
const files: string[] = []; const walk = (d: string) => { for (const n of readdirSync(d)) { const q = join(d, n); if (statSync(q).isDirectory()) { if (n !== '3d-compare') walk(q); } else if (EXT.test(n)) files.push(q); } };
for (const a of process.argv.slice(2).filter(a => a !== '--')) statSync(a).isDirectory() ? walk(a) : files.push(a);
const ONLY_BAD = files.length > 3;
for (const f of files) {
  let buf; try { buf = readFileSync(f); } catch { continue; }
  let board; try { board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f); } catch { continue; }
  const rows: { name: string; n: number; out: number; L: number; W: number; rot: number; pkg: string; why: string; side: string }[] = [];
  for (const part of board.parts) {
    if (part.pins.length < 60) continue;
    const e = estimatePart(part, { usePackage: true }); if (e.family !== 'bga') continue;
    const c = Math.cos(-e.rotDeg * Math.PI / 180), s = Math.sin(-e.rotDeg * Math.PI / 180); let out = 0;
    for (const q of part.pins) {
      const dx = (q.position.x - e.cx) * MM, dy = (q.position.y - e.cy) * MM; const x = dx * c - dy * s, y = dx * s + dy * c; const r = (q.radius || 8) * MM;
      if (Math.abs(x) + r > e.L / 2 || Math.abs(y) + r > e.W / 2) out++;
    }
    rows.push({ name: part.name, n: part.pins.length, out, L: e.L, W: e.W, rot: e.rotDeg, pkg: e.pkg ?? '—', why: e.why, side: part.side });
  }
  rows.sort((a, b) => b.out / b.n - a.out / a.n);
  if (ONLY_BAD && !rows.some(r => r.out)) continue;
  console.log(`\n${f.split('/').pop()}: ${rows.length} BGAs, ${rows.filter(r => r.out).length} with pads outside`);
  for (const r of (ONLY_BAD ? rows.filter(r => r.out) : rows.slice(0, 12))) console.log(`${r.name}\t${r.side}\t${r.n} pins\t${r.out} outside\t${r.L.toFixed(1)}×${r.W.toFixed(1)} rot ${r.rot.toFixed(0)}\t${r.pkg}\t${r.why.slice(0, 90)}`);
}
