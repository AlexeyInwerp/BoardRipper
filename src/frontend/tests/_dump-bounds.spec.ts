import { test } from '@playwright/test';
import fs from 'fs';
test('dump bounds + trace ranges', async () => {
  const SAMPLE = '/Users/besitzer/Desktop/Boardviewer/samples/altium/ESD_GW1N_4L.PcbDoc';
  test.skip(!fs.existsSync(SAMPLE));
  const { AltiumPcbFormat } = await import('../src/parsers/altium/altium-pcb-format');
  const board = await AltiumPcbFormat.parse(fs.readFileSync(SAMPLE).buffer as ArrayBuffer);
  console.log('bounds', JSON.stringify(board.bounds));
  console.log('outline first/last', board.outline[0], board.outline.at(-1));
  // Range of trace endpoints
  let txMin=Infinity, txMax=-Infinity, tyMin=Infinity, tyMax=-Infinity, nonFinite=0;
  for (const t of board.traces ?? []) {
    for (const p of [t.start, t.end]) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { nonFinite++; continue; }
      if (p.x < txMin) txMin = p.x;
      if (p.x > txMax) txMax = p.x;
      if (p.y < tyMin) tyMin = p.y;
      if (p.y > tyMax) tyMax = p.y;
    }
  }
  console.log('traces range x', txMin, txMax, 'y', tyMin, tyMax, 'nonFinite endpoints:', nonFinite);
  // Range of parts
  let pxMin=Infinity, pxMax=-Infinity, pyMin=Infinity, pyMax=-Infinity;
  for (const p of board.parts) {
    pxMin = Math.min(pxMin, p.bounds.minX);
    pxMax = Math.max(pxMax, p.bounds.maxX);
    pyMin = Math.min(pyMin, p.bounds.minY);
    pyMax = Math.max(pyMax, p.bounds.maxY);
  }
  console.log('parts range x', pxMin, pxMax, 'y', pyMin, pyMax);
});
