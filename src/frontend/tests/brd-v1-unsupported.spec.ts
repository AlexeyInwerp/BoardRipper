import { test, expect } from '@playwright/test';

/**
 * "BRD_V1.0" is a proprietary, encrypted .brd container we don't support
 * (origin tool unconfirmed). Detection must route it to the BRD parser so the
 * user gets a clear "proprietary, encoded format" message — not the misleading
 * "BDV file may be corrupt" error that resulted when content-detection found no
 * match and the .brd extension fallback handed the bytes to the BDV parser.
 */
test.describe('BRD_V1.0 unsupported container', () => {
  function makeBrdV1(): ArrayBuffer {
    const bytes = new Uint8Array(64);
    bytes.set([0x42, 0x52, 0x44, 0x5F, 0x56, 0x31, 0x2E, 0x30]); // "BRD_V1.0"
    for (let i = 16; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff; // pseudo-encrypted body
    return bytes.buffer;
  }

  test('content-detection routes BRD_V1.0 to the BRD parser', async () => {
    const { detectFormat } = await import('../src/parsers/registry');
    await import('../src/parsers/index'); // register formats
    const header = new Uint8Array(makeBrdV1(), 0, 16);
    expect(detectFormat(header)?.id).toBe('BRD');
  });

  test('open path throws the proprietary-format message, not "corrupt"', async () => {
    const { parseBoardFile } = await import('../src/parsers/index');
    let msg = '';
    try {
      await parseBoardFile(makeBrdV1(), 'x.brd');
    } catch (e: any) {
      msg = e.message;
    }
    expect(msg).toContain('BRD_V1.0');
    expect(msg).toContain('proprietary');
    expect(msg).not.toContain('corrupt');
  });
});
