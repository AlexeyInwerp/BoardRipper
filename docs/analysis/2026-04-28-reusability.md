# Code Review: Reusability & Organization (2026-04-28)

**Scope:** Follow-up analysis of BoardRipper after 1 month of feature work (2026-03-30 → 2026-04-28)  
**Codebase:** v0.14.0, ~610K LoC, ~100 frontend components  
**Review Status:** 22 prior issues resolved, 5 new findings identified  

---

## Executive Summary

The codebase continues to show disciplined architecture. The prior review's high-impact recommendations (R-1 PDF loading unification, R-2 store hook factory, R-4 emitter base class, R-5 dead code removal) have all been **implemented and are working well**. The recent addition of the Library panel's binding workflow brings new code (~1,780 lines) with two areas of duplication: tree-view filter logic and binding sort-key computation. The BoardRenderer has grown 825 lines (3,164 → 3,989) due to pad shape rendering features. No critical structural issues detected.

---

## Verification of Prior Findings

### ✅ FIXED (All 5 Critical/Important Reusability Items)

| ID | Issue | Status | Evidence |
|----|-------|--------|----------|
| **R-1** | PDF loading duplication (3 locations) | **FIXED** | `store/file-actions.ts` created; Toolbar, App, LibraryPanel all call `openPdfFiles()` |
| **R-2** | useSyncExternalStore boilerplate (3 hooks) | **FIXED** | `hooks/createStoreHook.ts` factory; `useBoardStore`, `useDatabank`, `usePdfStore` all use it |
| **R-4** | Store subscription pattern (7 stores) | **FIXED** | `store/emitter.ts` base class exists; all stores inherit from it |
| **R-5** | Dead `BoardCanvas.tsx` | **FIXED** | File deleted; zero imports found |
| **D-7** | `CLAUDE.md` parser signature | **FIXED** | Now correctly states `(buffer: ArrayBuffer) → BoardData \| Promise<BoardData>` |

### ⏸️ DEFERRED (Still Applicable But Not Urgent)

| ID | Issue | Status | Note |
|----|-------|--------|------|
| **R-3** | Parser finalization helpers | **NOT FIXED** | Would reduce duplication across 7 parsers; low impact, nice-to-have |
| **R-6** | Split render-settings.ts geometry | **NOT FIXED** | Still monolithic at 794 lines; not a blocker |
| **A-1** | Decompose BoardRenderer | **NOT FIXED** | Intentional decision per prior review; renderer grew 825 lines due to pad shapes |

---

## New Findings

### [Important] N-1: Duplicated Tree-View Filter Logic in LibraryPanel

**Files:** `panels/LibraryPanel.tsx:1286–1294` (MetadataView), `1374–1381` (ModelView)

The `filteredGroups` computation is nearly identical across MetadataView and ModelView:

**MetadataView** (lines 1286–1294):
```typescript
const filteredGroups = useMemo(() => groups.map(g => ({
  ...g,
  boardNumbers: g.boardNumbers.map(bn => ({
    ...bn,
    files: bn.files.filter(filterFile),
  })).filter(bn => bn.files.length > 0),
  ungrouped: g.ungrouped.filter(filterFile),
})).filter(g => g.boardNumbers.length > 0 || g.ungrouped.length > 0), [groups, filterFile]);
```

**ModelView** (lines 1374–1381):
```typescript
const filteredGroups = useMemo(() => groups.map(g => ({
  ...g,
  variants: g.variants.map(v => ({
    ...v,
    files: v.files.filter(filterFile),
  })).filter(v => v.files.length > 0),
  unresolved: g.unresolved.filter(filterFile),
})).filter(g => g.variants.length > 0 || g.unresolved.length > 0), [groups, filterFile]);
```

Both follow the same pattern: map outer groups, filter inner arrays, drop empty parents. Only field names differ (`boardNumbers` vs `variants`, `ungrouped` vs `unresolved`).

**Correction:** Extract a generic helper:
```typescript
function filterTreeGroups<G extends { [k: string]: any[] }>(
  groups: G[],
  filterFile: (f: DatabankFile) => boolean,
  structure: { subKey: string; itemKey: string },
): G[] {
  return groups.map(g => {
    const filtered = {
      ...g,
      [structure.subKey]: (g[structure.subKey] as any[])
        .map(item => ({
          ...item,
          [structure.itemKey]: item[structure.itemKey]?.filter(filterFile),
        }))
        .filter((item: any) => item[structure.itemKey]?.length > 0),
      [structure.itemKey === 'files' ? 'ungrouped' : 'unresolved']: 
        g[structure.itemKey === 'files' ? 'ungrouped' : 'unresolved']?.filter(filterFile),
    };
    return filtered;
  }).filter(g => Object.values(g).some(v => Array.isArray(v) && v.length > 0));
}
```

Or simpler: create a `groupFilterer(subKey, itemKey)` closure factory.

**Impact:** Removes ~30 lines; improves consistency when adding new tree views; reduces cognitive load (single filter logic to maintain).

**Severity:** Minor — both implementations work correctly; duplication is low-risk but indicates a missed abstraction.

---

### [Important] N-2: Duplicated Binding Sort Logic in BindingsGrouped

**Files:** `panels/LibraryPanel.tsx:886–913`

The `groups` and `flatSorted` useMemo blocks both compute the same sort key logic but apply it to different collections:

**In `groups` (lines 892–897):**
```typescript
buckets[k].sort((a, b) => {
  const am = a.source === 'binding' ? Number(a.auto_matched) : 0;
  const bm = b.source === 'binding' ? Number(b.auto_matched) : 0;
  if (am !== bm) return am - bm;  // manual (0) before auto-matched (1)
  return a.pdf_filename.localeCompare(b.pdf_filename);
});
```

**In `flatSorted` (lines 903–910):**
```typescript
out.sort((a, b) => {
  const am = a.source === 'binding' ? Number(a.auto_matched) : 0;
  const bm = b.source === 'binding' ? Number(b.auto_matched) : 0;
  if (am !== bm) return am - bm;
  const an = a.source === 'binding' ? a.board_filename : a.pdf_filename;
  const bn = b.source === 'binding' ? b.board_filename : b.pdf_filename;
  return an.localeCompare(bn);
});
```

The auto_matched comparison is identical. The filename source differs slightly (`pdf_filename` vs ternary logic on `board_filename` vs `pdf_filename`), but the **sort-key extraction logic is repeated**.

**Correction:** Extract sort-key function:
```typescript
function bindingSortKey(r: RenderedBinding, useBoard: boolean): [number, string] {
  const matched = r.source === 'binding' ? Number(r.auto_matched) : 0;
  const name = useBoard
    ? (r.source === 'binding' ? r.board_filename : r.pdf_filename)
    : r.pdf_filename;
  return [matched, name];
}

// Usage:
buckets[k].sort((a, b) => {
  const [am, an] = bindingSortKey(a, false);
  const [bm, bn] = bindingSortKey(b, false);
  return am !== bm ? am - bm : an.localeCompare(bn);
});

out.sort((a, b) => {
  const [am, an] = bindingSortKey(a, isBoard);
  const [bm, bn] = bindingSortKey(b, isBoard);
  return am !== bm ? am - bm : an.localeCompare(bn);
});
```

**Impact:** Removes ~12 lines; clarifies what "sort key" means; enables consistent reuse if binding sorting logic changes (e.g., add category as tie-breaker).

**Severity:** Minor — both sortings are correct; duplication is low-impact but violates DRY.

---

### [Important] N-3: LiveBrowser PDF Opening Doesn't Use Shared openPdfFiles()

**Files:** `panels/LibraryPanel.tsx:608–613`

The LiveBrowser view (live filesystem browser) manually opens PDFs without using the shared `openPdfFiles()` helper:

```typescript
if (ext === 'pdf') {
  boardStore.addPdf(fileObj);
  boardStore.autoBindPdf(fileObj.name);
  await pdfStore.loadFile(fileObj);
  ensurePdfPanel(fileObj.name);
  pdfStore.switchTo(fileObj.name);
}
```

Compare to `openPdfFiles()` (lines 13–54 in `store/file-actions.ts`), which does the same sequence but also:
1. Loops over multiple files (future-proofing)
2. Has centralized error handling
3. May gain new features in one place

The LiveBrowser PDF path is an independent duplication of **5 of 6 lines** from `openPdfFiles()`.

**Correction:** Call `openPdfFiles([fileObj])` instead:
```typescript
if (ext === 'pdf') {
  await openPdfFiles([fileObj]);
}
```

**Impact:** Removes 4 lines; ensures LiveBrowser gets any future PDF-opening improvements; reduces test surface (one code path to test instead of two).

**Severity:** Minor — low risk because LiveBrowser is less frequently used; but represents a gap in the R-1 fix.

---

### [Important] N-4: LibraryPanel Has Grown 1,780 Lines Without Subsplitting

**Files:** `panels/LibraryPanel.tsx`

The file has grown from ~1,400 lines (estimated from prior review) to **1,780 lines** in one month, encompassing:

- Main `LibraryPanel()` component (lines 56–569): ~500 lines
- `LiveBrowser()` view (lines 574–665): ~90 lines
- `FileDetailPane()` + binding UI (lines 736–859): ~120 lines
- `BindingsGrouped()` + `BindingRow()` + `BindPicker()` (lines 862–1122): ~260 lines
- `HistoryView()` (lines 1126–1220): ~95 lines
- `SearchResultsView()` (lines 1224–1274): ~50 lines
- `MetadataView()` (lines 1278–1361): ~85 lines
- `ModelView()` (lines 1365–1453): ~85 lines
- `FolderView()` (lines 1484–end): ~100 lines
- Utility functions + constants (lines 14–50): ~37 lines

This is **9 quasi-independent views + 3 binding components + utilities in a single file**.

The binding workflow (BindPicker, BindingsGrouped, BindingRow, FileDetailPane) is particularly self-contained and would benefit from extraction.

**Correction:** Create `panels/bindings/`:
- `panels/bindings/BindingsGrouped.tsx` — categorized binding list
- `panels/bindings/BindPicker.tsx` — candidate picker with scoring
- `panels/bindings/BindingRow.tsx` — single row renderer
- `panels/bindings/index.ts` — exports + type definitions

Move binding-specific utilities (BINDING_CATEGORIES, CATEGORY_LABEL, autoOpenDefault, normalizeCategory, nameMatchScore, metadataMatchScore) to `panels/bindings/types.ts`.

**Impact:**
- LibraryPanel drops to ~950 lines (reasonable panel size)
- Binding tests can be isolated
- Future datasheet-linking features (derived rows) have their own module
- Easier to parallelize work on bindings vs. browsing features

**Severity:** Minor — not blocking; purely organizational. The 1,780 line file is still readable but approaching the "hard to navigate" threshold.

---

### [Minor] N-5: BoardRenderer Growth (3,164 → 3,989 lines) Due to Pad Shape Work

**Files:** `renderer/BoardRenderer.ts`

The file grew **+825 lines** (26% increase) since the prior review, driven by:

1. Pad shape rendering for TVW/Allegro (new `drawPad` variants for round/oblong/rect/poly)
2. Pin-to-pad selection matching logic
3. Pad layer visibility toggling
4. Real copper bounds vs. clearance frame handling

**Commit context:** `a5a3112` (TVW pad shapes), `eecb96b` (Allegro pad shapes), `bc059dd` (pin selection fix).

While the growth is organic (new feature), the file is now reaching saturation. The prior review recommended decomposition into subsystems (ViewportManager, SelectionRenderer, HitTester, etc.), which remains valid.

**Correction:** If pad-shape work continues (e.g., vias, drill hole rendering), consider extracting a `PadRenderer` subsystem:
```typescript
class PadRenderer {
  drawPads(layer: Container, parts: Part[], ...): void
  drawPadSelection(layer: Container, pad: Pad, highlight: boolean): void
  getPadShape(pad: Pad): Graphics
}
```

This would move ~300–400 lines out of BoardRenderer and improve clarity.

**Impact:** Not urgent (renderer is still functional and well-commented). Refactoring becomes necessary only if renderer exceeds ~4,500 lines.

**Severity:** Minor — architectural feedback, not a bug or maintainability crisis.

---

## Code Quality Observations

### ✅ Strengths

1. **Consistent store pattern:** All stores inherit from `Emitter`, making subscribe/notify uniform
2. **Centralized PDF opening:** `openPdfFiles()` eliminates duplication; extends to all entry points
3. **Lazy tree computation:** MetadataView/ModelView defer tree grouping until the tab is actually shown (good perf)
4. **Binding categorization:** Clean schema (v8 migration) with sensible defaults
5. **Tree expansion persistence:** `usePersistedExpanded()` saves UI state correctly via localStorage

### ⚠️ Areas to Monitor

1. **Tree-view abstraction gap:** MetadataView and ModelView are 85 lines each with very similar filter logic; a third tree view (e.g., custom grouping) would make the gap obvious
2. **Binding sort logic:** Small duplication but represents missed functional extraction
3. **LiveBrowser isolation:** The live filesystem browser doesn't use shared helpers; creates local variation risk
4. **File growth:** LibraryPanel at 1,780 lines is approaching the "extract views" threshold; SettingsPanel and PdfViewerPanel are also large (1,765 and 2,981 lines)

---

## Summary Table: Prior Issues → Current State

| ID | Finding | Prior Status | Current | Action |
|----|---------|--------------|---------|--------|
| R-1 | PDF loading duplication | Important | ✅ FIXED | Use `openPdfFiles()` (except LiveBrowser) |
| R-2 | Store hook boilerplate | Important | ✅ FIXED | `createStoreHook` factory in use |
| R-3 | Parser finalization | Minor | NOT FIXED | Low priority; would save ~100 lines |
| R-4 | Store emitter pattern | Minor | ✅ FIXED | `Emitter` base class created |
| R-5 | Dead BoardCanvas | Minor | ✅ FIXED | Deleted |
| R-6 | render-settings geometry | Suggestion | NOT FIXED | Low priority; can defer |
| N-1 | Tree filter duplication | NEW | Minor | Extract `filterTreeGroups()` helper |
| N-2 | Binding sort logic | NEW | Minor | Extract `bindingSortKey()` function |
| N-3 | LiveBrowser PDF path | NEW | Minor | Use `openPdfFiles([fileObj])` |
| N-4 | LibraryPanel size | NEW | Minor | Extract binding components to `panels/bindings/` |
| N-5 | BoardRenderer growth | NEW | Minor | Monitor; refactor if >4500 lines |

---

## Recommendations (Priority Order)

### Phase A: Quick Wins (< 2 hours)

1. **N-3:** Update LiveBrowser to use `openPdfFiles()` — removes 4 lines, ensures consistency
2. **N-2:** Extract `bindingSortKey()` helper — ~12 lines saved, improves clarity

### Phase B: Structural Improvements (2–4 hours)

3. **N-1:** Create `filterTreeGroups()` or generic tree filter — reduces duplication, enables future tree views
4. **N-4:** Extract binding components to `panels/bindings/` — improves modularity, prep for datasheet linking feature

### Phase C: Future Monitoring

5. **N-5:** Track BoardRenderer size; if it exceeds 4,500 lines, refactor pad shape logic into subsystem
6. **R-3:** Gather feedback on parser finalization helpers; implement if pattern becomes painful across new formats

---

**Total new duplication found: ~46 lines** (sort logic, tree filters, LiveBrowser PDF)  
**Estimated refactoring effort: 3–4 hours for all recommendations**  
**Risk level: Very Low** — all fixes are mechanical, no logic changes needed

