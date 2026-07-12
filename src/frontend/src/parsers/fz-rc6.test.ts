import { describe, it, expect } from 'vitest';
import { rc6Decrypt } from './fz-parser';

const RC6_ROUNDS = 20;

function rotl32(val: number, shift: number): number {
  shift &= 31;
  return ((val << shift) | (val >>> (32 - shift))) >>> 0;
}
function readU32LE(buf: Uint8Array, off: number): number {
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** Reference: verbatim copy of the pre-optimization implementation. */
function rc6DecryptReference(data: Uint8Array, key: Uint32Array): void {
  const r = RC6_ROUNDS;
  const ibuf = new Uint8Array(16);
  let A = 0, B = 0, C = 0, D = 0;
  for (let pos = 0; pos < data.length; pos++) {
    B = (B + key[0]) >>> 0;
    D = (D + key[1]) >>> 0;
    for (let i = 1; i <= r; i++) {
      const t = rotl32(Math.imul(B, (2 * B + 1) >>> 0) >>> 0, 5);
      const u = rotl32(Math.imul(D, (2 * D + 1) >>> 0) >>> 0, 5);
      A = (rotl32(A ^ t, u) + key[2 * i]) >>> 0;
      C = (rotl32(C ^ u, t) + key[2 * i + 1]) >>> 0;
      const tmpA = A;
      A = B; B = C; C = D; D = tmpA;
    }
    A = (A + key[2 * r + 2]) >>> 0;
    C = (C + key[2 * r + 3]) >>> 0;
    const encrypted = data[pos];
    data[pos] = (encrypted ^ (A & 0xFF)) & 0xFF;
    for (let j = 0; j < 15; j++) ibuf[j] = ibuf[j + 1];
    ibuf[15] = encrypted;
    A = readU32LE(ibuf, 0);
    B = readU32LE(ibuf, 4);
    C = readU32LE(ibuf, 8);
    D = readU32LE(ibuf, 12);
  }
}

/** Deterministic PRNG (mulberry32-style, full-range uint32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0);
  };
}

describe('rc6Decrypt parity', () => {
  it('matches the reference on random data at window-edge sizes', () => {
    for (const size of [0, 1, 15, 16, 17, 31, 33, 1000, 65536]) {
      const r = rng(size + 7);
      const key = new Uint32Array(44);
      for (let i = 0; i < 44; i++) key[i] = r();
      const src = new Uint8Array(size);
      for (let i = 0; i < size; i++) src[i] = r() & 0xFF;
      const a = src.slice(), b = src.slice();
      rc6Decrypt(a, key);
      rc6DecryptReference(b, key);
      expect(a, `size=${size}`).toEqual(b);
    }
  });
});
