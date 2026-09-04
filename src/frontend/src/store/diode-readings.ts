// src/frontend/src/store/diode-readings.ts
//
// Source-agnostic diode-reading resolver. The on-pin overlay, canvas tooltip,
// ComponentInfo, and the diode-reference panel all read a pin's diode reading
// through here, so the two sources converge on one visual target:
//
//   • XZZ-baked  — per pin, millivolts, carried on `pin.diode` by the parser.
//   • OpenBoardData (OBD) — per net, volts, fetched async into `obdStore` and
//     resolved here via `pin.net` → `obdNetIndex`.
//
// OBD is consumed read-only through the existing index; nothing here mutates
// OBD or the BoardData.

import type { BoardData, DiodeReading, Pin } from '../parsers/types';
import { obdNetIndex } from './obd-store';
import type { RenderSettings } from './render-settings';

/** Format a reading for display. Volts, 3 decimals, unified across sources
 *  (XZZ stores mV, OBD stores V — both normalize to mv). `OL` shown literally;
 *  `none` returns '' (callers skip it). */
export function formatDiode(r: DiodeReading | undefined): string {
  if (!r || r.kind === 'none') return '';
  if (r.kind === 'open') return 'OL';
  if (r.mv == null) return r.raw;
  return `${(r.mv / 1000).toFixed(3)} V`;
}

/** Normalize an OBD diode string ("0.450" V, "OL", "", null) into a
 *  DiodeReading, or null when there's nothing to show. */
export function normalizeObdDiode(raw: string | null | undefined): DiodeReading | null {
  if (raw == null) return null;
  const tok = raw.trim();
  if (tok === '') return null;
  if (/^OL$/i.test(tok)) return { raw: tok, kind: 'open', mv: null, source: 'obd' };
  const v = Number(tok.replace(/[^0-9.+-]/g, ''));   // tolerate stray unit chars
  if (!Number.isFinite(v)) return { raw: tok, kind: 'value', mv: null, source: 'obd' };
  if (v === 0) return { raw: tok, kind: 'none', mv: 0, source: 'obd' };
  return { raw: tok, kind: 'value', mv: Math.round(v * 1000), source: 'obd' };  // volts → mV
}

/** The OBD reading for a pin (via its net), or undefined. When several OBD
 *  variants disagree, the first with a parseable diode wins. */
function obdReadingForPin(pin: Pin, boardNumber: string | undefined): DiodeReading | undefined {
  if (!pin.net || !boardNumber) return undefined;
  const nets = obdNetIndex(boardNumber).get(pin.net);
  if (!nets || nets.length === 0) return undefined;
  for (const n of nets) {
    const r = normalizeObdDiode(n.diode);
    if (r) return r;
  }
  return undefined;
}

/** Every reading available for a pin, across sources (0, 1, or 2 entries).
 *  XZZ first, then OBD. Used by the tooltip / ComponentInfo / reference panel
 *  to show provenance. */
export function resolveDiodeReadings(pin: Pin, boardNumber: string | undefined): DiodeReading[] {
  const out: DiodeReading[] = [];
  if (pin.diode) out.push(pin.diode);
  const obd = obdReadingForPin(pin, boardNumber);
  if (obd) out.push(obd);
  return out;
}

/** Whether a board carries diode data from *either* source — gates the
 *  `diodeValues` overlay slot and the reference panel. */
export function boardHasDiodeData(board: BoardData | null, boardNumber: string | undefined): boolean {
  if (board?.diodeReference) return true;
  if (!boardNumber) return false;
  for (const nets of obdNetIndex(boardNumber).values()) {
    for (const n of nets) if (normalizeObdDiode(n.diode)) return true;
  }
  return false;
}

/** The single reading to draw on the pin. Precedence: a real XZZ reading
 *  (value — including measured-as-zero — or open) beats OBD; OBD fills in
 *  where XZZ has nothing; a `none` (OBD zero = not measured) is the last
 *  resort. Returns undefined when neither source has anything. */
export function primaryDiodeReading(pin: Pin, boardNumber: string | undefined): DiodeReading | undefined {
  const all = resolveDiodeReadings(pin, boardNumber);
  if (all.length === 0) return undefined;
  return all.find(r => r.kind !== 'none') ?? all[0];
}

// ── Diode display mode ──────────────────────────────────────────────────────
// One button, three states, shared by the board-overlay slot and the sidebar's
// View tab so they can never disagree. The mode is stored as two independent
// booleans in RenderSettings rather than one enum: `showDiodeValues` predates
// this and is what `buildBoardScene` already gates the reading layer on, and
// keeping `diodeValuesOnly` separate means it never has to write (and later
// restore) the user's `showPinNumbers` / `showNetNames` choices.

export type DiodeMode = 'off' | 'on' | 'only';

/** Which of the three states the current settings represent. `diodeValuesOnly`
 *  is meaningless while readings are hidden, so it is ignored when off. */
export function diodeMode(s: Pick<RenderSettings, 'showDiodeValues' | 'diodeValuesOnly'>): DiodeMode {
  if (!s.showDiodeValues) return 'off';
  return s.diodeValuesOnly ? 'only' : 'on';
}

/** The settings patch that advances the button: off → on → only → off. */
export function cycleDiodeMode(
  s: Pick<RenderSettings, 'showDiodeValues' | 'diodeValuesOnly'>,
): Pick<RenderSettings, 'showDiodeValues' | 'diodeValuesOnly'> {
  switch (diodeMode(s)) {
    case 'off':  return { showDiodeValues: true,  diodeValuesOnly: false };
    case 'on':   return { showDiodeValues: true,  diodeValuesOnly: true  };
    case 'only': return { showDiodeValues: false, diodeValuesOnly: false };
  }
}

/** Tooltip naming the current state and what the next click does. */
export function diodeModeTitle(mode: DiodeMode): string {
  switch (mode) {
    case 'off':  return 'Diode values: OFF — click to show readings on pins';
    case 'on':   return 'Diode values: ON — click for diode-only (hides pin numbers and net names)';
    case 'only': return 'Diode values: ONLY — pin numbers and net names hidden. Click to turn off';
  }
}
