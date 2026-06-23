import { test, expect } from '@playwright/test';

// Pure-function unit tests (run in Node — no browser). The scorer ranks PDF
// occurrences of a looked-up component/net by how much of its context (nets +
// pin tokens) sits AROUND each occurrence, so the schematic symbol placement
// wins over BOM / cross-reference rows.

type Mod = typeof import('../src/store/pdf-lookup-score');
async function load(): Promise<Mod> {
  return import('../src/store/pdf-lookup-score');
}

const PARAMS = { xGapMul: 12, yGapMul: 12 };

function cand(matchIndex: number, page: number, x: number, y: number, fontSize = 10) {
  return { matchIndex, page, x, y, fontSize };
}
function netHit(page: number, x: number, y: number, term: string) {
  return { page, x, y, term, weight: 2 };
}
function pinHit(page: number, x: number, y: number, term: string) {
  return { page, x, y, term, weight: 1 };
}

test('no candidates → best is -1', async () => {
  const { scoreLookupCandidates } = await load();
  const r = scoreLookupCandidates([], [netHit(0, 100, 500, 'n1')], PARAMS, 0);
  expect(r.bestMatchIndex).toBe(-1);
});

test('empty context → best is -1 (caller falls back to page-proximity)', async () => {
  const { scoreLookupCandidates } = await load();
  const r = scoreLookupCandidates([cand(0, 0, 100, 500), cand(1, 1, 100, 500)], [], PARAMS, 0);
  expect(r.bestMatchIndex).toBe(-1);
});

test('symbol page (nets present) beats BOM page (no nets)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500), cand(1, 1, 100, 500)];
  const ctx = [netHit(0, 110, 510, 'n1'), netHit(0, 90, 490, 'n2')];
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 1); // current page = BOM page
  expect(r.bestMatchIndex).toBe(0);
});

test('local proximity beats a far occurrence on the same page', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500), cand(1, 0, 100, 5000)];
  const ctx = [netHit(0, 110, 505, 'n1')]; // near candidate 0 only
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 0);
  expect(r.bestMatchIndex).toBe(0);
});

test('a nearby net outweighs a nearby pin number (net weight > pin weight)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500), cand(1, 0, 1000, 500)];
  const ctx = [netHit(0, 105, 500, 'n1'), pinHit(0, 1005, 500, '14')];
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 0);
  expect(r.bestMatchIndex).toBe(0);
});

test('context on page but far from any candidate still selects via page score (not -1)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500), cand(1, 1, 100, 500)];
  const ctx = [netHit(0, 99999, 99999, 'n1')]; // page 0, but nowhere near candidate
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 1);
  expect(r.bestMatchIndex).toBe(0);
});

test('no context + different fonts → biggest font wins (not -1)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500, 8), cand(1, 0, 200, 500, 14)];
  const r = scoreLookupCandidates(candidates, [], PARAMS, 0);
  expect(r.bestMatchIndex).toBe(1); // bigger font
});

test('no context + uniform font → -1 (caller keeps page-proximity)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500, 10), cand(1, 1, 100, 500, 10)];
  const r = scoreLookupCandidates(candidates, [], PARAMS, 0);
  expect(r.bestMatchIndex).toBe(-1);
});

test('context outranks a bigger font (font is only additive)', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500, 10), cand(1, 0, 2000, 500, 20)];
  const ctx = [netHit(0, 105, 500, 'n1')]; // near small-font candidate 0 only
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 0);
  expect(r.bestMatchIndex).toBe(0); // context beats the bigger font
});

test('equal context → bigger font breaks the tie', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500, 10), cand(1, 0, 100, 500, 16)];
  const ctx = [netHit(0, 100, 500, 'n1')]; // within window of both
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 0);
  expect(r.bestMatchIndex).toBe(1); // same context, bigger font
});

test('distinct terms counted once; more distinct nearby nets wins', async () => {
  const { scoreLookupCandidates } = await load();
  const candidates = [cand(0, 0, 100, 500), cand(1, 0, 2000, 500)];
  // candidate 0: two distinct nets nearby; candidate 1: same net repeated 3x
  const ctx = [
    netHit(0, 105, 500, 'n1'), netHit(0, 95, 505, 'n2'),
    netHit(0, 2005, 500, 'n9'), netHit(0, 2006, 501, 'n9'), netHit(0, 2007, 499, 'n9'),
  ];
  const r = scoreLookupCandidates(candidates, ctx, PARAMS, 0);
  expect(r.bestMatchIndex).toBe(0); // 2 distinct (4) > 1 distinct (2)
});
