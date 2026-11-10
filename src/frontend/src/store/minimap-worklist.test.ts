import { describe, it, expect } from 'vitest';
import { worklistStepKeys, currentWorklistKey, worklistStep } from './minimap-worklist';
import type { Worklist } from './worklist-store';

const wl = {
  id: 'w', name: 'w', board: '', tags: [], createdAt: 0, updatedAt: 0,
  entries: [
    { partIndex: 0, refdes: 'U1', mark: 'none', note: '' },
    { partIndex: -1, refdes: 'X9', mark: 'none', note: '', unresolved: true },
    { partIndex: 2, refdes: 'C3', mark: 'cleaned', note: '' },
  ],
  netEntries: [{ netName: 'PP3V3', mark: 'none', note: '' }],
} as unknown as Worklist;

describe('minimap worklist stepping', () => {
  const keys = worklistStepKeys(wl);
  it('parts then nets, absent rows skipped', () => {
    expect(keys).toEqual(['p:U1', 'p:C3', 'n:PP3V3']);
  });
  it('the current row is the selected part, else the lit net', () => {
    expect(currentWorklistKey(keys, 'c3', null)).toBe('p:C3');
    expect(currentWorklistKey(keys, 'R1', 'pp3v3')).toBe('n:PP3V3');
    expect(currentWorklistKey(keys, 'R1', null)).toBeNull();
  });
  it('steps without wrapping; from nothing › starts at the first, ‹ at the last', () => {
    expect(worklistStep(keys, null, 1)).toBe('p:U1');
    expect(worklistStep(keys, null, -1)).toBe('n:PP3V3');
    expect(worklistStep(keys, 'p:C3', 1)).toBe('n:PP3V3');
    expect(worklistStep(keys, 'n:PP3V3', 1)).toBeNull();
    expect(worklistStep(keys, 'p:U1', -1)).toBeNull();
    expect(worklistStep([], null, 1)).toBeNull();
  });
});
