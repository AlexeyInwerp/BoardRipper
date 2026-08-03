/** Bakes the HDR focus-glow sprite: a radial white gradient whose centre sits
 *  at PEAK_NITS and falls to black at the edge, PQ-encoded and tagged
 *  CICP 9/16/0 (BT.2020 primaries / PQ transfer / identity matrix).
 *
 *  MAINTAINER TOOL — not part of any build. avifenc is not in CI or the Docker
 *  image; the generated .avif is committed. Re-run only when changing the
 *  gradient shape or peak.
 *
 *  Usage:  node scripts/make-hdr-glow.ts     (Node 25 strips the types natively)
 *  Needs:  brew install libavif
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pqEncode } from '../src/frontend/src/renderer/pq.ts';

const SIZE = 256;
const PEAK_NITS = 4000;   // centre luminance; real output is capped by display headroom
const FLOOR_NITS = 200;   // ~SDR white — the dimmest frame, where the SDR highlight takes over
const FRAMES = 7;         // luminance ladder used to fade WITHOUT opacity (see below)
const OUT = 'src/frontend/public/hdr-glow.avif';
const TMP = 'src/frontend/public/.hdr-glow-src.png';

/** Opacity compositing flattens HDR back to SDR (measured 2026-08-04 on the
 *  probe: swatch 4 == swatch 1). So the pulse cannot fade with alpha. Instead we
 *  bake a ladder of frames at decreasing PEAK luminance and swap the sprite —
 *  a real luminance fade rather than an alpha fade. Geometric spacing keeps the
 *  perceived steps even. */
function frameNits(i: number): number {
  if (FRAMES <= 1) return PEAK_NITS;
  const t = i / (FRAMES - 1);
  return PEAK_NITS * Math.pow(FLOOR_NITS / PEAK_NITS, t);
}

const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Build a 16-bit PNG of the PQ-encoded radial falloff at a given peak. */
function writeSourcePng(peakNits: number): void {
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 6)); // per row: filter byte + 3ch * 2B
  let p = 0;
  const r = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const dx = x - r + 0.5, dy = y - r + 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) / r);
      // smoothstep falloff — same easing family as the existing dark halo
      const t = 1 - d;
      const falloff = t <= 0 ? 0 : t * t * (3 - 2 * t);
      const v = Math.round(pqEncode(peakNits * falloff) * 65535);
      for (let c = 0; c < 3; c++) { raw.writeUInt16BE(v, p); p += 2; }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 16;  // bit depth
  ihdr[9] = 2;   // colour type: truecolour RGB
  writeFileSync(TMP, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Encode the staged PNG to AVIF with PQ CICP.
 *  9  = BT.2020 primaries
 *  16 = SMPTE ST 2084 (PQ) transfer
 *  0  = identity matrix (RGB, no YUV conversion loss on a synthetic gradient) */
function encodeAvif(out: string): void {
  execFileSync('avifenc', [
    '--cicp', '9/16/0',
    '--range', 'full',
    '--depth', '10',
    '--yuv', '444',
    '--speed', '0',
    TMP, out,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
}

for (let i = 0; i < FRAMES; i++) {
  const nits = frameNits(i);
  writeSourcePng(nits);
  encodeAvif(`src/frontend/public/hdr-glow-${i}.avif`);
  // Frame 0 doubles as the canonical single-sprite asset.
  if (i === 0) encodeAvif(OUT);
  console.log(`  frame ${i}: peak ${Math.round(nits)} nits`);
}
unlinkSync(TMP);
console.log(`wrote ${FRAMES} frames + ${OUT}`);
