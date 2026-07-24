# Tools Tab — Design

**Date:** 2026-07-22
**Status:** Approved (design), pending implementation plan

## Summary

Add a new top-level sidebar tab, **Tools**, positioned between **Library** and
**Settings**. It hosts a small set of bench calculators for electronics repair
work plus links/placeholders for other workbench features. Donor boards stay
where they are today (the Library panel's "Bench" view / `viewMode === 'bench'`);
this spec does **not** touch donor boards.

v1 contents:

- **Calculators:** Resistor color-band decoder, SMD resistor code decoder,
  Capacitor code/value converter.
- **Workbench:** Worklists (read-only catalog of every worklist stored on this
  device), Database Editor (launcher → opens the existing Dockview panel),
  Wiki (disabled "soon" placeholder).

## Relationship to the parked `feat/library-bench-folders` branch

That branch (2026-07-01/02) built the same "bench" idea *inside* the Library
panel — a Donor boards / Worklists / Device DB variant switcher. Main has since
moved the opposite way (2026-07-23 nested Donor boards under the PDF tab), so
the branch's Library restructure is **superseded and will not be merged**;
merging it would delete the Live folder browser and revert the newer donor
nesting across four conflicts.

This design reaches the same goal in a separate top-level tab, which touches no
Library code and therefore has no conflicts. Two pieces of that branch are not
superseded and are **reused verbatim** rather than rewritten:

- `ensureDatabaseEditorPanel()` → `store/dockview-api.ts`
- `worklistStore.listAllStored()` + the catalog UI and CSS

Because that code already exists and was proven on the branch, **Worklists ships
as a real read-only catalog, not a placeholder.** Only Wiki remains a
placeholder — it was never built anywhere.

The branch's third salvageable piece, the backend per-branch rescan
(`Scanner.ScanFolderAsync`, `POST /api/databank/scan/folder`,
`databankStore.scanFolder()`), belongs to the **Folders** tab and is explicitly
out of scope here; it is recorded as Phase 2 in the implementation plan.

## Non-goals

- No changes to donor boards or the Library panel at all.
- No inductor calculator in v1 (floated, deferred).
- No backend changes. Calculators are pure client-side.
- Worklists is **read-only** — no editing, no board-switching, no shared/remote
  worklist database (that remains future roadmap work).
- No implementation of Wiki — placeholder only.

## Navigation & layout

- New `SidebarTab` value `'tools'`, added to `SidebarTab` type and the `TABS`
  array in `src/frontend/src/components/Sidebar.utils.ts`, ordered
  `library, tools, settings, debug`.
- `showSidebarTab` and related helpers extend to the new tab with no special
  casing beyond what already exists.
- A new `ToolsPanel` component mounts inside `Sidebar.tsx`, toggled with the same
  `display: none` pattern the other tab panels use (library/settings/debug).
- `ToolsPanel` owns one piece of local React state: `activeTool: null |
  'resistor' | 'smd' | 'capacitor'`.
  - `null` → the landing list (grouped: **Calculators**, **Workbench**).
  - A calculator value → that calculator renders in place of the list, with a
    back link (`← Tools / <name>`) at the top that resets `activeTool` to `null`.
- Styling is plain, matching the existing Library list: text name, muted
  subtitle, right-aligned muted status word. **No emojis, no decorative glyphs,
  no per-item colors, no bold-for-emphasis** (per the project's
  no-decorative-UI rule). Icons are omitted (chosen option A).

### Landing list contents

```
Calculators
  Resistor color-band      4 / 5 / 6-band to ohms
  SMD resistor code        103, 4R7, 01C to ohms
  Capacitor converter      104 to pF / nF / µF

Workbench
  Worklists                every worklist stored on this device
  Database Editor          opens panel
  Wiki                     soon        (disabled)
```

`activeTool` is `null | 'resistor' | 'smd' | 'capacitor' | 'worklists'`.
Database Editor is not a tool view — it launches its own Dockview panel and
leaves the landing list in place.

### Lite build behavior

- The three calculators are pure client-side and remain available in lite build.
- Workbench entries that require a backend (Database Editor) are hidden when no
  backend is available, mirroring how the Library tab is gated. The Tools tab
  itself is shown in lite build (unlike Library).

## Calculator logic (pure, unit-tested)

Three pure modules under `src/frontend/src/tools/`, each a pure function
`(input) => result`, mirroring the "parsers are pure functions" convention. Each
gets a vitest unit test (`npm run test:unit`, vitest is already configured).

### `resistor-color.ts`

- Supports 4-, 5-, and 6-band resistors.
  - 4-band: 2 digit bands, 1 multiplier, 1 tolerance.
  - 5-band: 3 digit bands, 1 multiplier, 1 tolerance.
  - 6-band: 3 digit bands, 1 multiplier, 1 tolerance, 1 temperature coefficient
    (ppm/K).
- Color→value tables for digits, multipliers (including gold ×0.1, silver ×0.01),
  tolerances, and temp-co.
- Input: band count + selected color per band. Output:
  `{ ohms, tolerancePct, min, max, tempCoPpm?, formatted }` where `formatted`
  uses engineering suffixes (Ω / kΩ / MΩ / GΩ).
- Invalid band combinations (e.g. a color with no tolerance meaning selected in
  the tolerance slot) surface as a structured error rather than throwing.

### `smd-resistor.ts`

- Accepts, case-insensitively:
  - 3-digit: `103` → 10 kΩ (first two digits × 10^third).
  - 4-digit: `1002` → 10 kΩ (first three digits × 10^fourth).
  - R-notation: `4R7` → 4.7 Ω, `R47` → 0.47 Ω, `0R5` → 0.5 Ω (R marks the
    decimal point).
  - EIA-96: two significant-figure digits + a multiplier letter, e.g. `01C` →
    100 × 10^2 = 10 kΩ. Uses the standard EIA-96 code table + letter multiplier
    table.
- Input: raw code string. Output: `{ ohms, formatted }` or a parse error
  `{ error }`.

### `capacitor.ts`

- Bidirectional and multi-format:
  - Cap code: `104` → 100 nF (first two digits × 10^third, in **pF**).
  - p/n/µ notation: `4n7` → 4.7 nF, `22p` → 22 pF, `1u` → 1 µF (letter marks the
    decimal point and the unit).
  - Optional trailing tolerance letter (e.g. `J`=±5%, `K`=±10%, `M`=±20%) and/or
    voltage — parsed if present, ignored for the core value otherwise.
- Input: raw string. Output: the capacitance normalized and shown across all
  three units `{ pF, nF, uF, tolerancePct?, formatted }`, or `{ error }`.
- Because pF is the canonical internal unit, "bidirectional" means a single
  parse to pF followed by rendering the value in pF/nF/µF simultaneously; there
  is no separate value→code reverse path required in v1 beyond showing the
  normalized breakdown.

The UI wrappers (band swatch pickers for the color decoder, a code text input
for SMD and capacitor) are thin: they collect input, call the pure function, and
render the readout. No calculation logic lives in the components.

## Workbench entries

- **Worklists.** A read-only catalog of every worklist persisted in IndexedDB,
  flattened to one row per worklist: worklist name · board file name · part/net
  counts. Backed by `worklistStore.listAllStored()` (an `objectStore('boards')
  .getAll()` snapshot that does not disturb the live cache). Empty state: "No
  worklists stored yet." A one-line caption notes a shared knowledge database is
  coming. Both the method and the markup are **reused verbatim** from
  `feat/library-bench-folders`; they need no adaptation because
  `BoardWorklistes`, the `STORE` constant and `openDB()` already exist on main.
- **Database Editor.** Reuse the existing open mechanism. `openDatabaseEditor()`
  is currently a private function in `SettingsPanel.tsx` (~line 952) that calls
  `getDockviewApi()` and adds/focuses a Dockview panel with a stable id
  `database-editor`. Rather than inventing a new home for it, adopt the parked
  branch's version: `ensureDatabaseEditorPanel()` in
  `src/frontend/src/store/dockview-api.ts`, beside the existing
  `ensureBoardPanel`/`ensurePdfPanel` helpers. `SettingsPanel` and `ToolsPanel`
  both call it, so there is one copy. Hidden when no backend.
- **Wiki.** A disabled row with a muted "soon" status and no click handler.

## Testing

### vitest (unit)

Known-value cases for each module:

- `resistor-color`: brown-black-red-gold (4-band) → 1 kΩ ±5%;
  brown-black-black-red-brown (5-band) → 10.0 kΩ ±1%; a 6-band case exercising
  temp-co.
- `smd-resistor`: `103` → 10 kΩ; `1002` → 10 kΩ; `4R7` → 4.7 Ω; `R47` → 0.47 Ω;
  `01C` → 10 kΩ; an invalid code → error.
- `capacitor`: `104` → 100 nF; `4n7` → 4.7 nF; `22p` → 22 pF; `1u` → 1 µF;
  a tolerance-suffixed code → correct tolerance; an invalid code → error.

### Playwright (E2E)

- The **Tools** tab is present in the sidebar (and appears in the expected
  order).
- Clicking a calculator opens it; the back link returns to the landing list.
- Entering a known code in the SMD (or capacitor) tool shows the expected
  readout.
- Selecting bands in the color decoder shows the expected readout.
- The **Worklists** entry opens the catalog and the back link returns.
- The **Database Editor** workbench entry opens the Database Editor panel.

## Files touched (anticipated)

- `src/frontend/src/components/Sidebar.utils.ts` — add `'tools'` tab.
- `src/frontend/src/components/Sidebar.tsx` — mount `ToolsPanel`.
- `src/frontend/src/panels/ToolsPanel.tsx` — new.
- `src/frontend/src/panels/tools/{ResistorColorTool,SmdResistorTool,CapacitorTool,WorklistsTool}.tsx` — new.
- `src/frontend/src/tools/format.ts` — new (+ test; `formatOhms`, `trimNum`).
- `src/frontend/src/tools/resistor-color.ts` — new (+ test).
- `src/frontend/src/tools/smd-resistor.ts` — new (+ test).
- `src/frontend/src/tools/capacitor.ts` — new (+ test).
- `src/frontend/src/store/dockview-api.ts` — add `ensureDatabaseEditorPanel()` (salvaged).
- `src/frontend/src/store/worklist-store.ts` — add `listAllStored()` (salvaged).
- `src/frontend/src/panels/SettingsPanel.tsx` — use the shared helper.
- `src/frontend/tests/tools-tab.spec.ts` — new E2E.
- CSS for the Tools panel (co-located with the existing panel styles).

## Open questions

None outstanding. Inductor calculator deferred to a future iteration.
