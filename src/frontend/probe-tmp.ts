import fs from 'node:fs';
import { parseXZZ } from './src/parsers/xzz-parser';
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  const b = parseXZZ(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const pins = b.parts.flatMap(p => p.pins);
  const caps = pins.filter(p => p.padShape === 'round' && p.padWidth && p.padHeight && p.padWidth !== p.padHeight);
  const hist = new Map<string, number>();
  for (const p of caps) hist.set(`${p.padWidth}x${p.padHeight}`, (hist.get(`${p.padWidth}x${p.padHeight}`) ?? 0) + 1);
  const th = b.parts.filter(p => p.type === 'throughhole');
  const drilled = pins.filter(p => p.drill);
  const drillPads = b.pads.filter(p => p.drill);
  console.log(`\n>> ${f.split('/').pop()}`);
  console.log(`   parts=${b.parts.length} throughhole=${th.length} (${th.slice(0,6).map(p=>p.name).join(',')})`);
  console.log(`   pins w/ drill=${drilled.length}  pads w/ drill=${drillPads.length}  oblong pads surviving=${caps.length}`);
  console.log(`   surviving capsules: ${[...hist].sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>`${k}×${v}`).join(' ')}`);
  const slots = drillPads.filter(p => p.shape === 'round' && p.width !== p.height);
  if (slots.length) console.log(`   SLOTS: ${slots.length} e.g. ${slots.slice(0,3).map(p=>`${p.width}x${p.height} drill ${p.drill}`).join(', ')}`);
}
