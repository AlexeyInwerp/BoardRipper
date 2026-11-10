/**
 * Minimap worklist navigation — the worklist panel's ‹ › rule, driven from
 * the board's selection rather than the panel's own row state, so the map
 * can step a worklist with the panel closed.
 *
 * Order: parts, then nets, as the panel lists them; rows whose part or net is
 * not on this board are skipped; no wrap. The current row is whatever the
 * board has selected (a part, else the lit net) when that is in the list.
 */
import type { Worklist } from './worklist-store';

export type WlKey = `p:${string}` | `n:${string}`;

export function worklistStepKeys(wl: Worklist | null): WlKey[] {
  if (!wl) return [];
  return [
    ...wl.entries.filter(e => !e.unresolved).map(e => `p:${e.refdes}` as WlKey),
    ...(wl.netEntries ?? []).filter(e => !e.unresolved).map(e => `n:${e.netName}` as WlKey),
  ];
}

export function currentWorklistKey(keys: readonly WlKey[], selectedPart: string | null, litNet: string | null): WlKey | null {
  const up = (s: string) => s.toUpperCase();
  if (selectedPart) {
    const k = keys.find(k => k.startsWith('p:') && up(k.slice(2)) === up(selectedPart));
    if (k) return k;
  }
  if (litNet) {
    const k = keys.find(k => k.startsWith('n:') && up(k.slice(2)) === up(litNet));
    if (k) return k;
  }
  return null;
}

/** Where ‹ (-1) or › (+1) goes from `current`; null at either end. From no
 *  current row, › starts at the first and ‹ at the last. */
export function worklistStep(keys: readonly WlKey[], current: WlKey | null, dir: 1 | -1): WlKey | null {
  const at = current ? keys.indexOf(current) : -1;
  const to = at < 0 ? (dir > 0 ? 0 : keys.length - 1) : at + dir;
  return keys[to] ?? null;
}
