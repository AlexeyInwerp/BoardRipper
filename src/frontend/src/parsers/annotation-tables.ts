/**
 * Recovers the repair tables that XZZ "common problems" boards draw as loose
 * text over a few ruled lines.
 *
 * The ruled lines do NOT delimit the text: on iPhoneXSMAX the region carries 8
 * horizontal and 5 vertical rules, yet every label falls inside one drawn
 * column band. Structure therefore has to come from the text coordinates.
 *
 * The thresholds below were measured on the 13 boards in the XZZ library that
 * carry such text: 11 iPhone "Common problems" files and 2 repair flowcharts.
 * Pure: no store, no renderer.
 */
import type { AnnotationTable, BBox, BoardAnnotations, BoardText } from './types';

// CJK, Kana, Hangul, Cyrillic, Greek, Arabic, Hebrew, Thai. Only has to decide
// whether a string is annotation-language text; a false positive costs one
// extra note.
const NON_LATIN = /[Ͱ-ϿЀ-ӿ֐-׿؀-ۿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;

export function hasNonLatin(s: string): boolean {
  return NON_LATIN.test(s);
}

// A record stores a height but never a width. A Han glyph is one em wide by
// definition of the CJK grid; Latin averages a little over half. Good enough
// to apportion columns, which is all it is used for.
const CJK_ADVANCE = 1.0;
const LATIN_ADVANCE = 0.58;

export function textWidth(t: BoardText): number {
  let em = 0;
  for (const ch of t.text) em += NON_LATIN.test(ch) ? CJK_ADVANCE : LATIN_ADVANCE;
  return em * t.size;
}

// Two tables can sit side by side: six of the FAQ boards put a fault table
// next to a voltage test-point table. Column gaps inside a table reach 900
// mils (iPhone7Plus Qualcomm); gaps between tables run from 1,532
// (iPhone6S) to 4,987 (iPhoneX Qualcomm). The margin on the iPhone6S side
// is thin: two tables drawn closer than this would merge.
const TABLE_SPLIT_MILS = 1500;

// Repair-flowchart files draw boxes joined by arrows, not rows: the iPhone12
// flowchart puts 24 of 31 labels on one line, where a real table's largest
// row holds 7-32% of its labels.
const MAX_ROW_SHARE = 0.4;

// Every real table seen has 3 or 4 columns (two templates: fault / point /
// fix, and net / name / voltage / diode value). The iPhoneXS flowchart passes
// the row-share test at 28% and would otherwise come out as a 2-column
// "table" whose header is an instruction and a designator.
const MIN_COLUMNS = 3;

// Board notes are set at designator size (1-2.5 mils); table text at 30 mils
// and up. A quarter of the median sits inside that gap on every FAQ board
// and, being relative, assumes neither absolute size.
const TABLE_TEXT_SHARE = 0.25;

const MIN_LABELS = 6;

const median = (v: number[]): number => {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Every annotation label: the non-Latin ones, plus ASCII labels set at
 * annotation size inside their bounding box.
 *
 * Position alone cannot find the ASCII ones. Annotation text is drawn over the
 * board, so on iPhone6Plus a box around the Chinese labels holds 2,204 ASCII
 * texts, of which 83 belong to the tables. Size separates them: the tables are
 * set at 60 mils, silkscreen at 1-2. The designator cells ("U6300",
 * "Q3200, Q3201") are real table content and must survive.
 */
export function collectAnnotationLabels(texts: readonly BoardText[]): BoardText[] {
  const foreign = texts.filter(t => hasNonLatin(t.text));
  if (foreign.length < MIN_LABELS) return foreign;

  const minSize = median(foreign.map(t => t.size)) * 0.5;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of foreign) {
    x0 = Math.min(x0, t.x); x1 = Math.max(x1, t.x);
    y0 = Math.min(y0, t.y); y1 = Math.max(y1, t.y);
  }
  const padX = (x1 - x0) * 0.05 || 1;
  const padY = (y1 - y0) * 0.05 || 1;
  const ascii = texts.filter(t =>
    !hasNonLatin(t.text) && t.text.trim() !== '' && t.size >= minSize &&
    t.x >= x0 - padX && t.x <= x1 + padX && t.y >= y0 - padY && t.y <= y1 + padY);
  return [...foreign, ...ascii];
}

/**
 * The vertical gap that separates rows, measured from the labels themselves.
 *
 * Gaps are bimodal — jitter within a row vs. the pitch between rows — so this
 * is Otsu's method: the split minimising within-group variance. On the tables
 * of iPhone6, iPhone8 Qualcomm and iPhoneXSMAX it lands at 57-76 mils (67 on
 * iPhoneXSMAX), and a fixed 67 gives the same rows on each, so this is here to
 * avoid a tuned constant, not because one has been seen to fail.
 */
export function rowGapThreshold(gaps: readonly number[]): number {
  if (gaps.length < 2) return gaps[0] ?? 0;
  const v = [...gaps].sort((a, b) => a - b);
  const spread = (a: number[]) => {
    const m = a.reduce((s, x) => s + x, 0) / a.length;
    return a.reduce((s, x) => s + (x - m) ** 2, 0);
  };
  let best = v[0], bestScore = Infinity;
  for (let i = 1; i < v.length; i++) {
    const score = spread(v.slice(0, i)) + spread(v.slice(i));
    if (score < bestScore) { bestScore = score; best = (v[i - 1] + v[i]) / 2; }
  }
  return best;
}

function splitSideBySide(labels: BoardText[]): BoardText[][] {
  const byX = [...labels].sort((a, b) => a.x - b.x);
  const groups: BoardText[][] = [[byX[0]]];
  for (const l of byX.slice(1)) {
    const g = groups[groups.length - 1];
    if (l.x - g[g.length - 1].x > TABLE_SPLIT_MILS) groups.push([l]);
    else g.push(l);
  }
  return groups;
}

interface Built { table: AnnotationTable; placed: BoardText[] }

/**
 * One table from one side-by-side group, or null when the labels are not
 * tabular (the caller keeps them as notes).
 *
 * Columns are anchored on the header row's x positions and filled by nearest
 * anchor: a header can sit offset from the data under it, and plain
 * x-clustering then splits that column in two.
 */
function buildTable(labels: BoardText[]): Built | null {
  if (labels.length < MIN_LABELS) return null;

  // File Y grows upward, so reading order is descending Y.
  const sorted = [...labels].sort((a, b) => b.y - a.y);
  const gaps = sorted.slice(1).map((l, i) => sorted[i].y - l.y);
  const threshold = rowGapThreshold(gaps);

  const rows: BoardText[][] = [[sorted[0]]];
  for (const l of sorted.slice(1)) {
    const row = rows[rows.length - 1];
    if (row[row.length - 1].y - l.y > threshold) rows.push([l]);
    else row.push(l);
  }
  if (rows.length < 3) return null;
  if (Math.max(...rows.map(r => r.length)) / labels.length > MAX_ROW_SHARE) return null;

  // Lone labels on top are the title. Every file seen uses one line; a short
  // run is taken so a title wrapped over two or three still reads as one.
  const captionLines: BoardText[] = [];
  while (rows.length > 2 && rows[0].length === 1 && captionLines.length < 3) {
    captionLines.push(rows.shift()![0]);
  }

  const headerRow = rows[0];
  if (headerRow.length < MIN_COLUMNS) return null;
  const anchors = headerRow.map(h => h.x).sort((a, b) => a - b);

  const place = (row: BoardText[]): BoardText[][] => {
    const cells: BoardText[][] = anchors.map(() => []);
    for (const l of row) {
      let best = 0;
      for (let i = 1; i < anchors.length; i++) {
        if (Math.abs(l.x - anchors[i]) < Math.abs(l.x - anchors[best])) best = i;
      }
      cells[best].push(l);
    }
    return cells.map(c => c.sort((a, b) => b.y - a.y));
  };
  const header = place(headerRow);
  const body = rows.slice(1).map(place);

  // Width from the widest line each column actually holds, not an equal split:
  // an equal split starves a prose column beside a designator column and the
  // browser re-wraps lines the file had already broken.
  const columnWeights = anchors.map((a, i) => {
    let w = 0;
    for (const row of [header, ...body]) for (const l of row[i]) w = Math.max(w, textWidth(l));
    return Math.max(w, (anchors[i + 1] ?? a) - a, 1);
  });

  const placed = [...captionLines, ...header.flat(), ...body.flat(2)];
  return {
    placed,
    table: {
      ...(captionLines.length ? { caption: captionLines.map(l => l.text).join(' ') } : {}),
      header: header.map(c => c.map(l => l.text).join(' ')),
      rows: body.map(r => r.map(c => c.map(l => l.text))),
      columnWeights,
      rawBounds: extent(placed),
    },
  };
}

/** The box the text covers. Anchors under-report it: each label runs right of
 *  its anchor, and the first and last rows reach half a line past theirs. */
function extent(labels: BoardText[]): BBox {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const l of labels) {
    minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x + textWidth(l));
    minY = Math.min(minY, l.y - l.size / 2); maxY = Math.max(maxY, l.y + l.size / 2);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Tables left to right, plus every annotation label no table took.
 *
 * Board notes drawn at designator size are held out of the reconstruction:
 * without that, three 1-mil legend labels on iPhone6Plus (`黑OL红654` …)
 * become the left table's caption, and one 2.5-mil label on iPhone6S
 * (`USB 控制`) bridges the split gap and merges its two tables into one
 * 7-column table. They are returned as notes instead.
 */
export function buildAnnotations(texts: readonly BoardText[]): BoardAnnotations | undefined {
  const labels = collectAnnotationLabels(texts);
  if (labels.length === 0) return undefined;

  const minSize = median(labels.map(l => l.size)) * TABLE_TEXT_SHARE;
  const tableSized = labels.filter(l => l.size >= minSize);

  const tables: AnnotationTable[] = [];
  const placed = new Set<BoardText>();
  if (tableSized.length >= MIN_LABELS) {
    for (const group of splitSideBySide(tableSized)) {
      const built = buildTable(group);
      if (!built) continue;
      tables.push(built.table);
      for (const l of built.placed) placed.add(l);
    }
  }
  // Only foreign-language leftovers are notes; a stray ASCII label the size
  // gate let in is board text, not something a reader needs listed.
  const notes = labels.filter(l => !placed.has(l) && hasNonLatin(l.text));
  if (tables.length === 0 && notes.length === 0) return undefined;
  return { tables, notes };
}
