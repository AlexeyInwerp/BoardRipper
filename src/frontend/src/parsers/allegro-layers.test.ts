import { describe, it, expect } from 'vitest';
import { etchSubclassBase, etchLayerIndex } from './allegro/allegro-assembler';
import { AllegroStream } from './allegro/allegro-stream';
import { looksLikeVersionString } from './allegro/allegro-header';

/**
 * ETCH subclass → layer index.
 *
 * Regression for Compal LA-P161P (Allegro v18.0.0), whose etch stackup is
 * numbered 0-based: the old fixed `subclass - 1` mapped subclass 0 AND 1 both
 * to layer 0, merging top and bottom copper into a single trace container.
 */
describe('etch subclass rebasing', () => {
  it('leaves a 1-based stackup exactly where the old rule put it', () => {
    const base = etchSubclassBase([1, 2, 3, 4, 5, 6]);
    expect(base).toBe(1);
    expect([1, 2, 6].map((s) => etchLayerIndex(s, base))).toEqual([0, 1, 5]);
  });

  it('keeps a 0-based stackup (LA-P161P) split across layers', () => {
    const base = etchSubclassBase([0, 1]);
    expect(base).toBe(0);
    expect(etchLayerIndex(0, base)).toBe(0); // TOP
    expect(etchLayerIndex(1, base)).toBe(1); // BOTTOM — was 0 before the fix
  });

  it('does not care what order the subclasses arrive in', () => {
    expect(etchSubclassBase([5, 3, 1, 9])).toBe(1);
  });

  it('falls back to 0 when a file has no etch tracks', () => {
    expect(etchSubclassBase([])).toBe(0);
  });

  it('never returns a negative layer index', () => {
    expect(etchLayerIndex(0, 1)).toBe(0);
  });
});

/**
 * v18 header: 4 optional linked-list pairs sit between x35End and the 60-byte
 * ASCII version string on some sub-versions (v18.0.2 / LA-E331P) but not
 * others (v18.0.0 / LA-P161P). Presence is probed from the bytes.
 */
describe('looksLikeVersionString', () => {
  const streamOf = (bytes: number[]) => new AllegroStream(new Uint8Array(bytes).buffer);

  it('accepts the start of an ASCII version string', () => {
    const ascii = [...'all424109/25/'].map((c) => c.charCodeAt(0));
    expect(looksLikeVersionString(streamOf(ascii))).toBe(true);
  });

  it('rejects a linked-list pair whose small u32 head has NUL upper bytes', () => {
    expect(looksLikeVersionString(streamOf([0x7d, 0x00, 0x00, 0x00, 0, 0, 0, 0]))).toBe(false);
  });

  it('does not move the stream position', () => {
    const s = streamOf([0x41, 0x42, 0x43, 0x44]);
    s.seek(0);
    looksLikeVersionString(s);
    expect(s.position).toBe(0);
    const s2 = streamOf([0x7d, 0x00, 0x00, 0x00]);
    looksLikeVersionString(s2);
    expect(s2.position).toBe(0);
  });

  it('rejects a truncated stream', () => {
    expect(looksLikeVersionString(streamOf([0x41, 0x42]))).toBe(false);
  });
});
