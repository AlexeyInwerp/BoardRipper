# Heuristic component / net lookup — design

**Date:** 2026-06-23
**Status:** Design (approved in brainstorm)
**Branch:** `feature/lookup-heuristics`

## Problem

The board↔PDF lookup that links the board viewer and the schematic PDF is too
naive for real schematics:

1. **Board→PDF, multi-occurrence:** a component (or net) is mentioned many times
   in a schematic — symbol placement, BOM table, cross-reference index, change
   list. The lookup picks the *active* occurrence by mere **page proximity**
   (`pdf-store.ts` `_runSearch`, the `bestDist = |pageIndex − currentPage|`
   loop), so it frequently lands on a BOM/index row instead of the actual
   symbol. Visually it also stacks a transient single highlight box on top of
   the persistent per-page match boxes, muddying which hit was chosen.

2. **No disambiguation signal.** Today only the *first* distinctive net is folded
   into a `net@component` query, and only on the "preserve the user's typed
   search" branch — the main lookup path searches the bare component name. The
   rich context that actually identifies the schematic placement (the nets on
   the component's pins, the pin numbers printed on the symbol) is unused.

3. **Net lookup has the same weakness.** A net label appears all over the sheet;
   nothing biases the pick toward the placement surrounded by the connected
   components.

4. **Net PDF→board zoom ignores the net's extent.** Clicking a net in the PDF
   calls `boardStore.focusNet`, which zooms via `BoardRenderer.zoomToBounds`
   honoring the user's `navZoomMode`. With `keep` (and often `auto`) it pans to
   center the net but never **unzooms**, so a board-spanning net stays mostly
   off-screen. A net focus that doesn't frame the whole net is useless.

## Goals

- Pick and emphasize the **correct** occurrence of a looked-up component/net in
  the PDF, using nearby text as evidence.
- Keep **all** occurrences visibly highlighted on the page; jump to and
  emphasize the best one; keep prev/next cycling across pages.
- Apply the same heuristic to net lookups (inverted context).
- Make net PDF→board focus always frame the entire net.
- **No search lag.** No new full-document passes; no per-keystroke or per-frame
  cost. Plain typed PDF search stays on the original code path, unchanged.

## Non-goals

- No change to plain Ctrl-F typed search behavior.
- No fuzzy/semantic matching — substring + spatial proximity only.
- No new board-store → pdf-store dependency (context is built by callers).

---

## Design

### A. Best-occurrence scoring (covers points 1, 2, 3)

New pdf-store method:

```ts
lookupEntity(
  fileName: string,
  primary: string,            // component designator or net name
  contextTerms: string[],     // nets + pin tokens (caller-built, capped)
  source: SearchSource,       // 'lookup'
): void
```

It reuses the existing single-term search to populate **all** occurrences of
`primary` into `doc.matches` (so highlight-all and prev/next work unchanged),
then replaces the page-proximity "best" pick with a **context score**:

**Two-tier scoring (cheap):**

1. **Page-level.** For each page that already contains ≥1 `primary` hit, scan
   that page's merged dense-line text once per context term and count the number
   of **distinct** context terms present → `pageScore[pi]`. This alone
   distinguishes a schematic sheet (carries the component's nets) from a
   BOM/index page (does not).

2. **Local tie-break.** Only on the top-scoring page(s), for each candidate
   `primary` occurrence count the context terms whose nearest occurrence on that
   page falls within a spatial window of the candidate (reuse the existing
   `_multiTermXGap` / `_multiTermYGap` constants for the window). This separates
   the real symbol placement from a stray same-page mention.

**Selection:** `best = argmax(score)`; ties broken by the existing rule
(proximity to current page → reading order). **If `contextTerms` is empty or all
scores are zero, fall back to the current page-proximity pick exactly** — zero
regression for context-less lookups.

The chosen occurrence sets `activeMatchIndex` and the `_followTarget`
(`{ pageIndex, items }`) so the PDF zooms to the **best** hit, not `items[0]` of
a proximity pick.

**Scoring weights / anti-noise (pin tokens are short and collide):**

- Net terms weighted higher than pin terms (e.g. net = 2, pin = 1).
- Pin tokens matched only at **word boundaries** in the dense text.
- Purely-numeric **1-character** pin tokens are dropped entirely.
- Context list is **capped**: ≤ 4 distinctive nets + ≤ 4 pin tokens.

### Context construction (caller-built; pdf-store stays board-agnostic)

- **Component lookup** — `BoardRenderer.triggerFollowPdf`:
  - nets: up to 4 distinctive pin nets, reusing the existing GND/VCC/rail
    skip-list (raise the current cap from 3 → 4).
  - pins: the part's pin numbers/names (filtered by the anti-noise rules above).
- **Net lookup** (point 3): designators of components connected to the net
  (`net.pinIndices` → `parts[partIndex].name`, capped) + their pin tokens. Same
  scoring, inverted context.

### B. Highlight-all rendering (point 1)

`drawHighlights` (PdfViewerPanel.tsx) already boxes **every** match on the
current page (dim yellow) and emphasizes the active one (orange / red blink).
Changes:

1. The lookup follow effect (`consumeFollowTarget`) no longer stacks the
   competing transient `showClickHighlight` box for the lookup case — the
   persistent active/non-active styling from `drawHighlights` is the single
   source of truth. (A brief one-shot pulse on the **best** item only is
   acceptable; if kept, it fires on the best occurrence, not `items[0]`.)
2. Follow zoom targets the best-scored occurrence's items.

Cross-page occurrences remain reachable via the existing prev/next, which steps
`activeMatchIndex` and re-runs `drawHighlights`.

### C. Net lookup parity (point 3)

Wherever a **net** is the lookup target into the PDF, route through
`lookupEntity` with connected-designator context so net labels get the same
highlight-all + correct-best behavior.

### D. Net PDF→board zoom override (point 4)

In `BoardRenderer.onBoardUpdate`'s focus handler: when the consumed focus is a
**net** (`focus.partIndex == null`), pass `zoomMode: 'always'` (snap-to-fit)
regardless of the user's `navZoomMode`, keeping the existing `0.6` viewFraction
and 6× cap. Components continue to honor `navZoomMode`.

**Scope:** applies to *all* net focus (PDF→board, search, NetList) for
consistency — a net focus should always frame the whole net. The existing
single-pin bounds pad prevents over-zoom on tiny nets.

### E. Performance

- Scoring touches **only pages that already contain a `primary` hit** (few), with
  a **capped** context list (≤ 8 terms). That is a handful of substring scans
  layered on the single full-document term scan that already runs — negligible
  added cost, **no extra full-document passes**.
- The local spatial tie-break runs **only on the top-scoring page(s)**.
- Context is derived from the board once per lookup — O(pins of one part) or
  O(pins of one net).
- Plain typed PDF search supplies no context → original path, no added work. No
  new per-keystroke or per-frame cost.

---

## Files touched

| File | Change |
| --- | --- |
| `src/frontend/src/store/pdf-store.ts` | `lookupEntity` + scoring helpers (page-level + local spatial), best-pick selection. |
| `src/frontend/src/renderer/BoardRenderer.ts` | Build component context (nets cap 3→4 + pin tokens) and call `lookupEntity`; net-focus `zoomMode: 'always'` override. |
| `src/frontend/src/panels/PdfViewerPanel.tsx` | Follow path zooms to best item; drop/relocate competing transient highlight. |
| net-lookup callers (as wired) | Build connected-designator context and call `lookupEntity`. |
| `src/frontend/tests/` | New Playwright spec. |

## Testing

- **Pure scoring unit test:** synthetic text items modeling a symbol page (net
  labels + pin numbers around the designator) vs a BOM page (designator in a
  bare table). Assert best = symbol-page occurrence; assert empty-context falls
  back to page-proximity.
- **Anti-noise:** a pin-table row of bare `1 2 3` must not outscore the symbol
  placement surrounded by distinctive nets.
- **Playwright e2e:** board + linked PDF fixture with a known multi-occurrence
  component — assert the active (orange) highlight lands on the schematic
  placement; assert net PDF→board focus unzooms to frame the whole net. Bump
  `PARSER_VERSION` only if parser output changes (it does not here); note the
  IndexedDB cache caveat.

## Risks / mitigations

- **Wrong context (sparse/odd schematics):** all-zero score falls back to current
  behavior → never worse than today.
- **Pin-token noise:** weight + word-boundary + drop-1-char rules; capped list.
- **Net "always-fit" surprises users who set `keep`:** intended per point 4;
  scoped to nets only, components unaffected.
