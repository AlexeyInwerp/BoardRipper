import { describe, it, expect } from 'vitest';
import {
  push, touchCamera, stepIndex, moveCursor, removeEntry, listed, patchCursor,
  EMPTY_STATE, DEFAULT_LAYERS, NAV_HISTORY_CAP,
  type NavHistoryState, type NavVisit, type BoardPlace, type NavLayers,
} from './nav-history';

/**
 * The reducer is pure, so the rules of
 * docs/specs/2026-09-29-navigation-history-design.md §3 are pinned here one
 * by one: the jumplist re-anchor, the departure camera, the collapses, the
 * layer-aware step.
 */

const board = (part: string, extra: Partial<BoardPlace> = {}): BoardPlace =>
  ({ kind: 'board', tabId: 1, fileKey: 'a.brd:1:1', fileName: 'a.brd', part, ...extra });

const click = (part: string, at: number, extra: Partial<BoardPlace> = {}): NavVisit =>
  ({ cause: 'click', place: board(part, extra), at });

const cam = (x: number) => ({ x, y: 0, scaleX: 1, scaleY: 1 });

const ALL: NavLayers = { click: true, lookup: true, search: true, view: true };

function walk(visits: NavVisit[], state: NavHistoryState = EMPTY_STATE): NavHistoryState {
  return visits.reduce((s, v) => push(s, v), state);
}

const parts = (s: NavHistoryState) => s.entries.map(e => (e.place as BoardPlace | null)?.part ?? e.query?.text ?? '∅');

describe('push', () => {
  it('appends and moves the cursor to the end', () => {
    const s = walk([click('U1', 1), click('U2', 2), click('U3', 3)]);
    expect(parts(s)).toEqual(['U1', 'U2', 'U3']);
    expect(s.cursor).toBe(2);
    expect(s.entries.map(e => e.id)).toEqual([1, 2, 3]);
    expect(s.entries[0].label).toBe('U1');
  });

  it('re-anchors instead of truncating when the cursor is not at the end (§3.1)', () => {
    let s = walk([click('A', 1), click('B', 2), click('C', 3), click('D', 4)]);
    s = moveCursor(s, 1);                         // two backs → on B
    s = push(s, click('E', 5));
    expect(parts(s)).toEqual(['A', 'B', 'C', 'D', 'B', 'E']);
    expect(s.entries[4].revisit).toBe(true);
    expect(s.cursor).toBe(5);
    // back from E is B, then D, C, B, A — the full path
    const backs: string[] = [];
    let i = s.cursor;
    while ((i = stepIndex({ ...s, cursor: i }, -1, ALL)) >= 0) backs.push(parts(s)[i]);
    expect(backs).toEqual(['B', 'D', 'C', 'B', 'A']);
  });

  it('writes the departure camera into the entry under the cursor (§3.2)', () => {
    let s = push(EMPTY_STATE, click('U1', 1));
    s = push(s, click('U2', 2), cam(500));
    expect((s.entries[0].place as BoardPlace).camera).toEqual(cam(500));
    expect((s.entries[1].place as BoardPlace).camera).toBeUndefined();
  });

  it('a view entry does not write the departure camera', () => {
    let s = push(EMPTY_STATE, click('U1', 1));
    s = push(s, { cause: 'view', place: board('', { part: undefined, camera: cam(900) }), at: 2 }, cam(500));
    expect((s.entries[0].place as BoardPlace).camera).toBeUndefined();
    expect(s.entries).toHaveLength(2);
  });

  it('collapses consecutive same place and same part (pin walk)', () => {
    let s = walk([click('U1', 1), click('U1', 2, { pin: 'A3' }), click('U1', 3, { pin: 'A4', net: 'GND' })]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].label).toBe('U1 · pin A4 · GND');
    s = push(s, click('C5', 4));
    s = push(s, click('U1', 5));
    expect(parts(s)).toEqual(['U1', 'C5', 'U1']);   // non-consecutive repeats are kept
  });

  it('collapses query growth on one surface within an editing run', () => {
    let s = push(EMPTY_STATE, { cause: 'search', place: null, query: { surface: 'board', text: 'PPB' }, at: 1000 });
    s = push(s, { cause: 'search', place: null, query: { surface: 'board', text: 'PPBU' }, at: 1300 });
    s = push(s, { cause: 'search', place: null, query: { surface: 'board', text: 'PPBUS' }, at: 1600 });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].query?.text).toBe('PPBUS');
    // a different query after the run is a new entry
    s = push(s, { cause: 'search', place: null, query: { surface: 'board', text: 'SMC' }, at: 9000 });
    expect(s.entries).toHaveLength(2);
  });

  it('a picked result completes the query entry rather than adding one', () => {
    let s = push(EMPTY_STATE, { cause: 'search', place: null, query: { surface: 'board', text: 'C' }, at: 1 });
    s = push(s, { cause: 'search', place: board('C7'), at: 2 });
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0].label).toBe('“C” → C7');
    expect(s.entries[0].query?.text).toBe('C');
  });

  it('a query attaches to a result picked just before it (global search order)', () => {
    let s = push(EMPTY_STATE, { cause: 'search', place: board('U7'), query: { surface: 'global', text: 'U7' }, at: 1 });
    s = push(s, { cause: 'search', place: null, query: { surface: 'board', text: 'U7' }, at: 50 });
    // same text on another surface within the run: the sidebar mirroring the
    // global search must not add a second stop
    expect(s.entries).toHaveLength(1);
    expect((s.entries[0].place as BoardPlace).part).toBe('U7');
  });

  it('a click after a search is its own entry, and the search keeps its place', () => {
    let s = push(EMPTY_STATE, { cause: 'search', place: board('C7'), query: { surface: 'board', text: 'C' }, at: 1 });
    s = push(s, click('C7', 2, { pin: '1' }));
    expect(s.entries).toHaveLength(2);
    expect(s.entries[0].cause).toBe('search');
    expect(s.entries[1].cause).toBe('click');
  });

  it('caps the timeline and keeps the cursor on the same entry', () => {
    let s = EMPTY_STATE;
    for (let i = 0; i < NAV_HISTORY_CAP + 20; i++) s = push(s, click(`R${i}`, i));
    expect(s.entries).toHaveLength(NAV_HISTORY_CAP);
    expect(s.cursor).toBe(NAV_HISTORY_CAP - 1);
    expect(parts(s)[0]).toBe('R20');
  });
});

describe('touchCamera / patchCursor', () => {
  it('updates the cursor entry only', () => {
    let s = walk([click('U1', 1), click('U2', 2)]);
    s = touchCamera(s, cam(7));
    expect((s.entries[1].place as BoardPlace).camera).toEqual(cam(7));
    expect((s.entries[0].place as BoardPlace).camera).toBeUndefined();
    s = patchCursor(s, { follow: { fileName: 'x.pdf', page: 3, matchIndex: 0 } });
    expect(s.entries[1].follow?.page).toBe(3);
  });
});

describe('stepIndex', () => {
  it('skips switched-off layers and unreachable entries', () => {
    let s = walk([
      click('U1', 1),
      { cause: 'search', place: board('C7'), query: { surface: 'board', text: 'C' }, at: 2 },
      click('U2', 3),
      { cause: 'lookup', place: { kind: 'pdf', fileName: 'x.pdf', page: 4 }, at: 4 },
    ]);
    expect(stepIndex(s, -1, ALL)).toBe(2);
    expect(stepIndex(s, -1, { ...ALL, click: false })).toBe(1);
    expect(stepIndex(s, -1, { ...ALL, click: false, search: false })).toBe(-1);
    expect(stepIndex(s, 1, ALL)).toBe(-1);
    s = moveCursor(s, 0);
    expect(stepIndex(s, 1, ALL)).toBe(1);
    expect(stepIndex(s, 1, ALL, e => e.place?.kind !== 'board')).toBe(3);
  });

  it('default layers list clicks, lookups and searches but not views', () => {
    const s = walk([click('U1', 1), { cause: 'view', place: board('', { part: undefined }), at: 2 }]);
    expect(listed(s, DEFAULT_LAYERS).map(e => e.cause)).toEqual(['click']);
    expect(listed(s, ALL).map(e => e.cause)).toEqual(['view', 'click']);
  });
});

describe('removeEntry', () => {
  it('keeps the cursor on the same entry when an earlier one goes', () => {
    let s = walk([click('U1', 1), click('U2', 2), click('U3', 3)]);
    s = moveCursor(s, 1);
    s = removeEntry(s, 1);
    expect(parts(s)).toEqual(['U2', 'U3']);
    expect(s.cursor).toBe(0);
    s = removeEntry(s, 2);
    expect(parts(s)).toEqual(['U3']);
    expect(s.cursor).toBe(0);
  });
});
