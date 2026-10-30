/**
 * What the board legend lists, computed from the board and the effective
 * render settings. Pure: the card (components/BoardLegend.tsx) only lays it
 * out, and the unit test checks the counts.
 *
 * Every count is per board, so the legend answers "what is this colour
 * here", not "what could it be": a rule that colours nothing on this board
 * says 0, and the colour no rule claims — the commonest pin colour on most
 * boards — is listed with its own count, per side, because its underside
 * twin is red, the same family as the power rails.
 */
import type { BoardData } from '../parsers';
import type { DiodeReading } from '../parsers/types';
import {
  matchPinGroupKeyword, resolvePartType,
  type PinGroup, type RenderSettings,
} from './render-settings';
import { DIODE_RED_BELOW_MV, DIODE_YELLOW_UPTO_MV, DIODE_COLOR } from './diode-readings';

export type LegendMode = 'pins' | 'parts' | 'readings' | 'lines' | 'keys';

export const LEGEND_MODES: ReadonlyArray<{ id: LegendMode; label: string; title: string }> = [
  { id: 'pins',     label: 'Pins',     title: 'Pin colours: which rule coloured a pin, and how many pins on this board' },
  { id: 'parts',    label: 'Parts',    title: 'Component colours by type' },
  { id: 'readings', label: 'Readings', title: 'Diode reading colours' },
  { id: 'lines',    label: 'Lines',    title: 'Net lines and selection colours' },
  { id: 'keys',     label: 'Keys',     title: 'Board keys' },
];

export interface PinLegend {
  /** Pins per rule id, in the settings' own order. */
  byRule: Map<string, number>;
  /** Pins no rule claims, by the side their part sits on. */
  unmatchedTop: number;
  unmatchedBottom: number;
}

/** The rule a net's pins take: first group, first rule, first keyword that
 *  matches — the same walk as resolvePinGroup, returning the rule's id. */
export function pinRuleFor(groups: readonly PinGroup[], net: string): string | null {
  if (!net) return null;
  const upper = net.toUpperCase();
  for (const g of groups) {
    for (const r of g.rules) {
      for (const kw of r.keywords.split(',')) {
        if (matchPinGroupKeyword(upper, kw, g.outlineOnly)) return r.id;
      }
    }
  }
  return null;
}

const pinCache = new WeakMap<BoardData, { sig: string; legend: PinLegend }>();

/** Pin counts per rule on `board`. Each distinct net is classified once;
 *  cached per board until the rules change. */
export function pinLegend(board: BoardData, groups: readonly PinGroup[]): PinLegend {
  const sig = JSON.stringify(groups.map(g => [g.outlineOnly, g.rules.map(r => [r.id, r.keywords])]));
  const hit = pinCache.get(board);
  if (hit && hit.sig === sig) return hit.legend;
  const byRule = new Map<string, number>();
  for (const g of groups) for (const r of g.rules) byRule.set(r.id, 0);
  const ruleOfNet = new Map<string, string | null>();
  let unmatchedTop = 0, unmatchedBottom = 0;
  for (const part of board.parts) {
    for (const pin of part.pins) {
      let rule = ruleOfNet.get(pin.net);
      if (rule === undefined) { rule = pinRuleFor(groups, pin.net); ruleOfNet.set(pin.net, rule); }
      if (rule) byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
      else if (part.side === 'bottom') unmatchedBottom++;
      else unmatchedTop++;
    }
  }
  const legend = { byRule, unmatchedTop, unmatchedBottom };
  pinCache.set(board, { sig, legend });
  return legend;
}

/** Parts per part-type id on `board` (types with no parts are absent). */
export function partTypeCounts(board: BoardData, s: RenderSettings): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of board.parts) {
    const t = resolvePartType(part.name, s);
    if (t) out.set(t.id, (out.get(t.id) ?? 0) + 1);
  }
  return out;
}

export type ReadingBand = 'short' | 'junction' | 'high' | 'open';

export const READING_BANDS: ReadonlyArray<{ id: ReadingBand; label: string; range: string; color: number }> = [
  { id: 'short',    label: 'Short or near short', range: `below ${(DIODE_RED_BELOW_MV / 1000).toFixed(3)} V`, color: DIODE_COLOR.short },
  { id: 'junction', label: 'Junction, loaded rail', range: `${(DIODE_RED_BELOW_MV / 1000).toFixed(3)}–${(DIODE_YELLOW_UPTO_MV / 1000).toFixed(3)} V`, color: DIODE_COLOR.junction },
  { id: 'high',     label: 'Higher',              range: `above ${(DIODE_YELLOW_UPTO_MV / 1000).toFixed(3)} V`, color: DIODE_COLOR.high },
  { id: 'open',     label: 'Open, no path',       range: 'OL', color: DIODE_COLOR.open },
];

/** Which band a reading falls in; null for no reading. Mirrors diodeReadingColor. */
export function readingBand(r: DiodeReading | undefined): ReadingBand | null {
  if (!r) return null;
  if (r.kind === 'open') return 'open';
  if (r.kind !== 'value' || r.mv == null) return null;
  if (r.mv < DIODE_RED_BELOW_MV) return 'short';
  if (r.mv <= DIODE_YELLOW_UPTO_MV) return 'junction';
  return 'high';
}

/** Readings per band among the readings the file itself carries. */
export function readingCounts(board: BoardData): Map<ReadingBand, number> {
  const out = new Map<ReadingBand, number>();
  for (const part of board.parts) {
    for (const pin of part.pins) {
      const b = readingBand(pin.diode);
      if (b) out.set(b, (out.get(b) ?? 0) + 1);
    }
  }
  return out;
}

/** Board keys worth having in front of you, by shortcut id, in reading order. */
export const LEGEND_KEY_IDS: readonly string[] = [
  'flipBoard', 'rotateBoardCCW', 'rotateBoardCW', 'mirrorBoard',
  'zoomBoardIn', 'zoomBoardOut', 'panBoardUp',
  'focusSearch', 'searchStep', 'historyBack', 'historyForward',
  'copySelection', 'tabJump',
];
