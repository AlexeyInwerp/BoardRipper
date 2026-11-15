/**
 * What every connector designator on the sample boards is classified as (kind label, with pin count and evidence).
 *   cd src/frontend && npx vite-node ../../scripts/connector-survey.ts -- ../../samples > conn.tsv
 */
import { readFileSync, readdirSync, statSync } from 'fs'; import { join } from 'path';
import { parseBoardFile } from '../src/frontend/src/parsers';
import { estimatePart } from '../src/frontend/src/store/package-estimate';
import { isConnectorRef } from '../src/frontend/src/store/connector-kinds';
const EXT = /\.(brd|bvr|pcb|cad|fz|tvw|bdv|kicad_pcb|pcbdoc|asc)$/i; const files: string[] = [];
const walk = (d: string) => { for (const n of readdirSync(d)) { const q = join(d, n); if (statSync(q).isDirectory()) { if (n !== '3d-compare' && n !== 'nas-iphone') walk(q); } else if (EXT.test(n)) files.push(q); } };
for (const a of process.argv.slice(2).filter(a => a !== '--')) statSync(a).isDirectory() ? walk(a) : files.push(a);
console.log(['file', 'refdes', 'pins', 'family', 'label', 'L', 'W', 'H', 'evidence'].join('\t'));
for (const f of files) {
  let board; try { const buf = readFileSync(f); board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f); } catch { continue; }
  for (const p of board.parts) { if (!isConnectorRef(p.name) || p.pins.length < 2) continue; const e = estimatePart(p, { usePackage: true }); console.log([f.split('/').pop(), p.name, p.pins.length, e.family, e.size ?? '', e.L.toFixed(1), e.W.toFixed(1), e.H.toFixed(1), e.why.slice(-12)].join('\t')); }
}
