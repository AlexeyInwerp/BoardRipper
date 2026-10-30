/**
 * N / Shift+N — step through what the board search found.
 *
 * Two kinds of result list, decided by the current selection:
 *  - **A lit net** (picked in Find net, the Search tab, or by clicking a pin):
 *    one stop per part on the net, at the pin that sits on it. Parts with at
 *    most three pins come first — those are the easy probe points when the
 *    net is being measured — then the rest, each run in natural refdes order.
 *  - **Otherwise, a search query** (the ribbon finds and the Search tab share
 *    one): the parts the board search lights, in natural refdes order.
 *
 * There is no cursor to keep in sync: the step starts from whichever stop is
 * selected now, so a click on the board, a history jump or a pick in the
 * Search tab all move the starting point for free. Nothing selected yet, or a
 * selection outside the list, starts at the first stop (the last for Shift).
 *
 * Idea from the 2R Tools fork (reparomac/boardripper-2r).
 */
import type { BoardData } from '../parsers';
import type { SelectionState } from './board-store';
import { naturalCompare } from '../components/overlay/natural-sort';

export interface Stop { partIndex: number; pinIndex: number | null }

/** Few enough pins to put a probe on without hunting (passives, SOT-23s). */
const EASY_PROBE_PINS = 3;

/** The net's stops: one per part, at its first pin on the net. */
export function netStops(board: BoardData, net: string): Stop[] {
  const stops: Stop[] = [];
  board.parts.forEach((p, partIndex) => {
    const pinIndex = p.pins.findIndex(pin => pin.net === net);
    if (pinIndex >= 0) stops.push({ partIndex, pinIndex });
  });
  const easy = (s: Stop) => (board.parts[s.partIndex].pins.length <= EASY_PROBE_PINS ? 0 : 1);
  return stops.sort((a, b) => easy(a) - easy(b)
    || naturalCompare(board.parts[a.partIndex].name, board.parts[b.partIndex].name));
}

/** The search's stops, in natural refdes order. */
export function partStops(board: BoardData, partIndices: Iterable<number>): Stop[] {
  return [...partIndices]
    .sort((a, b) => naturalCompare(board.parts[a].name, board.parts[b].name))
    .map(partIndex => ({ partIndex, pinIndex: null }));
}

/**
 * True when the selection is a net the user is on — a net picked on its own,
 * or a pin's net. A part selected by its body can also carry a net (the
 * chain-adjacent net-line mode seeds one from a 2-pin part), and that one is
 * not a net the user asked to walk.
 */
export function walkingNet(sel: SelectionState): boolean {
  return !!sel.highlightedNet && (sel.partIndex === null || sel.pinIndex !== null);
}

/** The stop `dir` steps away from the selected part; wraps at both ends. */
export function nextStop(stops: readonly Stop[], selectedPart: number | null, dir: 1 | -1): Stop | null {
  if (stops.length === 0) return null;
  const at = selectedPart === null ? -1 : stops.findIndex(s => s.partIndex === selectedPart);
  if (at < 0) return dir > 0 ? stops[0] : stops[stops.length - 1];
  return stops[(at + dir + stops.length) % stops.length];
}
