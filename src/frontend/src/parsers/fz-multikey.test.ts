import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseFZ, FZKeyError } from './fz-parser';
import { parseFzKeyText } from '../store/fz-key-store';

/**
 * Multi-key selection (issue #25).
 *
 * ASRock `.cae` is the same container and cipher as ASUS `.fz` with a
 * different key, so `parseFZ` takes a LIST of candidate keys and probes each
 * against the file rather than trusting the extension. These tests pin that
 * behaviour using a real encrypted board plus a deliberately wrong key — the
 * CAE key itself is not in this repo (it is third-party material we do not
 * redistribute), so what is proven here is the selection, not that any
 * particular ASRock key works.
 */
const SAMPLE = path.resolve(__dirname, '../../../../samples/BROKEN/Acer N22Q22 - DAZGRMB2AC0.fz');
const ENV = path.resolve(__dirname, '../../.env.local');

function devKey(): Uint32Array | null {
  if (!fs.existsSync(ENV)) return null;
  const m = /VITE_FZ_KEY\s*=\s*"?([^"\n]+)"?/.exec(fs.readFileSync(ENV, 'utf8'));
  return m ? parseFzKeyText(m[1]) : null;
}

function load(): ArrayBuffer {
  const b = fs.readFileSync(SAMPLE);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const key = fs.existsSync(SAMPLE) ? devKey() : null;
const wrong = new Uint32Array(44).fill(0xdeadbeef);

describe.skipIf(!key)('parseFZ candidate-key selection', () => {
  it('finds the working key when it is not the first candidate', async () => {
    const board = await parseFZ(load(), [wrong, key!]);
    expect(board.parts.length).toBeGreaterThan(0);
  });

  it('finds it when it is first, and ignores the useless one after it', async () => {
    const board = await parseFZ(load(), [key!, wrong]);
    expect(board.parts.length).toBeGreaterThan(0);
  });

  it('still accepts a single key, not just a list', async () => {
    const board = await parseFZ(load(), key!);
    expect(board.parts.length).toBeGreaterThan(0);
  });

  it('throws FZKeyError(invalid) when no candidate decrypts the file', async () => {
    await expect(parseFZ(load(), [wrong])).rejects.toBeInstanceOf(FZKeyError);
    await expect(parseFZ(load(), [wrong])).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('throws FZKeyError(missing) when the list is empty', async () => {
    await expect(parseFZ(load(), [])).rejects.toMatchObject({ reason: 'missing' });
    await expect(parseFZ(load())).rejects.toMatchObject({ reason: 'missing' });
  });

  it('rejects malformed keys by length rather than trying them', async () => {
    await expect(parseFZ(load(), [new Uint32Array(43)])).rejects.toThrow(/exactly 44/);
  });
});
