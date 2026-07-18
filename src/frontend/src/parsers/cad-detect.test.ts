import { describe, it, expect } from 'vitest';
import '../parsers/index';
import { detectFormat } from './registry';
import { CADFormat } from './cad-format';
import { MentorNeutralFormat } from './mentor-neutral-format';

const enc = new TextEncoder();

const GENCAD_HEADER = '$HEADER\r\nGENCAD 2050\nUSER "GOCCANH_VIETNAM - Licensed"\nDRAWING DAX3ACMBAF0 X3AC Rev F.brd\n$ENDHEADER\n';
const MENTOR_HEADER = 'BOARD board1 OFFSET x: 0.0 y: 0.0\nB_UNITS MILS\n';

describe('CAD (GenCAD) content detection', () => {
  it('detects a clean GenCAD header', () => {
    expect(CADFormat.detect(enc.encode(GENCAD_HEADER))).toBe(true);
  });

  it('detects a GenCAD header prefixed with NUL bytes (GOCCANH/Honhan converter output)', () => {
    // Real-world sample: "DAX3ACMBAF0 X3AC Rev F.CAD" starts with 00 0A before $HEADER
    // and sprinkles NUL bytes between sections.
    expect(CADFormat.detect(enc.encode('\x00\n' + GENCAD_HEADER))).toBe(true);
  });

  it('routes a NUL-prefixed GenCAD file to CAD, not the Mentor .cad fallback', () => {
    const fmt = detectFormat(enc.encode('\x00\n' + GENCAD_HEADER));
    expect(fmt?.id).toBe('CAD');
  });

  it('does not claim Mentor neutral files', () => {
    expect(CADFormat.detect(enc.encode(MENTOR_HEADER))).toBe(false);
    expect(MentorNeutralFormat.detect(enc.encode(MENTOR_HEADER))).toBe(true);
  });

  it('does not claim arbitrary NUL-prefixed binaries', () => {
    expect(CADFormat.detect(new Uint8Array([0, 0, 0, 1, 2, 3, 4, 5]))).toBe(false);
  });
});
