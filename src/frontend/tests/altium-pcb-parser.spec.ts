import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/altium');
const SAMPLE_PCB = path.join(SAMPLES_DIR, 'PCB.PcbDoc');
const SAMPLE_ESD = path.join(SAMPLES_DIR, 'ESD_GW1N_4L.PcbDoc');

test.describe('Altium PCB Parser — Phase 1', () => {
  test('cfb dependency is loadable', async () => {
    const cfb = await import('cfb');
    expect(typeof cfb.read).toBe('function');
    expect(typeof cfb.find).toBe('function');
  });

  test('samples are present (informational)', () => {
    test.skip(!fs.existsSync(SAMPLE_PCB), 'samples/altium/PCB.PcbDoc missing — local-only file');
    expect(fs.statSync(SAMPLE_PCB).size).toBeGreaterThan(100_000);
    if (fs.existsSync(SAMPLE_ESD)) {
      expect(fs.statSync(SAMPLE_ESD).size).toBeGreaterThan(1_000_000);
    }
  });
});

test.describe('altium-units', () => {
  test('altiumToMils divides by 10000', async () => {
    const { altiumToMils } = await import('../src/parsers/altium/altium-units');
    expect(altiumToMils(254000)).toBe(25.4);
    expect(altiumToMils(0)).toBe(0);
    expect(altiumToMils(-100000)).toBe(-10);
  });

  test('altiumYToMils negates after scaling', async () => {
    const { altiumYToMils } = await import('../src/parsers/altium/altium-units');
    expect(altiumYToMils(254000)).toBe(-25.4);
    expect(altiumYToMils(-100000)).toBe(10);
    expect(altiumYToMils(0)).toBe(0);
  });

  test('altiumAngleToDegrees handles wraps', async () => {
    const { altiumAngleToDegrees } = await import('../src/parsers/altium/altium-units');
    expect(altiumAngleToDegrees(0)).toBe(0);
    expect(altiumAngleToDegrees(90)).toBe(90);
    expect(altiumAngleToDegrees(370)).toBe(10);
    expect(altiumAngleToDegrees(-10)).toBe(350);
  });
});

test.describe('altium-props', () => {
  test('parsePropBagText splits KEY=VALUE pairs', async () => {
    const { parsePropBagText } = await import('../src/parsers/altium/altium-props');
    const m = parsePropBagText('|RECORD=Component|NAME=R1|LAYER=TOP|');
    expect(m.get('RECORD')).toBe('Component');
    expect(m.get('NAME')).toBe('R1');
    expect(m.get('LAYER')).toBe('TOP');
    expect(m.size).toBe(3);
  });

  test('parsePropBagText handles empty values and leading/trailing pipes', async () => {
    const { parsePropBagText } = await import('../src/parsers/altium/altium-props');
    const m = parsePropBagText('|A=|B=2|');
    expect(m.get('A')).toBe('');
    expect(m.get('B')).toBe('2');
  });

  test('readPropBool returns booleans', async () => {
    const { readPropBool } = await import('../src/parsers/altium/altium-props');
    const m = new Map([['X', 'TRUE'], ['Y', 'FALSE'], ['Z', 'true']]);
    expect(readPropBool(m, 'X', false)).toBe(true);
    expect(readPropBool(m, 'Y', true)).toBe(false);
    expect(readPropBool(m, 'Z', false)).toBe(true);
    expect(readPropBool(m, 'MISSING', true)).toBe(true);
  });

  test('readPropInt / readPropFloat parse numerics with fallback', async () => {
    const { readPropInt, readPropFloat } = await import('../src/parsers/altium/altium-props');
    const m = new Map([['I', '42'], ['F', '3.14'], ['BAD', 'oops']]);
    expect(readPropInt(m, 'I', 0)).toBe(42);
    expect(readPropFloat(m, 'F', 0)).toBeCloseTo(3.14);
    expect(readPropInt(m, 'BAD', 7)).toBe(7);
    expect(readPropInt(m, 'MISSING', -1)).toBe(-1);
  });

  test('iterateRecords splits a length-prefixed text-stream blob', async () => {
    const { iterateRecords } = await import('../src/parsers/altium/altium-props');
    const r1 = '|RECORD=A|NAME=X|';
    const r2 = '|RECORD=A|NAME=Y|';
    const enc = new TextEncoder();
    const b1 = enc.encode(r1);
    const b2 = enc.encode(r2);
    const buf = new Uint8Array(4 + b1.length + 4 + b2.length);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, b1.length, true);
    buf.set(b1, 4);
    dv.setUint32(4 + b1.length, b2.length, true);
    buf.set(b2, 4 + b1.length + 4);
    const rows = [...iterateRecords(buf)].map(r => r.get('NAME'));
    expect(rows).toEqual(['X', 'Y']);
  });
});
