# OpenBoardData (OBD) integration — design

**Date:** 2026-05-01
**Status:** Spec approved by user. Implementation plan pending.

## Goal

Add a per-board diagnostic-measurement layer to BoardRipper, sourced from openboarddata.org. Per-net diode / voltage / resistance readings plus free-form repair notes are surfaced in the LibraryPanel detail pane for boards whose `board_number` matches an entry in the OBD index. Data is fetched on demand by the user, never bundled or auto-synced.

This is the first sub-project of OBD integration. Canvas pin-hover tooltips and `ComponentInfoPanel` enrichment are intentionally deferred to later sub-projects so v1 can validate the fetch / parse / cache / display pipeline end-to-end before adding renderer work.

## Non-goals (this sub-project)

- Canvas pin-hover tooltip surface for OBD data.
- Adding diode / voltage / resistance columns to `ComponentInfoPanel.tsx`.
- Populating the `board_openboarddata` table from the boards.db v2 schema. This sub-project deliberately does not touch `boards.db` at all — see "Decoupling from boards.db" below.
- Bundling the `inflex/OpenBoardData` GitHub repo (rejected: stale).
- Background sync, scheduled refresh, ETag-based incremental updates.
- Contributing measurements back upstream (openboarddata.org has no contribution API; users email the maintainer directly).

## Decoupling from boards.db

OBD is treated as an **independent filesystem-backed data layer**, separate from the curated `boards.db`. Reasons:

- `boards.db` is BoardRipper's own curated reference data (brands, families, models, ODM resolution). OBD is community-contributed external data under ODbL — different lifecycle, different license, different update cadence.
- A v1 that doesn't write to `boards.db` lets us ship without coupling to the boards.db v2 redesign (which has a committed plan but is not yet implemented).
- The v2 schema's `board_openboarddata(board_uuid, external_id, notes)` table is reserved for *explicit* per-board variant overrides (e.g. "this board canonically uses the `iP7P_intel` OBD entry"). v1 doesn't need explicit overrides — substring matching against `board_number` covers the case organically.

If the matching heuristic produces false positives in practice, the v2 table is the natural place to record overrides — but that's a follow-up sub-project, not this one.

## Source and licensing

**Source:** `openboarddata.org` only.

**License:** ODbL 1.0 (Open Database License, share-alike).

**Distribution constraint:** ODbL share-alike means we cannot bundle .org's data inside the BoardRipper Docker image or ship a tarball with the app. Users fetch on demand into their own data directory, where the share-alike obligation falls on them if they redistribute. The Settings UI carries a non-dismissible disclaimer stating this.

The `inflex/OpenBoardData` GitHub mirror (MIT, ~113 boards) was considered as an alternative transport. Rejected: data is significantly older than .org and would mislead users about coverage.

## Architecture

### On-disk layout

All OBD state lives under `<library_root>/.boardripper/openboarddata/`:

```
<library_root>/.boardripper/openboarddata/
├── index.json                                  # written by sync; ~hundreds of KB
├── laptops/apple/820-00045.txt                 # raw OBDATA_V002 from .org
├── laptops/apple/820-00045.parsed.json         # cached parse, sibling of .txt
├── laptops/apple/iP7P_intel.txt
├── laptops/apple/iP7P_intel.parsed.json
└── laptops/apple/iP7P_qualcomm.txt
    ...
```

- `index.json` is the manifest: a single file written by the index-sync action listing every available bpath. Without this file, the OBD UI is hidden.
- `<bpath>.txt` is the raw response from .org's `?a=generate&bpath=<X>` endpoint, written verbatim. Lazy: appears only after the user clicks "Fetch" for that board.
- `<bpath>.parsed.json` is the parser's output, cached so the detail pane doesn't re-parse on every render. Invalidated by deleting alongside the `.txt`.

The bpath structure mirrors .org 1:1 (`category/manufacturer/board`), which makes matching, lookup, and offline browsing trivial.

### Backend (Go) — `src/backend/obd/`

New package with four files:

- `types.go` — shared types: `Index`, `IndexEntry`, `ObdData`, `Match`.
- `scraper.go` — fetches and parses category index pages from openboarddata.org; produces an `Index` value.
- `parser.go` — parses `OBDATA_V002` raw text into the `ObdData` shape.
- `store.go` — filesystem operations: read/write `index.json`, atomic write of `<bpath>.txt` + `<bpath>.parsed.json`, "is fetched?" check, "delete cache" operation.

### Backend HTTP handlers — `src/backend/handlers/obd.go`

Four new endpoints registered in the existing handler wire-up:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/obd/index/sync` | Scrapes openboarddata.org category index pages, writes `index.json` atomically. Returns `{ "synced_at": "<iso>", "board_count": N }`. Single-flight: returns 409 if a sync is already running. |
| `GET` | `/api/obd/match?board_number=<X>` | Returns `{ "matches": [{ "bpath", "brand", "category", "fetched": bool, "fetched_at": "<iso>|null" }] }`. Empty array when no `index.json`, no match, or empty `board_number`. The `fetched` / `fetched_at` fields are computed at request time by stat-ing `<bpath>.txt` on disk — they're not persisted in `index.json`. |
| `POST` | `/api/obd/fetch?bpath=<X>` | Validates bpath against the loaded index, downloads `?a=generate&bpath=<X>` from .org, parses, writes `.txt` and `.parsed.json` atomically. Returns the parsed payload. Idempotent — overwrites existing files (acts as both fetch and update). Single-flight per bpath. |
| `DELETE` | `/api/obd/cache` | Removes the entire `<library_root>/.boardripper/openboarddata/` folder — wired to the "Delete all OBD data" button. |

### Frontend — surfaces

Two surfaces in v1:

1. **Library detail panel** (the lower pane of `LibraryPanel.tsx` shown when a board file is selected) — the OBD section appears here.
2. **Settings panel new "Library" tab** — sync controls and disclaimer.

There is no third surface. Canvas hover and ComponentInfoPanel are deferred.

### Frontend store — `src/frontend/src/store/obd-store.ts`

Singleton store following the existing pattern (`useSyncExternalStore`-friendly, stable `getSnapshot` reference). State:

```ts
type ObdStoreState = {
  indexStatus: 'unknown' | 'loading' | 'ready' | 'error';
  indexSyncedAt: string | null;
  indexBoardCount: number;
  matchesByBoardNumber: Record<string, ObdMatch[]>;   // GET /api/obd/match cache
  fetchedDataByBpath: Record<string, ObdData>;        // POST /api/obd/fetch results
  fetchingBpaths: Set<string>;                        // in-flight requests
  syncing: boolean;
  error: string | null;
};
```

Plus a `useObdForBoard(file: DatabankFile)` hook returning `{ matches, fetched, fetch, update, isFetching }` — the LibraryPanel detail pane is the only consumer in v1.

## Index sync (the scrape)

### Algorithm

1. GET `https://openboarddata.org/`. Extract category links from anchor `href` query strings (the `?a=showboards&category=...` pattern). Fall back to a hardcoded list `["consoles", "desktops", "laptops", "phones"]` if the front page doesn't expose category anchors cleanly — empirically determined during implementation.
2. For each category: GET the listing page, extract every `bpath` from anchors whose `href` matches `?a=showboardsolutions&bpath=<value>`. The bpath segments are stable (manufacturer / board); `brand` and `category` are derived from the first two segments.
3. Build the in-memory `Index { synced_at, source: "https://openboarddata.org", boards: [{ bpath, brand, category }] }`.
4. Write `index.json.tmp` then rename to `index.json`. A partially-failed sync leaves the prior `index.json` intact.

The exact CSS / anchor selectors are deliberately not specified in this design — they have to be derived from real fetches during implementation, and committing them in the spec would be guessing. The selector strategy is "extract `bpath` query parameter from anchors on category listing pages"; the regex / parser shape lands in the implementation plan.

### Politeness and safety

- **Single-flight:** the backend rejects a second `POST /api/obd/index/sync` while one is running (409 Conflict).
- **Per-request delay:** 250 ms between HTTP GETs.
- **Bounded:** index sync only walks category listing pages (a handful), not per-board pages. Board `.txt` files are never fetched during a sync.
- **User-Agent:** `BoardRipper/<version> (+<project-homepage-url>)` — the actual URL is set by the implementation; the goal is identifying us politely so .org's maintainer can reach us if our scraping causes problems.
- **Hard cap:** if more than 50 listing pages are walked in a single sync, abort with an error. Sanity check against runaway redirects.
- **Drop guard:** if the new index has fewer than 50 % of the previous index's board count, the new index is rejected and the old `index.json` is kept. Logs a warning. Protects against silent breakage on .org redesigns.

### No automation

Strictly user-clicks-button. No background sync, no sync on app start, no scheduled refresh. The Settings UI shows the last-sync timestamp; the user decides when to refresh.

## Matching

`GET /api/obd/match?board_number=<X>` runs case-insensitive substring match: a bpath matches the board if the **last segment of the bpath** (after the final `/`) contains the board's `board_number` as a substring after both sides are normalized by lowercasing and stripping spaces and dashes.

Examples:

- `board_number = "820-00045"` matches bpath `laptops/apple/820-00045` ✓
- `board_number = "820-00045"` matches bpath `laptops/apple/820-00045-A` ✓
- `board_number = "iP7P"` matches bpaths `laptops/apple/iP7P_intel` and `laptops/apple/iP7P_qualcomm` ✓ (multi-variant)
- `board_number = ""` (empty / unresolved) → no matches; OBD section is hidden in the UI

There is no fallback to filename or aliases. Boards with no resolved `board_number` get no OBD enrichment — explicitly accepted to avoid spurious matches.

## Per-board fetch

`POST /api/obd/fetch?bpath=<X>`:

1. Read `index.json`. If `bpath` is not in the index, return 400. Prevents arbitrary URL injection through this endpoint.
2. HTTP GET `https://openboarddata.org/?a=generate&bpath=<bpath>`, 30 s timeout, BoardRipper User-Agent.
3. Verify the response body starts with `OBDATA_V002`. Reject otherwise — catches HTML error pages served as 200.
4. Atomic write: `<bpath>.txt.tmp` → rename → `<bpath>.txt`.
5. Run the parser; serialize result to `<bpath>.parsed.json` via the same atomic-rename pattern.
6. Return the parsed payload.

Single-flight per bpath: if a fetch is already in flight for the same bpath, the second request awaits the first's result rather than issuing a duplicate HTTP GET.

Failure modes leave no partial state on disk (atomic rename guarantees this). The prior local copy, if any, is preserved.

## OBDATA_V002 parser

The format is plain text, line-based, internally documented with `###` comment lines. Sections are bracketed by `<NAME>_DATA_START` / `<NAME>_DATA_END`.

### Output shape

```ts
type ObdData = {
  bpath: string;
  source_url: string;
  fetched_at: string;
  header: {
    timestamp: string | null;
    id: string | null;
    brand: string | null;
    category: string | null;
    comment: string | null;
  };
  diagnosis: string;
  components: Array<{
    refdes: string;
    attrs: Record<string, string>;
  }>;
  nets: Array<{
    name: string;
    qualifier: string;
    diode: string | null;
    voltage: string | null;
    resistance: string | null;
    aliases: string[];
    comments: string[];
  }>;
};
```

### Parser rules

- Skip lines starting with `###` and blank lines.
- Header lines (between the `OBDATA_V002` magic and the first `_DATA_START`) are `KEY VALUE` with one space separator. Recognized keys: `TIMESTAMP`, `BOARDPATH`, `ID`, `BRAND`, `CATEGORY`, `COMMENT`. Unknown header keys are dropped with a warning.
- `DIAGNOSIS_DATA` section content is captured as raw text (joined by newlines), preserved verbatim. Internal structure varies; v1 doesn't interpret it.
- `COMPONENTS_DATA` section: each line is `<refdes> <attr_key> <attr_value>`. Multiple lines per refdes; merge into one `attrs` map. Duplicate `(refdes, attr_key)` pairs: last write wins, log a warning. Unknown attr keys are kept as-is (`attrs` is open-shape).
- `NETS_DATA` section: each line is `<name>/<qualifier> <type> <value> '<comment>'`. `type` ∈ `{d, r, v, a, t}`. Group by `(name, qualifier)`. `d`, `r`, `v` populate the corresponding scalar (last write wins for repeats, with warning). `a` and `t` accumulate into arrays. Unknown type keys are dropped with a warning.

### Why server-side

Parsing in Go (not TypeScript) keeps the frontend store simple: the fetch endpoint returns parsed JSON directly. Go also gives us a cheap fixture-driven unit test path without a browser.

## Frontend UI

### Settings — new "Library" tab

`SettingsPanel.tsx` currently has tabs `['theme', 'board', 'input', 'system']`. Add `'library'`.

Contents of the Library tab:

- **Heading:** "OpenBoardData".
- **Disclaimer block** (small grey text, always visible, not dismissible):
  > Per-net diagnostic measurements (diode / voltage / resistance) and repair notes from openboarddata.org. Data is community-contributed under the **ODbL 1.0** license. BoardRipper does not bundle this data; you fetch it on demand. Re-distribution requires keeping the same license — see https://opendatacommons.org/licenses/odbl/1-0/ for terms.
- **Sync row:**
  - "Sync OBD index" button → `POST /api/obd/index/sync`. Spinner + "Syncing…" while in flight; disabled while syncing.
  - Status line below: `Last synced: <iso> · <N> boards` (from `index.json`'s `synced_at` + `boards.length`). Falls back to "Never synced" when no `index.json`.
- **Clear cache row:**
  - "Delete all OBD data" button. Confirm dialog before calling `DELETE /api/obd/cache`.

### Library detail panel — OBD section

The lower pane of `LibraryPanel.tsx` (shown when a row is selected) gains a collapsible "OpenBoardData" section. State table:

| State | Render |
|---|---|
| No `index.json` synced yet | Section hidden. No "sync hint" — settings is one click away. |
| Index synced, no match for this board's `board_number` | Section hidden. |
| Match(es) exist, none fetched | "OpenBoardData available" header + one variant chip per match (outlined) + "Fetch" action on each chip. Clicking calls `POST /api/obd/fetch?bpath=…`. |
| Match(es) exist, ≥ 1 fetched | One chip per match (filled = fetched, outlined = not yet fetched). Each filled chip carries an "Update" action; each outlined chip carries a "Fetch" action. The merged measurement table below renders all fetched variants side-by-side; outlined (unfetched) variants are absent from the table until fetched. |

**Variant label.** Each chip's label is the bpath's leaf segment verbatim (e.g. `820-00045`, `iP7P_intel`, `iP7P_qualcomm`). No prefix-elision UI in v1 — the leaf is short enough to fit, and verbatim matches what users see on .org.

### Multi-variant rendering

When multiple variants are fetched (e.g. both `iP7P_intel` and `iP7P_qualcomm`), the per-net table merges them with side-by-side columns per variant:

```
┌────────────────┬───────────┬───────────┐
│ Net            │ intel     │ qualcomm  │
│                │ d / V / Ω │ d / V / Ω │
├────────────────┼───────────┼───────────┤
│ AGND_PMIC      │ 0.000/—/— │ 0.000/—/— │
│ PP3V3_S0_REG   │ 0.45/3.30/47k │ 0.42/3.30/47k │
│ ...                                    │
└────────────────┴───────────┴───────────┘
```

This is the per-net realization of the "show all variants" choice (option (x) from brainstorming). Variants the user hasn't fetched yet are absent from the table; clicking the outlined chip fetches and adds them.

### Detail-pane layout

```
[Header strip: Source: openboarddata.org · Fetched: <iso> · Variant: <chip(s)> · [↗ open upstream]]
[If diagnosis non-empty: collapsible "Diagnostic notes" block, default collapsed]
[Searchable net measurement table]
[Components section: collapsible, default collapsed]
```

The "open upstream" link points at `https://openboarddata.org/?a=showboardsolutions&bpath=<bpath>` for the active chip — the same URL the user would land on by browsing .org directly. Opens in a new tab.

A search input above the table filters net names case-insensitively. Net rows with `t` comments expose them via a row-expand chevron.

## Edge cases

- **Library has no `library_root` configured** → all OBD endpoints return 503 with a clear message. UI shows "Configure library path first" instead of the section.
- **`index.json` exists but is malformed** → backend logs warning, treats as no-index. User can re-sync.
- **Disk write failure during fetch** (out of space, permission) → no partial files on disk. Error returned to the UI.
- **User clicks "Fetch" twice rapidly** → backend single-flights per bpath. Second call awaits the first's result.
- **`index.json` last-synced is older than 30 days** → soft warning chip in the detail panel ("OBD index may be stale") with a link to Settings. Not a hard block.
- **Network errors during fetch** → preserve any prior local copy; show a retry button in the panel.
- **HTML structure changes break the scraper** → drop guard rejects the new index if board count drops > 50 %. User sees stale-but-correct data until the scraper is updated. Logged loudly server-side.

## Test plan

### Go unit tests — `src/backend/obd/`

- `parser_test.go`: fixture file `testdata/sample.obd.txt` captured from a real .org response; plus malformed variants (missing magic line, unterminated section, unknown net type key, duplicate component attr, empty diagnosis section). Coverage target: every parser branch.
- `scraper_test.go`: fixture HTML files served from a `httptest.Server`. Verifies `index.json` is built atomically, the bpath extraction strategy works against the captured HTML, and the > 50 % drop guard kicks in.
- `store_test.go`: atomic-rename behaviour, "is fetched?" check, cache deletion.

### Go integration tests — `src/backend/handlers/`

- `obd_handlers_test.go`: stubbed `index.json`, exercises:
  - `GET /api/obd/match` with no index → empty
  - `GET /api/obd/match` with no match → empty
  - `GET /api/obd/match` with one match → single result
  - `GET /api/obd/match` with multi-variant → multiple results
  - `POST /api/obd/fetch` with bpath not in index → 400
  - `POST /api/obd/fetch` happy path with `httptest.Server` standing in for .org
  - `POST /api/obd/fetch` two concurrent calls for the same bpath → only one upstream HTTP GET is issued (verifies single-flight)
  - `POST /api/obd/fetch` upstream returns non-`OBDATA_V002` body → rejected, no files written
  - `POST /api/obd/index/sync` second-call-while-running → 409
  - `DELETE /api/obd/cache` → folder removed

### Playwright spec — `tests/obd.spec.ts`

- Load library with fixture board file `820-00045.bvr`.
- Seed `<library_root>/.boardripper/openboarddata/index.json` with a known match.
- Click "Fetch OBD" with the .org URL stubbed via `page.route()`.
- Assert the parsed table renders.
- Negative path: no `index.json` → OBD section is not present in the DOM.

### No live network in tests

All HTTP is stubbed (`httptest.Server` server-side, `page.route` browser-side). The spec deliberately does not depend on .org being reachable.

## Deliverables

- `src/backend/obd/` package: `scraper.go`, `parser.go`, `store.go`, `types.go`
- `src/backend/handlers/obd.go`: four HTTP handlers (`/api/obd/index/sync`, `/api/obd/match`, `/api/obd/fetch`, `/api/obd/cache`) and route registration in the existing wire-up
- `src/frontend/src/store/obd-store.ts` + `useObdForBoard` hook
- `LibraryPanel.tsx` detail-pane addition (OBD section)
- `SettingsPanel.tsx` new "Library" tab with disclaimer + sync controls
- Fixtures: `testdata/sample.obd.txt`, `testdata/sample-index.html`, malformed-variant fixtures
- Go unit + integration tests
- Playwright spec
- **No `boards.db` schema changes; no migration script.**

## Future-work items (separate sub-projects)

1. **Canvas pin-hover tooltip** for OBD readings. Adds renderer-level work (PixiJS hover detection, position math, tooltip primitive). Consumes the same `obdStore`.
2. **`ComponentInfoPanel` enrichment** — add diode / voltage / resistance columns to the existing pin table inside `ComponentInfoPanel.tsx`. Trivial follow-up once `obdStore` exists.
3. **Per-board variant overrides** via the v2 schema's `board_openboarddata` table — used only when substring matching produces too many false positives in practice.
4. **Background / scheduled / ETag-based incremental sync** — only if users complain about manual sync.
5. **Contributing measurements back upstream** — gated on .org adding a contribution API; today the path is "email Paul Daniels".
