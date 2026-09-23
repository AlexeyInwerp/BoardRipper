import { describe, it, expect } from 'vitest';
import { parseTestPadBlock } from './xzz-parser';

/** A top-level 0x09 payload: pad number, x, y, drill, angle, name, three pad
 *  records, 5-byte terminator, net index, then optionally the reading
 *  section. Shaped like IPhone12 ProMax pad "76" (70 bytes, net 955). */
function testPad(net: number, reading?: string): Uint8Array {
  const name = new TextEncoder().encode('76');
  const bytes: number[] = [];
  const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(76); u32(5_000_000); u32(6_000_000); u32(0); u32(0);
  u32(name.length); bytes.push(...name);
  for (let i = 0; i < 3; i++) { u32(200_000); u32(200_000); bytes.push(1); }
  u32(0); bytes.push(0);
  u32(net);
  if (reading !== undefined) {
    const r = new TextEncoder().encode(reading);
    u32(r.length); bytes.push(...r, 0, 0, 0, 0);
  }
  return new Uint8Array(bytes);
}

describe('parseTestPadBlock', () => {
  it('reads the net index when the block ends with it', () => {
    expect(parseTestPadBlock(testPad(955))?.netIndex).toBe(955);
  });

  it('reads the net index before an empty reading section, not the last 4 bytes', () => {
    const block = testPad(955, '');
    expect(block.length).toBeGreaterThan(62);
    expect(parseTestPadBlock(block)?.netIndex).toBe(955);
  });

  it('reads the net index before a reading such as "OL"', () => {
    expect(parseTestPadBlock(testPad(1522, 'OL'))?.netIndex).toBe(1522);
  });

  it('keeps the position', () => {
    expect(parseTestPadBlock(testPad(1))).toMatchObject({ x: 500, y: 600 });
  });

  it('reads the name and first pad record, as for a pin', () => {
    expect(parseTestPadBlock(testPad(955, 'OL'))).toMatchObject({
      name: '76', padW: 20, padH: 20, padShape: 'round', drill: 0,
    });
  });
});
