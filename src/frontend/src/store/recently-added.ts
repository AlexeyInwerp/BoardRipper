import type { DatabankFile } from './databank-store';
import type { RecentDrop } from './recent-drops';

const RECENTLY_ADDED_MAX = 100;

/** The newest library files. On the server a row's id is its insertion order
 *  (scan_time is rewritten when a file changes, so it would list edits as
 *  additions); the desktop and folder producers stamp every row with the scan
 *  time and hash their ids, so there the file's own mtime is the best clue.
 *  Files the user dropped that the library already had (`drops`) join the
 *  list at the time of the drop, marked as such: a drop of known files
 *  creates no new row, and the list would otherwise not show it at all. */
export function recentlyAdded(
  files: DatabankFile[], local: boolean, filter: string, drops: readonly RecentDrop[] = [],
): { file: DatabankFile; at: number; dropped?: string }[] {
  const q = filter.trim().toLowerCase();
  const matches = (f: DatabankFile) =>
    f.filename.toLowerCase().includes(q) ||
    f.path.toLowerCase().includes(q) ||
    (f.board_number?.toLowerCase().includes(q) ?? false);
  const pool = q ? files.filter(matches) : files;
  const key = local ? (f: DatabankFile) => f.mod_time : (f: DatabankFile) => f.id;
  // Partial selection: keep the top N without sorting 100k rows.
  const top: DatabankFile[] = [];
  for (const f of pool) {
    if (top.length === RECENTLY_ADDED_MAX && key(f) <= key(top[top.length - 1])) continue;
    let i = top.length;
    while (i > 0 && key(top[i - 1]) < key(f)) i--;
    top.splice(i, 0, f);
    if (top.length > RECENTLY_ADDED_MAX) top.pop();
  }
  const out: { file: DatabankFile; at: number; dropped?: string }[] =
    top.map(file => ({ file, at: (local ? file.mod_time : file.scan_time) * 1000 }));
  if (drops.length === 0) return out;

  const wanted = new Map(drops.map(d => [d.id, d]));
  const shown = new Set(out.map(r => r.file.id));
  const extra: typeof out = [];
  for (const f of pool) {
    const d = wanted.get(f.id);
    if (d && !shown.has(f.id)) extra.push({ file: f, at: d.at, dropped: d.dropped });
  }
  if (extra.length === 0) return out;
  // New rows keep their insertion order among themselves; a drop goes in
  // front of every row added before it.
  const merged: typeof out = [];
  let i = 0;
  for (const e of extra.sort((a, b) => b.at - a.at)) {
    while (i < out.length && out[i].at > e.at) merged.push(out[i++]);
    merged.push(e);
  }
  while (i < out.length) merged.push(out[i++]);
  return merged.slice(0, RECENTLY_ADDED_MAX);
}

