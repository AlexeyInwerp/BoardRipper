/**
 * Pure (browser-free) serialization for the worklist clipboard format.
 *
 * Kept out of `worklist-store.ts` so it has no store/DOM/IndexedDB coupling and
 * can be unit-tested in isolation. The store builds a `ClipWorklist` from its
 * live `Worklist` and delegates here; the importer parses back into the same
 * shape.
 *
 * Format (issue #20 follow-up — nets + measurements were previously dropped on
 * copy). Sectioned and round-trippable:
 *
 *   -[name]-
 *   > ticket note line 1
 *   > ticket note line 2
 *
 *   Parts
 *     C7100 [replaced]
 *     U5000 [water] (got hot)
 *
 *   Nets
 *     PP3V3_S5 [short] surge — Diode 0.000 (short to GND)
 *     PPVIN [solved] — V 12.6
 *     PPBUS_G3H [absent]
 *
 * Bracket tokens are the raw mark enum values; `surge` is a bare word; the
 * measurement reads `— <Diode|V|Ω> <value>`; a trailing `(…)` is the note.
 * Legacy flat copies (part rows directly after the header, no section labels)
 * still import — rows default to the Parts section.
 */

export type WorklistMark = 'none' | 'replaced' | 'reworked' | 'cleaned';
export type NetWorklistMark = 'none' | 'short' | 'solved' | 'absent';
export type MeasKind = 'voltage' | 'diode' | 'resistance';

export interface ClipPart { refdes: string; mark: WorklistMark; note: string; waterdamage: boolean; }
export interface ClipNetMeas { kind: MeasKind; value: string; }
export interface ClipNet {
  netName: string;
  mark: NetWorklistMark;
  surge: boolean;
  note: string;
  measurement: ClipNetMeas | null;
}
export interface ClipWorklist {
  name: string;
  note: string;
  parts: ClipPart[];
  nets: ClipNet[];
}

const MEAS_LABEL: Record<MeasKind, string> = { voltage: 'V', diode: 'Diode', resistance: 'Ω' };
const LABEL_MEAS: Record<string, MeasKind> = { V: 'voltage', Diode: 'diode', 'Ω': 'resistance' };
const PART_MARKS = new Set<WorklistMark>(['replaced', 'reworked', 'cleaned']);
const NET_MARKS = new Set<NetWorklistMark>(['short', 'solved', 'absent']);

// ── format ──────────────────────────────────────────────────────────────────

export function formatWorklist(w: ClipWorklist): string {
  const lines: string[] = [`-[${w.name}]-`];
  if (w.note && w.note.trim()) {
    for (const ln of w.note.split('\n')) lines.push(`> ${ln}`);
  }
  if (w.parts.length > 0) {
    lines.push('', 'Parts');
    for (const p of w.parts) {
      let s = `  ${p.refdes}`;
      if (p.mark !== 'none') s += ` [${p.mark}]`;
      if (p.waterdamage) s += ` [water]`;
      if (p.note.trim()) s += ` (${p.note.trim()})`;
      lines.push(s);
    }
  }
  if (w.nets.length > 0) {
    lines.push('', 'Nets');
    for (const n of w.nets) {
      let s = `  ${n.netName}`;
      if (n.mark !== 'none') s += ` [${n.mark}]`;
      if (n.surge) s += ` surge`;
      if (n.measurement) s += ` — ${MEAS_LABEL[n.measurement.kind]} ${n.measurement.value}`;
      if (n.note.trim()) s += ` (${n.note.trim()})`;
      lines.push(s);
    }
  }
  return lines.join('\n');
}

// ── parse ───────────────────────────────────────────────────────────────────

const REFDES_RE = /^[A-Z][A-Z0-9_\-./]{0,31}$/;
const NETNAME_RE = /^[A-Za-z0-9+_\-./#]{1,64}$/;

/** Strip a trailing `(note)` off a row, returning [body, note]. */
function splitNote(s: string): [string, string] {
  const m = s.match(/\(([^)]*)\)\s*$/);
  if (!m) return [s, ''];
  return [s.slice(0, m.index).trim(), m[1].trim().slice(0, 500)];
}

function parsePartRow(raw: string): ClipPart | null {
  let [s, note] = splitNote(raw.trim());
  let mark: WorklistMark = 'none';
  let waterdamage = false;
  for (const m of s.matchAll(/\[([a-z]+)\]/g)) {
    const t = m[1] as WorklistMark | 'water';
    if (t === 'water') waterdamage = true;
    else if (PART_MARKS.has(t as WorklistMark)) mark = t as WorklistMark;
  }
  s = s.replace(/\[[a-z]+\]/g, '').trim();
  const refdes = s.split(/\s+/)[0] ?? '';
  if (!REFDES_RE.test(refdes)) return null;
  return { refdes, mark, note, waterdamage };
}

function parseNetRow(raw: string): ClipNet | null {
  let [s, note] = splitNote(raw.trim());
  // measurement: — <label> <value>
  let measurement: ClipNetMeas | null = null;
  const mm = s.match(/—\s*(Diode|V|Ω)\s+(.+?)\s*$/);
  if (mm) {
    measurement = { kind: LABEL_MEAS[mm[1]], value: mm[2].trim().slice(0, 64) };
    s = s.slice(0, mm.index).trim();
  }
  // surge (bare word)
  let surge = false;
  const sm = s.match(/\bsurge\b/);
  if (sm) { surge = true; s = (s.slice(0, sm.index) + s.slice(sm.index! + 5)).trim(); }
  // mark token
  let mark: NetWorklistMark = 'none';
  for (const m of s.matchAll(/\[([a-z]+)\]/g)) {
    if (NET_MARKS.has(m[1] as NetWorklistMark)) mark = m[1] as NetWorklistMark;
  }
  s = s.replace(/\[[a-z]+\]/g, '').trim();
  const netName = s.split(/\s+/)[0] ?? '';
  if (!NETNAME_RE.test(netName)) return null;
  return { netName, mark, surge, note, measurement };
}

export function parseWorklistText(text: string): ClipWorklist | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 256 * 1024) return null;
  const lines = text.split(/\r?\n/, 2001);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return null;
  const headerMatch = lines[i].trim().match(/^-\[(.+)\]-$/);
  if (!headerMatch) return null;
  const name = headerMatch[1].trim().slice(0, 200);
  // eslint-disable-next-line no-control-regex
  if (!name || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(name)) return null;
  i++;

  // Ticket note: contiguous `> ` lines.
  const noteLines: string[] = [];
  while (i < lines.length) {
    const m = lines[i].match(/^>\s?(.*)$/);
    if (!m) break;
    noteLines.push(m[1]);
    i++;
    if (noteLines.length > 200) break;
  }
  const note = noteLines.join('\n').slice(0, 4000);

  const parts: ClipPart[] = [];
  const nets: ClipNet[] = [];
  let mode: 'parts' | 'nets' = 'parts'; // legacy flat copies have no section label
  let trailingNonEmpty = 0;
  for (; i < lines.length && parts.length + nets.length < 2000; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower === 'parts') { mode = 'parts'; continue; }
    if (lower === 'nets') { mode = 'nets'; continue; }
    trailingNonEmpty++;
    if (mode === 'nets') {
      const n = parseNetRow(raw);
      if (n) nets.push(n);
    } else {
      const p = parsePartRow(raw);
      if (p) parts.push(p);
    }
  }

  // False-positive guard: a coincidental `-[heading]-` followed by prose.
  if (parts.length === 0 && nets.length === 0 && trailingNonEmpty >= 5) return null;
  return { name, note, parts, nets };
}
