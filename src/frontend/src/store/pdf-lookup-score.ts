/**
 * Pure scoring for heuristic component/net lookup in a PDF.
 *
 * Given the occurrences of a looked-up entity (a component designator or a net
 * name) and the positions of its *context* terms — the nets on the component's
 * pins and the pin numbers, or for a net the connected designators — rank each
 * occurrence by how much of that context sits AROUND it. The schematic symbol
 * placement is surrounded by its net labels and pin numbers, so it scores far
 * higher than a BOM row or cross-reference index where the designator appears
 * with none of its neighbours.
 *
 * Dependency-free on purpose: all PDF text extraction lives in pdf-store; this
 * module does geometry only, so it is unit-testable with synthetic coordinates.
 */

export interface LookupCandidate {
  /** Index into the document's flat `matches` array. */
  matchIndex: number;
  page: number;
  /** Occurrence anchor in PDF page space (transform[4], transform[5]). */
  x: number;
  y: number;
  fontSize: number;
}

export interface LookupContextHit {
  page: number;
  x: number;
  y: number;
  /** Normalised key used for distinct-term counting. */
  term: string;
  /** Relative importance — nets weigh more than pin numbers. */
  weight: number;
}

export interface LookupScoreParams {
  /** Horizontal window = candidate.fontSize × xGapMul. */
  xGapMul: number;
  /** Vertical window = candidate.fontSize × yGapMul. */
  yGapMul: number;
}

export interface LookupScoreResult {
  /** Best occurrence's matchIndex, or -1 when there is no context signal at
   *  all (no candidates / no context / every score zero) — the caller then
   *  keeps its own page-proximity pick. */
  bestMatchIndex: number;
  /** matchIndex → total score (exposed for tests / debugging). */
  scoreByMatch: Map<number, number>;
}

/** Local proximity dominates; page-level presence only breaks ties. */
const LOCAL_DOMINANCE = 1000;

/**
 * Per page: weight of each distinct context term present anywhere on it.
 * A term seen multiple times still counts once (its weight).
 */
function pageScores(contextHits: LookupContextHit[]): Map<number, number> {
  const perPageTerms = new Map<number, Map<string, number>>();
  for (const h of contextHits) {
    let terms = perPageTerms.get(h.page);
    if (!terms) { terms = new Map(); perPageTerms.set(h.page, terms); }
    if (!terms.has(h.term)) terms.set(h.term, h.weight);
  }
  const out = new Map<number, number>();
  for (const [page, terms] of perPageTerms) {
    let sum = 0;
    for (const w of terms.values()) sum += w;
    out.set(page, sum);
  }
  return out;
}

export function scoreLookupCandidates(
  candidates: LookupCandidate[],
  contextHits: LookupContextHit[],
  params: LookupScoreParams,
  currentPageIndex: number,
): LookupScoreResult {
  const scoreByMatch = new Map<number, number>();
  if (candidates.length === 0) return { bestMatchIndex: -1, scoreByMatch };

  const pageScore = pageScores(contextHits);

  // Group context hits by page so the local pass only scans the same page.
  const hitsByPage = new Map<number, LookupContextHit[]>();
  for (const h of contextHits) {
    let arr = hitsByPage.get(h.page);
    if (!arr) { arr = []; hitsByPage.set(h.page, arr); }
    arr.push(h);
  }

  let best: LookupCandidate | null = null;
  let bestTotal = -1;

  for (const c of candidates) {
    const base = pageScore.get(c.page) ?? 0;

    // Local: distinct context terms with ≥1 occurrence inside the window.
    const xWin = c.fontSize * params.xGapMul;
    const yWin = c.fontSize * params.yGapMul;
    const nearTerms = new Map<string, number>();
    for (const h of hitsByPage.get(c.page) ?? []) {
      if (Math.abs(h.x - c.x) > xWin || Math.abs(h.y - c.y) > yWin) continue;
      if (!nearTerms.has(h.term)) nearTerms.set(h.term, h.weight);
    }
    let local = 0;
    for (const w of nearTerms.values()) local += w;

    const total = local * LOCAL_DOMINANCE + base;
    scoreByMatch.set(c.matchIndex, total);

    if (total > bestTotal) {
      best = c; bestTotal = total;
    } else if (total === bestTotal && best) {
      // Tie-break: nearer the current page, then earlier in reading order.
      const dCur = Math.abs(c.page - currentPageIndex);
      const dBest = Math.abs(best.page - currentPageIndex);
      if (dCur < dBest || (dCur === dBest && c.matchIndex < best.matchIndex)) best = c;
    }
  }

  // Zero total everywhere → no usable signal; let the caller fall back.
  if (!best || bestTotal <= 0) return { bestMatchIndex: -1, scoreByMatch };
  return { bestMatchIndex: best.matchIndex, scoreByMatch };
}
