import { describe, it, expect } from 'vitest';
import { normalizeStoredWorklistes, type BoardWorklistes } from './worklist-store';

/** Build a raw record as it might exist on disk, allowing fields the current
 *  type marks required to be absent (legacy blobs). */
function rawRecord(over: Record<string, unknown>): BoardWorklistes {
  return { key: 'k', fileName: 'f.brd', activeWorklistId: null, worklistes: [], updatedAt: 0, schemaVersion: 1, ...over } as BoardWorklistes;
}

describe('normalizeStoredWorklistes (Worklists catalog crash guard)', () => {
  it('returns [] for undefined / empty input', () => {
    expect(normalizeStoredWorklistes(undefined)).toEqual([]);
    expect(normalizeStoredWorklistes([])).toEqual([]);
  });

  it('back-fills a legacy worklist missing netEntries so `.length` is safe', () => {
    // Pre-nets-in-worklist record: `netEntries` absent on disk.
    const raw = [rawRecord({ worklistes: [{ id: 'w1', name: 'Old', entries: [{}, {}] }] })];
    const out = normalizeStoredWorklistes(raw as unknown as BoardWorklistes[]);
    const w = out[0].worklistes[0];
    expect(w.entries.length).toBe(2);
    expect(w.netEntries).toEqual([]);
    expect(w.netEntries.length).toBe(0); // the exact access that used to throw
  });

  it('back-fills a record whose `worklistes` array is absent', () => {
    const raw = [rawRecord({ worklistes: undefined })];
    const out = normalizeStoredWorklistes(raw as unknown as BoardWorklistes[]);
    expect(out[0].worklistes).toEqual([]);
  });

  it('leaves a well-formed modern record untouched in shape', () => {
    const raw = [rawRecord({ worklistes: [{ id: 'w1', name: 'New', entries: [{}], netEntries: [{}, {}] }] })];
    const w = normalizeStoredWorklistes(raw as unknown as BoardWorklistes[])[0].worklistes[0];
    expect(w.entries.length).toBe(1);
    expect(w.netEntries.length).toBe(2);
  });
});
