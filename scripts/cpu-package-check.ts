/**
 * Which large BGAs on the sample boards resolve to a known package record, through the estimator itself.
 *   cd src/frontend && npx vite-node ../../scripts/cpu-package-check.ts -- ../../samples/<file> [...]
 */
import { readFileSync } from 'fs';
import { parseBoardFile } from '../src/frontend/src/parsers';
import { estimatePart } from '../src/frontend/src/store/package-estimate';
for (const f of process.argv.slice(2).filter(a => a !== '--')) {
  const buf = readFileSync(f); const board = await parseBoardFile(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, f);
  for (const part of board.parts) {
    if (part.pins.length < 300) continue;
    for (const usePackage of [true, false]) {
      const e = estimatePart(part, { usePackage });
      console.log(`${f.split('/').pop()}\t${part.name}\t${part.pins.length}\t${usePackage ? 'pkg ' : 'pins'}\t${e.family}\t${e.pkg ?? '—'}\t${e.L}×${e.W}×${e.H}\trot ${e.rotDeg.toFixed(0)}\t${e.why}`);
    }
  }
}
