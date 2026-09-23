import { describe, it, expect } from 'vitest';
import { decodeXzzText } from './xzz-parser';

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(parts.flatMap(p => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)));

describe('decodeXzzText', () => {
  it('decodes GB2312 that is not valid UTF-8', () => {
    // 故障点, the column header iPhoneXSMAX Common problems stores at 0x132.
    expect(decodeXzzText(bytes([0xB9, 0xCA, 0xD5, 0xCF, 0xB5, 0xE3]))).toBe('故障点');
  });

  it('decodes GB2312 that happens to be valid UTF-8', () => {
    // A part label on DJI T40 PP00266604: 丝印 is CB BF D3 A1, which UTF-8
    // reads as "˿ӡ"; 芯片 is D0 BE C6 AC, which UTF-8 reads as "оƬ".
    expect(decodeXzzText(bytes('1N4148 W', [0xCB, 0xBF, 0xD3, 0xA1], 'T4'))).toBe('1N4148 W丝印T4');
    expect(decodeXzzText(bytes('USB', [0xD0, 0xBE, 0xC6, 0xAC]))).toBe('USB芯片');
  });

  it('keeps genuine UTF-8, including symbols GB18030 would also accept', () => {
    // A footprint on IQOO15 Ultra: × is C3 97, valid GB18030 as 脳.
    expect(decodeXzzText(bytes('BGA-6', [0xC3, 0x97], '6-36'))).toBe('BGA-6×6-36');
    expect(decodeXzzText(new TextEncoder().encode('10KΩ 故障点'))).toBe('10KΩ 故障点');
  });

  it('decodes a GB2312 Ω, which is not valid UTF-8', () => {
    expect(decodeXzzText(bytes('10K', [0xA6, 0xB8]))).toBe('10KΩ');
  });

  it('leaves ASCII alone', () => {
    expect(decodeXzzText(new TextEncoder().encode('PP_VDD_BOOST'))).toBe('PP_VDD_BOOST');
  });
});
