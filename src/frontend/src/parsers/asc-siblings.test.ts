import { describe, it, expect } from 'vitest';
import { ascSectionFromName, groupAscSiblings } from './asc-siblings';

describe('ascSectionFromName', () => {
  it('reads the section out of prefixed, bare and dotted names', () => {
    expect(ascSectionFromName('LA-L031P_pins.asc')).toBe('pins');
    expect(ascSectionFromName('Pins.asc')).toBe('pins');
    expect(ascSectionFromName('board.nails.ASC')).toBe('nails');
    expect(ascSectionFromName('X555LD R36 Format.asc')).toBe('format');
    expect(ascSectionFromName('Nets.asc')).toBe('nets');
    expect(ascSectionFromName('Parts.asc')).toBe('parts');
  });

  it('ignores non-asc files and names with no section word', () => {
    expect(ascSectionFromName('pins.txt')).toBeNull();
    expect(ascSectionFromName('board.asc')).toBeNull();
    // PADS Layout ships PART.ASC / CONN.ASC next to a job — singular PART is
    // not the placement section, and must never join a group.
    expect(ascSectionFromName('PART.ASC')).toBeNull();
    expect(ascSectionFromName('CONN.ASC')).toBeNull();
    // No false positive from a section word buried inside another word.
    expect(ascSectionFromName('spinsheet.asc')).toBeNull();
  });
});

describe('groupAscSiblings', () => {
  const X555 = ['Format.asc', 'Nails.asc', 'Nets.asc', 'Parts.asc', 'Pins.asc'];

  it('collects the whole delivery from any one of its files', () => {
    expect(groupAscSiblings('Nets.asc', X555)).toEqual([
      'Format.asc', 'Nails.asc', 'Pins.asc', 'Parts.asc', 'Nets.asc',
    ]);
    expect(groupAscSiblings('Pins.asc', X555)).toHaveLength(5);
  });

  it('matches board-prefixed names by their shared stem', () => {
    const files = ['LA-L031P_format.asc', 'LA-L031P_nails.asc', 'LA-L031P_pins.asc'];
    expect(groupAscSiblings('LA-L031P_pins.asc', files)).toEqual([
      'LA-L031P_format.asc', 'LA-L031P_nails.asc', 'LA-L031P_pins.asc',
    ]);
  });

  it('keeps two boards exported into one folder apart', () => {
    const files = ['A_pins.asc', 'A_nails.asc', 'B_pins.asc', 'B_nails.asc'];
    expect(groupAscSiblings('A_pins.asc', files)).toEqual(['A_nails.asc', 'A_pins.asc']);
  });

  it('never pulls in a PADS job sharing the folder', () => {
    const files = ['Pins.asc', 'Nails.asc', 'PART.ASC', 'CONN.ASC'];
    expect(groupAscSiblings('Pins.asc', files)).toEqual(['Nails.asc', 'Pins.asc']);
  });

  it('returns the clicked file alone when nothing matches', () => {
    expect(groupAscSiblings('board.asc', X555)).toEqual(['board.asc']);
    expect(groupAscSiblings('Pins.asc', ['Pins.asc'])).toEqual(['Pins.asc']);
    expect(groupAscSiblings('A_pins.asc', ['B_nails.asc'])).toEqual(['A_pins.asc']);
  });

  it('prefers the shortest name when a section appears twice', () => {
    const files = ['Pins.asc', 'Nails.asc', 'Nails (copy).asc'];
    expect(groupAscSiblings('Pins.asc', files)).toEqual(['Nails.asc', 'Pins.asc']);
  });
});
