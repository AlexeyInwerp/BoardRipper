/**
 * 10-orphan-parents.ts — the 975 v17 segments that no v15 ETCH track chain
 * yields have v15 segment records whose +0x0C parent the candidate index does
 * not know (700 of them) or resolves to odd headers ([0x64]/[0x94] with class
 * byte 0x91). Look at where those parent keys actually live in the file.
 *
 * Run: cd src/frontend && npx vite-node ../../scripts/allegro-v15-copper-probe/10-orphan-parents.ts
 */
import { loadV15, buildIndex, hex, dump, histogram, u32, i32, findAll } from './lib';

const buf = loadV15();
const ix = buildIndex(buf);
const SAMPLES = [0x00561ac8, 0x0056c860, 0x0056fb18, 0x005714b4, 0x00578f3c, 0x005beaf8];
const parentSites = new Map<string, number>();
for (const s of SAMPLES) {
  const parent = u32(buf, s + 0x0c), next = u32(buf, s + 0x08), key = u32(buf, s + 4);
  const pat = Buffer.alloc(4); pat.writeUInt32LE(parent, 0);
  const hits = findAll(buf, pat, 10);
  console.log(`\nsegment at ${hex(s)} key ${hex(key)} next ${hex(next)} parent ${hex(parent)} (parent − LL addend = ${hex(parent - ix.globalAddend)}); parent value occurs at: ${hits.map(h => hex(h)).join(' ')}`);
  console.log(dump(buf, s, 0x28, s));
  for (const h of hits.slice(0, 3)) {
    // is it a key position (+4 of a header)?
    const r = h - 4;
    console.log(`  at ${hex(h)}: preceding word ${buf.subarray(r, r + 4).toString('hex')} — ${buf[r] === 0 ? `header-shaped, type byte 0x${buf[r + 1].toString(16)} (=0x${(buf[r + 1] >> 2).toString(16)} if ×4)` : 'not a header position'}`);
    console.log(dump(buf, Math.max(0, r - 16), 0x50, Math.max(0, r - 16)));
  }
  // walk this segment's chain forward via +0x08 until the parent key comes back
  let k = next; const types: string[] = []; const seen = new Set<number>();
  for (let i = 0; i < 100 && k !== 0 && k !== parent && !seen.has(k); i++) { seen.add(k); const r = ix.recAnyType(k); if (!r) { types.push('unres'); break; } types.push(r.b1.toString(16)); k = u32(buf, r.off + 8); }
  console.log(`  chain via +0x08: ${types.join(' → ')}${k === parent ? ' → parent' : ''}`);
}
// Census: all segment records whose parent is not in the index — what does the word before the parent's key look like?
let unres = 0; const siteTypes = new Map<string, number>();
for (const t of [0x54, 0x58, 0x5c]) for (const o of ix.ofType.get(t) ?? []) {
  const parent = u32(buf, o + 0x0c);
  if (ix.recAnyType(parent)) continue;
  unres++;
  if (unres > 3000) continue;
  const pat = Buffer.alloc(4); pat.writeUInt32LE(parent, 0);
  const hits = findAll(buf, pat, 5);
  const tag = hits.map(h => buf[h - 4] === 0 ? `T${buf[h - 3].toString(16)}` : 'x').join(',');
  siteTypes.set(tag, (siteTypes.get(tag) ?? 0) + 1);
}
console.log(`\nsegment records with unresolved parent: ${unres}; header type bytes preceding the parent-key occurrences (first 3000):`, [...siteTypes].sort((a, b) => b[1] - a[1]).slice(0, 10));

// Pool census for ETCH tracks regardless of the addend window: every `0x 14 06 xx`
// header (byte 0 ∈ {0, 4, 0x10}) in the file, binned by key − offset − LL addend.
const pools = new Map<string, number>(); let total = 0;
for (let off = 0; off + 8 <= buf.length; off += 4) {
  if (buf[off + 1] !== 0x14 || buf[off + 2] !== 6 || (buf[off] & ~0x14) !== 0) continue;
  const d = u32(buf, off + 4) - off - ix.globalAddend;
  const bin = `${d < 0 ? '-' : '+'}${hex(Math.abs(Math.round(d / 0x100000)) * 0x100000, 8)}`;
  pools.set(bin, (pools.get(bin) ?? 0) + 1); total++;
}
console.log(`\nall ETCH track headers in the file: ${total}; key − offset − LL addend, 1 MB bins:`, [...pools].sort((a, b) => b[1] - a[1]));
