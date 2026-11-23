import { describe, it, expect } from 'vitest';
import { recentlyAdded } from './recently-added';
import type { DatabankFile } from './databank-store';

const f = (id: number, name: string, scanSec: number) =>
  ({ id, filename: name, path: `lib/${name}`, file_type: 'board', scan_time: scanSec, mod_time: scanSec }) as unknown as DatabankFile;

describe('recentlyAdded', () => {
  const files = [f(1, 'old.brd', 1000), f(2, 'mid.brd', 2000), f(3, 'new.brd', 3000)];

  it('lists new rows newest first', () => {
    expect(recentlyAdded(files, false, '').map(r => r.file.filename)).toEqual(['new.brd', 'mid.brd', 'old.brd']);
  });

  it('puts a dropped file the library already had at the time of the drop, marked', () => {
    const many = Array.from({ length: 150 }, (_, i) => f(i + 10, `n${i}.brd`, 5000 + i));
    const rows = recentlyAdded([...files, ...many], false, '', [{ id: 1, at: 9_999_000, dropped: 'X.zip › old.brd' }]);
    expect(rows[0]).toMatchObject({ file: { id: 1 }, dropped: 'X.zip › old.brd' });
    expect(rows).toHaveLength(100);
  });

  it('orders drops against new rows by time', () => {
    const rows = recentlyAdded(files, false, '', [{ id: 1, at: 2_500_000, dropped: 'old.brd' }]);
    // id 1 is already in the top list as a plain row; nothing to add.
    expect(rows.filter(r => r.file.id === 1)).toHaveLength(1);
  });

  it('honours the search filter and skips ids no longer in the library', () => {
    const many = Array.from({ length: 100 }, (_, i) => f(i + 10, `n${i}.brd`, 5000 + i));
    const rows = recentlyAdded([...files, ...many], false, 'old', [{ id: 1, at: 9_000_000, dropped: 'a' }, { id: 777, at: 9_000_000, dropped: 'gone' }]);
    expect(rows.map(r => r.file.id)).toEqual([1]);
  });
});
