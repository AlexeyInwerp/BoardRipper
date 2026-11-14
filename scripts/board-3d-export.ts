/**
 * Export a board for the 3D comparison mockup (docs/specs/2026-11-14-3d-compare-mockup.html).
 *
 *   cd src/frontend && npx vite-node ../../scripts/board-3d-export.ts -- <board> <out.js> [name]
 *
 * Writes `window.BOARD3D = {...}` (a classic script, so the mockup works from
 * file://). Coordinates in mils, board frame (Y up). Each part carries two
 * estimates: with the package name, and from the pins alone.
 *
 * EAGLE only, for now, for the silkscreen art: EAGLE logos and labels are often
 * bitmap imports — thousands of <rectangle>s on layer 200/201 in a package —
 * which the board parser rightly skips; the 3D board top bakes them into its
 * silkscreen texture.
 */
import { readFileSync, writeFileSync } from 'fs';
import { parseBoardFile } from '../src/frontend/src/parsers';
import { parseEagleXml, parseEagleRot, type EagleXmlNode } from '../src/frontend/src/parsers/eagle-parser';
import { estimatePart } from '../src/frontend/src/store/package-estimate';

const [file, outFile, name = file.split('/').pop()] = process.argv.slice(2).filter(a => a !== '--');
const buf = readFileSync(file);
const board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, file);
const MIL = 1 / 0.0254;
const r1 = (v: number) => Math.round(v * 10) / 10;

// ── silkscreen art + plain holes/texts straight from the XML (EAGLE) ──
const rects: { side: 'top' | 'bottom'; x0: number; y0: number; x1: number; y1: number }[] = [];
const holes: { x: number; y: number; d: number }[] = [];
const texts: { text: string; x: number; y: number; size: number; rot: number; side: 'top' | 'bottom'; align: string }[] = [];
if (board.format === 'EAGLE_BRD') {
  const root = parseEagleXml(buf.toString('utf8'));
  const find = (n: EagleXmlNode, tag: string): EagleXmlNode[] => { const out: EagleXmlNode[] = []; const walk = (x: EagleXmlNode) => { if (x.name === tag) out.push(x); x.children.forEach(walk); }; walk(n); return out; };
  const pkgs = new Map<string, EagleXmlNode>();
  for (const lib of find(root, 'library')) for (const p of find(lib, 'package')) pkgs.set(`${lib.attrs.name}/${p.attrs.name}`, p);
  for (const el of find(root, 'element')) {
    const pkg = pkgs.get(`${el.attrs.library}/${el.attrs.package}`); if (!pkg) continue;
    const { angleDeg, mirror } = parseEagleRot(el.attrs.rot);
    const ex = +el.attrs.x, ey = +el.attrs.y, a = angleDeg * Math.PI / 180;
    const tf = (x: number, y: number) => { const mx = mirror ? -x : x; return [ex + mx * Math.cos(a) - y * Math.sin(a), ey + mx * Math.sin(a) + y * Math.cos(a)]; };
    for (const c of pkg.children) {
      if (c.name !== 'rectangle' || !['200', '201', '21', '22'].includes(c.attrs.layer)) continue;
      const [ax, ay] = tf(+c.attrs.x1, +c.attrs.y1), [bx, by] = tf(+c.attrs.x2, +c.attrs.y2);
      // tPlace/bPlace (21/22) swap sides with a mirrored element; the bitmap
      // import layers (200/201) are user layers and do not.
      const top = c.attrs.layer === '200' || c.attrs.layer === '201' ? c.attrs.layer === '200' : (c.attrs.layer === '21') !== mirror;
      rects.push({ side: top ? 'top' : 'bottom', x0: r1(Math.min(ax, bx) * MIL), y0: r1(Math.min(ay, by) * MIL), x1: r1(Math.max(ax, bx) * MIL), y1: r1(Math.max(ay, by) * MIL) });
    }
  }
  const plain = find(root, 'plain')[0];
  for (const c of plain?.children ?? []) {
    if (c.name === 'hole') holes.push({ x: +c.attrs.x * MIL, y: +c.attrs.y * MIL, d: +c.attrs.drill * MIL });
  }
  // text content is not kept by parseEagleXml; board-level silk text is few, read it directly
  const plainXml = buf.toString('utf8').match(/<plain>([\s\S]*?)<\/plain>/)?.[1] ?? '';
  for (const m of plainXml.matchAll(/<text ([^>]*)>([^<]*)<\/text>/g)) {
    const at = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(x => [x[1], x[2]]));
    if (at.layer !== '21' && at.layer !== '22') continue;
    texts.push({ text: m[2], x: +at.x * MIL, y: +at.y * MIL, size: +at.size * MIL, rot: parseEagleRot(at.rot).angleDeg, side: at.layer === '21' ? 'top' : 'bottom', align: at.align ?? 'bottom-left' });
  }
}

const out = {
  name, format: board.format, bounds: board.bounds, layerNames: board.layerNames ?? [],
  outline: board.outline.map(p => (Number.isNaN(p.x) ? null : [r1(p.x), r1(p.y)])),
  holes,
  vias: (board.vias ?? []).map(v => [r1(v.position.x), r1(v.position.y), r1(v.diameter)]),
  traces: (board.traces ?? []).map(t => [r1(t.start.x), r1(t.start.y), r1(t.end.x), r1(t.end.y), r1(t.width), t.layer ?? 0, t.net]),
  pads: (board.pads ?? []).map(p => ({ b: [r1(p.bounds.minX), r1(p.bounds.minY), r1(p.bounds.maxX), r1(p.bounds.maxY)], side: p.side, shape: p.shape ?? 'rect', w: p.width && r1(p.width), h: p.height && r1(p.height), a: p.angleDeg ?? 0, drill: p.drill && r1(p.drill), net: p.net })),
  silk: (board.silkscreen ?? []).map(s => ({ side: s.side, pts: s.points.map(p => [r1(p.x), r1(p.y)]) })),
  rects, texts,
  parts: board.parts.map(p => ({
    name: p.name, side: p.side, package: p.meta?.package ?? '', value: p.meta?.value ?? '',
    pins: p.pins.map(q => [r1(q.position.x), r1(q.position.y), q.net, q.number]),
    est: { pkg: estimatePart(p, { usePackage: true }), pins: estimatePart(p, { usePackage: false }) },
  })),
};
writeFileSync(outFile, `window.BOARD3D = ${JSON.stringify(out)};\n`);
const fam = (k: 'pkg' | 'pins') => out.parts.reduce<Record<string, number>>((a, p) => { a[p.est[k].family] = (a[p.est[k].family] ?? 0) + 1; return a; }, {});
const agree = out.parts.filter(p => p.est.pkg.family === p.est.pins.family && p.est.pkg.size === p.est.pins.size).length;
console.log(`${name}: ${out.parts.length} parts, ${out.traces.length} traces, ${rects.length} silk rects, ${texts.length} texts, ${holes.length} plain holes`);
console.log('with package :', JSON.stringify(fam('pkg')));
console.log('pins only    :', JSON.stringify(fam('pins')));
console.log(`agree (family + size): ${agree}/${out.parts.length}`);
for (const p of out.parts) if (p.est.pkg.family !== p.est.pins.family || p.est.pkg.size !== p.est.pins.size) console.log(`  ${p.name.padEnd(6)} pkg=${p.est.pkg.family}/${p.est.pkg.size ?? ''}  pins=${p.est.pins.family}/${p.est.pins.size ?? ''}  — ${p.est.pins.why}`);
