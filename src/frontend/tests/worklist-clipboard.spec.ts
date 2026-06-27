/**
 * Unit coverage for the worklist clipboard format (parts + nets + measurements).
 * Pure round-trip — imports the browser-free module directly, no page needed.
 */
import { test, expect } from '@playwright/test';
import {
  formatWorklist,
  parseWorklistText,
  type ClipWorklist,
} from '../src/store/worklist-clipboard';

const sample: ClipWorklist = {
  name: 'A2179 logic',
  note: '3V3 rail short, isolating\nsecond line',
  parts: [
    { refdes: 'C7100', mark: 'replaced', note: '', waterdamage: false },
    { refdes: 'U5000', mark: 'none', note: 'got hot', waterdamage: true },
  ],
  nets: [
    // multiple readings on one net (the point of the change)
    { netName: 'PP3V3_S5', mark: 'short', surge: true, note: 'short to GND', measurements: [{ kind: 'voltage', value: '0.81' }, { kind: 'diode', value: '0.000' }] },
    { netName: 'PPVIN', mark: 'solved', surge: false, note: '', measurements: [{ kind: 'voltage', value: '12.6' }] },
    { netName: 'PPBUS_G3H', mark: 'absent', surge: false, note: '', measurements: [] },
    { netName: 'PP1V8', mark: 'none', surge: false, note: '', measurements: [{ kind: 'resistance', value: '1.2k' }] },
  ],
};

test('worklist format matches the sectioned layout', () => {
  const text = formatWorklist(sample);
  expect(text.startsWith('-[A2179 logic]-\n')).toBe(true);
  expect(text).toContain('\n> 3V3 rail short, isolating\n');
  expect(text).toContain('\nParts\n');
  expect(text).toContain('\n  C7100 [replaced]\n');
  expect(text).toContain('\n  U5000 [water] (got hot)\n');
  expect(text).toContain('\nNets\n');
  expect(text).toContain('\n  PP3V3_S5 [short] surge — V 0.81, Diode 0.000 (short to GND)\n');
  expect(text).toContain('\n  PPVIN [solved] — V 12.6\n');
  expect(text).toContain('\n  PPBUS_G3H [absent]\n');
  expect(text.endsWith('\n  PP1V8 — Ω 1.2k')).toBe(true);
});

test('worklist copy ↔ paste is lossless (parts + nets + measurements)', () => {
  const back = parseWorklistText(formatWorklist(sample));
  expect(back).not.toBeNull();
  expect(back).toEqual(sample);
});

test('legacy flat copies still import as parts (back-compat)', () => {
  const old = '-[legacy]-\n> a note\nC1[replaced]\nU2 (hot)\nR3[cleaned]';
  const p = parseWorklistText(old);
  expect(p).not.toBeNull();
  expect(p!.name).toBe('legacy');
  expect(p!.note).toBe('a note');
  expect(p!.parts.map(x => x.refdes)).toEqual(['C1', 'U2', 'R3']);
  expect(p!.parts[0].mark).toBe('replaced');
  expect(p!.nets).toEqual([]);
});

test('arbitrary text is rejected', () => {
  expect(parseWorklistText('not a worklist\nrandom prose here\nmore lines\nand more\nand more')).toBeNull();
  expect(parseWorklistText('')).toBeNull();
});
