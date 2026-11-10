import { describe, it, expect } from 'vitest';
import { looseTextMatch, matchWorklist, suggestWorklists, boardKeys } from './worklist-match';

const keys = boardKeys({
  fileName: '820-02016-07_MacBook Air (M1, A2337).pcb',
  boardNumber: '820-02016',
  facts: { brand: 'Apple', family: 'MacBook Air', model: 'MacBook Air (M1, 2020)', model_number: 'A2337', aliases: ['J313'] },
});
const wl = (id: string, board: string, tags: string[] = [], updatedAt = 0) => ({ id, board, tags, updatedAt });

describe('looseTextMatch', () => {
  it('equal or containing, separators and case ignored', () => {
    expect(looseTextMatch('820-02016', '82002016')).toBe(true);
    expect(looseTextMatch('02016', '820-02016-07_MacBook Air')).toBe(true);
    expect(looseTextMatch('a2337', 'A2337')).toBe(true);
  });
  it('a short fragment does not match by containment', () => {
    expect(looseTextMatch('M1', 'MacBook Air (M1, 2020)')).toBe(false);
    expect(looseTextMatch('820', '820-02016')).toBe(false);
  });
});

describe('matchWorklist', () => {
  it('a board number is the strongest match', () => {
    expect(matchWorklist(keys, wl('a', '820-02016'))).toMatchObject({ weight: 3, key: { what: 'board number' } });
    expect(matchWorklist(keys, wl('b', 'J313'))).toMatchObject({ weight: 3, key: { what: 'board alias' } });
  });
  it('a partial board name reaches the board through its file name', () => {
    expect(matchWorklist(keys, wl('a', '02016'))!.weight).toBeGreaterThanOrEqual(2);
  });
  it('tags match like the board name, and say so', () => {
    const m = matchWorklist(keys, wl('a', 'something else', ['A2337']))!;
    expect(m).toMatchObject({ weight: 2, byTag: true, via: 'A2337' });
    expect(matchWorklist(keys, wl('b', '', ['Apple']))!.weight).toBe(1);   // brand only
  });
  it('an unrelated worklist does not match', () => {
    expect(matchWorklist(keys, wl('a', '820-01700', ['A2141', 'water']))).toBeNull();
  });
});

describe('suggestWorklists', () => {
  it('strongest first, most recent first within a weight', () => {
    const out = suggestWorklists(keys, [
      wl('family', '', ['Apple'], 99),
      wl('old', '820-02016', [], 1),
      wl('new', '820-02016', [], 50),
      wl('none', 'X', [], 100),
    ]);
    expect(out.map(s => s.worklist.id)).toEqual(['new', 'old', 'family']);
  });
});

describe('boardKeys', () => {
  it('keeps the strongest weight for duplicates and works from a file name alone', () => {
    const k = boardKeys({ fileName: '820-02016.bvr', boardNumber: '820-02016' });
    expect(k).toEqual([{ text: '820-02016', weight: 3, what: 'board number' }]);
  });
});
