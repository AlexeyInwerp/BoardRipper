import { test, expect } from '@playwright/test';

/**
 * Mentor PADS Layout (PowerPCB) native binary `.pcb` files share the `.pcb`
 * extension with the supported XZZ boardview format but are an unrelated,
 * unsupported format (the native PADS design database). Detection must route
 * them to the XZZ parser so the user gets a clear "Mentor PADS Layout binary"
 * message — not the cryptic "XZZ: invalid header offsets" that resulted when
 * content-detection found no match and the `.pcb` extension fallback handed the
 * bytes to the XZZ parser, which XOR-mangled them and failed deep inside.
 * Canary real file: samples N7100.pcb / iphone4.pcb / ipad3.pcb.
 */
test.describe('Mentor PADS Layout binary .pcb (unsupported)', () => {
  // PADS binary signature: magic 00 FF 26 20 + six zero bytes (stable across all
  // observed samples), then a pseudo-random body.
  function makePadsBinary(): ArrayBuffer {
    const bytes = new Uint8Array(64);
    bytes.set([0x00, 0xff, 0x26, 0x20, 0, 0, 0, 0, 0, 0]);
    for (let i = 10; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    return bytes.buffer;
  }

  test('content-detection routes PADS binary to the XZZ parser', async () => {
    const { detectFormat } = await import('../src/parsers/registry');
    await import('../src/parsers/index'); // register formats
    const header = new Uint8Array(makePadsBinary(), 0, 16);
    expect(detectFormat(header)?.id).toBe('XZZ');
  });

  test('open path throws the clear PADS message, not "invalid header offsets"', async () => {
    const { parseBoardFile } = await import('../src/parsers/index');
    let msg = '';
    try {
      await parseBoardFile(makePadsBinary(), 'N7100.pcb');
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toMatch(/PADS/i);
    expect(msg).not.toContain('invalid header offsets');
  });

  test('a genuine XZZ header is unaffected (still detected as XZZ)', async () => {
    const { detectFormat } = await import('../src/parsers/registry');
    await import('../src/parsers/index');
    const xzz = new Uint8Array(32);
    xzz.set([...'XZZPCB'].map(c => c.charCodeAt(0))); // plain "XZZPCB" magic
    expect(detectFormat(xzz)?.id).toBe('XZZ');
  });
});
