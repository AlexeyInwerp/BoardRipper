/**
 * Row order for the Info panel's pin table (filter + sort). Pure, so the
 * table and its unit test share one rule. Pin filter and sortable columns
 * after the 2R Tools fork (reparomac/boardripper-2r).
 */
import type { Pin } from '../parsers';
import { looseMatcher } from '../store/loose-match';
import { naturalCompare } from './overlay/natural-sort';

export type PinSortCol = 'num' | 'name' | 'net';

/** Below this many pins the whole table fits on screen and a filter field is
 *  only clutter. */
export const PIN_FILTER_MIN_PINS = 12;

/** Row order for the pin table: indices into `pins` that match `query` (pin
 *  number, name or net — substring or the loose rule), sorted by `sort` in
 *  natural order, file order otherwise. `keep` (the selected pin) is never
 *  filtered out. */
export function orderPins(
  pins: readonly Pin[],
  query: string,
  sort: { col: PinSortCol; dir: 1 | -1 } | null,
  keep: number | null,
): number[] {
  let order = pins.map((_, i) => i);
  if (query.trim()) {
    const m = looseMatcher(query.trim());
    order = order.filter(i => i === keep
      || m.test(pins[i].number ?? '') || m.test(pins[i].name ?? '') || m.test(pins[i].net ?? ''));
  }
  if (sort) {
    const key = (p: Pin) => (sort.col === 'num' ? p.number : sort.col === 'name' ? p.name : p.net) ?? '';
    order.sort((a, b) => naturalCompare(key(pins[a]), key(pins[b])) * sort.dir || a - b);
  }
  return order;
}

